/**
 * The Unassigned chip in the person filter row: it shows the tasks nobody is
 * assigned to, combines with the person chips as OR, and never gets in the
 * way of the auto-assign for new tasks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, ...over,
});

const TASKS = [
  TASK({ id: 'A1', title: 'A one', sort_order: 0, assigned_person: 'person.a' }),
  TASK({ id: 'B1', title: 'B one', sort_order: 1, assigned_person: 'person.b' }),
  TASK({ id: 'U1', title: 'Nobody one', sort_order: 2 }),
  TASK({ id: 'U2', title: 'Nobody two', sort_order: 3 }),
  // An external collaborator without an HA person counts as unassigned.
  TASK({ id: 'N1', title: 'Name only', sort_order: 4, assigned_name: 'Grandma' }),
];

const STATES = {
  'person.a': { attributes: { friendly_name: 'Anna' } },
  'person.b': { attributes: { friendly_name: 'Ben' } },
};

const SECTIONS = [
  { id: 'S1', name: 'First', sort_order: 0 },
  { id: 'S2', name: 'Second', sort_order: 1 },
];

function makeHass(tasks, sections = []) {
  const calls = [];
  return {
    language: 'en', states: STATES, auth: {}, calls,
    callWS: async (msg) => {
      calls.push(msg);
      switch (msg.type) {
        case 'home_tasks/get_lists': return { lists: [{ id: 'L1', name: 'Household' }] };
        case 'home_tasks/get_external_lists': return { external_lists: [] };
        case 'home_tasks/get_tasks': return { tasks: tasks.map((t) => ({ ...t })), sections, tag_catalog: [] };
        case 'home_tasks/add_task': return TASK({ id: 'NEW', title: msg.title });
        default: return null;
      }
    },
    callService: async () => null,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount({ col = {}, tasks = TASKS, sections = [] } = {}) {
  const loaded = await loadCard({ force: true });
  const { HomeTasksCard, window } = loaded;
  if (!window.CSS) {
    window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, '\\$&') };
  }
  const card = new HomeTasksCard();
  window.document.body.replaceChildren(card);
  card.setConfig({ columns: [{ list_id: 'L1', ...col }] });
  const hass = makeHass(tasks, sections);
  card.hass = hass;
  await flush();
  return { card, hass, window };
}

const chips = (card) => [...card.shadowRoot.querySelectorAll('.person-chip')];
const unassignedChip = (card) => card.shadowRoot.querySelector('.person-chip-unassigned');
const chipFor = (card, eid) => card.shadowRoot.querySelector(`.person-chip[data-eid="${eid}"]`);
const shownIds = (card) =>
  [...card.shadowRoot.querySelectorAll('.task[data-task-id]')].map((el) => el.dataset.taskId).sort();
// A filter change animates tasks out first and re-renders ~175 ms later.
const click = async (el) => { el.click(); await new Promise((r) => setTimeout(r, 260)); await flush(); };
const adds = (hass) => hass.calls.filter((c) => c.type === 'home_tasks/add_task');

describe('Unassigned chip', () => {
  test('sits last in the person row, after the person chips', async () => {
    const { card } = await mount();
    const all = chips(card);
    assert.deepEqual(all.map((c) => c.dataset.eid), ['person.a', 'person.b', '__unassigned__']);
    assert.equal(card.shadowRoot.querySelectorAll('.person-chip-unassigned').length, 1);
    const chip = unassignedChip(card);
    assert.equal(chip.getAttribute('aria-pressed'), 'false');
    assert.ok(chip.textContent.includes('Unassigned'));
    assert.ok(chip.querySelector('ha-icon'));
  });

  test('alone it shows only the tasks without a person, including a name-only one', async () => {
    const { card } = await mount();
    await click(unassignedChip(card));
    assert.deepEqual(shownIds(card), ['N1', 'U1', 'U2']);
    assert.equal(unassignedChip(card).getAttribute('aria-pressed'), 'true');
    assert.ok(unassignedChip(card).classList.contains('active'));
    await click(unassignedChip(card));
    assert.equal(shownIds(card).length, 5);
  });

  test('with a person it is an OR', async () => {
    const { card } = await mount();
    await click(chipFor(card, 'person.a'));
    assert.deepEqual(shownIds(card), ['A1']);
    await click(unassignedChip(card));
    assert.deepEqual(shownIds(card), ['A1', 'N1', 'U1', 'U2']);
  });

  test('no chip without an unassigned task; no row when everything is unassigned', async () => {
    const assignedOnly = await mount({ tasks: TASKS.filter((t) => t.assigned_person) });
    assert.equal(chips(assignedOnly.card).length, 2);
    assert.equal(unassignedChip(assignedOnly.card), null);

    const nobody = await mount({ tasks: TASKS.filter((t) => !t.assigned_person) });
    assert.equal(nobody.card.shadowRoot.querySelectorAll('.person-chip').length, 0);
    assert.equal(nobody.card.shadowRoot.querySelector('.person-chips'), null);
  });

  test('once active it stays, even when no unassigned task is left', async () => {
    const { card } = await mount();
    await click(unassignedChip(card));
    // A reload brings a list in which nobody is unassigned any more.
    card._columns[0].tasks = card._columns[0].tasks.filter((t) => t.assigned_person);
    card._render();
    await flush();
    const chip = unassignedChip(card);
    assert.ok(chip, 'an active filter must stay switchable');
    assert.ok(chip.classList.contains('active'));
    await click(chip);
    assert.equal(unassignedChip(card), null);
  });

  test('show_unassigned_filter: false and person_filter: off hide it', async () => {
    const off = await mount({ col: { show_unassigned_filter: false } });
    assert.equal(unassignedChip(off.card), null);
    assert.equal(chips(off.card).length, 2);

    const none = await mount({ col: { person_filter: 'off' } });
    assert.equal(none.card.shadowRoot.querySelectorAll('.person-chip').length, 0);
    assert.equal(none.card.shadowRoot.querySelector('.person-chips'), null);
  });

  test('picture mode is the icon alone with an accessible label', async () => {
    const { card } = await mount({ col: { person_filter: 'picture' } });
    const chip = unassignedChip(card);
    assert.ok(chip.classList.contains('avatar-only'));
    assert.ok(chip.querySelector('ha-icon'));
    assert.equal(chip.querySelector('span'), null);
    assert.equal(chip.textContent.trim(), '');
    assert.equal(chip.getAttribute('aria-label'), 'Unassigned');
    assert.equal(chip.title, 'Unassigned');
  });

  test('both mode keeps icon and text', async () => {
    const { card } = await mount({ col: { person_filter: 'both' } });
    const chip = unassignedChip(card);
    assert.ok(chip.classList.contains('with-avatar'));
    assert.ok(chip.querySelector('ha-icon'));
    assert.equal(chip.textContent.trim(), 'Unassigned');
  });
});

describe('adding with the Unassigned chip', () => {
  const addViaRow = async (card, window, text) => {
    const input = card.shadowRoot.querySelector('.add-input');
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flush();
    card.shadowRoot.querySelector('.add-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flush();
  };

  test('only Unassigned active: the new task is sent without assigned_person', async () => {
    const { card, hass, window } = await mount();
    await click(unassignedChip(card));
    await addViaRow(card, window, 'Fresh');
    assert.equal(adds(hass).length, 1);
    assert.equal('assigned_person' in adds(hass)[0], false);
  });

  test('only a person active: the task goes to that person, as before', async () => {
    const { card, hass, window } = await mount();
    await click(chipFor(card, 'person.a'));
    await addViaRow(card, window, 'For Anna');
    assert.equal(adds(hass)[0].assigned_person, 'person.a');
  });

  test('Unassigned plus a person: nothing is auto-assigned', async () => {
    const { card } = await mount();
    card._columns[0].personFilters = new Set(['person.a', '__unassigned__']);
    assert.equal(card._autoAssignPerson(card._config.columns[0], card._columns[0]), null);
  });
});

describe('board view', () => {
  const lane = (card, id) => card.shadowRoot.querySelector(`.board > .board-lane[data-section-id="${id}"]`);

  test('the chip filters the lanes and per-lane add sends no assigned_person', async () => {
    const tasks = [
      TASK({ id: 'A1', title: 'A one', sort_order: 0, section_id: 'S1', assigned_person: 'person.a' }),
      TASK({ id: 'B1', title: 'B one', sort_order: 1, section_id: 'S2', assigned_person: 'person.b' }),
      TASK({ id: 'U1', title: 'Nobody', sort_order: 2, section_id: 'S1' }),
    ];
    const { card, hass, window } = await mount({
      col: { view_mode: 'board' }, tasks, sections: SECTIONS,
    });
    assert.ok(unassignedChip(card), 'the person row works on a board');
    await click(unassignedChip(card));
    assert.deepEqual(shownIds(card), ['U1']);

    lane(card, 'S2').querySelector('.board-add-btn').click();
    const input = lane(card, 'S2').querySelector('.board-add-input');
    input.value = 'Lane task';
    input.dispatchEvent(new window.Event('input'));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    const sent = adds(hass);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].section_id, 'S2');
    assert.equal('assigned_person' in sent[0], false);
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
  const switchOf = (ed) => {
    const row = [...ed.shadowRoot.querySelectorAll('.toggle-row')]
      .find((r) => r.querySelector('.toggle-label').textContent === 'Unassigned filter');
    return row && row.querySelector('ha-switch');
  };

  test('the switch exists, is on by default and writes show_unassigned_filter', async () => {
    const { ed, changes, window } = await editor();
    const sw = switchOf(ed);
    assert.ok(sw, 'switch is there');
    assert.equal(sw.checked, true);
    sw.checked = false;
    sw.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).columns[0].show_unassigned_filter, false);
  });

  test('it reads an existing false', async () => {
    const { ed } = await editor({ show_unassigned_filter: false });
    assert.equal(switchOf(ed).checked, false);
  });
});
