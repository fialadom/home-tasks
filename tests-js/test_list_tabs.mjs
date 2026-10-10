/**
 * layout: tabs - several lists on one card as tabs. Only the active column is
 * rendered; every column keeps loading, so the counts are live. The active tab
 * is remembered in localStorage per set of lists.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';


async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// jsdom has no CSS.escape, which the card uses to look elements up by id.
async function freshCard() {
  const loaded = await loadCard({ force: true });
  if (!loaded.window.CSS) {
    loaded.window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, '\\$&') };
  }
  return loaded;
}

const task = (id, extra = {}) => ({
  id, title: `Task ${id}`, completed: false, sort_order: 0, sub_items: [], ...extra,
});

const LISTS = [{ id: 'L1', name: 'Household' }, { id: 'L2', name: 'Homelab' }];
const TASKS = {
  L1: [task('A1'), task('A2'), task('A3', { completed: true })],
  L2: [task('B1')],
};
const SECTIONS = {
  L1: [],
  L2: [{ id: 'S1', name: 'Doing', sort_order: 0 }],
};

function makeHass() {
  return makeMockHass({
    callWS: async (msg) => {
      if (msg.type === 'home_tasks/get_lists') return { lists: LISTS };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') {
        return { tasks: TASKS[msg.list_id] || [], sections: SECTIONS[msg.list_id] || [], tag_catalog: [] };
      }
      return null;
    },
  });
}

const COLS = [
  { list_id: 'L1', title: 'Domácnost' },
  { list_id: 'L2', title: 'Homelab' },
];

/** Card over two native lists; `config` extends the card config, `Card` reuses a loaded class. */
async function setup({ config = {}, columns = COLS, loaded = null } = {}) {
  const { HomeTasksCard, window } = loaded || await freshCard();
  const card = new HomeTasksCard();
  card.setConfig({ columns, ...config });
  card.hass = makeHass();
  await flush();
  return { card, window, HomeTasksCard };
}

const root = (card) => card.shadowRoot;
const tabs = (card) => [...root(card).querySelectorAll('.list-tabs > button.list-tab')];
const columns = (card) => [...root(card).querySelectorAll('.card-column')];
const taskIds = (card) => [...root(card).querySelectorAll('.task[data-task-id]')].map((el) => el.dataset.taskId);
const STORE_PREFIX = 'home_tasks_card:active_tab:';


describe('layout', () => {
  test('without layout both columns render side by side and there is no tab bar', async () => {
    const { card } = await setup();
    const multi = root(card).querySelectorAll('.multi-columns');
    assert.equal(multi.length, 1);
    assert.equal(multi[0].querySelectorAll(':scope > .card-column').length, 2);
    assert.equal(root(card).querySelector('.list-tabs'), null);
  });

  test('layout "columns" is the same as no layout', async () => {
    const { card } = await setup({ config: { layout: 'columns', tab_counts: false } });
    assert.equal(root(card).querySelectorAll('.multi-columns > .card-column').length, 2);
    assert.equal(root(card).querySelector('.list-tabs'), null);
  });

  test('tabs: one tab bar with a button per column and a single column in the DOM', async () => {
    const { card } = await setup({ config: { layout: 'tabs' } });
    assert.equal(root(card).querySelectorAll('.list-tabs').length, 1);
    assert.equal(root(card).querySelector('.list-tabs').getAttribute('role'), 'tablist');
    const t = tabs(card);
    assert.equal(t.length, 2);
    assert.ok(t.every((b) => b.getAttribute('role') === 'tab'));
    assert.ok(t[0].textContent.includes('Domácnost'));
    assert.ok(t[1].textContent.includes('Homelab'));
    assert.equal(columns(card).length, 1);
    assert.equal(root(card).querySelector('.multi-columns'), null);
    assert.deepEqual(taskIds(card).sort(), ['A1', 'A2', 'A3']);
  });

  test('the label falls back to the list name and shows the icon before the text', async () => {
    const { card } = await setup({
      config: { layout: 'tabs' },
      columns: [{ list_id: 'L1', icon: 'mdi:home' }, { list_id: 'L2' }],
    });
    const t = tabs(card);
    assert.ok(t[0].textContent.includes('Household'));
    assert.ok(t[1].textContent.includes('Homelab'));
    assert.equal(t[0].firstElementChild.tagName.toLowerCase(), 'ha-icon');
    assert.equal(t[0].firstElementChild.getAttribute('icon'), 'mdi:home');
    assert.equal(t[1].querySelector('ha-icon'), null);
  });

  test('the card title is rendered above the tab bar', async () => {
    const { card } = await setup({ config: { layout: 'tabs', title: 'Home' } });
    const title = root(card).querySelector('h1.card-global-title');
    assert.equal(title.textContent, 'Home');
    assert.equal(title.nextElementSibling.className, 'list-tabs');
  });

  test('a single column renders as before, without a tab bar', async () => {
    const { card } = await setup({ config: { layout: 'tabs' }, columns: [COLS[0]] });
    assert.equal(root(card).querySelector('.list-tabs'), null);
    assert.equal(columns(card).length, 1);
    assert.deepEqual(taskIds(card).sort(), ['A1', 'A2', 'A3']);
  });
});


