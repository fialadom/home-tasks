/**
 * Board view (view_mode: board): lanes per section plus a Done lane, drag and
 * drop between lanes, per-lane add, and the editor option.
 *
 * jsdom has no layout (getBoundingClientRect is all zeros), so the drag tests
 * move the card's DOM node into the target lane themselves - which is what the
 * live preview does - and then call _boardDragStart / _finishBoardDrag, the two
 * ends of a drag.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';


function makeRecordingHass(responses = {}) {
  const calls = [];
  return {
    language: 'en',
    states: {},
    auth: {},
    calls,
    callWS: async (msg) => {
      calls.push(msg);
      const fn = responses[msg.type];
      if (typeof fn === 'function') return fn(msg);
      if (fn !== undefined) return fn;
      if (msg.type === 'home_tasks/get_lists') return { lists: [] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [] };
      if (msg.type === 'home_tasks/get_external_tasks') return { tasks: [] };
      return null;
    },
    callService: async () => {},
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// jsdom has no CSS.escape, which the board uses to look cards up by id.
async function freshCard() {
  const loaded = await loadCard({ force: true });
  if (!loaded.window.CSS) {
    loaded.window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, '\\$&') };
  }
  return loaded;
}

const SECTIONS = [
  // Deliberately out of order: lanes must follow sort_order, not array order.
  { id: 'S2', name: 'Rozpracováno', sort_order: 1 },
  { id: 'S1', name: 'K řešení', sort_order: 0, icon: 'mdi:inbox' },
];

const task = (id, extra = {}) => ({
  id, title: `Task ${id}`, completed: false, sort_order: 0, sub_items: [], ...extra,
});

/**
 * Card with one native list L1 rendered as a board.
 * `tasks` / `sections` are what get_tasks returns; `col` extends the column config.
 */
async function setup({ tasks = [], sections = SECTIONS, col = {}, responses = {} } = {}) {
  const { HomeTasksCard } = await freshCard();
  const hass = makeRecordingHass({
    'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
    'home_tasks/get_tasks': { tasks, sections, tag_catalog: [] },
    'home_tasks/add_task': { id: 'NEW' },
    ...responses,
  });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', view_mode: 'board', ...col }] });
  card.hass = hass;
  await flush();
  return { card, hass };
}

const lanes = (card) => [...card.shadowRoot.querySelectorAll('.board > .board-lane')];
const laneIds = (card) => lanes(card).map((l) => l.dataset.sectionId);
const lane = (card, id) => lanes(card).find((l) => l.dataset.sectionId === id);
const laneBody = (card, id) => lane(card, id).querySelector('.board-lane-body');
const cardIds = (card, id) =>
  [...laneBody(card, id).querySelectorAll(':scope > .task')].map((el) => el.dataset.taskId);
const callsOf = (hass, type) => hass.calls.filter((c) => c.type === type);

// What the live preview does while dragging: put the card into the lane.
function moveCard(card, taskId, laneId) {
  const el = card.shadowRoot.querySelector(`.board .task[data-task-id="${taskId}"]`);
  laneBody(card, laneId).appendChild(el);
}
async function drop(card, taskId, laneId, colIdx = 0) {
  card._boardDragStart(taskId, colIdx);
  moveCard(card, taskId, laneId);
  await card._finishBoardDrag();
  await flush();
}


