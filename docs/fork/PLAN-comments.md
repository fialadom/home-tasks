# Phase 3: comments with @mentions + richer history (implementation spec)

Fork `fialadom/home-tasks`, branch `feat/board-view` (clean at `79fe99d`). Roadmap:
`~/Dev/repos/proxmox/docs/home-tasks-board-plan.md`, *Phase 3*.

Built in two parts that run **in parallel** against the contract below:
- **Part A, backend:** Python, `services.yaml`, `README.md`, Python tests.
- **Part B, card:** `home-tasks-card.js`, JS tests, `tests-js/test_i18n.mjs`.

Each part touches only its own files. **README is owned by part A**, including the card options
from part B listed in *README* below.

**Scope: native lists only.** External (linked) lists get no comments. The card hides the
comments section and badge for external columns, and the backend has no external variants of
the commands. External parity is a later follow-up.

## Contract

### Comment object (stored in `task["comments"]`, returned by WS)

```json
{
  "id": "uuid4",
  "ts": "2026-10-11T20:15:00+00:00",
  "by": "Dominik Fiala",
  "by_user_id": "abc123",
  "by_person": "person.dominik",
  "text": "Hotovo, <@person.anna> mrkni prosím na https://example.com",
  "mentions": ["person.anna"],
  "edited_ts": "2026-10-11T20:20:00+00:00"
}
```

- `by`, `by_user_id` and `by_person` may each be `null`. A comment made by an automation has no
  user. `by_person` is the `person.*` whose `user_id` attribute equals `by_user_id`.
- `edited_ts` is present only after an edit.
- `text` holds mention **tokens** `<@person.x>`. Regex: `<@(person\.[a-z0-9_]+)>`.
- `mentions` is **derived on the server** from the tokens in `text`: unique, in order of first
  appearance. A client never sends it.
- `task["comments"]` is ordered oldest first. `home_tasks/get_tasks` already returns whole task
  dicts, so the card gets comments with the tasks.

### Limits (`const.py`)

`MAX_COMMENT_LENGTH = 2000`, `MAX_COMMENTS_PER_TASK = 200`, `MAX_MENTIONS_PER_COMMENT = 10`.

### WS commands (native: `list_id` + `task_id`)

| type | fields | result |
|---|---|---|
| `home_tasks/add_comment` | `list_id`, `task_id`, `text` (1–2000 chars after strip) | the comment |
| `home_tasks/update_comment` | `list_id`, `task_id`, `comment_id`, `text` | the comment |
| `home_tasks/delete_comment` | `list_id`, `task_id`, `comment_id` | `{}` |

Error codes the card relies on:
- `unknown_person`: a token names a `person.*` that does not exist in `hass.states`.
- `too_many_mentions`: more than 10 different persons.
- `unauthorized`: update or delete by someone who is neither the author (`by_user_id`) nor an
  admin.
- Anything else uses the existing `invalid_request` (empty or too long text, 200 comments
  reached, unknown task or comment).

### History entries (in `task["history"]`)

| action | extra keys | when |
|---|---|---|
| `commented` | `by`, `mentions` (omitted when empty), `comment_id` | add_comment |
| `updated` with `field: "section_id"` | `from`, `to` (section ids or null), `by` | section change through `update_task` (board drag, editor) |
| `sub_task` | `op` (`added`, `completed`, `reopened` or `deleted`), `title`, `by` | sub-task WS commands on native lists |
| `moved` | `from_list` (source list name), `by` | native → native move (`move_task` / `move_task_cross`), recorded on the moved task in the target list |

Edits and deletes of comments add no history entry.

### Events

Both events fire in the author's user context (`Context(user_id=by_user_id)` when known), like
`home_tasks_task_completed`. `text` is **rendered**: tokens are replaced by `@<friendly_name>` (or
`@person.x` when the person is gone) and truncated to 255 characters.

- `home_tasks_comment_added`: `_build_event_data(...)` plus `comment_id`, `by`,
  `by_user_id`, `by_person`, `text`, `mentions` (each key only when known or non-empty).
- `home_tasks_comment_mention`: **one event per mentioned person**, never for
  `by_person` itself. Carries `_build_event_data(...)` plus `comment_id`, `mentioned_person`,
  `by`, `by_person`, `text`. On `update_comment` it fires only for persons the edit **newly**
  added.

### Service `home_tasks.add_comment`