describe('counts', () => {
  const counts = (card) => tabs(card).map((b) => b.querySelector('.list-tab-count')?.textContent ?? null);

  test('each tab shows the number of open tasks of its list', async () => {
    const { card } = await setup({ config: { layout: 'tabs' } });
    assert.deepEqual(counts(card), ['2', '1']);
  });

  test('tab_counts: false hides the badges', async () => {
    const { card } = await setup({ config: { layout: 'tabs', tab_counts: false } });
    assert.equal(root(card).querySelectorAll('.list-tab-count').length, 0);
  });
});


describe('switching and persistence', () => {
  test('clicking tab 2 shows only its list, marks it selected and stores the index', async () => {
    const { card, window } = await setup({ config: { layout: 'tabs' } });
    assert.equal(tabs(card)[0].getAttribute('aria-selected'), 'true');
    assert.ok(tabs(card)[0].classList.contains('active'));

    tabs(card)[1].click();
    assert.equal(columns(card).length, 1);
    assert.deepEqual(taskIds(card), ['B1']);
    assert.equal(tabs(card)[0].getAttribute('aria-selected'), 'false');
    assert.equal(tabs(card)[1].getAttribute('aria-selected'), 'true');
    assert.ok(tabs(card)[1].classList.contains('active'));
    assert.ok(!tabs(card)[0].classList.contains('active'));
    assert.equal(window.localStorage.getItem(`${STORE_PREFIX}native:L1,native:L2`), '1');
  });

  test('a new card with the same config starts on the stored tab', async () => {
    const first = await setup({ config: { layout: 'tabs' } });
    tabs(first.card)[1].click();

    const second = await setup({ config: { layout: 'tabs' }, loaded: first });
    assert.equal(tabs(second.card)[1].getAttribute('aria-selected'), 'true');
    assert.deepEqual(taskIds(second.card), ['B1']);
  });

  test('a stored index out of range falls back to tab 0', async () => {
    const loaded = await freshCard();
    loaded.window.localStorage.setItem(`${STORE_PREFIX}native:L1,native:L2`, '7');
    const { card } = await setup({ config: { layout: 'tabs' }, loaded });
    assert.equal(tabs(card)[0].getAttribute('aria-selected'), 'true');
    assert.deepEqual(taskIds(card).sort(), ['A1', 'A2', 'A3']);

    loaded.window.localStorage.setItem(`${STORE_PREFIX}native:L1,native:L2`, 'junk');
    const again = await setup({ config: { layout: 'tabs' }, loaded });
    assert.equal(tabs(again.card)[0].getAttribute('aria-selected'), 'true');
  });

  test('removing a column keeps the active tab valid', async () => {
    const { card } = await setup({ config: { layout: 'tabs' } });
    tabs(card)[1].click();
    card.setConfig({ layout: 'tabs', columns: [COLS[0]] });
    await flush();
    assert.equal(root(card).querySelector('.list-tabs'), null);
    assert.deepEqual(taskIds(card).sort(), ['A1', 'A2', 'A3']);
  });

  test('each tab keeps its own view mode', async () => {
    const { card } = await setup({
      config: { layout: 'tabs' },
      columns: [{ ...COLS[0], view_mode: 'board' }, COLS[1]],
    });
    assert.ok(root(card).querySelector('.board'), 'tab 1 is a board');
    assert.equal(root(card).querySelector('.card-column').classList.contains('board-mode'), true);

    tabs(card)[1].click();
    assert.equal(root(card).querySelector('.board'), null);
    assert.equal(root(card).querySelector('.card-column').classList.contains('board-mode'), false);
    assert.ok(root(card).querySelector('.task-list'));

    tabs(card)[0].click();
    assert.ok(root(card).querySelector('.board'));
  });

  test('a board on the second tab renders its lanes', async () => {
    const { card } = await setup({
      config: { layout: 'tabs' },
      columns: [COLS[0], { ...COLS[1], view_mode: 'board' }],
    });
    assert.equal(root(card).querySelector('.board'), null);
    tabs(card)[1].click();
    const lanes = [...root(card).querySelectorAll('.board > .board-lane')].map((l) => l.dataset.sectionId);
    // B1 has no section, so the No section lane leads.
    assert.deepEqual(lanes, ['', 'S1', '__done__']);
  });

  test('state of the hidden column survives a switch', async () => {
    const { card } = await setup({ config: { layout: 'tabs' } });
    card._columns[0].taskSearchQuery = 'A2';
    card._render();
    assert.deepEqual(taskIds(card), ['A2']);
    tabs(card)[1].click();
    tabs(card)[0].click();
    assert.deepEqual(taskIds(card), ['A2']);
  });

  test('column code that targets the hidden column does not throw', async () => {
    const { card } = await setup({
      config: { layout: 'tabs' },
      columns: [COLS[0], { ...COLS[1], view_mode: 'board' }],
    });
    // Column 1 is not in the DOM.
    assert.doesNotThrow(() => card._refreshTaskListDOM(1));
    assert.doesNotThrow(() => card._captureListFlip(1));
    assert.doesNotThrow(() => card._applyFlip(new Map([['B1', { top: 0, left: 0 }]]), 1));
    assert.doesNotThrow(() => card._restoreBoardScroll(1));
    assert.doesNotThrow(() => card._finishDrag());
    assert.equal(card._getOrderFromDom(1).length, 0);
    // _refreshTaskListDOM fell back to a full render of the active tab.
    assert.equal(columns(card).length, 1);
  });
});