describe('board lanes', () => {
  test('one lane per section in sort_order plus Done; tasks and counts per lane', async () => {
    const { card } = await setup({
      tasks: [
        task('A', { section_id: 'S1' }),
        task('B', { section_id: 'S2' }),
        task('C', { section_id: 'S1' }),
        task('D', { completed: true, section_id: 'S1', completed_at: '2026-01-01T10:00:00+00:00' }),
      ],
    });
    assert.deepEqual(laneIds(card), ['S1', 'S2', '__done__']);
    assert.deepEqual(cardIds(card, 'S1'), ['A', 'C']);
    assert.deepEqual(cardIds(card, 'S2'), ['B']);
    assert.deepEqual(cardIds(card, '__done__'), ['D']);

    const text = (id, sel) => lane(card, id).querySelector(sel).textContent;
    assert.equal(text('S1', '.board-lane-name'), 'K řešení');
    assert.equal(text('S1', '.board-lane-count'), '2');
    assert.equal(text('S2', '.board-lane-name'), 'Rozpracováno');
    assert.equal(text('S2', '.board-lane-count'), '1');
    assert.equal(text('__done__', '.board-lane-name'), 'Done');
    assert.equal(text('__done__', '.board-lane-count'), '1');
    assert.ok(lane(card, '__done__').classList.contains('done-lane'));
    assert.equal(lane(card, 'S1').querySelector('ha-icon').getAttribute('icon'), 'mdi:inbox');
  });

  test('the board keeps the task-list class and column index, and marks the column', async () => {
    const { card } = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    const board = card.shadowRoot.querySelector('.task-list.board[data-col-idx="0"]');
    assert.ok(board);
    assert.ok(card.shadowRoot.querySelector('.card-column.board-mode'));
  });

  test('a No section lane leads only when an open task has no (or an unknown) section', async () => {
    const without = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    assert.deepEqual(laneIds(without.card), ['S1', 'S2', '__done__']);

    const { card } = await setup({
      tasks: [task('A', { section_id: 'S1' }), task('X'), task('Y', { section_id: 'GONE' })],
    });
    assert.deepEqual(laneIds(card), ['', 'S1', 'S2', '__done__']);
    assert.equal(lane(card, '').querySelector('.board-lane-name').textContent, 'No section');
    assert.deepEqual(cardIds(card, ''), ['X', 'Y']);

    const hidden = await setup({
      col: { board_show_unsectioned: false },
      tasks: [task('A', { section_id: 'S1' }), task('X')],
    });
    assert.deepEqual(laneIds(hidden.card), ['S1', 'S2', '__done__']);

    const forced = await setup({
      col: { board_show_unsectioned: true },
      tasks: [task('A', { section_id: 'S1' })],
    });
    assert.deepEqual(laneIds(forced.card), ['', 'S1', 'S2', '__done__']);
  });

  test('a list without sections has an Open and a Done lane', async () => {
    const { card } = await setup({
      sections: [],
      tasks: [task('A'), task('B'), task('C', { completed: true })],
    });
    assert.deepEqual(laneIds(card), ['', '__done__']);
    assert.equal(lane(card, '').querySelector('.board-lane-name').textContent, 'Open');
    assert.deepEqual(cardIds(card, ''), ['A', 'B']);
    assert.deepEqual(cardIds(card, '__done__'), ['C']);
  });

  test('board_done_column: false removes the Done lane', async () => {
    const { card } = await setup({
      col: { board_done_column: false },
      tasks: [task('A', { section_id: 'S1' }), task('D', { completed: true })],
    });
    assert.deepEqual(laneIds(card), ['S1', 'S2']);
  });

  test('Done lane: newest completed_at first, board_done_limit cuts with a +N more line', async () => {
    const done = [
      task('old', { completed: true, completed_at: '2026-01-01T00:00:00+00:00' }),
      task('new', { completed: true, completed_at: '2026-03-01T00:00:00+00:00' }),
      task('mid', { completed: true, completed_at: '2026-02-01T00:00:00+00:00' }),
    ];
    const { card } = await setup({ col: { board_done_limit: 1 }, tasks: done });
    assert.deepEqual(cardIds(card, '__done__'), ['new']);
    assert.equal(lane(card, '__done__').querySelector('.board-lane-more').textContent, '+2 more');
    assert.equal(lane(card, '__done__').querySelector('.board-lane-count').textContent, '3',
      'the count is the lane size, not the cards drawn');

    const all = await setup({ col: { board_done_limit: 0 }, tasks: done });
    assert.deepEqual(cardIds(all.card, '__done__'), ['new', 'mid', 'old']);
    assert.equal(lane(all.card, '__done__').querySelector('.board-lane-more'), null);

    const dflt = await setup({ tasks: done });
    assert.deepEqual(cardIds(dflt.card, '__done__'), ['new', 'mid', 'old'], 'default limit is 10');
  });

  test('the status filter row is gone in board mode, present in list mode', async () => {
    const board = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    assert.equal(board.card.shadowRoot.querySelector('.filters .filter-btn'), null);
    assert.equal(board.card.shadowRoot.querySelector('.filter-btn'), null);

    const list = await setup({ col: { view_mode: undefined }, tasks: [task('A', { section_id: 'S1' })] });
    assert.ok(list.card.shadowRoot.querySelectorAll('.filter-btn').length >= 3);
    assert.equal(list.card.shadowRoot.querySelector('.board'), null);
  });

  test('a leftover default_filter does not hide cards on the board', async () => {
    const { card } = await setup({
      col: { default_filter: 'done' },
      tasks: [task('A', { section_id: 'S1' }), task('D', { completed: true })],
    });
    assert.deepEqual(cardIds(card, 'S1'), ['A']);
    assert.deepEqual(cardIds(card, '__done__'), ['D']);
  });

  test('an active search shows the flat results instead of the lanes', async () => {
    const { card } = await setup({
      tasks: [task('A', { section_id: 'S1', title: 'Milk' }), task('B', { section_id: 'S2', title: 'Bread' })],
    });
    card._columns[0].taskSearchQuery = 'mil';
    card._refreshTaskListDOM(0);
    const list = card.shadowRoot.querySelector('.task-list[data-col-idx="0"]');
    assert.equal(list.querySelector('.board-lane'), null);
    assert.deepEqual([...list.querySelectorAll('.task')].map((e) => e.dataset.taskId), ['A']);
  });
});