Fields: `entry_id` | `list_name`, `task_id` | `task_title` (resolved exactly like
`update_task` does, via `_resolve_store` / `_resolve_task`), and `text`. The author comes from
`call.context.user_id` (`_resolve_actor`). Mentions use the same tokens in `text`, so automations
can tag people. Add it to `services.yaml` (and service translations wherever the existing
services have them).

## Part A — backend

1. **`store.py`:**
   - Backfill `task.setdefault("comments", [])` on load (next to `history`, ~471).
   - New tasks start with `"comments": []`. **`async_duplicate_task` must set `"comments": []`**
     (it spreads `**source` today).
   - Moves keep comments (export/import copy the whole dict). Verify it with a test.
   - Pure helper `extract_mentions(text) -> list[str]` (unique, in order), unit-testable without
     hass.
   - `async_add_comment(task_id, text, *, by=None, by_user_id=None, by_person=None)` validates
     the text (strip, 1–2000, `validate_text`-style), the 200-comment limit and the
     ≤10-mentions rule (raise a `TooManyMentionsError(ValueError)` subclass). It appends the
     comment and the `commented` history entry (`_trim_history`), saves, then calls
     `self.on_comment_added(task, comment)` if set.
   - `async_update_comment(task_id, comment_id, text, *, user_id, is_admin)` checks permission
     (raise `PermissionError`). It recomputes `mentions`, sets `edited_ts`, saves and calls
     `self.on_comment_updated(task, comment, added_mentions)`.
   - `async_delete_comment(task_id, comment_id, *, user_id, is_admin)` has the same permission
     rule.
   - History:
     - Add `section_id` to `_HISTORY_FIELDS`, `_HISTORY_ENTRY_FORMATS` (`from_to`) and
       `_snapshot_task`.
     - Sub-task methods get an optional `actor` and record `sub_task` entries. Toggling
       `completed` records `completed` or `reopened`; a title rename records nothing.
2. **Person checks (WS and service layer, which have `hass`):**
   - Every token must be an existing `person.*` state, otherwise raise
     `UnknownPersonError(ValueError)`.
   - Factor the user → person lookup out of `completed_by_data` (`__init__.py` ~300) into a
     helper such as `person_for_user(hass, user_id)` and reuse it.
3. **`websocket_api.py`:**
   - The three commands, with `by` = `connection.user.name`, `by_user_id` =
     `connection.user.id` and `is_admin` = `connection.user.is_admin`.
   - Map `UnknownPersonError` → `unknown_person`, `TooManyMentionsError` →
     `too_many_mentions` and `PermissionError` → `unauthorized`. Do it in the handlers or in a
     small extension of `_handle_error`, without changing what other commands send.
   - Pass `actor` into the native sub-task handlers.
   - Record `moved` in the native move path (find where `async_move_task_any` imports into the
     target store).
   - **This file uses CRLF line endings. Keep them.** After editing, `git ls-files --eol
     custom_components/home_tasks/websocket_api.py` must still show `w/crlf`. Convert back if a
     tool changed them.
4. **`__init__.py`:**
   - Wire `on_comment_added` / `on_comment_updated` where the other store callbacks are wired,
     and fire both events.
   - A helper renders tokens to `@Name` for the event `text`.
   - Register the `add_comment` service.
5. **README (all of phase 3):**
   - Feature list: comments with @mentions; richer history.
   - Events table: the two new events and their extra fields.
   - Services: `home_tasks.add_comment` and the token format.
   - Card column options: `show_comments` (default `true`) and `badge_comments` (default `true`).
     Note that `show_history` defaults to `true` for `view_mode: board`.
   - An example automation: on `home_tasks_comment_mention`, `choose` by `mentioned_person` →
     `notify.mobile_app_<phone>` with title "{{ by }} tě zmínil v úkolu {{ task_title }}", message
     `text` and `data: {url: /ukoly-porovnani/ukoly}` (say the URL is an example).
6. **Python tests** (official fixtures only, see `TESTING.md`; events via
   `async_capture_events`, not mocked services):
   - **Unit:** `extract_mentions` (dedup, order, junk tokens ignored); store add, update, delete
     and the limits; duplicate drops comments; history `section_id` / `sub_task` / `commented`.
   - **Integration (WS):** add stores `mentions` / `by_person` (create a `person` state through
     the person integration or `hass.states.async_set` for `person.*`, as existing tests do for
     persons); `unknown_person`; `too_many_mentions`; a non-author non-admin update or delete →
     `unauthorized`, an admin is allowed; `comment_added` fires with the rendered text; `mention`
     fires once per person, not for the author; on edit only for newly added persons; a moved
     task keeps its comments and gets `moved` in its history; the service creates a comment.
   - Run: `.venv/bin/pytest -o log_cli=false -p no:cacheprovider` (the venv exists, Python 3.14).
     Everything must pass. 1008 passed before this phase.

