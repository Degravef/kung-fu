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

const sb = new Stickboy();
const played = [];
let panel = null;
const noop = () => {};
const ui = createUI(sb, {
  select: noop, hover: noop, move: noop, view: noop, focus: noop, edited: noop, toggleLabels: noop, toggleBones: noop, toggleGround: noop,
  pose: (key) => played.push(key),
  userPoses: () => panel?.poses() ?? [],
});
const make = () =>
  createPositionsPanel(sb, { applied: noop, playPose: (k) => played.push(`panel:${k}`), posesChanged: () => ui.refreshPoseBar() });
panel = make();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const btn = (text) => $$('#positions button').find((b) => b.textContent.trim() === text || b.title === text);
const barUser = () => $$('#posebar .btn.user').map((b) => b.textContent);
const stored = () => JSON.parse(localStorage.getItem('kungfu.positions'));

test('the panel has a "Whole pose" mode with a save form, and no built-in list', () => {
  click($('.tab[data-tab="positions"]'));
  click(btn('Whole pose'));
  assert.ok(btn('Save current pose'));
  assert.equal($$('#positions h3').some((h) => h.textContent === 'Built-in positions'), false);
  assert.match($('#positions').textContent, /No saved poses yet/);
  assert.deepEqual(barUser(), []);
});

test('saving a whole pose adds a ★ button to the bottom bar, after the built-in poses', () => {
  sb.setPose({ root: { x: 0.05 }, joints: { knee_L: { flex: 45 }, hip_L: { flex: 35 }, shoulder_R: { flex: 60 }, index_pip_L: { flex: 80 } } });
  $('#positions .pos-name-input').value = 'My stance';
  click(btn('Save current pose'));
  assert.deepEqual(barUser(), ['★ My stance']);
  const children = [...$('#posebar').children];
  const star = children.find((c) => c.textContent === '★ My stance');
  const lastBuiltIn = children.filter((c) => c.classList.contains('btn') && !c.classList.contains('user') && !c.classList.contains('move')).at(-1);
  assert.ok(children.indexOf(star) > children.indexOf(lastBuiltIn), 'user poses come after the built-in ones');
  const saved = stored().poses[0];
  assert.deepEqual([saved.name, saved.root.x, saved.joints.knee_L, saved.joints.shoulder_R], ['My stance', 0.05, { flex: 45 }, { flex: 60 }]);
  assert.match($('#pos-status').textContent, /Saved “My stance”/);
});

test('clicking the ★ button plays that pose; its pressed state follows setActivePose', () => {
  const id = stored().poses[0].id;
  click($$('#posebar .btn.user')[0]);
  assert.deepEqual(played.at(-1), id);
  ui.setActivePose(id);
  assert.equal($$('#posebar .btn.user')[0].getAttribute('aria-pressed'), 'true');
  ui.setActivePose('guard');
  assert.equal($$('#posebar .btn.user')[0].getAttribute('aria-pressed'), 'false');
  assert.equal($$('#posebar .btn').find((b) => b.getAttribute('aria-pressed') === 'true').textContent, 'Ready stance');
});

test('"Show" in the panel plays it too', () => {
  click(btn('Show “My stance”'));
  assert.equal(played.at(-1), `panel:${stored().poses[0].id}`);
  assert.match($('#pos-status').textContent, /Showing “My stance”/);
});

test('rename and delete update the bottom bar and storage', () => {
  window.prompt = () => 'Stance B';
  click($('#positions button[title="Rename"]'));
  assert.deepEqual(barUser(), ['★ Stance B']);
  assert.equal(stored().poses[0].name, 'Stance B');

  window.confirm = () => true;
  click($('#positions button[title="Delete"]'));
  assert.deepEqual(barUser(), []);
  assert.deepEqual(stored().poses, []);
});

test('a saved pose survives a reload (new panel reads storage) and appears in the bar', () => {
  $('#positions .pos-name-input').value = 'Keep me';
  click(btn('Save current pose'));
  assert.deepEqual(barUser(), ['★ Keep me']);
  panel = make(); // "reload"
  ui.refreshPoseBar();
  assert.deepEqual(barUser(), ['★ Keep me']);
});

test('importing a file with poses adds them to the bar; a bad one adds nothing', async () => {
  const input = $('#positions input[type=file]');
  const send = async (text) => {
    Object.defineProperty(input, 'files', { value: [new window.File([text], 'x.json')], configurable: true });
    input.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 50));
  };
  await send(JSON.stringify({ format: 'kungfu-positions', version: 1, positions: {}, poses: [{ id: 'user:imp', name: 'Imported', joints: { elbow_R: { flex: 70 } } }, { name: 'Broken', joints: { nope: { flex: 1 } } }] }));
  assert.deepEqual(barUser(), ['★ Keep me', '★ Imported']);
  assert.match($('#pos-status').textContent, /Imported 1 new/);
  await send('{broken');
  assert.deepEqual(barUser(), ['★ Keep me', '★ Imported']);
  assert.match($('#pos-status').textContent, /Import failed/);
});

test('export contains the whole poses', async () => {
  let blob = null;
  window.URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
  window.URL.revokeObjectURL = () => {};
  globalThis.URL = window.URL;
  click(btn('Export…'));
  const file = JSON.parse(await blob.text());
  assert.deepEqual(file.poses.map((p) => p.name), ['Keep me', 'Imported']);
  assert.match($('#pos-status').textContent, /Exported 2 position\(s\)/);
});
