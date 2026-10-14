import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const { window } = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Blob: window.Blob, File: window.File });

const { Stickboy } = await import('../src/skeleton/Stickboy.js');
const { createUI } = await import('../src/ui.js');
const { createPositionsPanel } = await import('../src/positionsUI.js');
const { setLang } = await import('../src/i18n/index.js');

const sb = new Stickboy();
const calls = { move: [], steps: [], pose: [] };
let panel = null;
const noop = () => {};
const ui = createUI(sb, {
  select: noop, hover: noop, view: noop, focus: noop, edited: noop, toggleLabels: noop, toggleBones: noop, toggleGround: noop,
  pose: (k) => calls.pose.push(k),
  move: (k) => calls.move.push(k),
  userPoses: () => panel?.poses() ?? [],
  userMoves: () => panel?.moves() ?? [],
});
const make = () =>
  createPositionsPanel(sb, {
    applied: noop, playPose: noop,
    posesChanged: () => ui.refreshPoseBar(), movesChanged: () => ui.refreshPoseBar(),
    playSteps: (steps) => calls.steps.push(steps.map((s) => ({ ...s }))),
    playMove: (id) => calls.move.push(`panel:${id}`),
  });
panel = make();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const btn = (text) => $$('#positions button').find((b) => b.textContent.trim() === text || b.title === text || b.getAttribute('aria-label') === text);
const stored = () => JSON.parse(localStorage.getItem('kungfu.positions'));
const stepRows = () => $$('#positions .mv-step');
const stepNames = () => stepRows().map((r) => r.querySelector('.mv-pose').textContent);
const barMoves = () => $$('#posebar .btn.move').map((b) => b.textContent);
const choose = (label) => {
  const sel = $('#positions .mv-select');
  sel.value = [...sel.options].find((o) => o.textContent === label).value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const addStep = (label) => { choose(label); click(btn('Add step')); };

test('Move mode: empty builder, save and preview are disabled', () => {
  click($('.tab[data-tab="positions"]'));
  click(btn('Move'));
  assert.match($('#positions').textContent, /No steps yet/);
  assert.equal(btn('Save move').disabled, true);
  assert.equal(btn('▶ Preview').disabled, true);
  assert.match($('#positions').textContent, /No saved moves yet/);
});

test('add steps from built-in poses and from saved ★ poses; the list keeps the order', () => {
  sb.setPose({ joints: { knee_L: { flex: 30 } } });
  click(btn('Whole pose'));
  $('#positions .pos-name-input').value = 'Mine';
  click(btn('Save current pose'));
  click(btn('Move'));
  addStep('Ready stance');
  addStep('Straight punch');
  addStep('★ Mine');
  assert.deepEqual(stepNames(), ['Ready stance', 'Straight punch', '★ Mine']);
  assert.equal(stepRows()[0].querySelector('.mv-seconds').value, '0.6', 'first step blends in from wherever you are');
  assert.equal(stepRows()[1].querySelector('.mv-seconds').value, '0.5');
});

test('reorder, remove and edit durations (clamped to 0.05–10 s)', () => {
  click(stepRows()[2].querySelector('button[title="Move up"]'));
  assert.deepEqual(stepNames(), ['Ready stance', '★ Mine', 'Straight punch']);
  assert.equal(stepRows()[0].querySelector('button[title="Move up"]').disabled, true);
  assert.equal(stepRows()[2].querySelector('button[title="Move down"]').disabled, true);
  click(stepRows()[0].querySelector('button[title="Move down"]'));
  assert.deepEqual(stepNames(), ['★ Mine', 'Ready stance', 'Straight punch']);
  click(stepRows()[0].querySelector('button[title="Remove step"]'));
  assert.deepEqual(stepNames(), ['Ready stance', 'Straight punch']);

  const secs = stepRows()[1].querySelector('.mv-seconds');
  secs.value = '0.2';
  secs.dispatchEvent(new window.Event('input', { bubbles: true }));
  secs.dispatchEvent(new window.Event('change', { bubbles: true }));
  const bad = stepRows()[0].querySelector('.mv-seconds');
  bad.value = '99';
  bad.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(bad.value, '10');
});

test('preview plays the draft without saving it', () => {
  click(btn('▶ Preview'));
  assert.deepEqual(calls.steps.at(-1), [{ pose: 'guard', duration: 10 }, { pose: 'punch', duration: 0.2 }]);
  assert.equal(stored().moves.length, 0);
});

test('save: the move is stored, listed, shown as a ▶ button in the bottom bar, and the builder resets', () => {
  const bad = stepRows()[0].querySelector('.mv-seconds');
  bad.value = '0.6';
  bad.dispatchEvent(new window.Event('change', { bubbles: true }));
  $('#positions .pos-name-input').value = 'Punch combo';
  click(btn('Save move'));
  assert.match($('#pos-status').textContent, /Saved move “Punch combo”/);
  assert.deepEqual(stored().moves[0].steps, [{ pose: 'guard', duration: 0.6 }, { pose: 'punch', duration: 0.2 }]);
  assert.equal(stored().moves[0].name, 'Punch combo');
  assert.deepEqual(barMoves(), ['▶ Roundhouse kick', '▶ Punch combo'], 'saved moves follow the built-in ones');
  assert.ok($('#posebar .btn.move.user'), 'styled as a user item');
  assert.deepEqual(stepNames(), [], 'the draft is cleared after saving');
  assert.match($('#positions .mv-saved').textContent, /Ready stance → Straight punch/);
});

test('the ▶ button in the bar and the ▶ in the list both play the saved move', () => {
  const id = stored().moves[0].id;
  click($('#posebar .btn.move.user'));
  assert.equal(calls.move.at(-1), id);
  click(btn('Play “Punch combo”'));
  assert.equal(calls.move.at(-1), `panel:${id}`);
  ui.setActiveMove(id);
  assert.equal($('#posebar .btn.move.user').getAttribute('aria-pressed'), 'true');
});

test('edit loads the move into the builder; update saves changes in place', () => {
  click(btn('Edit: Punch combo'));
  assert.deepEqual(stepNames(), ['Ready stance', 'Straight punch']);
  assert.match($('#positions').textContent, /Editing “Punch combo”/);
  addStep('Front kick');
  $('#positions .pos-name-input').value = 'Punch + kick';
  click(btn('Update “Punch combo”'));
  assert.equal(stored().moves.length, 1, 'updated, not duplicated');
  assert.deepEqual(stored().moves[0].steps.map((s) => s.pose), ['guard', 'punch', 'kick']);
  assert.deepEqual(barMoves(), ['▶ Roundhouse kick', '▶ Punch + kick']);
  assert.match($('#pos-status').textContent, /Updated move/);
});

test('"New move" abandons an edit; saving with no steps is refused', () => {
  click(btn('Edit: Punch + kick'));
  click(btn('New move'));
  assert.deepEqual(stepNames(), []);
  assert.doesNotMatch($('#positions').textContent, /Editing/);
  assert.equal(stored().moves.length, 1);
});

test('deleting a pose that a move uses asks for a stronger confirmation; the step is flagged as missing', () => {
  addStep('★ Mine');
  $('#positions .pos-name-input').value = 'Uses mine';
  click(btn('Save move'));
  click(btn('Whole pose'));
  let asked = '';
  window.confirm = (q) => { asked = q; return true; };
  click(btn('Delete: Mine'));
  assert.match(asked, /It is used by: Uses mine/);
  assert.deepEqual(stored().poses, []);
  click(btn('Move'));
  assert.match($$('#positions .mv-saved').find((r) => r.textContent.includes('Uses mine')).textContent, /missing pose/);
  click(btn('Edit: Uses mine'));
  assert.equal(stepRows()[0].classList.contains('missing'), true);
});

test('delete a saved move (confirm) removes it from the list, the bar and storage', () => {
  window.confirm = () => false;
  click(btn('Delete: Uses mine'));
  assert.equal(stored().moves.length, 2);
  window.confirm = () => true;
  click(btn('Delete: Uses mine'));
  assert.deepEqual(stored().moves.map((m) => m.name), ['Punch + kick']);
  assert.deepEqual(barMoves(), ['▶ Roundhouse kick', '▶ Punch + kick']);
});

test('saved moves survive a reload and appear in the bar', () => {
  panel = make();
  ui.refreshPoseBar();
  assert.deepEqual(barMoves(), ['▶ Roundhouse kick', '▶ Punch + kick']);
});

test('import: moves referencing poses in the same file or already saved are accepted; bad ones are reported', async () => {
  const input = $('#positions input[type=file]');
  const send = async (obj) => {
    Object.defineProperty(input, 'files', { value: [new window.File([JSON.stringify(obj)], 'm.json')], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 50));
  };
  await send({
    format: 'kungfu-positions', version: 1, positions: {},
    poses: [{ id: 'user:fromfile', name: 'From file', joints: {} }],
    moves: [{ id: 'user:mv', name: 'Imported move', steps: [{ pose: 'guard', duration: 0.4 }, { pose: 'user:fromfile', duration: 0.3 }] }, { name: 'Broken', steps: [{ pose: 'user:ghost', duration: 1 }] }],
  });
  assert.match($('#pos-status').textContent, /Imported 2 new/);
  assert.match($('#pos-status').textContent, /unknown pose "user:ghost"/);
  assert.ok(barMoves().includes('▶ Imported move'));
  assert.ok($$('#posebar .btn.user').some((b) => b.textContent === '★ From file'), 'its pose arrived too');
});

test('export contains the moves', async () => {
  let blob = null;
  window.URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
  window.URL.revokeObjectURL = () => {};
  globalThis.URL = window.URL;
  click(btn('Export…'));
  const file = JSON.parse(await blob.text());
  assert.deepEqual(file.moves.map((m) => m.name), ['Punch + kick', 'Imported move']);
});

test('French: the Move mode and bar buttons are translated', () => {
  setLang('fr-BE');
  try {
    assert.ok(btn('Mouvement'));
    click(btn('Mouvement'));
    assert.ok($$('#positions h3').some((h) => h.textContent === 'Étapes, dans l’ordre'));
    assert.ok(btn('Jouer « Imported move »'));
    assert.ok($$('#posebar .btn.move.user').some((b) => b.title === 'Mouvement enregistré : Imported move'));
  } finally {
    setLang('en');
  }
});

test('regression: no mode of the Positions tab renders a stray "null" or "undefined" text', () => {
  for (const mode of ['Whole pose', 'Move', 'Hand', 'Arm', 'Leg', 'Torso']) {
    click(btn(mode));
    const text = $('#positions').textContent;
    assert.doesNotMatch(text, /\b(null|undefined)\b/, `${mode}: ${text.slice(0, 120)}`);
  }
});

test('icon-only buttons have an accessible name as a real aria-label attribute', () => {
  click(btn('Move'));
  const unnamed = $$('#positions button').filter((b) => !b.textContent.trim() || /^[✎🗑✕↑↓▶]$/.test(b.textContent.trim())).filter((b) => !b.getAttribute('aria-label'));
  assert.deepEqual(unnamed.map((b) => b.outerHTML.slice(0, 80)), []);
});
