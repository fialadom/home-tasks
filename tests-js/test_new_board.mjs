/**
 * "+" after the last tab (layout: tabs): creates a list through
 * home_tasks/create_list, appends a column for it to this card's config in the
 * storage-mode dashboard (lovelace.saveConfig) and switches to the new tab.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';


async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function freshCard() {
  const loaded = await loadCard({ force: true });
  if (!loaded.window.CSS) {
    loaded.window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, '\\$&') };
  }
  return loaded;
}

const task = (id, extra = {}) => ({
  id, title: `Task ${id}`, completed: false, sort_order: 0, sub_items: [], ...extra,
});

const LISTS = [{ id: 'L1', name: 'Household' }, { id: 'L2', name: 'Homelab' }];
const TASKS = { L1: [task('A1')], L2: [task('B1')] };
const SECTIONS = {
  L1: [],
  // deliberately out of order: the card sends them sorted by sort_order
  L2: [
    { id: 'S2', name: 'Done-ish', sort_order: 2 },
    { id: 'S1', name: 'Doing', sort_order: 1, icon: 'mdi:run' },
  ],
};

const COLS = [
  { list_id: 'L1', title: 'Domácnost' },
  { list_id: 'L2', title: 'Homelab', icon: 'mdi:server', view_mode: 'board', board_add_per_lane: false },
];
const CARD_CONFIG = { type: 'custom:home-tasks-card', layout: 'tabs', columns: COLS };
const OTHER_CARD = { type: 'markdown', content: 'untouched' };
const NEW_LIST = { id: 'L3', name: 'Projekty', task_count: 0 };

function makeDashboard(card = CARD_CONFIG) {
  return { views: [{ title: 'Home', sections: [{ cards: [OTHER_CARD, card] }] }] };
}

/**
 * Card inside a fake host that carries HA's `lovelace` object.
 * `createList` answers home_tasks/create_list (resolve or throw).
 */
async function setup({
  config = CARD_CONFIG, dashboard = makeDashboard(), lovelace = {}, user = { is_admin: true },
  preview = false, withHost = true, createList = async () => ({ list: NEW_LIST }),
} = {}) {
  const loaded = await freshCard();
  const { HomeTasksCard, window } = loaded;
  const saved = [];
  const wsCalls = [];
  const host = window.document.createElement('div');
  host.lovelace = {
    mode: 'storage', config: dashboard, rawConfig: dashboard,
    saveConfig: async (c) => { saved.push(c); },
    ...lovelace,
  };
  window.document.body.appendChild(host);
  const card = new HomeTasksCard();
  if (preview) card.preview = true;
  (withHost ? host : window.document.body).appendChild(card);
  card.setConfig(config);
  card.hass = makeMockHass({
    user,
    callWS: async (msg) => {
      wsCalls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: LISTS };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') {
        return { tasks: TASKS[msg.list_id] || [], sections: SECTIONS[msg.list_id] || [], tag_catalog: [] };
      }
      if (msg.type === 'home_tasks/create_list') return createList(msg);
      return null;
    },
  });
  await flush();
  return { card, window, host, saved, wsCalls, HomeTasksCard };
}

// Objects built inside the jsdom realm have its Array/Object prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));
const root = (card) => card.shadowRoot;
const addBtn = (card) => root(card).querySelector('.list-tab-add');
const form = (card) => root(card).querySelector('.new-board-form');
const tabs = (card) => [...root(card).querySelectorAll('.list-tabs > button.list-tab')];
const errorText = (card) => root(card).querySelector('.new-board-error')?.textContent;
const createCalls = (wsCalls) => wsCalls.filter((m) => m.type === 'home_tasks/create_list');

async function openAndType(card, window, name, template) {
  addBtn(card).click();
  await flush();
  const input = root(card).querySelector('input.new-board-name');
  input.value = name;
  input.dispatchEvent(new window.Event('input'));
  if (template !== undefined) {
    const sel = root(card).querySelector('select.new-board-template');
    sel.value = template;
    sel.dispatchEvent(new window.Event('change'));
  }
}

async function submit(card) {
  root(card).querySelector('button.new-board-create').click();
  await flush();
}

describe('visibility of the + button', () => {
  test('admin + tabs + 2 columns + storage dashboard: one + after the last tab', async () => {
    const { card } = await setup();
    const bar = root(card).querySelector('.list-tabs');
    assert.equal(bar.querySelectorAll('.list-tab-add').length, 1);
    assert.equal(bar.lastElementChild, addBtn(card));
    assert.equal(addBtn(card).getAttribute('aria-label'), 'New board');
    assert.equal(addBtn(card).title, 'New board');
    assert.ok(addBtn(card).querySelector('ha-icon[icon="mdi:plus"]'));
    assert.equal(addBtn(card).getAttribute('role'), null);
    assert.equal(tabs(card).length, 2, '+ is not a tab');
  });

  const cases = {
    'not admin': { user: { is_admin: false } },
    'no user': { user: null },
    'tab_add false': { config: { ...CARD_CONFIG, tab_add: false }, dashboard: makeDashboard({ ...CARD_CONFIG, tab_add: false }) },
    'layout not tabs': { config: { ...CARD_CONFIG, layout: 'columns' } },
    'one column': { config: { ...CARD_CONFIG, columns: [COLS[0]] } },
    'editor preview': { preview: true },
    'no lovelace ancestor': { withHost: false },
    'yaml dashboard': { lovelace: { mode: 'yaml' } },
  };
  for (const [name, opts] of Object.entries(cases)) {
    test(`no + when ${name}`, async () => {
      const { card } = await setup(opts);
      assert.equal(addBtn(card), null);
      assert.equal(form(card), null);
    });
  }
});

