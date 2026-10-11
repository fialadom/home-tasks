# New board from the tab bar (implementation spec)

Builds on phases 1–2 (`PLAN-board-view.md`, `PLAN-list-tabs.md`) on branch `feat/board-view`.
Unlike them this touches **both** the backend (one new WS command) and the card.
CARD = `custom_components/home_tasks/home-tasks-card.js`, WS = `custom_components/home_tasks/websocket_api.py`.

## Goal

The user has a card with `layout: tabs` showing *Domácnost* and *Homelab* as boards. Today a new
board needs two detours: create a list in HA Settings → Devices & services → Home Tasks → Add
service, then add a column in the card editor. Instead, a **`+` at the end of the tab bar** does it
in one step on the dashboard:

```
 Domácnost 5   Homelab 4   [+]
┌──────────────────────────────────────────────────────────────┐
│ Name of the new board [Projekty      ]  Copy sections from [Homelab ▾]  [Create] [Cancel] │
└──────────────────────────────────────────────────────────────┘
 (active board below, unchanged)
```

On **Create** the card:
1. creates a new native list with that name, with the sections of the chosen board (or none),
2. appends a column for it to **this card's config in the dashboard** and saves the dashboard,
3. switches to the new tab.

## Behaviour

### When the `+` is shown

All of these must hold, otherwise no `+` (and nothing else changes):
- `layout: "tabs"` and the tab bar is rendered (two or more columns; a single column has no tab
  bar and stays as today),
- `tab_add !== false` (new card-level option, default on),
- `this._hass.user?.is_admin === true` (creating a list and saving a dashboard are admin-only),
- the card is not an editor preview: `this.preview !== true` (HA sets `preview` on cards rendered
  inside the card editor),
- a storage-mode dashboard object is reachable: `this._findLovelace()` (below) returns an object
  with `mode === "storage"`. YAML dashboards and anything outside a dashboard get no `+`.

The `+` is a `button.list-tab-add` (type button, `aria-label` and `title` = `t("new_board")`,
containing an `ha-icon` `mdi:plus`) placed **after** the last tab inside `.list-tabs`. It is not a
`role=tab` and is not part of the ArrowLeft/ArrowRight cycle.

### The form

- Clicking `+` toggles an inline form `div.new-board-form` rendered **between the tab bar and the
  active column** (`_buildCardContent` tabs branch). The `+` gets class `active` while it is open.
- Fields:
  - text input `input.new-board-name`, `maxlength=100`, placeholder `t("new_board_name")`, gets
    focus when the form opens;
  - select `select.new-board-template` labelled `t("new_board_sections_from")`: one option per
    column of this card (label = `_getListName(i)`, value = column index) plus a last option
    `t("new_board_sections_none")` (value `""`). Default = the active tab.
  - `button.new-board-create` (`t("new_board_create")`) and `button.new-board-cancel`
    (`t("new_board_cancel")`, or an existing generic cancel key if one exists).
  - `div.new-board-error` (role `alert`), empty unless there is an error.
- Enter in the name input = Create, Escape = Cancel (closes and clears the draft).
- State lives on the instance so it survives re-renders (background task reloads re-render the
  card while the user types): `this._newBoardOpen`, `this._newBoardName`, `this._newBoardTemplate`,
  `this._newBoardBusy`, `this._newBoardError`. Give the name input a `data-focus-key` so `_render`
  restores focus, exactly like the board's per-lane add input (`_buildBoardLaneAdd`,
  `_boardAddOpen` / `_boardAddText`) — follow that pattern, including whatever it does to avoid a
  rebuild under the keyboard while typing.
- While busy: Create and Cancel are disabled and Create shows `t("ed_loading")` (existing key).

### Create (`_createBoard()`)

1. `name = this._newBoardName.trim()`; empty → error `t("new_board_err_empty")`, stop.
2. `lovelace = this._findLovelace()`; locate this card in it (see *Finding this card*). No match →
   error `t("new_board_err_card")`, stop. **Do this before creating the list**, so a card that
   cannot be updated does not leave an orphan list behind.
