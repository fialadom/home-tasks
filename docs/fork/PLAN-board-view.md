# Phase 1 — `view_mode: board` (implementation spec)

Fork `fialadom/home-tasks`, branch `feat/board-view`, base upstream v2.4.0 (`12ffc13`).
Overall roadmap: `~/Dev/repos/proxmox/docs/home-tasks-board-plan.md`.
**Card-only change.** No Python/backend edits. Line numbers refer to
`custom_components/home_tasks/home-tasks-card.js` (CARD) at the base commit.

## Behaviour

- A column with `view_mode: board` renders its list as a Kanban board. There is one **lane** per
  section, in `sort_order`, plus a **Done** lane on the right.
- Lanes sit side by side and scroll horizontally when they do not fit, including on mobile.
  They never stack.
- Lane rules:
  - The list has **no sections**: lanes are *Open* (all open tasks) and *Done*.
  - The list has sections and some open tasks have no or an unknown `section_id`: a *No section*
    lane comes first (`board_show_unsectioned`: `"auto"` default | `true` | `false`).
- The Done lane shows completed tasks newest first (`completed_at` desc), limited to
  `board_done_limit` (default 10, 0 = all), with a "+N more" line when truncated.
  `board_done_column: false` hides the lane.
- Every card is the normal task element from `_buildTask`: checkbox, badges, tap expands the
  details inline. Only the drag handler differs.