describe('keyboard', () => {
  const press = (window, tab, key) =>
    tab.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  test('ArrowRight activates the next tab and wraps from the last to the first', async () => {
    const { card, window } = await setup({ config: { layout: 'tabs' } });
    window.document.body.appendChild(card); // focus needs a connected card
    tabs(card)[0].focus();
    press(window, tabs(card)[0], 'ArrowRight');
    assert.equal(tabs(card)[1].getAttribute('aria-selected'), 'true');
    assert.deepEqual(taskIds(card), ['B1']);
    assert.equal(root(card).activeElement, tabs(card)[1], 'focus follows the selection');

    press(window, tabs(card)[1], 'ArrowRight');
    assert.equal(tabs(card)[0].getAttribute('aria-selected'), 'true');
    assert.deepEqual(taskIds(card).sort(), ['A1', 'A2', 'A3']);
  });

  test('ArrowLeft goes back and wraps from the first to the last', async () => {
    const { card, window } = await setup({ config: { layout: 'tabs' } });
    press(window, tabs(card)[0], 'ArrowLeft');
    assert.equal(tabs(card)[1].getAttribute('aria-selected'), 'true');
    press(window, tabs(card)[1], 'ArrowLeft');
    assert.equal(tabs(card)[0].getAttribute('aria-selected'), 'true');
  });
});


describe('editor', () => {
  async function editor(config = {}) {
    const { window } = await loadCard({ force: true });
    const Editor = window.customElements.get('home-tasks-card-editor');
    const ed = new Editor();
    ed.hass = makeMockHass({
      callWS: async (m) => {
        if (m.type === 'home_tasks/get_lists') return { lists: LISTS };
        if (m.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    });
    ed.setConfig({ columns: [{ list_id: 'L1' }, { list_id: 'L2' }], ...config });
    window.document.body.appendChild(ed);
    await new Promise((r) => setTimeout(r, 150));
    const changes = [];
    ed.addEventListener('config-changed', (e) => changes.push(e.detail.config));
    return { ed, changes, window };
  }
  const layoutSelect = (ed) => [...ed.shadowRoot.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'tabs'));
  const toggleRow = (ed, label) => [...ed.shadowRoot.querySelectorAll('.toggle-row')]
    .find((r) => r.querySelector('.toggle-label').textContent === label);
  const choose = (sel, window, value) => {
    sel.value = value;
    sel.dispatchEvent(new window.Event('change'));
  };

  test('the layout select offers columns and tabs, columns by default', async () => {
    const { ed } = await editor();
    const sel = layoutSelect(ed);
    assert.ok(sel, 'layout select exists');
    assert.deepEqual([...sel.options].map((o) => o.value), ['columns', 'tabs']);
    assert.deepEqual([...sel.options].map((o) => o.textContent), ['Columns side by side', 'Tabs']);
    assert.equal(sel.value, 'columns');
    assert.equal(toggleRow(ed, 'Task count in tabs'), undefined);
  });

  test('choosing tabs fires config-changed with layout: tabs and shows the counts toggle', async () => {
    const { ed, changes, window } = await editor();
    choose(layoutSelect(ed), window, 'tabs');
    assert.equal(changes.at(-1).layout, 'tabs');
    assert.equal(changes.at(-1).columns.length, 2);

    const sw = toggleRow(ed, 'Task count in tabs').querySelector('ha-switch');
    assert.equal(sw.checked, true, 'counts default on');
    sw.checked = false;
    sw.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).tab_counts, false);
    assert.equal(changes.at(-1).layout, 'tabs');
  });

  test('choosing columns removes the key', async () => {
    const { ed, changes, window } = await editor({ layout: 'tabs' });
    assert.equal(layoutSelect(ed).value, 'tabs');
    choose(layoutSelect(ed), window, 'columns');
    assert.ok(!('layout' in changes.at(-1)), 'layout key is deleted');
    assert.equal(toggleRow(ed, 'Task count in tabs'), undefined);
  });
});