3. Sections to copy: if a template column `t` is chosen, take `this._columns[t].sections`, sort by
   `sort_order`, map to `{name, icon}` (omit `icon` when falsy). Otherwise `[]`.
4. `await this._hass.callWS({type: "home_tasks/create_list", name, sections})`.
   On error map `err.code`: `duplicate_name` → `new_board_err_duplicate`, `empty_name` →
   `new_board_err_empty`, `max_lists_reached` → `new_board_err_max`, anything else →
   `new_board_err_failed`. Stay in the form, stop.
5. Push the returned `list` into `this._lists` (if not there yet), so the new tab's label resolves
   before any reload.
6. New column config:
   - with a template column: a copy of that column's config **without** `list_id`, `entity_id`,
     `title`, `icon`; then `list_id: <new id>`;
   - without a template: `{ list_id: <new id>, view_mode: "board" }`.
   No `title` — the tab label falls back to the list name.
7. New dashboard config: deep-clone the raw dashboard config and replace every node matching this
   card with `{ ...node, columns: [...node.columns, newCol] }`.
8. Make the new tab the active one **for the new set of lists**: write
   `localStorage["home_tasks_card:active_tab:" + <source keys of the new columns joined by ",">]`
   = new index (same key format as `_activeTabKey`; consider letting `_activeTabKey` take an
   optional columns array instead of duplicating the format). try/catch like `_setActiveTab`.
9. `await lovelace.saveConfig(newConfig)`. On failure → error `t("new_board_err_save")` (the list
   *does* exist now; the message says to add it via the card editor), stop.
10. On success: close the form, clear the draft, and call `this.setConfig(<the updated card
    node>)` so this instance shows the new tab immediately (HA will also push the new config; a
    second identical `setConfig` must be harmless).

### Finding the dashboard (`_findLovelace()`)

HA's view and root elements (`hui-root`, `hui-sections-view`, `hui-masonry-view`, `hui-section`, …)
carry a `lovelace` property: `{ config, rawConfig?, mode, editMode, urlPath, saveConfig(cfg) }`.
`lovelace.saveConfig` persists the dashboard **and** updates the UI without HA's
"dashboard was changed, refresh?" toast that a raw `lovelace/config/save` WS call would trigger.

