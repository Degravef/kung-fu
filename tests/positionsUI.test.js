import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Build the real page markup (without the module script) and expose it as globals before importing the UI.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage, Blob: window.Blob, File: window.File });

const { Stickboy } = await import('../src/skeleton/Stickboy.js');
const { createPositionsPanel } = await import('../src/positionsUI.js');
const { setLang } = await import('../src/i18n/index.js');
const { FORMAT } = await import('../src/positions.js');

const sb = new Stickboy();
let appliedCount = 0;
createPositionsPanel(sb, { applied: () => appliedCount++ });

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const btn = (text) => $$('#positions button').find((b) => b.textContent.trim() === text || b.title === text);
// With nothing saved there is only the built-in list; otherwise [yours, built-in]
const builtinList = () => $$('#positions .pos-list').at(-1);
const rows = () => $$('#positions .pos-list')[0].querySelectorAll('.pos-row');
const stored = () => JSON.parse(localStorage.getItem('kungfu.positions') ?? 'null');

test('tabs switch between the joint list and the positions panel', () => {
  assert.equal($('#positions').hidden, true);
  click($('.tab[data-tab="positions"]'));
  assert.equal($('#positions').hidden, false);
  assert.equal($('#tree-body').hidden, true);
  assert.equal($('#search').hidden, true);
  assert.equal($('.tab[data-tab="positions"]').getAttribute('aria-selected'), 'true');
  click($('.tab[data-tab="joints"]'));
  assert.equal($('#positions').hidden, true);
  assert.equal($('#tree-body').hidden, false);
  click($('.tab[data-tab="positions"]'));
});

test('built-in positions are listed per part and applying one to the left or right hand works', () => {
  const builtin = builtinList();
  assert.ok(builtin.querySelectorAll('.pos-row').length >= 3);
  const fist = [...builtin.querySelectorAll('.pos-row')].find((r) => r.textContent.includes('Fist'));
  const [left, right] = fist.querySelectorAll('.pos-actions button');
  click(left);
  assert.equal(appliedCount, 1);
  assert.ok(sb.values.get('index_pip_L').flex > 90);
  assert.equal(sb.values.get('index_pip_R').flex, 0, 'the right hand is untouched');
  assert.match($('#pos-status').textContent, /Applied “Fist” \(Left\)/);
  click(right);
  assert.equal(sb.values.get('index_pip_R').flex, sb.values.get('index_pip_L').flex, 'same position on the other side');
});

test('save the current arm, list it, apply it to the other side, persist it', () => {
  click(btn('Arm'));
  sb.setPose({ joints: { shoulder_L: { flex: 77 }, elbow_L: { flex: 66 } } });
  assert.equal($$('#positions .pos-list').length, 1, 'nothing saved yet: only the built-in list');
  const input = $('#positions .pos-name-input');
  input.value = 'My guard';
  click(btn('Save current position (arm)'));
  assert.equal(rows().length, 1);
  assert.match($('#pos-status').textContent, /Saved “My guard”/);
  assert.deepEqual(stored().positions.arm[0].joints, { shoulder: { flex: 77 }, elbow: { flex: 66 } });

  sb.setPose({});
  const mine = rows()[0];
  click(mine.querySelectorAll('.pos-actions button')[1]); // R
  assert.equal(sb.values.get('shoulder_R').flex, 77);
  assert.equal(sb.values.get('shoulder_L').flex, 0);
});

test('"take it from the right side" captures the right arm', () => {
  sb.setPose({ joints: { shoulder_R: { flex: 33 } } });
  click(btn('Right'));
  $('#positions .pos-name-input').value = 'From right';
  click(btn('Save current position (arm)'));
  assert.equal(stored().positions.arm.at(-1).joints.shoulder.flex, 33);
});

test('rename and delete (with confirmation) update the list and storage', () => {
  window.prompt = () => 'Renamed';
  click(rows()[0].querySelector('button[title="Rename"]'));
  assert.equal(rows()[0].querySelector('.pos-name').textContent, 'Renamed');
  assert.equal(stored().positions.arm[0].name, 'Renamed');

  window.confirm = () => false;
  click(rows()[0].querySelector('button[title="Delete"]'));
  assert.equal(rows().length, 2, 'declined confirmation keeps it');
  window.confirm = () => true;
  click(rows()[0].querySelector('button[title="Delete"]'));
  assert.equal(rows().length, 1);
  assert.equal(stored().positions.arm.length, 1);
});

test('torso has no side controls and one Apply button per position', () => {
  click(btn('Torso'));
  assert.equal($('#positions .take'), null);
  const row = builtinList().querySelector('.pos-row');
  assert.equal(row.querySelectorAll('.pos-actions button').length, 1);
});

test('export downloads a valid file; import merges it back and reports problems', async () => {
  click(btn('Arm'));
  let downloaded = null;
  window.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:x'; };
  window.URL.revokeObjectURL = () => {};
  globalThis.URL = window.URL;
  click(btn('Export…'));
  assert.ok(downloaded, 'a file was offered');
  const text = await downloaded.text();
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, FORMAT);
  assert.equal(parsed.positions.arm.length, 1);
  assert.match($('#pos-status').textContent, /Exported 1 position\(s\) to kungfu-positions\.json/);

  const file = new window.File([JSON.stringify({
    format: FORMAT, version: 1,
    positions: { hand: [{ id: 'user:h1', name: 'Claw', joints: { index_mcp: { flex: 40, spread: 400 } } }, { name: 'Broken', joints: { knee: { flex: 1 } } }] },
  })], 'in.json', { type: 'application/json' });
  const input = $('#positions input[type=file]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 50));
  assert.match($('#pos-status').textContent, /Imported 1 new and 0 updated/);
  assert.match($('#pos-status').textContent, /skipped/);
  assert.match($('#pos-status').textContent, /not a joint of the hand/);
  click(btn('Hand'));
  assert.equal(rows().length, 1);
  assert.equal(stored().positions.hand[0].joints.index_mcp.spread, 20, 'clamped to the spread limit');
});

test('a bad file gives a clear failure and changes nothing', async () => {
  const before = localStorage.getItem('kungfu.positions');
  const input = $('#positions input[type=file]');
  Object.defineProperty(input, 'files', { value: [new window.File(['{nope'], 'bad.json')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 50));
  assert.match($('#pos-status').textContent, /Import failed: not valid JSON/);
  assert.equal(localStorage.getItem('kungfu.positions'), before);
});

test('switching language re-renders the panel (French labels, translated built-in names)', () => {
  click(btn('Hand'));
  setLang('fr-BE');
  assert.ok($$('#positions h3').some((h) => h.textContent === 'Partie du corps'));
  assert.ok($$('#positions .pos-name').some((n) => n.textContent === 'Poing'));
  assert.ok(btn('Main'), 'part buttons are translated');
  setLang('en');
});
