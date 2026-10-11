# Confirm before deleting a task (implementation spec)

Card-only change, no Python. CARD = `custom_components/home_tasks/home-tasks-card.js`.
Branch `feat/board-view`. The working tree already holds two uncommitted features ("new board"
and "unassigned filter", see `PLAN-new-board.md` and `PLAN-unassigned-filter.md`). Leave that
code alone.

## Goal

**Delete task** in the task details (inline in the list, in the tile/board detail sheet) deletes
immediately. One mis-tap loses the task. Ask first.

## Behaviour

- **The prompt:** clicking `.delete-task-btn` (built in the detail actions, ~CARD 8009) first asks
  `await this._confirmDialog(this._t("confirm_delete_task_msg", task.title),
  this._t("confirm_delete_task_ok"))`. This is the same `<dialog>` helper `confirm_complete`
  uses (`_modalDialog`, ~CARD 3270). It opens in the browser's top layer, so it sits above the
  detail sheet.
  - **Cancel** (button, Esc, backdrop): nothing happens. The detail sheet stays open, the task
    stays expanded.
  - **Confirm:** only now close the detail sheet (`_closeTaskDetailSheet()`), then
    `_deleteTask(task.id, colIdx)`, as today.
- **Double clicks:** a second click on the button while the dialog is open must not open a
  second dialog. Guard it, e.g. with a flag on the instance.
- **New column option `confirm_delete`, default `true`.** `false` restores today's immediate
  delete.
- **Where the prompt does not apply:**
  - `auto_delete_completed`: a completed task removed by `_toggleTaskCore` → `_deleteTask`
    (~CARD 2598) is not a manual delete. `confirm_complete` covers that path; do not add a second
    prompt there. The guard belongs in the button handler, **not** inside `_deleteTask`.
  - Deleting sub-tasks is out of scope.
- **Native and external lists:** both behave the same, since both go through the same button.
- **OK button:** if `_modalDialog` / `.ht-confirm-btn` already has a destructive style, use it
  for the OK button. Otherwise add a small `danger` variant (`color: var(--error-color,
  #db4437)` / matching border or background). Keep the change local, without restyling the
  `confirm_complete` dialog.

## Editor

Next to `makeToggle("confirm-complete", "ed_confirm_complete", "confirm_complete", false)`
(~CARD 11483): `makeToggle("confirm-delete", "ed_confirm_delete", "confirm_delete", true)`.

## i18n

Three new keys in **all 15** language blocks with real translations, next to
`confirm_complete_msg` / `confirm_complete_ok` and `ed_confirm_complete`. A few languages keep
part of their keys in a second block further down (German ~CARD 1530–1690); put them next to
their siblings.

| key | cs | en |
|---|---|---|
| `confirm_delete_task_msg` | Smazat úkol „{0}“? Tuto akci nelze vrátit. | Delete "{0}"? This can't be undone. |
| `confirm_delete_task_ok` | Smazat | Delete |
| `ed_confirm_delete` | Potvrdit před smazáním | Confirm before deleting |

Use each language's quotation marks as `confirm_complete_msg` does in that language. Add
`confirm_delete_task_msg` and `ed_confirm_delete` to the "recent feature keys" list in
`tests-js/test_i18n.mjs`.

## README

A row for `confirm_delete` (default `true`) in the column option table, right after
`confirm_complete`.

## Tests: new `tests-js/test_confirm_delete.mjs`

Reuse how existing tests drive `confirm_complete` and the `ht-confirm` dialog
(`tests-js/test_tap_to_complete.mjs`, `tests-js/test_card_render.mjs`).

1. Expanding a task and clicking **Delete task** opens a `dialog.ht-confirm` whose message holds
   the task title. No `home_tasks/delete_task` call yet.
2. Cancel → no `delete_task`, the task is still rendered, and the detail stays open/expanded.
3. Confirm → exactly one `home_tasks/delete_task {list_id, task_id}`.
4. `confirm_delete: false` → clicking **Delete task** sends `delete_task` immediately, with no
   dialog.
5. Tile view, detail sheet: cancel keeps the sheet open; confirm closes it and deletes.
6. Two quick clicks on **Delete task** → one dialog only.
7. `auto_delete_completed: true` + completing a task → the delete dialog does **not** appear
   (`confirm_complete` unset).
8. External list column: confirm → the existing external delete WS call is sent.
9. Editor: the `confirm_delete` toggle exists and is checked by default. Unchecking it fires
   `config-changed` with `confirm_delete: false`.

Then run the full JS suite with `npm run test:nocov` (all must pass, 425 before this change) and
`node --check` on CARD.

## Out of scope

Undo/snackbar after delete, confirming sub-task deletes, confirming section deletes (already
uses `window.confirm`).
