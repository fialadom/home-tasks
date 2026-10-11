# Filter for unassigned tasks (implementation spec)

Card-only change, no Python. CARD = `custom_components/home_tasks/home-tasks-card.js`.
Branch `feat/board-view`; the working tree already holds the uncommitted "new board" feature
(`PLAN-new-board.md`). Leave that code alone.

## Goal

The person filter row (chips built by `_buildColumnPersonChips`, ~CARD 4575) lets you show only
the tasks of chosen people. There is no way to show the tasks **nobody** is assigned to. Add an
**Unassigned** chip (cs *Nepřiřazené*) to that row.

## Behaviour

- **Combining:** the chip toggles like a person chip and combines with them as **OR**. *Dominik +
  Unassigned* shows Dominik's tasks and the unassigned ones ("what can I pick up"). *Unassigned*
  alone shows only tasks without `assigned_person`.
- **Sentinel:** implement with a module-level constant `UNASSIGNED_FILTER = "__unassigned__"`
  stored in the existing `cs.personFilters` Set. The filter in `_filteredTasks` (~CARD 3023)
  becomes `cs.personFilters.has(t.assigned_person || UNASSIGNED_FILTER)`. A task with only
  `assigned_name` (an external collaborator without an HA person) counts as unassigned.
- **When the chip shows:** inside the person chip row, after the person chips. Only when the row
  is shown at all (`person_filter` not `off`, `show_assigned_person !== false`), the new column
  option `show_unassigned_filter !== false` (default on), and either:
  - at least one task in `_preFilteredTasks(colIdx)` is unassigned **and** at least one person
    chip exists, or
  - the chip is active. Never hide an active filter the user cannot switch off.
  Today the row returns `null` when no person is assigned. Keep that unless the Unassigned chip
  is active.
- **Look:** follow `_buildColumnPersonChip` and the `person_filter` mode (`_personMode(colIdx,
  "filter")`):
  - `name`: `ha-icon` `mdi:account-off-outline` (16px) + text `t("person_unassigned")`, instead
    of the 👤 emoji;
  - `both`: the same icon in place of the avatar + text;
  - `picture`: the icon alone, sized like the avatar-only chip, with `title`/`aria-label` = the
    label.
  Same classes as person chips (`person-chip`, `active`, `with-avatar`, `avatar-only`) plus
  `person-chip-unassigned` and `data-eid="__unassigned__"`, so the existing chip-pop animation
  selector works. Add `aria-pressed`.
- **Auto-assign must ignore the sentinel.** Two places pick the person for a new task when
  exactly one person chip is active: `_addTask` (~CARD 2452) and the board lane add (~CARD 5001).
  Extract one helper `_autoAssignPerson(col, cs)` used by both:
  - the single active filter, unless it is `UNASSIGNED_FILTER`;
  - otherwise a preset `filters.assignees` of length 1, only when no chip is active.

  So with *Unassigned* active a new task stays unassigned, which matches the filter. With
  *Unassigned + one person* active nothing is auto-assigned (size 2, as today).
- **Board view:** the person row already works there. The chip must work too, including
  per-lane add.
- **Untouched:** search results, tiles and the board go through `_filteredTasks` and need no
  extra work, but check it. The assigned-person badge click on a task (~CARD 6211) is unchanged.

## Editor

In the column editor, right after `makePersonSelect("filter")` (~CARD 11435), add a toggle for
`show_unassigned_filter`, default on, label `t("ed_show_unassigned_filter")`. Use the editor's
existing toggle helper and `updateCol`, like the neighbouring switches.

## i18n

Two new keys in **all 15** language blocks with real translations. A few languages keep part of
their keys in a second block further down (German ~CARD 1530–1670). Put the new keys next to the
person-filter keys.

| key | cs | en |
|---|---|---|
| `person_unassigned` | Nepřiřazené | Unassigned |
| `ed_show_unassigned_filter` | Filtr nepřiřazených úkolů | Unassigned filter |

Add both keys to the "recent feature keys" list in `tests-js/test_i18n.mjs`.

## README

- Column option table: a row for `show_unassigned_filter` next to `person_filter`.
- One sentence in the person-filter part of the feature list about the Unassigned chip and the
  OR combination.

## Tests: new `tests-js/test_unassigned_filter.mjs`

Use the harness of `tests-js/test_list_tabs.mjs` / `tests-js/test_person_avatar.mjs` (`loadCard`,
`makeMockHass`, `hass.states` with `person.*` entities, local `CSS.escape` polyfill). The list
has tasks for person A, for person B, two unassigned tasks, and one with only `assigned_name`.

1. The person row has the A and B chips plus one `.person-chip-unassigned`, which comes last.
2. Clicking Unassigned shows only the unassigned tasks, including the `assigned_name` one.
3. Unassigned + A shows A's tasks and the unassigned ones (OR).
4. No unassigned task in the list → no Unassigned chip. Every task unassigned → no person row,
   as today.
5. Once active, the chip stays rendered even when no unassigned task remains (e.g. after a
   reload).
6. `show_unassigned_filter: false` → no chip. `person_filter: off` → no row and no chip.
7. In `picture` mode the chip is icon-only and has an accessible label.
8. Add with only Unassigned active → `home_tasks/add_task` is sent **without**
   `assigned_person`. With only A active → `assigned_person: A`, as before.
9. Board view: the chip filters the lanes, and per-lane add with Unassigned active sends no
   `assigned_person`.
10. Editor: the `show_unassigned_filter` switch exists and is checked by default. Unchecking it
    fires `config-changed` with `show_unassigned_filter: false`.

Then run the full JS suite with `npm run test:nocov` (all must pass) and `node --check` on CARD.

## Out of scope

Unassigned in preset `filters.assignees` (YAML), the `home_tasks.get_tasks` service, any
backend change.