## Part B — card

1. **Comments section** in `_buildTaskDetails` (~CARD 6465), placed after recurrence and before
   history. Shown when `col.show_comments !== false` and the column is native
   (`!this._isExternalCol(colIdx)`). Label `t("comments")`.
   - **List, oldest first:**
     - Avatar: `_buildPersonAvatar(by_person, name)` when `by_person` is set, else an initial
       bubble.
     - Name: `by_person`'s friendly name, else `by`, else `t("comment_by_automation")`.
     - Time: `_fmtTimestamp`, plus `t("comment_edited")` when `edited_ts` is set.
     - Text: URLs as links via `_findUrls` (as the notes view does) and mention tokens as
       `span.mention` "@Name". Add class `mention-me` when it is the viewer's person (the
       `person.*` whose `attributes.user_id === hass.user.id`). A missing person shows as
       `@person.x` with class `mention-removed`.
     - Edit and delete icon buttons when `by_user_id === hass.user.id` or `hass.user.is_admin`.
       Delete asks through `_confirmDialog(t("confirm_delete_comment"), t("confirm_delete_task_ok"),
       true)`. Edit swaps the text for a textarea with Save and Cancel; the tokens become `@Name`
       there, and the mention map is rebuilt.
   - **Input:**
     - `textarea.comment-input`, placeholder `t("comment_placeholder")` ("Napiš komentář… @ pro
       zmínku"), with a send button.
     - Ctrl/Cmd+Enter sends; plain Enter makes a new line.
     - The draft lives in `this._commentDrafts` (Map taskId → `{text, mentions: Map display →
       entity}`) so it survives re-renders.
     - `data-focus-key="comment_<taskId>"`. Extend the `_render` background-update deferral that
       today covers the notes textarea (`activeNotes`) to these comment inputs, for the same iOS
       keyboard reason.
   - **@ picker:**
     - When the text before the caret matches `(^|\s)@([\p{L}\p{N}_.\-]*)$` (u flag), show
       `div.mention-picker` under the textarea. It lists `person.*` states (avatar + friendly
       name) filtered by the query: case- and diacritics-insensitive (`normalize("NFD")`, strip
       marks), prefix match on any word of the name.
     - ArrowUp/ArrowDown move, Enter or Tab inserts, Escape closes, and a mouse click (on
       `mousedown`, so the textarea keeps focus) inserts. Enter or Tab while the picker is open
       inserts and does not send.
     - Insert replaces `@query` with `@<Name> ` and stores Name → entity in the draft's map.
     - At most 8 rows. With no match the picker hides.
   - **Send:**
     - Convert every map entry whose `@<Name>` still occurs in the text to `<@entity>`, longest
       names first. Entries that no longer occur are dropped, and a broken mention stays plain
       text.
     - Call WS `home_tasks/add_comment`. On success push the returned comment into
       `task.comments`, clear the draft and re-render.
     - On error show an inline error under the input:
       - `unknown_person` → `comment_err_person`;
       - `too_many_mentions` → `comment_err_mentions`;
       - anything else → `comment_err_failed`.
       Keep the draft.
2. **Badge:** next to the other task badges in `_buildTask`, `💬 N` when the task has comments and
   `col.badge_comments !== false` (native only). It gets class `badge-mention-me` and a leading
   "@" when any comment mentions the viewer. It shows in list rows, tiles and board cards, wherever
   the other badges show.
3. **History rendering** (`_formatHistoryEntry` / `_formatHistoryUpdateText`, ~CARD 8590):
   - `commented` → 💬 `t("history_commented")`, plus ` · ` and `t("history_mentioned")` and the
     names when there are mentions.
   - `updated` with field `section_id` → label `t("hist_section")`, with ids resolved to names
     from `this._columns[colIdx].sections`. A null id is `t("board_no_section")`; an unknown id is
     `t("hist_section_deleted")`. `_buildHistorySection` needs `colIdx`; thread it through.
   - `sub_task` → ☑ `t("history_sub_<op>")` + `: <title>`.
   - `moved` → ⇄ `t("history_moved", from_list)`.
4. **Board default:** in a `view_mode: board` column, `show_history` counts as `true` unless it is
   explicitly `false`.
5. **Editor:** a `show_comments` toggle (default on) next to `show_history`, and a
   `badge_comments` toggle (default on) next to the other `badge_*` toggles (~CARD 11542).
6. **i18n:** every new key in **all 15** languages with real translations. Some languages keep
   part of their keys in a second block further down (German ~CARD 1530–1720); put the keys next
   to their siblings. Keys: `comments`, `comment_placeholder`, `comment_send`, `comment_edited`,
   `comment_by_automation`, `comment_err_person`, `comment_err_mentions`, `comment_err_failed`,
   `confirm_delete_comment`, `ed_show_comments`, `ed_badge_comments`, `history_commented`,
   `history_mentioned`, `hist_section`, `hist_section_deleted`, `history_sub_added`,
   `history_sub_completed`, `history_sub_reopened`, `history_sub_deleted`, `history_moved` (with
   `{0}`). Czech:

   | key | cs |
   |---|---|
   | `comments` | Komentáře |
   | `comment_placeholder` | Napiš komentář… (@ pro zmínku) |
   | `comment_send` | Odeslat |
   | `comment_edited` | upraveno |
   | `comment_by_automation` | Automatizace |
   | `comment_err_person` | Zmíněná osoba neexistuje. |
   | `comment_err_mentions` | Komentář může zmínit nejvýš 10 lidí. |
   | `comment_err_failed` | Komentář se nepodařilo uložit. |
   | `confirm_delete_comment` | Smazat tento komentář? |
   | `ed_show_comments` | Komentáře |
   | `ed_badge_comments` | Počet komentářů |
   | `history_commented` | Komentář |
   | `history_mentioned` | zmínil(a) |
   | `hist_section` | Sloupec |
   | `hist_section_deleted` | (smazaná sekce) |
   | `history_sub_added` | Podúkol přidán |
   | `history_sub_completed` | Podúkol dokončen |
   | `history_sub_reopened` | Podúkol znovu otevřen |
   | `history_sub_deleted` | Podúkol smazán |
   | `history_moved` | Přesunuto ze seznamu {0} |

   Add `comments` and `history_commented` to the "recent feature keys" list in
   `tests-js/test_i18n.mjs`.
7. **Styles:** comment list, avatar row, `.mention` chips (`--todo-primary` tint; `.mention-me`
   stronger), the picker (absolutely positioned under the textarea, above other content,
   scrollable, an active row highlight), the badge. Must work at phone width and in light and
   dark themes.
8. **JS tests**, new `tests-js/test_comments.mjs` (harness as in `test_list_tabs.mjs` /
   `test_person_avatar.mjs`; mock `callWS`, `hass.user = {id, is_admin}`, `person.*` states):
   - The section renders comments with the author, a rendered mention chip, a link, and the
     edited marker.
   - `mention-me` appears for the viewer's person, and `mention-removed` for a missing one.
   - Typing `@an` opens the picker filtered to Anna (also `@án` → Anna). Enter inserts
     `@Anna `, and send calls `add_comment` with `<@person.anna>` in the text.
   - A broken mention (`@Ann` after editing the text) is sent as plain text.
   - Ctrl+Enter sends; plain Enter does not.
   - An error `unknown_person` shows the message and keeps the draft.
   - Edit and delete buttons show only for the author or an admin. Delete confirms and then
     calls `delete_comment`. Edit turns tokens into `@Name`, and saving sends `update_comment`
     with tokens.
   - The badge `💬 2` shows, gets `badge-mention-me` when the viewer is mentioned, and is hidden
     by `badge_comments: false`.
   - External column → no comments section and no badge.
   - History: section move with names, the deleted-section fallback, `commented` with mentions,
     `sub_task`, `moved`.
   - Board column without `show_history` → the history section is shown; `show_history: false`
     → hidden.
   - The draft survives a re-render.
   - Editor toggles exist with the right defaults.

   Run the whole suite with `npm run test:nocov` (434 passed before this phase) and `node --check`
   on CARD.

## Out of scope

External lists, reactions, attachments, notifications sent by the integration itself (that is
the automation's job), a "mentions me" filter, comment search.