describe('form', () => {
  test('opens with a focused name input and a template select, Escape closes it', async () => {
    const { card, window } = await setup();
    addBtn(card).click();
    await flush();
    assert.ok(form(card));
    assert.ok(addBtn(card).classList.contains('active'));
    const input = root(card).querySelector('input.new-board-name');
    assert.equal(input.getAttribute('maxlength'), '100');
    assert.equal(input.getAttribute('data-focus-key'), 'new_board_name');
    const sel = root(card).querySelector('select.new-board-template');
    assert.deepEqual([...sel.options].map((o) => o.textContent), ['Domácnost', 'Homelab', 'None']);
    assert.deepEqual([...sel.options].map((o) => o.value), ['0', '1', '']);
    assert.equal(sel.value, '0', 'defaults to the active tab');
    assert.ok(root(card).querySelector('.new-board-error[role="alert"]'));
    // form sits between the tab bar and the column
    assert.equal(root(card).querySelector('.list-tabs').nextElementSibling, form(card));

    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    assert.equal(form(card), null);
    assert.ok(!addBtn(card).classList.contains('active'));
  });

  test('the typed name survives a background re-render', async () => {
    const { card, window } = await setup();
    await openAndType(card, window, 'Half typed');
    card._render();
    await flush();
    assert.equal(root(card).querySelector('input.new-board-name').value, 'Half typed');
  });
});

describe('create', () => {
  test('with a template: copies sections, adds the column, saves the dashboard, switches tab', async () => {
    const { card, window, saved, wsCalls } = await setup();
    await openAndType(card, window, '  Projekty ', '1');
    await submit(card);

    const calls = createCalls(wsCalls);
    assert.equal(calls.length, 1);
    assert.deepEqual(plain(calls[0]), {
      type: 'home_tasks/create_list',
      name: 'Projekty',
      sections: [{ name: 'Doing', icon: 'mdi:run' }, { name: 'Done-ish' }],
    });

    assert.equal(saved.length, 1);
    const cards = saved[0].views[0].sections[0].cards;
    assert.deepEqual(plain(cards[0]), OTHER_CARD, 'unrelated card untouched');
    assert.equal(cards[1].columns.length, 3);
    assert.deepEqual(plain(cards[1].columns[2]), { list_id: 'L3', view_mode: 'board', board_add_per_lane: false });
    assert.deepEqual(plain(cards[1].columns.slice(0, 2)), COLS);
    assert.equal(cards[1].layout, 'tabs');

    // active index stored under the key of the new set of lists
    assert.equal(window.localStorage.getItem('home_tasks_card:active_tab:native:L1,native:L2,native:L3'), '2');

    // card shows 3 tabs, the new one active and named after the list
    assert.equal(form(card), null);
    const t = tabs(card);
    assert.equal(t.length, 3);
    assert.equal(t[2].getAttribute('aria-selected'), 'true');
    assert.ok(t[2].textContent.includes('Projekty'));
  });

  test('template None: no sections and a bare board column', async () => {
    const { card, window, saved, wsCalls } = await setup();
    await openAndType(card, window, 'Projekty', '');
    await submit(card);
    assert.deepEqual(plain(createCalls(wsCalls)[0].sections), []);
    const col = saved[0].views[0].sections[0].cards[1].columns[2];
    assert.deepEqual(plain(col), { list_id: 'L3', view_mode: 'board' });
  });

  test('empty name: message, no WS call', async () => {
    const { card, window, saved, wsCalls } = await setup();
    await openAndType(card, window, '   ');
    await submit(card);
    assert.equal(errorText(card), 'Enter a name for the board.');
    assert.equal(createCalls(wsCalls).length, 0);
    assert.equal(saved.length, 0);
  });

  test('duplicate name: message, form stays open, dashboard not saved', async () => {
    const { card, window, saved } = await setup({
      createList: async () => { throw { code: 'duplicate_name', message: 'x' }; },
    });
    await openAndType(card, window, 'Homelab');
    await submit(card);
    assert.equal(errorText(card), 'A list with this name already exists.');
    assert.ok(form(card));
    assert.equal(root(card).querySelector('input.new-board-name').value, 'Homelab');
    assert.equal(root(card).querySelector('button.new-board-create').disabled, false);
    assert.equal(saved.length, 0);
  });

  test('card not found in the dashboard: error and no create_list call', async () => {
    const { card, window, saved, wsCalls } = await setup({
      dashboard: makeDashboard({ type: 'custom:home-tasks-card', columns: [{ list_id: 'Other' }] }),
    });
    await openAndType(card, window, 'Projekty');
    await submit(card);
    assert.match(errorText(card), /not found in the dashboard configuration/);
    assert.equal(createCalls(wsCalls).length, 0);
    assert.equal(saved.length, 0);
  });

  test('saveConfig rejects: save error shown', async () => {
    const { card, window } = await setup({
      lovelace: { saveConfig: async () => { throw new Error('nope'); } },
    });
    await openAndType(card, window, 'Projekty');
    await submit(card);
    assert.match(errorText(card), /list was created but could not be added/);
    assert.ok(form(card));
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
  const toggleRow = (ed, label) => [...ed.shadowRoot.querySelectorAll('.toggle-row')]
    .find((r) => r.querySelector('.toggle-label').textContent === label);

  test('tab_add switch: only with tabs, default on, unchecking stores false', async () => {
    const plain = await editor();
    assert.equal(toggleRow(plain.ed, '+ button for a new board'), undefined);

    const { ed, changes, window } = await editor({ layout: 'tabs' });
    const sw = toggleRow(ed, '+ button for a new board').querySelector('ha-switch');
    assert.equal(sw.checked, true);
    sw.checked = false;
    sw.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).tab_add, false);
    assert.equal(changes.at(-1).layout, 'tabs');
  });
});
