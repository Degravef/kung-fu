import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*><\/script>/, '');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
const { createLayout } = await import('../src/layout.js');
const { setLang } = await import('../src/i18n/index.js');

/** A fresh page with a controllable matchMedia (narrow or wide) and optional stored layout. */
function page({ narrow = false, stored } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  const listeners = [];
  const mq = {
    matches: narrow,
    addEventListener: (_, fn) => listeners.push(fn),
    set(v) { mq.matches = v; listeners.forEach((fn) => fn({ matches: v })); },
  };
  window.matchMedia = () => mq;
  if (stored) window.localStorage.setItem('kungfu.layout', JSON.stringify(stored));
  Object.assign(globalThis, { window, document: window.document, localStorage: window.localStorage });
  // the labels normally filled by ui.js (data-i18n)
  for (const el of document.querySelectorAll('.fold-label')) el.textContent = { left: 'Joints & positions', right: 'Selected joint', toolbar: 'Tools', posebar: 'Poses & moves' }[el.closest('[data-fold]').dataset.fold];
  const layout = createLayout();
  const $ = (s) => document.querySelector(s);
  const btn = (name) => $(`[data-fold="${name}"]`);
  const app = $('#app');
  return { layout, mq, $, btn, app, window, saved: () => JSON.parse(localStorage.getItem('kungfu.layout')) };
}

test('wide screens start fully open; every fold button says what it will do', () => {
  const p = page();
  for (const n of ['left', 'right', 'toolbar', 'posebar']) {
    assert.equal(p.btn(n).getAttribute('aria-expanded'), 'true', n);
    assert.equal(p.app.classList.contains(`fold-${n}`), false);
  }
  assert.equal(p.btn('left').title, 'Hide: Joints & positions');
  assert.equal(p.btn('left').getAttribute('aria-label'), 'Hide: Joints & positions');
  assert.equal(p.btn('left').getAttribute('aria-controls'), 'tree-content');
  assert.ok(document.getElementById('tree-content') && document.getElementById('inspector-content') && document.getElementById('toolbar-content') && document.getElementById('posebar'), 'every aria-controls target exists');
});

test('narrow screens start with the 3D view and the pose bar only', () => {
  const p = page({ narrow: true });
  assert.deepEqual(['left', 'right', 'toolbar', 'posebar'].map((n) => p.layout.isFolded(n)), [true, true, true, false]);
  assert.equal(p.btn('right').getAttribute('aria-expanded'), 'false');
  assert.equal(p.btn('right').title, 'Show: Selected joint');
});