describe('board drag and drop', () => {
  const base = () => [
    task('A', { section_id: 'S1' }),
    task('B', { section_id: 'S2' }),
    task('D', { completed: true, section_id: 'S1', completed_at: '2026-01-01T00:00:00+00:00' }),
  ];

  test('S1 -> S2 sets section_id and persists the order', async () => {
    const { card, hass } = await setup({ tasks: base() });
    await drop(card, 'A', 'S2');

    const updates = callsOf(hass, 'home_tasks/update_task');
    assert.equal(updates.length, 1);
    assert.deepEqual(
      { list_id: updates[0].list_id, task_id: updates[0].task_id, section_id: updates[0].section_id },
      { list_id: 'L1', task_id: 'A', section_id: 'S2' });
    assert.equal('completed' in updates[0], false);
    const reorder = callsOf(hass, 'home_tasks/reorder_tasks');
    assert.equal(reorder.length, 1);
    assert.deepEqual([...reorder[0].task_ids].sort(), ['A', 'B', 'D']);
    assert.ok(reorder[0].task_ids.indexOf('B') < reorder[0].task_ids.indexOf('A'),
      'A was dropped after B in S2');
  });

  test('a drop into No section / Open sends section_id null', async () => {
    const { card, hass } = await setup({ tasks: [...base(), task('X')] });
    await drop(card, 'A', '');
    const updates = callsOf(hass, 'home_tasks/update_task');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].task_id, 'A');
    assert.equal(updates[0].section_id, null);
  });

  test('a drop in the same lane only reorders', async () => {
    const { card, hass } = await setup({ tasks: [task('A', { section_id: 'S1' }), task('C', { section_id: 'S1' })] });
    card._boardDragStart('A', 0);
    laneBody(card, 'S1').appendChild(card.shadowRoot.querySelector('.board .task[data-task-id="A"]'));
    await card._finishBoardDrag();
    await flush();
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
    const reorder = callsOf(hass, 'home_tasks/reorder_tasks');
    assert.equal(reorder.length, 1);
    assert.deepEqual([...reorder[0].task_ids], ['C', 'A']);
  });

  test('open lane -> Done completes the task and leaves its section alone', async () => {
    const { card, hass } = await setup({ tasks: base() });
    await drop(card, 'A', '__done__');

    const updates = callsOf(hass, 'home_tasks/update_task');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].task_id, 'A');
    assert.equal(updates[0].completed, true);
    assert.equal('section_id' in updates[0], false);
    assert.equal(callsOf(hass, 'home_tasks/reorder_tasks').length, 0);
  });

  test('confirm_complete: a cancelled prompt completes nothing and restores the board', async () => {
    const { card, hass } = await setup({ col: { confirm_complete: true }, tasks: base() });
    let asked = 0;
    card._confirmDialog = async () => { asked++; return false; };
    await drop(card, 'A', '__done__');

    assert.equal(asked, 1);
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
    assert.deepEqual(cardIds(card, 'S1'), ['A'], 'the card is back in its lane');
    assert.deepEqual(cardIds(card, '__done__'), ['D']);
  });

  test('confirm_complete: a confirmed prompt completes the task', async () => {
    const { card, hass } = await setup({ col: { confirm_complete: true }, tasks: base() });
    card._confirmDialog = async () => true;
    await drop(card, 'A', '__done__');
    const updates = callsOf(hass, 'home_tasks/update_task');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].completed, true);
  });

  test('auto_delete_completed: a drop on Done deletes the task like the checkbox', async () => {
    const { card, hass } = await setup({ col: { auto_delete_completed: true }, tasks: base() });
    await drop(card, 'A', '__done__');
    await new Promise((r) => setTimeout(r, 400));  // the exit animation runs first
    const deletes = callsOf(hass, 'home_tasks/delete_task');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].task_id, 'A');
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
  });

  test('Done -> S1 sets the section first, then reopens', async () => {
    const { card, hass } = await setup({ tasks: [...base(), task('E', { completed: true, section_id: 'S2' })] });
    await drop(card, 'E', 'S1');

    const updates = callsOf(hass, 'home_tasks/update_task');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].task_id, 'E');
    assert.equal(updates[0].section_id, 'S1');
    assert.equal('completed' in updates[0], false);
    assert.equal(updates[1].task_id, 'E');
    assert.equal(updates[1].completed, false);
    assert.equal('section_id' in updates[1], false);
  });

  test('Done -> Done and a drag that ends outside any lane save nothing', async () => {
    const { card, hass } = await setup({ tasks: [...base(), task('E', { completed: true })] });
    await drop(card, 'E', '__done__');
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
    assert.equal(callsOf(hass, 'home_tasks/reorder_tasks').length, 0);

    // Dropped outside the board: the card is not in a lane body any more.
    card._boardDragStart('A', 0);
    card.shadowRoot.querySelector('.board .task[data-task-id="A"]').remove();
    await card._finishBoardDrag();
    await flush();
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
    assert.deepEqual(cardIds(card, 'S1'), ['A'], 'the board was rebuilt');
  });

  test('a cancelled drag (dragend without a drop) puts the card back', async () => {
    const { card, hass } = await setup({ tasks: base() });
    card._boardDragStart('A', 0);
    moveCard(card, 'A', 'S2');
    await card._finishBoardDrag({ cancel: true });
    await flush();
    assert.equal(callsOf(hass, 'home_tasks/update_task').length, 0);
    assert.deepEqual(cardIds(card, 'S1'), ['A']);
  });

  test('the drag state is cleared and a render deferred during the drag runs after it', async () => {
    const { card } = await setup({ tasks: base() });
    card._boardDragStart('A', 0);
    assert.equal(card._draggedTaskId, 'A');
    assert.equal(card._boardDragColIdx, 0);
    assert.equal(card._boardDragOrigin.completed, false);
    assert.equal(card._boardDragOrigin.sectionId, 'S1');

    // A background update during the drag must not rebuild the board.
    const board = card.shadowRoot.querySelector('.board');
    card._bgUpdates = 1;
    card._render();
    card._bgUpdates = 0;
    assert.equal(card._pendingRender, true);
    assert.equal(card.shadowRoot.querySelector('.board'), board);

    await card._finishBoardDrag();
    assert.equal(card._draggedTaskId, null);
    assert.equal(card._boardDragColIdx, null);
    assert.equal(card._boardDragOrigin, null);
    assert.notEqual(card.shadowRoot.querySelector('.board'), board, 'deferred render ran');
  });

  test('_boardDragOver moves the card into the lane under the pointer and marks it', async () => {
    const { card } = await setup({ tasks: base() });
    card._boardDragStart('A', 0);
    // No layout in jsdom: every midpoint is 0, so a pointer at y = 10 lands at the end.
    card._boardDragOver(laneBody(card, 'S2'), 10, 0);
    assert.deepEqual(cardIds(card, 'S2'), ['B', 'A']);
    assert.ok(lane(card, 'S2').classList.contains('drop-target'));

    card._boardDragOver(lane(card, '__done__'), 10, 0);
    assert.ok(lane(card, '__done__').classList.contains('drop-target'));
    assert.ok(!lane(card, 'S2').classList.contains('drop-target'));
    assert.ok(cardIds(card, '__done__').includes('A'));

    // Over something that is not in this board: nothing moves.
    card._boardDragOver(card.shadowRoot.querySelector('.title') || card.shadowRoot.host, 10, 0);
    await card._finishBoardDrag({ cancel: true });
  });
});