- Drag and drop (mouse and touch):
  - open lane → open lane: set `section_id` to the target (`null` for *Open*/*No section*) and
    persist the order. Reuse `_applySectionChangesAndReorder` (CARD 2824).
  - open lane → Done: complete through `_toggleTaskCore(taskId, false, colIdx)` (CARD 2543;
    its 2nd arg is the *current* completed state), so `confirm_complete`, `auto_delete_completed`
    and recurrence behave as with the checkbox. A cancelled confirm re-renders.
  - Done → open lane: first `_applySectionChangesAndReorder` (sets the section while the task is
    still completed), then `_toggleTaskCore(taskId, true, colIdx)` to reopen.
  - Done → Done, or a drop outside this board: restore with `_render()`.
- Per-lane add: a "+ Add a task" button at the bottom of every open lane. When open, it becomes an
  input that stays open for repeated entry; Enter adds, Escape or a × button closes it.
  - Sends `home_tasks/add_task {list_id, title, section_id?}`. Omit `section_id` for the
    *Open*/*No section* lane.
  - Auto-assign uses the same rule as `_addTask` (CARD ~2417): exactly one active person chip,
    else a preset `filters.assignees` of length 1.
  - Native lists only. Hide the button for external columns (`_isExternalCol`) and when
    `board_add_per_lane: false` or `show_add_task: false`.
  - The normal add row above the board stays and works as today. The store applies the list's
    default section.
- In board mode the All/Open/Done status filter row is hidden. Tag chips, person chips, sort and
  search keep working.
  - An active search shows the flat search results, as the list view does
    (`_buildTaskSearchResults`).
  - The sort applies inside each lane.

## Code changes (CARD)

1. **`_buildColumnBody`** (3967): `if (col.view_mode === "board") return this._buildColumnBoard(filteredTasks, colIdx);`
2. **`_buildColumn`** (3634):
   - `hideFilters` is also true when `col.view_mode === "board"`.
   - Add the class `board-mode` to `.card-column`.
3. **`_buildTask`** (5008, near the end): call `this._attachBoardDragToTask(taskEl, task.id, colIdx)`
   instead of `_attachDragToTask` when the column is in board mode.
4. New block **`// ── Board view ──`** placed after `_buildColumnTaskList` (ends ~4420) and before
   the *Tile / Kachel view* block.
   - `_buildColumnBoard(filteredTasks, colIdx)` returns
     `div.task-list.board[data-col-idx]`.
     - It keeps the `task-list` class on purpose: `_refreshTaskListDOM`, `_captureListFlip`,
       `_applyFlip` and the focus code all select `.task-list[data-col-idx]`.
     - Children are lanes: `div.board-lane[data-section-id]` (`""` for Open/No section,
       `"__done__"` for Done, plus `done-lane`) containing:
       - `div.board-lane-header` (optional `ha-icon`, `span.board-lane-name`,
         `span.board-lane-count`)
       - `div.board-lane-body[data-section-id]` (the tasks)
       - optional `div.board-lane-more`
       - the add control
   - `_buildBoardLaneAdd(lane, colIdx)`: the open/closed state lives in `this._boardAddOpen`
     (`"<colIdx>:<laneId>"`). The input carries `data-focus-key="board_add_<colIdx>_<laneId>"`, so
     `_render`'s focus restore keeps the caret across reloads.
   - `async _addTaskToLane(colIdx, sectionId, title)`: snapshot with `_captureListFlip`, call WS,
     `_loadAllTasks`, `_applyFlip(before, colIdx, 0.25)`. On failure call
     `_showError(this._t("add_failed"))`.
   - `_attachBoardDragToTask(taskEl, taskId, colIdx)`:
     - Desktop HTML5:
       - `dragstart` ignores `_isInteractiveTarget`, calls `_boardDragStart`, sets
         `effectAllowed = "move"` and `setData("text/plain", id)` inside try/catch, and adds
         the class `dragging`.
       - `dragend` calls `_finishBoardDrag()`.
     - Touch: a 150 ms long-press timer, as in `_attachDragToTask` (CARD ~8065), creates a
       `position:fixed` `.drag-clone` that follows **both X and Y** (store the X/Y offsets).
       - `touchmove` (`passive:false`): `elementFromPoint` → `_boardDragOver(hit, clientY,
         colIdx)` and `_boardAutoScroll(clientX, colIdx)`.
       - `touchend`/`touchcancel`: copy the `_suppressRowTapUntil` logic from the row drag,
         then `_finishBoardDrag()`.
   - `_boardDragStart(taskId, colIdx)`:
     - Sets `this._draggedTaskId` and `this._draggedColIdx`. These keep `_render`'s background
       deferral working (CARD 3470).
     - Sets `this._boardDragColIdx` and stores `this._boardDragOrigin = {completed, sectionId}`
       from `cs.tasks`.
     - Calls `this._collapseAllForDrag()`.
   - Lane-level drop: each `.board-lane` gets `dragover` and `drop` listeners.
     - `dragover`: only when `_boardDragColIdx === colIdx`; then `preventDefault`,
       `_boardDragOver(e.target, e.clientY, colIdx)` and `_boardAutoScroll(e.clientX, colIdx)`.
     - `drop`: `preventDefault` and `_finishBoardDrag()`.
   - `_boardDragOver(hitEl, clientY, colIdx)`:
     - Find the lane with `closest(".board-lane")` and check the board's `data-col-idx`.
     - The insertion point is the first non-dragging child `.task` of the lane body whose
       vertical midpoint is below `clientY`, else append.
     - Skip no-op moves.
     - Insert with a 2D FLIP of the other cards in the board (`translate(dx,dy)`, 0.18 s, the
       same pattern as `_liveMoveTask` 7862).
     - Mark the lane with `drop-target`.
   - `_boardAutoScroll(clientX, colIdx)`: scroll `.board` by about 12 px when within 40 px of
     its left or right edge.
   - `async _finishBoardDrag()`:
     - Clean up drag state, the clone, the timer and the classes.
     - Resolve the target lane via `closest(".board-lane-body")` of the dragged element in
       this board. If there is none, `_render()`.
     - Apply the rules above, using `_getBoardOrderFromDom(board)`, which returns
       `[{taskId, sectionId}]` in DOM order over all lane bodies. Done lane entries get
       `"__done__"`, which `_applySectionChangesAndReorder` already skips.
     - Finally `if (this._pendingRender) this._render();`.
   - `_boardTaskEl(taskId)`: `.board .task[data-task-id=…]` (escape with `CSS.escape`). This
     excludes the clone.
5. **Styles** (`_getStyles`, ~8156), next to the section CSS:
   - `.board`: `display:flex; gap:12px; align-items:flex-start; overflow-x:auto;
     overscroll-behavior-x:contain; scroll-snap-type:x proximity; padding-bottom:6px`
   - `.board-lane`: `flex:1 0 260px; min-width:240px; max-width:420px; display:flex;
     flex-direction:column; gap:8px; padding:10px; border-radius:var(--todo-radius);
     background: rgba(var(--rgb-primary-text-color,33,33,33),0.04);
     scroll-snap-align:start; box-sizing:border-box`
   - `.board .task { background: var(--todo-bg) }`, so cards stand out from the lane
   - `.board-lane.drop-target`: a dashed primary outline
   - `.board-lane-body`: `min-height:40px; display:flex; flex-direction:column; gap:6px`.
     An empty lane must remain a drop target, unlike `.section-body:empty`.
   - Header, count, more, add button and input styles that match the existing add input
   - `.card-column.board-mode { min-width:0 }`
   - Do **not** let the `@media (max-width:600px)` stacking rule (8189) affect lanes.
6. **Editor** (`_buildVisualEditor`, view select ~10373):
   - Add the `["board", "ed_view_mode_board"]` option.
   - When `board` is selected, show the hint `ed_board_help` and a `toggle-grid` with
     `makeToggle("board-done","ed_board_done_column","board_done_column",true)` and
     `makeToggle("board-add","ed_board_add_per_lane","board_add_per_lane",true)`.
7. **i18n** (`_TRANSLATIONS`, 15 blocks in the order en, nl, it, pl, sv, fr, pt, es, ru, cs, da,
   no, fi, hu, de): insert the new keys directly after `ed_view_mode_tiles` in every block.
   `tests-js/test_i18n.mjs` requires identical key sets. Add `ed_view_mode_board` to its
   "recent feature keys" list.

   | key | en | cs |
   |---|---|---|
   | `ed_view_mode_board` | Board | Nástěnka |
   | `board_open` | Open | Otevřené |
   | `board_no_section` | No section | Bez sekce |
   | `board_add_card` | Add a task | Přidat úkol |
   | `board_more_done` | +{0} more | +{0} dalších |
   | `ed_board_done_column` | Done column | Sloupec Hotovo |
   | `ed_board_add_per_lane` | Add button in each column | Tlačítko přidat v každém sloupci |
   | `ed_board_help` | Board: sections become columns. Drag a task to another column to change its section, into Done to complete it. | Nástěnka: sekce se zobrazí jako sloupce. Přetažením úkolu do jiného sloupce změníte jeho sekci, do Hotovo ho dokončíte. |

   Provide real translations for the other 13 languages (existing wording for "section"/"done"
   in each block, e.g. nl *sectie*/*Klaar*, de *Abschnitt*/*Erledigt*).
8. **README**:
   - Add `board` to the `view_mode` row of the column option table.
   - Add rows for `board_done_column`, `board_done_limit`, `board_show_unsectioned` and
     `board_add_per_lane`.
   - Add a short "Board view" section with a YAML example (one list with sections
     *K řešení*/*Rozpracováno*).

## Tests — new `tests-js/test_board_view.mjs`

Follow `tests-js/test_card_render.mjs`: `loadCard()` and `makeRecordingHass(responses)`
returning canned `home_tasks/get_lists` / `get_tasks {tasks, sections, tag_catalog}`, plus
`flush()`. Cover:

1. Sections S1, S2 plus open and completed tasks → lanes `[S1, S2, __done__]` in `sort_order`,
   each task in the right lane, counts correct.
2. Unsectioned open task → a leading `""` lane appears only then; `board_show_unsectioned:false`
   hides it.
3. No sections → lanes `["", "__done__"]`, the first titled *Open*.
4. `board_done_column:false` → no Done lane. `board_done_limit:1` with 3 completed → 1 card +
   "+2 more", newest `completed_at` first.
5. Status filter row absent in board mode; present in list mode.
6. Drop S1 → S2: move the DOM node into S2's body, call `card._boardDragStart(id, 0)` then
   `await card._finishBoardDrag()` → recorded `update_task {section_id:S2}` +
   `reorder_tasks`.
7. Drop open → Done → `update_task {completed:true}` and no `section_id` change.
   `confirm_complete:true` with the dialog stubbed to cancel → no `update_task`.
8. Drop Done → S1 → `update_task {section_id:S1}`, then `update_task {completed:false}`.
9. Per-lane add: open the lane add, type, Enter → `add_task {list_id, title, section_id:S1}`.
   The *Open* lane sends no `section_id`. External column → no add button.
10. Editor: `view_mode` select offers `board`; the board toggles render when it is selected.

Then the full suite must pass: `npm run test:nocov` (341 tests at base). The Python tests
are untouched.

## Out of scope for phase 1

Tabs (phase 2), comments and history (phase 3), the cross-list board (phase 4), lane-to-lane
moves between *different* card columns, and reordering lanes by drag.
