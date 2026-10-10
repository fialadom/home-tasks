# Phase 2: `layout: tabs` (implementation spec)

This phase builds on the uncommitted phase 1 (board view) in the same working tree, branch
`feat/board-view`. Read `PLAN-board-view.md` for context. It is a card-only change and touches
no Python. The file is `custom_components/home_tasks/home-tasks-card.js` (CARD).

## Goal

A single card holds several lists, one per category (e.g. *Domácnost*, *Homelab*), as **tabs**.
The tab bar shows **text labels**. Only the active tab's column is rendered. Each tab keeps its
own `view_mode`, so tabs can mix board and list.

```yaml
type: custom:home-tasks-card
layout: tabs              # new card-level option; default "columns" = today's side-by-side
tab_counts: true          # default true: show the open-task count next to each label
columns:
  - { list_id: <Domácnost>, title: Domácnost, view_mode: board }
  - { list_id: <Homelab>,   title: Homelab,   view_mode: board }
```

## Behaviour

- `layout` is missing or `"columns"`: render exactly as today. Nothing may change for existing
  configs.
- `layout: "tabs"` with **two or more** columns:
  - Render `config.title` as `h1.card-global-title` when set. Below it a tab bar
    `div.list-tabs[role=tablist]` with one `button.list-tab[role=tab]` per column. Below that,
    only the active column: `this._buildColumn(activeIdx)`.
  - Label is `col.title`, else the list name (`_getListName(i)`). When `col.icon` is set, an
    `ha-icon` goes *before* the text. The text is always visible.
  - Count: `span.list-tab-count` holding the number of **open** tasks in that column's list
    (`cs.tasks` where `!completed`). Hidden when `tab_counts: false`.
  - Active tab: `aria-selected="true"` and class `active`. Clicking a tab sets the active index,
    persists it and calls `_render()`.
  - ArrowLeft/ArrowRight on a focused tab move to the previous/next tab, wrapping around.
- `layout: "tabs"` with **one** column: no tab bar, same as the current single-column render.
- Persistence: the active index is stored in
  `localStorage["home_tasks_card:active_tab:" + <column source keys joined by ",">]`. Use the
  existing `_colSourceKey(i)` (list_id or entity_id). Fall back to 0 when the stored index is out
  of range or the key is missing. Wrap localStorage access in try/catch, as the section-collapse
  helpers do.
- All columns keep loading (`_loadAllTasks`), so counts are live and switching is instant. The
  existing per-column state (`this._columns[i]`: filters, search, sort) is kept per tab.
- Code that queries `.task-list[data-col-idx=N]` (or `.board[...]`) for a column that is not
  rendered must not throw. Audit callers such as `_refreshTaskListDOM`, `_captureListFlip`,
  `_applyFlip`, `_finishDrag`, the board helpers and `_restoreBoardScroll`. Most already fall
  back to `_render()` or no-op; fix any that would throw.
- Drag between columns is impossible in tabs mode, because only one column exists in the DOM.
  That is fine.
- `setConfig`: when the number of columns shrinks, keep the active index valid.

## Code changes (CARD)

1. `_buildCardContent()` (the existing multi-column branch): add the tabs branch described
   above, in its own helper `_buildListTabs()`.
2. Active-tab helpers: `_activeTabKey()`, `_getActiveTab()`, `_setActiveTab(i)`.
3. Styles (`_getStyles`):
   - `.list-tabs`: `display:flex; gap:4px; overflow-x:auto; border-bottom:1px solid
     var(--todo-divider); padding:0 8px; scrollbar-width:none`
   - `.list-tab`: `background:none; border:none; border-bottom:2px solid transparent;
     padding:12px 14px; font:inherit; font-weight:500; color:var(--secondary-text-color);
     cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:6px`
   - `.list-tab.active`: `color:var(--primary-text-color); border-bottom-color:var(--todo-primary)`
   - `.list-tab-count`: `font-size:.85em; opacity:.65`
   - `.list-tab:focus-visible`: an outline
4. Editor (`HomeTasksCardEditor._render`, next to the card-title `ha-textfield`, ~CARD 10410):
   - A card-level `layout` select with options `columns` (`ed_layout_columns`) and `tabs`
     (`ed_layout_tabs`), labelled `ed_layout`. Store nothing when `columns` is chosen, i.e.
     delete the key.
   - When `tabs` is chosen: an `ha-switch` toggle for `tab_counts`, default on, labelled
     `ed_tab_counts`.
   - Follow the existing editor patterns for building selects and firing changes
     (`_fireChanged`). These are card-level keys, so do not use `updateCol`.
5. i18n: add `ed_layout`, `ed_layout_columns`, `ed_layout_tabs` and `ed_tab_counts` to **all 15**
   language blocks, right after the board keys added in phase 1. Use real translations. Czech:
   *Rozložení*, *Sloupce vedle sebe*, *Záložky*, *Počet úkolů v záložkách*. English: *Layout*,
   *Columns side by side*, *Tabs*, *Task count in tabs*. Add `ed_layout_tabs` to the "recent
   feature keys" list in `tests-js/test_i18n.mjs`.
6. README:
   - Card-level option table: rows for `layout` and `tab_counts`.
   - A short "Tabs" subsection with the YAML example above.

## Tests: new `tests-js/test_list_tabs.mjs`

Use the same harness as `tests-js/test_board_view.mjs` (including its local `CSS.escape`
polyfill if needed). Mock two native lists with tasks.

1. With no `layout`, both columns are rendered side by side (`.multi-columns` holds 2
   `.card-column`) and there is no `.list-tabs`. This guards against regressions.
2. With `layout: tabs` and 2 columns, there is one `.list-tabs` with 2 `button.list-tab`. The
   labels are the column titles (text present), with the list name used when `title` is
   missing. Only **one** `.card-column` is in the DOM.
3. Count badges show the open-task count of each list. `tab_counts: false` → no `.list-tab-count`.
4. A click on tab 2 renders column 1's tasks and not column 0's, sets `aria-selected`, and
   stores the index in localStorage. A new card instance with the same config starts on tab 2.
5. A stored index out of range falls back to tab 0.
6. `layout: tabs` with a single column → no tab bar.
7. Tabs combined with `view_mode: board` on the active column → the `.board` renders. Switching
   tabs keeps each tab's own view mode.
8. ArrowRight on the focused tab activates the next tab, wrapping from the last to the first.
9. Editor: the layout select exists. Selecting `tabs` fires `config-changed` with
   `layout: "tabs"`. Selecting `columns` removes the key.

Then run the full suite with `npm run test:nocov`; everything must pass (372 at the start of
phase 2). Also run `node --check` on CARD.

## Out of scope

Comments and history (phase 3), the cross-list board (phase 4), URL deep links to a tab, and
drag-and-drop between tabs.
