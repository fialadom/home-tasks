/**
 * confirm_delete: "Delete task" in the task details asks first (default on).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, sort_order: 0, ...over,
});

async function makeCard(col = {}) {
  const { HomeTasksCard, window } = await loadCard({ force: true });
  // jsdom has no CSS.escape, which the delete animation uses.
  window.CSS ??= { escape: (v) => String(v) };
  const calls = [];
  const services = [];
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') {
        return { external_lists: [{ entity_id: 'todo.linked', name: 'Linked', supported_features: 15 }] };
      }
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [TASK({ id: 'T1', title: 'Bins' })], sections: [] };
      if (msg.type === 'home_tasks/get_external_tasks') {
        return { tasks: [TASK({ id: 'uid-1', title: 'Linked task', _external: true })], sections: [] };
      }
      return null;
    },
    callService: async (domain, service, data, target) => { services.push({ domain, service, data, target }); },
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...col }] });
  card.hass = hass;
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  return { card, calls, services };
}

const q = (card, sel) => card.shadowRoot.querySelector(sel);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const deleteCalls = (calls) => calls.filter((c) => c.type === 'home_tasks/delete_task');
const dialogs = (card) => card.shadowRoot.querySelectorAll('dialog.ht-confirm');
const okBtn = (card) => q(card, 'dialog.ht-confirm .ht-confirm-btn.primary');
const cancelBtn = (card) => q(card, 'dialog.ht-confirm .ht-confirm-btn:not(.primary)');

async function openList(card) {
  click(q(card, '.expand-btn'));
  await tick();
  return q(card, '.delete-task-btn');
}

describe('confirm_delete', () => {
  test('clicking Delete task asks first, naming the task, and deletes nothing yet', async () => {
    const { card, calls } = await makeCard();
    click(await openList(card));
    await tick();
    assert.equal(dialogs(card).length, 1);
    assert.match(q(card, 'dialog.ht-confirm .ht-confirm-msg').textContent, /Bins/);
    assert.ok(okBtn(card).classList.contains('danger'), 'destructive OK style');
    assert.equal(deleteCalls(calls).length, 0);
  });

  test('cancel: nothing is deleted, the task stays rendered and expanded', async () => {
    const { card, calls } = await makeCard();
    click(await openList(card));
    await tick();
    click(cancelBtn(card));
    await tick();
    assert.equal(dialogs(card).length, 0);
    assert.equal(deleteCalls(calls).length, 0);
    assert.ok(q(card, '.task[data-task-id="T1"]'));
    assert.ok(card._expandedTasks.has('T1'));
    assert.ok(q(card, '.delete-task-btn'), 'details still open');
  });

  test('confirm: exactly one delete_task call', async () => {
    const { card, calls } = await makeCard();
    click(await openList(card));
    await tick();
    click(okBtn(card));
    await new Promise((r) => setTimeout(r, 350));
    const dels = deleteCalls(calls);
    assert.equal(dels.length, 1);
    assert.equal(JSON.stringify({ l: dels[0].list_id, t: dels[0].task_id }), JSON.stringify({ l: 'L1', t: 'T1' }));
  });

  test('confirm_delete: false deletes immediately, no dialog', async () => {
    const { card, calls } = await makeCard({ confirm_delete: false });
    click(await openList(card));
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(dialogs(card).length, 0);
    assert.equal(deleteCalls(calls).length, 1);
  });

  test('tile detail sheet: cancel keeps it open, confirm closes it and deletes', async () => {
    const { card, calls } = await makeCard({ view_mode: 'tiles' });
    const task = card._columns[0].tasks[0];
    card._openTaskDetailSheet(task, 0);
    await tick();
    click(q(card, '.task-detail-sheet .delete-task-btn'));
    await tick();
    assert.equal(dialogs(card).length, 1);
    click(cancelBtn(card));
    await tick();
    assert.ok(q(card, '.task-detail-sheet'), 'sheet still open after cancel');
    assert.equal(deleteCalls(calls).length, 0);

    click(q(card, '.task-detail-sheet .delete-task-btn'));
    await tick();
    click(okBtn(card));
    await tick();
    assert.equal(q(card, '.task-detail-sheet'), null, 'sheet closed on confirm');
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(deleteCalls(calls).length, 1);
  });

  test('two quick clicks open one dialog only', async () => {
    const { card } = await makeCard();
    const btn = await openList(card);
    click(btn);
    click(btn);
    await tick();
    assert.equal(dialogs(card).length, 1);
  });

  test('auto_delete_completed: completing a task shows no delete dialog', async () => {
    const { card, calls } = await makeCard({ auto_delete_completed: true });
    await card._toggleTask('T1', false, 0);
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(dialogs(card).length, 0);
    assert.equal(deleteCalls(calls).length, 1, 'still auto-deleted');
  });

  test('external list: confirm sends the provider remove_item', async () => {
    const { card, services } = await makeCard({ list_id: undefined, entity_id: 'todo.linked' });
    click(await openList(card));
    await tick();
    assert.equal(dialogs(card).length, 1);
    assert.equal(services.length, 0);
    click(okBtn(card));
    await new Promise((r) => setTimeout(r, 350));
    const rm = services.filter((s) => s.service === 'remove_item');
    assert.equal(rm.length, 1);
    assert.equal(rm[0].data.item, 'uid-1');
    assert.equal(rm[0].target.entity_id, 'todo.linked');
  });
});

describe('confirm_delete editor toggle', () => {
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
    return { ed, changes };
  }
  const sw = (ed) => [...ed.shadowRoot.querySelectorAll('.toggle-row')]
    .find((r) => r.textContent.includes('Confirm before deleting')).querySelector('ha-switch');

  test('exists, on by default; switching it off writes confirm_delete: false', async () => {
    const { ed, changes } = await editor();
    assert.equal(sw(ed).checked, true);
    sw(ed).checked = false;
    sw(ed).dispatchEvent(new window.Event('change'));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].columns[0].confirm_delete, false);
  });
});