describe('per-lane add', () => {
  const open = async (card, id) => {
    lane(card, id).querySelector('.board-add-btn').click();
    return lane(card, id).querySelector('.board-add-input');
  };
  const type = async (card, input, text) => {
    input.value = text;
    input.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.Event('input'));
    input.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
  };

  test('every open lane has an add button, Done does not', async () => {
    const { card } = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    assert.ok(lane(card, 'S1').querySelector('.board-add-btn'));
    assert.ok(lane(card, 'S2').querySelector('.board-add-btn'));
    assert.equal(lane(card, '__done__').querySelector('.board-add-btn'), null);
    assert.equal(lane(card, 'S1').querySelector('.board-add-btn').textContent, '+ Add a task');
  });

  test('opening, typing and Enter sends add_task with the lane section_id and stays open', async () => {
    const { card, hass } = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    const input = await open(card, 'S1');
    assert.ok(input, 'the button turns into an input');
    assert.ok(card._boardAddOpen.has('0:S1'));
    assert.equal(input.dataset.focusKey, 'board_add_0_S1');

    await type(card, input, 'Buy milk');
    const adds = callsOf(hass, 'home_tasks/add_task');
    assert.equal(adds.length, 1);
    assert.deepEqual({ ...adds[0] }, { type: 'home_tasks/add_task', list_id: 'L1', title: 'Buy milk', section_id: 'S1' });

    const again = lane(card, 'S1').querySelector('.board-add-input');
    assert.ok(again, 'still open after the reload, ready for the next entry');
    assert.equal(again.value, '');
  });

  test('the Open / No section lane sends no section_id', async () => {
    const { card, hass } = await setup({ sections: [], tasks: [task('A')] });
    const input = await open(card, '');
    await type(card, input, 'Plain');
    const adds = callsOf(hass, 'home_tasks/add_task');
    assert.equal(adds.length, 1);
    assert.equal('section_id' in adds[0], false);
    assert.equal(adds[0].title, 'Plain');
  });

  test('a single active person chip is assigned, like the main add row', async () => {
    const { card, hass } = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    card._columns[0].personFilters = new Set(['person.anna']);
    const input = await open(card, 'S2');
    await type(card, input, 'For Anna');
    assert.equal(callsOf(hass, 'home_tasks/add_task')[0].assigned_person, 'person.anna');
  });

  test('Escape and the close button close the input; an empty Enter adds nothing', async () => {
    const { card, hass } = await setup({ tasks: [task('A', { section_id: 'S1' })] });
    let input = await open(card, 'S1');
    await type(card, input, '   ');
    assert.equal(callsOf(hass, 'home_tasks/add_task').length, 0);

    input.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(lane(card, 'S1').querySelector('.board-add-input'), null);
    assert.ok(lane(card, 'S1').querySelector('.board-add-btn'));
    assert.ok(!card._boardAddOpen.has('0:S1'));

    input = await open(card, 'S1');
    lane(card, 'S1').querySelector('.board-add-close').click();
    assert.equal(lane(card, 'S1').querySelector('.board-add-input'), null);
  });

  test('a refused add keeps the text and shows the error', async () => {
    const { card, hass } = await setup({
      tasks: [task('A', { section_id: 'S1' })],
      responses: { 'home_tasks/add_task': () => { throw new Error('nope'); } },
    });
    const input = await open(card, 'S1');
    await type(card, input, 'Will fail');
    assert.equal(callsOf(hass, 'home_tasks/add_task').length, 1);
    assert.ok(card.shadowRoot.querySelector('.toast-error'));
    assert.equal(card._boardAddText.get('0:S1'), 'Will fail');
  });

  test('no add button on an external column, with board_add_per_lane: false or show_add_task: false', async () => {
    const { HomeTasksCard } = await freshCard();
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [] },
      'home_tasks/get_external_lists': { external_lists: [{ entity_id: 'todo.x', name: 'X', linked: true, supported_features: 0, capabilities: {} }] },
      'home_tasks/get_external_tasks': { tasks: [task('A', { section_id: 'S1', _external: true })], sections: SECTIONS },
    });
    const ext = new HomeTasksCard();
    ext.setConfig({ columns: [{ entity_id: 'todo.x', view_mode: 'board' }] });
    ext.hass = hass;
    await flush();
    assert.deepEqual(laneIds(ext), ['S1', 'S2', '__done__'], 'the board itself still renders');
    assert.equal(ext.shadowRoot.querySelector('.board-add-btn'), null);

    const off = await setup({ col: { board_add_per_lane: false }, tasks: [task('A', { section_id: 'S1' })] });
    assert.equal(off.card.shadowRoot.querySelector('.board-add-btn'), null);

    const noAdd = await setup({ col: { show_add_task: false }, tasks: [task('A', { section_id: 'S1' })] });
    assert.equal(noAdd.card.shadowRoot.querySelector('.board-add-btn'), null);
    assert.equal(noAdd.card.shadowRoot.querySelector('.add-task'), null);
  });
});


