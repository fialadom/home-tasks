/**
 * Comments with @mentions on native lists, and the richer history lines.
 *
 * The card talks to the backend through hass.callWS, which is mocked here:
 * these tests pin what the card sends (tokens, never display names) and what
 * it shows for the objects the contract describes.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], comments: [],
  section_id: null, sort_order: 0, ...over,
});

const STATES = {
  'person.dominik': { attributes: { friendly_name: 'Dominik', user_id: 'u-dom' } },
  'person.anna': { attributes: { friendly_name: 'Anna', user_id: 'u-anna' } },
  'person.ondrej': { attributes: { friendly_name: 'Ondřej Novák', user_id: 'u-ond' } },
  'sensor.not_a_person': { attributes: { friendly_name: 'Anna sensor' } },
};

const COMMENTS = [
  {
    id: 'c1', ts: '2026-10-11T20:15:00+00:00', by: 'Dominik Fiala', by_user_id: 'u-dom',
    by_person: 'person.dominik', text: 'Hotovo, <@person.anna> mrkni na https://example.com/x prosím',
    mentions: ['person.anna'], edited_ts: '2026-10-11T20:20:00+00:00',
  },
  {
    id: 'c2', ts: '2026-10-11T21:00:00+00:00', by: 'Anna A', by_user_id: 'u-anna',
    by_person: 'person.anna', text: 'Díky <@person.gone>', mentions: ['person.gone'],
  },
  {
    id: 'c3', ts: '2026-10-11T22:00:00+00:00', by: null, by_user_id: null,
    by_person: null, text: 'Automatic note', mentions: [],
  },
];

// jsdom has no CSS.escape, which the card uses to look elements up by id.
async function mount({ col = {}, user = { id: 'u-dom', is_admin: false }, task = {}, wsError = null,
                       external = false } = {}) {
  const loaded = await loadCard({ force: true });
  loaded.window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_ -￿-]/g, '\\$&') };
  const calls = [];
  const taskObj = () => TASK({ id: 'T1', title: 'Bins', comments: COMMENTS.map((c) => ({ ...c })), ...task });
  const hass = makeMockHass({
    language: 'en',
    states: STATES,
    user,
    callWS: async (msg) => {
      calls.push(JSON.parse(JSON.stringify(msg)));
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Home' }] };
      if (msg.type === 'home_tasks/get_external_lists') {
        return { external_lists: [{ entity_id: 'todo.linked', name: 'Linked', supported_features: 15 }] };
      }
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [taskObj()], sections: [] };
      if (msg.type === 'home_tasks/get_external_tasks') {
        return { tasks: [TASK({ id: 'uid-1', title: 'Linked', _external: true, comments: COMMENTS.map((c) => ({ ...c })) })], sections: [] };
      }
      if (/comment$/.test(msg.type) && wsError) {
        throw Object.assign(new Error('boom'), { code: wsError });
      }
      if (msg.type === 'home_tasks/add_comment') {
        return {
          id: 'new1', ts: '2026-10-12T08:00:00+00:00', by: 'Dominik Fiala', by_user_id: user.id,
          by_person: 'person.dominik', text: msg.text, mentions: [],
        };
      }
      if (msg.type === 'home_tasks/update_comment') {
        return {
          ...COMMENTS.find((c) => c.id === msg.comment_id), text: msg.text,
          edited_ts: '2026-10-12T09:00:00+00:00',
        };
      }
      if (msg.type === 'home_tasks/delete_comment') return {};
      return null;
    },
  });
  const card = new loaded.HomeTasksCard();
  const column = external ? { entity_id: 'todo.linked', ...col } : { list_id: 'L1', ...col };
  card.setConfig({ columns: [column] });
  loaded.window.document.body.appendChild(card);
  mounted.push(card);
  card.hass = hass;
  await tick(8);
  return { card, calls, window: loaded.window };
}

// Connected, so focus() works; removed again after each test.
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().remove(); });

const q = (card, sel) => card.shadowRoot.querySelector(sel);
const qa = (card, sel) => [...card.shadowRoot.querySelectorAll(sel)];
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

async function expand(card, id = 'T1') {
  card._expandedTasks.add(id);
  card._render();
  await tick();
}

function type(window, ta, text, caret = text.length) {
  ta.value = text;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const key = (window, ta, k, opts = {}) => {
  const ev = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  ta.dispatchEvent(ev);
  return ev;
};
const writeCalls = (calls, name) => calls.filter((c) => c.type === `home_tasks/${name}`);
const input = (card) => q(card, 'textarea.comment-input[data-focus-key="comment_T1"]');
const picker = (card) => q(card, '.mention-picker');
const pickerOpen = (card) => !!picker(card) && picker(card).style.display !== 'none'
  && picker(card).children.length > 0;
const pickerNames = (card) => qa(card, '.mention-picker .mention-option').map((e) => e.lastElementChild.textContent);

describe('comments section', () => {
  test('lists the comments oldest first with author, chip, link and edited marker', async () => {
    const { card } = await mount();
    await expand(card);
    const rows = qa(card, '.comment');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.dataset.commentId), ['c1', 'c2', 'c3']);

    const first = rows[0];
    assert.equal(first.querySelector('.comment-author').textContent, 'Dominik');
    assert.match(first.querySelector('.comment-ts').textContent, /edited/);
    assert.ok(first.querySelector('.person-avatar'), 'avatar');
    const chip = first.querySelector('.comment-text .mention');
    assert.equal(chip.textContent, '@Anna');
    const link = first.querySelector('.comment-text a');
    assert.equal(link.getAttribute('href'), 'https://example.com/x');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.ok(!rows[1].querySelector('.comment-ts').textContent.includes('edited'));
  });

  test('an automation comment gets the automation name and an initial bubble', async () => {
    const { card } = await mount();
    await expand(card);
    const row = qa(card, '.comment')[2];
    assert.equal(row.querySelector('.comment-author').textContent, 'Automation');
    assert.equal(row.querySelector('.person-avatar').tagName, 'SPAN');
  });

  test('mention-me marks the viewer, mention-removed a person who is gone', async () => {
    const { card } = await mount({ user: { id: 'u-anna', is_admin: false } });
    await expand(card);
    const rows = qa(card, '.comment');
    assert.ok(rows[0].querySelector('.mention').classList.contains('mention-me'));
    const gone = rows[1].querySelector('.mention');
    assert.ok(gone.classList.contains('mention-removed'));
    assert.equal(gone.textContent, '@person.gone');
    assert.ok(!gone.classList.contains('mention-me'));
  });

  test('another viewer does not get mention-me', async () => {
    const { card } = await mount();
    await expand(card);
    assert.ok(!qa(card, '.mention-me').length);
  });

  test('markup in a comment is text, never parsed', async () => {
    const { card } = await mount({ task: { comments: [{ ...COMMENTS[2], text: '<img src=x onerror=alert(1)> <b>x</b>' }] } });
    await expand(card);
    assert.equal(q(card, '.comment-text img'), null);
    assert.equal(q(card, '.comment-text b'), null);
    assert.match(q(card, '.comment-text').textContent, /<b>x<\/b>/);
  });

  test('an external column has no comments section and no badge', async () => {
    const { card } = await mount({ external: true });
    await expand(card, 'uid-1');
    assert.ok(q(card, '.task-details'), 'details are open');
    assert.equal(q(card, '.comments-section'), null);
    assert.equal(q(card, '.comment-badge'), null);
  });

  test('show_comments: false hides the section', async () => {
    const { card } = await mount({ col: { show_comments: false } });
    await expand(card);
    assert.equal(q(card, '.comments-section'), null);
  });
});

describe('edit and delete rights', () => {
  test('the author gets both buttons on their own comments only', async () => {
    const { card } = await mount();
    await expand(card);
    const rows = qa(card, '.comment');
    assert.ok(rows[0].querySelector('.comment-edit-btn') && rows[0].querySelector('.comment-delete-btn'));
    assert.equal(rows[1].querySelector('.comment-edit-btn'), null);
    assert.equal(rows[2].querySelector('.comment-delete-btn'), null);
  });

  test('an admin gets them on every comment', async () => {
    const { card } = await mount({ user: { id: 'u-other', is_admin: true } });
    await expand(card);
    assert.equal(qa(card, '.comment-edit-btn').length, 3);
    assert.equal(qa(card, '.comment-delete-btn').length, 3);
  });

  test('somebody else gets none', async () => {
    const { card } = await mount({ user: { id: 'u-other', is_admin: false } });
    await expand(card);
    assert.equal(qa(card, '.comment-edit-btn').length, 0);
    assert.equal(qa(card, '.comment-delete-btn').length, 0);
  });

  test('delete asks first, then calls delete_comment', async () => {
    const { card, calls } = await mount();
    await expand(card);
    click(q(card, '[data-comment-id="c1"] .comment-delete-btn'));
    await tick();
    const dlg = q(card, 'dialog.ht-confirm');
    assert.ok(dlg, 'confirm dialog');
    assert.match(dlg.textContent, /Delete this comment\?/);
    assert.equal(writeCalls(calls, 'delete_comment').length, 0, 'nothing yet');
    click(q(card, 'dialog.ht-confirm .ht-confirm-btn.primary'));
    await tick(8);
    assert.deepEqual(writeCalls(calls, 'delete_comment'),
      [{ type: 'home_tasks/delete_comment', list_id: 'L1', task_id: 'T1', comment_id: 'c1' }]);
    assert.deepEqual(qa(card, '.comment').map((r) => r.dataset.commentId), ['c2', 'c3']);
  });

  test('cancelling the confirmation deletes nothing', async () => {
    const { card, calls } = await mount();
    await expand(card);
    click(q(card, '[data-comment-id="c1"] .comment-delete-btn'));
    await tick();
    click(q(card, 'dialog.ht-confirm .ht-confirm-btn:not(.primary)'));
    await tick();
    assert.equal(writeCalls(calls, 'delete_comment').length, 0);
    assert.equal(qa(card, '.comment').length, 3);
  });

  test('edit turns tokens into @Name; saving sends the tokens to update_comment', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    click(q(card, '[data-comment-id="c1"] .comment-edit-btn'));
    await tick();
    const ta = q(card, '[data-comment-id="c1"] textarea');
    assert.equal(ta.value, 'Hotovo, @Anna mrkni na https://example.com/x prosím');
    type(window, ta, ta.value + ' díky');
    click(q(card, '[data-comment-id="c1"] .comment-btn.primary'));
    await tick(8);
    const sent = writeCalls(calls, 'update_comment');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], {
      type: 'home_tasks/update_comment', list_id: 'L1', task_id: 'T1', comment_id: 'c1',
      text: 'Hotovo, <@person.anna> mrkni na https://example.com/x prosím díky',
    });
    assert.equal(q(card, '[data-comment-id="c1"] textarea'), null, 'back to the read view');
    assert.match(q(card, '[data-comment-id="c1"] .comment-text').textContent, /díky/);
  });

  test('cancel leaves the comment as it was', async () => {
    const { card, calls } = await mount();
    await expand(card);
    click(q(card, '[data-comment-id="c1"] .comment-edit-btn'));
    await tick();
    click(q(card, '[data-comment-id="c1"] .comment-btn:not(.primary)'));
    await tick();
    assert.equal(q(card, '[data-comment-id="c1"] textarea'), null);
    assert.equal(writeCalls(calls, 'update_comment').length, 0);
  });
});

describe('writing a comment', () => {
  test('typing @an opens the picker on Anna only; Enter inserts, send uses the token', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    const ta = input(card);
    assert.equal(ta.placeholder, 'Write a comment… (@ to mention)');
    type(window, ta, 'Hi @an');
    assert.ok(pickerOpen(card));
    assert.deepEqual(pickerNames(card), ['Anna'], 'a sensor named Anna is not a person');

    const ev = key(window, ta, 'Enter');
    assert.ok(ev.defaultPrevented);
    assert.equal(ta.value, 'Hi @Anna ');
    assert.ok(!pickerOpen(card), 'picker closed');
    assert.equal(writeCalls(calls, 'add_comment').length, 0, 'Enter in the picker does not send');

    type(window, ta, ta.value + 'thanks');
    click(q(card, '.comment-send'));
    await tick(8);
    assert.deepEqual(writeCalls(calls, 'add_comment'),
      [{ type: 'home_tasks/add_comment', list_id: 'L1', task_id: 'T1', text: 'Hi <@person.anna> thanks' }]);
    assert.equal(qa(card, '.comment').length, 4, 'the returned comment is listed');
    assert.equal(input(card).value, '', 'draft cleared');
    assert.equal(card._commentDrafts.get('T1').text, '');
    assert.equal(card._commentDrafts.get('T1').mentions.size, 0);
  });

  test('@án finds Anna and @nov finds Ondřej Novák by a later word', async () => {
    const { card, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@án');
    assert.deepEqual(pickerNames(card), ['Anna']);
    type(window, ta, '@nov');
    assert.deepEqual(pickerNames(card), ['Ondřej Novák']);
    type(window, ta, '@ond');
    assert.deepEqual(pickerNames(card), ['Ondřej Novák']);
    type(window, ta, '@zzz');
    assert.ok(!pickerOpen(card), 'no match, no picker');
  });

  test('a bare @ lists everybody; an @ inside a word opens nothing', async () => {
    const { card, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@');
    assert.deepEqual(pickerNames(card), ['Anna', 'Dominik', 'Ondřej Novák']);
    type(window, ta, 'mail me at x@an');
    assert.ok(!pickerOpen(card));
  });

  test('arrows move, Tab inserts the active row, Escape closes', async () => {
    const { card, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@');
    key(window, ta, 'ArrowDown');
    assert.ok(qa(card, '.mention-option')[1].classList.contains('active'));
    key(window, ta, 'ArrowUp');
    key(window, ta, 'ArrowUp');
    assert.ok(qa(card, '.mention-option')[2].classList.contains('active'), 'wraps');
    key(window, ta, 'ArrowDown');
    key(window, ta, 'Tab');
    assert.equal(ta.value, '@Anna ');

    type(window, ta, '@do');
    assert.ok(pickerOpen(card));
    key(window, ta, 'Escape');
    assert.ok(!pickerOpen(card));
    assert.equal(ta.value, '@do', 'Escape leaves the text alone');
  });

  test('a mouse press on a row inserts it', async () => {
    const { card, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, 'Hey @dom');
    const row = q(card, '.mention-option');
    const ev = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, 'the textarea keeps focus');
    assert.equal(ta.value, 'Hey @Dominik ');
  });

  test('the picker shows at most 8 rows', async () => {
    const { card, window } = await mount();
    for (let i = 0; i < 12; i++) {
      card._hass.states[`person.p${i}`] = { attributes: { friendly_name: `Pat ${i}` } };
    }
    await expand(card);
    type(window, input(card), '@pat');
    assert.equal(qa(card, '.mention-option').length, 8);
  });

  test('a mention broken afterwards is sent as plain text', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@an');
    key(window, ta, 'Enter');
    assert.equal(ta.value, '@Anna ');
    type(window, ta, '@Ann ok');
    click(q(card, '.comment-send'));
    await tick(8);
    assert.equal(writeCalls(calls, 'add_comment')[0].text, '@Ann ok');
  });

  test('a name that is a prefix of another is not cut out of it', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@an');
    key(window, ta, 'Enter');
    type(window, ta, '@Anna and @Annabel');
    click(q(card, '.comment-send'));
    await tick(8);
    assert.equal(writeCalls(calls, 'add_comment')[0].text, '<@person.anna> and @Annabel');
  });

  test('Ctrl+Enter and Cmd+Enter send; plain Enter does not', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    let ta = input(card);
    type(window, ta, 'one');
    const plain = key(window, ta, 'Enter');
    assert.ok(!plain.defaultPrevented, 'plain Enter is a new line');
    await tick();
    assert.equal(writeCalls(calls, 'add_comment').length, 0);

    key(window, ta, 'Enter', { ctrlKey: true });
    await tick(8);
    assert.equal(writeCalls(calls, 'add_comment').length, 1);

    ta = input(card);
    type(window, ta, 'two');
    key(window, ta, 'Enter', { metaKey: true });
    await tick(8);
    assert.deepEqual(writeCalls(calls, 'add_comment').map((c) => c.text), ['one', 'two']);
  });

  test('an empty draft sends nothing', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    type(window, input(card), '   ');
    click(q(card, '.comment-send'));
    await tick();
    assert.equal(writeCalls(calls, 'add_comment').length, 0);
  });

  for (const [code, msg] of [
    ['unknown_person', 'The mentioned person does not exist.'],
    ['too_many_mentions', 'A comment can mention at most 10 people.'],
    ['invalid_request', 'The comment could not be saved.'],
  ]) {
    test(`error ${code} is shown under the input and the draft is kept`, async () => {
      const { card, window } = await mount({ wsError: code });
      await expand(card);
      const ta = input(card);
      type(window, ta, 'Hi @an');
      key(window, ta, 'Enter');
      click(q(card, '.comment-send'));
      await tick(8);
      assert.equal(q(card, '.comments-section > .comment-error').textContent, msg);
      assert.equal(input(card).value, 'Hi @Anna ');
      assert.equal(qa(card, '.comment').length, 3, 'nothing added');
      assert.equal(card._commentDrafts.get('T1').text, 'Hi @Anna ');
    });
  }
});

describe('the draft survives re-renders', () => {
  test('text and mention map are rebuilt into the new input', async () => {
    const { card, calls, window } = await mount();
    await expand(card);
    const ta = input(card);
    type(window, ta, '@an');
    key(window, ta, 'Enter');
    type(window, ta, ta.value + 'half way');
    card._render();
    await tick();
    const again = input(card);
    assert.notEqual(again, ta, 'the DOM was rebuilt');
    assert.equal(again.value, '@Anna half way');
    click(q(card, '.comment-send'));
    await tick(8);
    assert.equal(writeCalls(calls, 'add_comment')[0].text, '<@person.anna> half way');
  });

  test('a background update does not rebuild under a focused comment input', async () => {
    const { card, window } = await mount();
    await expand(card);
    const ta = input(card);
    ta.focus();
    assert.equal(card.shadowRoot.activeElement, ta);
    type(window, ta, 'typing');
    card._bgUpdates = 1;
    try { card._render(); } finally { card._bgUpdates = 0; }
    assert.equal(input(card), ta, 'same element: render deferred until blur');
    assert.ok(card._pendingRender);
  });

  test('so does an edit in progress', async () => {
    const { card } = await mount();
    await expand(card);
    click(q(card, '[data-comment-id="c1"] .comment-edit-btn'));
    await tick();
    const ta = q(card, '[data-comment-id="c1"] textarea');
    ta.focus();
    card._bgUpdates = 1;
    try { card._render(); } finally { card._bgUpdates = 0; }
    assert.equal(q(card, '[data-comment-id="c1"] textarea'), ta);
    // And a foreground render brings the edit back, with its text.
    ta.value = 'changed';
    ta.dispatchEvent(new card.ownerDocument.defaultView.Event('input'));
    card._render();
    await tick();
    assert.equal(q(card, '[data-comment-id="c1"] textarea').value, 'changed');
  });
});

describe('badge', () => {
  const badge = (card) => q(card, '.task .comment-badge');

  test('shows 💬 N, and a leading @ with badge-mention-me when the viewer is mentioned', async () => {
    const { card } = await mount({ user: { id: 'u-anna', is_admin: false },
      task: { comments: COMMENTS.slice(0, 2) } });
    assert.equal(badge(card).textContent, '@\u{1F4AC} 2');
    assert.ok(badge(card).classList.contains('badge-mention-me'));
  });

  test('a plain count when nobody is mentioned', async () => {
    const { card } = await mount({ task: { comments: COMMENTS.slice(0, 2) } });
    assert.equal(badge(card).textContent, '\u{1F4AC} 2');
    assert.ok(!badge(card).classList.contains('badge-mention-me'));
  });

  test('no comments, no badge; badge_comments: false hides it', async () => {
    assert.equal(badge((await mount({ task: { comments: [] } })).card), null);
    assert.equal(badge((await mount({ col: { badge_comments: false } })).card), null);
  });

  test('external column: no badge even when the task carries comments', async () => {
    const { card } = await mount({ external: true });
    assert.equal(badge(card), null);
  });

  test('board cards carry the badge too', async () => {
    const { card } = await mount({ col: { view_mode: 'board' } });
    assert.ok(q(card, '.board .comment-badge'));
  });
});

describe('history lines', () => {
  const SECTIONS = [{ id: 's1', name: 'Doing', sort_order: 0 }];
  const entry = (over) => ({ ts: '2026-10-11T20:00:00+00:00', by: 'Dominik', ...over });
  async function history(entries, col = { show_history: true }) {
    const m = await mount({ col, task: { history: entries } });
    m.card._columns[0].sections = SECTIONS;
    await expand(m.card);
    return qa(m.card, '.history-entry .history-text').map((e) => e.textContent);
  }

  test('a section move names both sections, null is "No section"', async () => {
    const lines = await history([
      entry({ action: 'updated', field: 'section_id', from: null, to: 's1' }),
    ]);
    assert.match(lines[0], /^Column: No section → Doing/);
  });

  test('a deleted section falls back', async () => {
    const lines = await history([
      entry({ action: 'updated', field: 'section_id', from: 'gone', to: null }),
    ]);
    assert.match(lines[0], /^Column: \(deleted section\) → No section/);
  });

  test('commented, with and without mentions', async () => {
    const lines = await history([
      entry({ action: 'commented', comment_id: 'c1', mentions: ['person.anna', 'person.gone'] }),
      entry({ action: 'commented', comment_id: 'c2' }),
    ]);
    // newest first
    assert.match(lines[0], /^Comment · /);
    assert.ok(!lines[0].includes('mentioned'));
    assert.match(lines[1], /^Comment · mentioned @Anna, @person\.gone/);
  });

  test('sub_task ops and moved', async () => {
    const lines = await history([
      entry({ action: 'sub_task', op: 'added', title: 'Buy bags' }),
      entry({ action: 'sub_task', op: 'completed', title: 'Buy bags' }),
      entry({ action: 'sub_task', op: 'reopened', title: 'Buy bags' }),
      entry({ action: 'sub_task', op: 'deleted', title: 'Buy bags' }),
      entry({ action: 'moved', from_list: 'Garden' }),
    ]);
    assert.deepEqual(lines.map((l) => l.replace(/ · .*$/, '')), [
      'Moved from list Garden',
      'Sub-task deleted: Buy bags',
      'Sub-task reopened: Buy bags',
      'Sub-task completed: Buy bags',
      'Sub-task added: Buy bags',
    ]);
  });

  test('a board column shows history by default, show_history: false hides it', async () => {
    const shown = await mount({ col: { view_mode: 'board' } });
    await expand(shown.card);
    assert.ok(q(shown.card, '.history-list'));
    const hidden = await mount({ col: { view_mode: 'board', show_history: false } });
    await expand(hidden.card);
    assert.equal(q(hidden.card, '.history-list'), null);
  });

  test('a list column still hides history unless asked', async () => {
    const m = await mount();
    await expand(m.card);
    assert.equal(q(m.card, '.history-list'), null);
  });
});

describe('editor', () => {
  async function editor(colExtra = {}) {
    const { window } = await loadCard({ force: true });
    const Editor = window.customElements.get('home-tasks-card-editor');
    const ed = new Editor();
    ed.hass = makeMockHass({
      callWS: async (m) => {
        if (m.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Home' }] };
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
  const toggle = (ed, label) => [...ed.shadowRoot.querySelectorAll('.toggle-row')]
    .find((r) => r.querySelector('.toggle-label').textContent === label);

  test('show_comments and badge_comments toggles exist and default on', async () => {
    const { ed } = await editor();
    assert.equal(toggle(ed, 'Comments').querySelector('ha-switch').checked, true);
    assert.equal(toggle(ed, 'Comment count').querySelector('ha-switch').checked, true);
  });

  test('they reflect false and write their keys', async () => {
    const { ed, changes, window } = await editor({ show_comments: false, badge_comments: false });
    const show = toggle(ed, 'Comments').querySelector('ha-switch');
    assert.equal(show.checked, false);
    assert.equal(toggle(ed, 'Comment count').querySelector('ha-switch').checked, false);
    show.checked = true;
    show.dispatchEvent(new window.Event('change'));
    assert.equal(changes.at(-1).columns[0].show_comments, true);
  });

  test('the history toggle defaults on for a board column, off otherwise', async () => {
    const board = await editor({ view_mode: 'board' });
    assert.equal(toggle(board.ed, 'Histories').querySelector('ha-switch').checked, true);
    const list = await editor();
    assert.equal(toggle(list.ed, 'Histories').querySelector('ha-switch').checked, false);
  });
});