Walk up from the card through light DOM and shadow roots:
`n = n.parentNode || n.host` (a ShadowRoot's `parentNode` is null, its `host` is the element),
and return the first `n.lovelace` that has a `saveConfig` function. Return `null` if none.
Use `lovelace.rawConfig ?? lovelace.config` as the dashboard config to edit.

**Verify these property names against the HA frontend source before relying on them**
(`src/panels/lovelace/types.ts` → `interface Lovelace`, `src/panels/lovelace/ha-panel-lovelace.ts`
→ `saveConfig`, and a view such as `src/panels/lovelace/views/hui-sections-view.ts`) on GitHub
`home-assistant/frontend` `dev`. If something differs (e.g. no `rawConfig`), adapt and note it in
the code comment.

### Finding this card in the dashboard config

- `setConfig` must keep the config exactly as HA passed it: `this._rawConfig = config` as the
  **first** line, before any normalisation.
- Walk the dashboard config recursively (views → `cards`, `sections[].cards`, and any nested
  `cards` array or `card` object of stacks/grids/conditional cards). A node matches when it deep-
  equals `this._rawConfig` (order-insensitive key comparison, e.g. a stable-stringify helper).
- Several identical matches → update all of them (they are the same card shown twice).
- A dashboard with a `strategy` (auto-generated) never contains this card → no match.

### Editor

Under the layout select, next to the existing `tab_counts` switch (only when `layout === "tabs"`),
an `ha-switch` for `tab_add`, default on, label `t("ed_tab_add")`. Card-level key: same pattern as
`tab_counts` (not `updateCol`).

## Backend: `home_tasks/create_list` (WS)

```python
@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/create_list",
    vol.Required("name"): str,
    vol.Optional("sections", default=[]): vol.All(
        [{vol.Required("name"): _val_section_name, vol.Optional("icon"): _val_icon}],
        vol.Length(max=MAX_SECTIONS_PER_LIST),
    ),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_create_list(hass, connection, msg): ...
```

(`_val_icon` / `_val_section_name` are defined further down in WS — move them up or define the
command after them.) Register it in `async_register_websocket_commands`.

- Create the list **through the existing config flow**, so validation (empty, too long,
  case-insensitive duplicate, `MAX_LISTS`) lives in one place and the entry looks exactly like one
  made in HA Settings (`source = "user"`):
  `async_init(DOMAIN, context={"source": SOURCE_USER})` → expect `MENU` (an `ABORT` with reason
  `max_lists_reached` → error code `max_lists_reached`) → `async_configure(flow_id,
  {"next_step_id": "native"})` → `async_configure(flow_id, {"name": msg["name"]})`.
  - `CREATE_ENTRY` → `entry = result["result"]`.
  - `FORM` with errors → **abort the flow** (`hass.config_entries.flow.async_abort(flow_id)`, so
    no flow lingers in progress) and `connection.send_error(msg_id, <errors["name"]>, <English
    message>)` — codes `empty_name`, `name_too_long`, `duplicate_name`.
- The entry is set up before `async_configure` returns, so the store is in
  `hass.data[DOMAIN][entry.entry_id]`. Verify that in the test. If it is not there yet, find the
  proper await (never `hass.async_block_till_done()` in production code) and raise a clear error
  when the store is still missing. Then `await store.async_add_section(name, icon=icon)` for each
  section, in order.
- Result: `{"list": <same dict shape as one entry of get_lists>}`. Extract the per-entry dict
  building from `ws_get_lists` into a helper (e.g. `_list_info(hass, entry, entity_reg)`) and use
  it in both commands.
- Errors that are not flow errors go through `_handle_error` as today.

## i18n

New card keys in **all 15** language blocks, next to the phase 2 keys (`ed_tab_counts`). Real
translations. Czech / English:

| key | cs | en |
|---|---|---|
| `new_board` | Nový board | New board |
| `new_board_name` | Název nového boardu | Name of the new board |
| `new_board_sections_from` | Sekce zkopírovat z | Copy sections from |
| `new_board_sections_none` | Žádné | None |
| `new_board_create` | Vytvořit | Create |
| `new_board_cancel` | Zrušit | Cancel |
| `new_board_err_empty` | Zadej název boardu. | Enter a name for the board. |
| `new_board_err_duplicate` | Seznam s tímto názvem už existuje. | A list with this name already exists. |
| `new_board_err_max` | Bylo dosaženo maximálního počtu seznamů. | The maximum number of lists has been reached. |
| `new_board_err_failed` | Board se nepodařilo vytvořit. | Could not create the board. |
| `new_board_err_card` | Tuto kartu se nepodařilo najít v konfiguraci dashboardu. Přidej board v editoru karty. | This card was not found in the dashboard configuration. Add the board in the card editor. |
| `new_board_err_save` | Seznam byl vytvořen, ale nepodařilo se ho přidat na kartu. Přidej ho v editoru karty. | The list was created but could not be added to this card. Add it in the card editor. |
| `ed_tab_add` | Tlačítko + pro nový board | + button for a new board |

(Skip `new_board_cancel` if a generic cancel key already exists and reuse that.) Add `new_board`
and `ed_tab_add` to the "recent feature keys" list in `tests-js/test_i18n.mjs`.

## Styles (`_getStyles`)

- `.list-tab-add`: same height/padding feel as `.list-tab`, no border, `color:
  var(--todo-secondary-text)`, `display:inline-flex; align-items:center`, `cursor:pointer`;
  `.list-tab-add.active` / `:hover` → `var(--todo-text)`; `:focus-visible` outline like `.list-tab`.
- `.new-board-form`: `display:flex; flex-wrap:wrap; gap:8px; align-items:flex-end; padding:12px 16px;
  border-bottom:1px solid var(--todo-divider)`. Reuse `.add-input` look for the input and the
  card's existing button look for the buttons. `.new-board-error`: full row, `color:
  var(--error-color, #db4437)`, 13px.
- Must work at phone width (wraps; no horizontal page scroll).

## README

- Card-level option table: row for `tab_add` (default `true`; admin only; storage-mode
  dashboards only; needs `layout: tabs` with 2+ columns).
- In the *Tabs* subsection: a short paragraph on the `+` (creates a list, copies sections from the
  chosen board, adds the tab to this card and saves the dashboard).

## Tests

### Python — new `tests/integration/test_websocket_create_list.py`

Use `hass_ws_client`, `MockConfigEntry`, and the existing `mock_config_entry` fixture
(`tests/conftest.py`). Official fixtures only (see `TESTING.md`).

1. Create succeeds: result `list.id` is a new config entry of the domain with `source == "user"`,
   title and `data["name"]` = the name; `home_tasks/get_lists` now contains it; its store exists.
2. Sections are created in the given order with their icons (`home_tasks/get_sections`).
3. Duplicate name (different case) → error code `duplicate_name`; no new entry;
   `hass.config_entries.flow.async_progress()` has no lingering flow.
4. Whitespace-only name → `empty_name`; 101-char name → `name_too_long`.
5. `MAX_LISTS` reached (patch `custom_components.home_tasks.config_flow.MAX_LISTS` to the current
   count) → `max_lists_reached`.
6. Non-admin user (`hass_read_only_access_token` with `hass_ws_client(hass, token)`) →
   `unauthorized`.
7. 51 sections → schema error, no entry created.

Python env: no venv exists yet. `uv venv .venv --python 3.13 && uv pip install --python .venv -r
requirements_test.txt` (use 3.14 if the pinned HA test package needs it). Run the new file, then
the whole suite: `.venv/bin/pytest -q` (live tests are excluded by `pytest.ini`).

### JS — new `tests-js/test_new_board.mjs`

Harness as in `tests-js/test_list_tabs.mjs` (`loadCard`, `makeMockHass`, local `CSS.escape`
polyfill). Mount the card **inside a fake host element** that has a `lovelace` property
`{ mode: "storage", config, rawConfig: config, saveConfig: async (c) => { saved.push(c) } }` where
`config` is a dashboard with one view containing this card (e.g. in `sections[0].cards`, next to
an unrelated card). The hass mock gets `user: { is_admin: true }` and answers `create_list`.

1. Admin + tabs + 2 columns + storage dashboard → one `.list-tab-add` after the last `.list-tab`.
2. No `+` when: not admin; `tab_add: false`; `layout` not tabs; one column; `preview = true`;
   no `lovelace` ancestor; `lovelace.mode === "yaml"`.
3. Click `+` → `.new-board-form` with focused name input; template select defaults to the
   active tab and has a "None" option; Escape closes it.
4. Create with template = Homelab: `create_list` is called with the name and Homelab's sections
   (`{name, icon}` in `sort_order`); `saveConfig` receives a dashboard where only this card has a
   3rd column `{...homelabColWithoutTitleIcon, list_id: <new>}` and the unrelated card is
   untouched; localStorage holds the new index under the new key; the card now renders 3 tabs
   with the new one active and labelled with the list name.
5. Template "None" → `sections: []` and new column `{list_id, view_mode: "board"}`.
6. Empty name → `new_board_err_empty` text, no WS call.
7. `create_list` rejects with `{code: "duplicate_name"}` → duplicate message, form stays open,
   `saveConfig` not called.
8. Card not found in the dashboard config (e.g. dashboard holds a different config) → card error,
   `create_list` **not** called.
9. `saveConfig` rejects → save error message shown.
10. The typed name survives a background re-render (`_render()` while typing).
11. Editor: with `layout: tabs` the `tab_add` switch exists, default checked; unchecking fires
    `config-changed` with `tab_add: false`.

Then run the full JS suite `npm run test:nocov` (all must pass) and `node --check` on CARD.

## Out of scope

Renaming or deleting lists from the card, a `+` for the side-by-side `columns` layout, YAML-mode
dashboards, creating external (linked) lists, a `home_tasks.create_list` service.