describe('editor', () => {
  async function editor(colExtra = {}) {
    const { window } = await loadCard({ force: true });
    const Editor = window.customElements.get('home-tasks-card-editor');
    const ed = new Editor();
    ed.hass = makeMockHass({
      callWS: async (m) => {
        if (m.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Household' }] };
        if (m.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    });
    ed.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    window.document.body.appendChild(ed);
    await new Promise((r) => setTimeout(r, 150));
    const changes = [];
    ed.addEventListener('config-changed', (e) => changes.push(e.detail.config));
    return { ed, changes, window };
  }
  const viewSelect = (ed) => [...ed.shadowRoot.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'tiles'));
  const toggleLabels = (ed) => [...ed.shadowRoot.querySelectorAll('.toggle-label')].map((e) => e.textContent);

  test('the view mode select offers board', async () => {
    const { ed } = await editor();
    const sel = viewSelect(ed);
    assert.deepEqual([...sel.options].map((o) => o.value), ['list', 'tiles', 'board']);
    assert.equal([...sel.options].find((o) => o.value === 'board').textContent, 'Board');
    assert.ok(!toggleLabels(ed).includes('Done column'), 'board options only show for a board');
  });

  test('picking board writes view_mode and shows the hint and the two toggles', async () => {
    const { ed, changes, window } = await editor();
    const sel = viewSelect(ed);
    sel.value = 'board';
    sel.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).columns[0].view_mode, 'board');

    const labels = toggleLabels(ed);
    assert.ok(labels.includes('Done column'));
    assert.ok(labels.includes('Add button in each column'));
    const hints = [...ed.shadowRoot.querySelectorAll('.hint')].map((e) => e.textContent);
    assert.ok(hints.some((h) => h.startsWith('Board: sections become columns')));
  });

  test('the toggles write board_done_column and board_add_per_lane (default on)', async () => {
    const { ed, changes, window } = await editor({ view_mode: 'board' });
    const rows = [...ed.shadowRoot.querySelectorAll('.toggle-row')];
    const row = (label) => rows.find((r) => r.querySelector('.toggle-label').textContent === label);
    const doneSw = row('Done column').querySelector('ha-switch');
    const addSw = row('Add button in each column').querySelector('ha-switch');
    assert.equal(doneSw.checked, true);
    assert.equal(addSw.checked, true);

    doneSw.checked = false;
    doneSw.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).columns[0].board_done_column, false);
    addSw.checked = false;
    addSw.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).columns[0].board_add_per_lane, false);
  });
});