test('clicking a fold button toggles it, updates ARIA, and remembers the choice', () => {
  const p = page();
  p.btn('left').click();
  assert.equal(p.app.classList.contains('fold-left'), true);
  assert.equal(p.btn('left').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(p.saved().wide, { left: true, right: false, toolbar: false, posebar: false });
  p.btn('left').click();
  assert.equal(p.app.classList.contains('fold-left'), false);
  p.btn('posebar').click();
  assert.equal(p.layout.isFolded('posebar'), true);
});

test('a saved layout is restored on the next visit', () => {
  const p = page({ stored: { wide: { right: true, posebar: true } } });
  assert.deepEqual(['left', 'right', 'toolbar', 'posebar'].map((n) => p.layout.isFolded(n)), [false, true, false, true]);
  assert.equal(p.app.classList.contains('fold-right'), true);
});

test('wide and narrow screens remember their own layouts; crossing the breakpoint switches', () => {
  const p = page();
  p.btn('toolbar').click(); // wide: fold the toolbar
  p.mq.set(true); // rotate to narrow
  assert.deepEqual(['left', 'right', 'toolbar', 'posebar'].map((n) => p.layout.isFolded(n)), [true, true, true, false], 'narrow defaults');
  p.btn('left').click(); // narrow: open the left panel
  assert.equal(p.layout.isFolded('left'), false);
  p.mq.set(false); // back to wide
  assert.deepEqual(['left', 'right', 'toolbar', 'posebar'].map((n) => p.layout.isFolded(n)), [false, false, true, false], "wide keeps its own state");
  assert.equal(p.saved().narrow.left, false);
});

test('broken storage does not break the layout', () => {
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  Object.assign(globalThis, { window, document: window.document });
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  const layout = createLayout();
  layout.fold('left');
  assert.equal(layout.isFolded('left'), true);
  delete globalThis.localStorage;
});

/* ----------------------------------------------------------------- fullscreen */

test('fullscreen uses a full-window mode where the Fullscreen API is missing; Escape leaves it', async () => {
  const p = page();
  assert.equal(p.$('#fs-toggle').title, 'Full screen');
  p.$('#fs-toggle').click();
  await new Promise((r) => setTimeout(r, 0));
  const stage = p.$('#stage');
  assert.deepEqual([stage.classList.contains('fs'), stage.classList.contains('pseudo-fs')], [true, true]);
  assert.equal(p.layout.isFullscreen(), true);
  assert.equal(p.$('#fs-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('#fs-toggle').title, 'Exit full screen');
  assert.equal(document.documentElement.style.overflow, 'hidden', 'page scroll is locked behind it');
  document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape' }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([stage.classList.contains('fs'), p.layout.isFullscreen(), document.documentElement.style.overflow], [false, false, '']);
});

test('uses the real Fullscreen API when available, and follows the browser leaving it', async () => {
  const p = page();
  const stage = p.$('#stage');
  let current = null;
  stage.requestFullscreen = async () => { current = stage; document.dispatchEvent(new p.window.Event('fullscreenchange')); };
  document.exitFullscreen = async () => { current = null; document.dispatchEvent(new p.window.Event('fullscreenchange')); };
  Object.defineProperty(document, 'fullscreenElement', { get: () => current, configurable: true });
  p.$('#fs-toggle').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([stage.classList.contains('fs'), stage.classList.contains('pseudo-fs')], [true, false], 'real fullscreen, not the fallback');
  assert.equal(document.documentElement.style.overflow, '');
  current = null; // the user pressed Esc: the browser exits on its own
  document.dispatchEvent(new p.window.Event('fullscreenchange'));
  assert.equal(stage.classList.contains('fs'), false);
  assert.equal(p.$('#fs-toggle').getAttribute('aria-pressed'), 'false');
});

test('if the browser refuses fullscreen, the fallback is used', async () => {
  const p = page();
  p.$('#stage').requestFullscreen = async () => { throw new Error('denied'); };
  p.$('#fs-toggle').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.$('#stage').classList.contains('pseudo-fs'), true);
});

test('the ▶ button appears in fullscreen only for a move, replays it, and follows the language', async () => {
  const p = page();
  let plays = 0;
  const play = p.$('#fs-play');
  assert.equal(play.hidden, true, 'nothing to play');
  p.layout.setMove({ label: () => 'Roundhouse kick', play: () => plays++ });
  assert.equal(play.hidden, true, 'not in fullscreen: the pose bar is already on screen');
  p.$('#fs-toggle').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(play.hidden, false);
  assert.equal(play.textContent, '▶ Roundhouse kick');
  assert.equal(play.getAttribute('aria-label'), 'Play “Roundhouse kick”');
  play.click();
  play.click();
  assert.equal(plays, 2, 'replays every time');
  p.layout.setMove(null); // a plain pose is shown now
  assert.equal(play.hidden, true);
  p.layout.setMove({ label: () => 'Coup de pied circulaire', play: () => {} });
  setLang('fr-BE');
  try {
    assert.equal(p.$('#fs-toggle').title, 'Quitter le plein écran');
    assert.equal(play.getAttribute('aria-label'), 'Jouer « Coup de pied circulaire »');
  } finally {
    setLang('en');
  }
  p.layout.exitFullscreen();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(play.hidden, true, 'hidden again outside fullscreen');
});

test('fold buttons are translated when the language changes', () => {
  const p = page();
  setLang('fr-BE');
  try {
    assert.match(p.btn('left').title, /^Masquer : /);
    p.btn('left').click();
    assert.match(p.btn('left').title, /^Afficher : /);
  } finally {
    setLang('en');
  }
});

/* ---------------------------------------------------------------- stylesheet */

test('stylesheet: nothing is pinned or fixed-size — side panels are fluid, only fullscreen is position:fixed', () => {
  assert.doesNotMatch(css, /position:\s*sticky/, 'no sticky elements');
  const fixed = [...css.matchAll(/([^{}]+)\{[^{}]*position:\s*fixed[^{}]*\}/g)].map((m) => m[1].trim());
  assert.deepEqual(fixed, ['#stage.pseudo-fs'], 'position:fixed only for the full-window fallback');
  assert.match(css, /grid-template-columns:\s*var\(--left-w\)\s+minmax\(0,\s*1fr\)\s+var\(--right-w\)/);
  assert.match(css, /--left-w:\s*clamp\(/);
  assert.match(css, /--right-w:\s*clamp\(/);
  assert.match(css, /@media \(max-width: 899px\)/);
  assert.match(css, /#stage\.fs #viewport\s*\{[^}]*flex:\s*1/, 'in fullscreen the 3D view fills the screen even on small screens');
  assert.match(css, /prefers-reduced-motion/);
});

test('a browser that never answers the fullscreen request still gets the full-window view at once', async () => {
  const p = page();
  let asked = 0;
  p.$('#stage').requestFullscreen = () => { asked++; return new Promise(() => {}); }; // pending forever, like an embedded webview
  p.$('#fs-toggle').click();
  // no waiting for the browser: the very next tick is already fullscreen
  assert.deepEqual([p.$('#stage').classList.contains('fs'), p.$('#stage').classList.contains('pseudo-fs'), asked], [true, true, 1]);
  assert.equal(p.$('#fs-toggle').getAttribute('aria-pressed'), 'true');
  p.$('#fs-toggle').click(); // and it can be left again
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.$('#stage').classList.contains('fs'), false);
});

test('a late "yes" from the browser after the user already left does not bring fullscreen back', async () => {
  const p = page();
  const stage = p.$('#stage');
  let current = null;
  let exits = 0;
  stage.requestFullscreen = () => new Promise(() => {});
  document.exitFullscreen = async () => { exits++; current = null; document.dispatchEvent(new p.window.Event('fullscreenchange')); };
  Object.defineProperty(document, 'fullscreenElement', { get: () => current, configurable: true });
  p.$('#fs-toggle').click(); // enter (browser hasn't answered)
  p.$('#fs-toggle').click(); // leave before it does
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stage.classList.contains('fs'), false);
  current = stage; // ...and now the browser says yes
  document.dispatchEvent(new p.window.Event('fullscreenchange'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(exits, 1, 'it is sent straight back out');
  assert.equal(stage.classList.contains('fs'), false);
});

test('real fullscreen replaces the full-window view; Esc from the browser leaves it for good', async () => {
  const p = page();
  const stage = p.$('#stage');
  let current = null;
  stage.requestFullscreen = async () => { current = stage; document.dispatchEvent(new p.window.Event('fullscreenchange')); };
  Object.defineProperty(document, 'fullscreenElement', { get: () => current, configurable: true });
  p.$('#fs-toggle').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([stage.classList.contains('fs'), stage.classList.contains('pseudo-fs')], [true, false]);
  current = null; // Esc
  document.dispatchEvent(new p.window.Event('fullscreenchange'));
  assert.equal(stage.classList.contains('fs'), false);
  p.$('#fs-toggle').click(); // can enter again afterwards
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(stage.classList.contains('fs'), true);
});
