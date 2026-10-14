import { $ } from './dom.js';
import { t, onLangChange } from './i18n/index.js';

const STORAGE_KEY = 'kungfu.layout';
const NARROW = '(max-width: 899px)';
const PANELS = ['left', 'right', 'toolbar', 'posebar'];

/**
 * Layout behaviour: every panel / bar can be folded, the choice is remembered (separately for wide and
 * narrow screens), and the 3D view can go full screen — with a ▶ button when a move is active.
 *
 * Folding is just a class on #app (`fold-left`, `fold-right`, `fold-toolbar`, `fold-posebar`) plus
 * aria-expanded on the buttons; the CSS does the rest.
 */
export function createLayout() {
  const app = $('#app');
  const stage = $('#stage');
  const fsToggle = $('#fs-toggle');
  const fsPlay = $('#fs-play');
  const mq = window.matchMedia ? window.matchMedia(NARROW) : { matches: false, addEventListener() {} };

  /* ------------------------------------------------------------------ folding */

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
      return {};
    }
  };
  const write = (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    } catch { /* storage blocked: the layout just isn't remembered */ }
  };

  const mode = () => (mq.matches ? 'narrow' : 'wide');
  // First visit: wide screens start fully open; small screens start with the 3D view and the pose bar only.
  const defaults = (m) => ({ left: m === 'narrow', right: m === 'narrow', toolbar: m === 'narrow', posebar: false });

  let folded = { ...defaults(mode()), ...(read()[mode()] ?? {}) };

  function renderFold() {
    for (const name of PANELS) app.classList.toggle(`fold-${name}`, !!folded[name]);
    for (const btn of document.querySelectorAll('[data-fold]')) {
      const isFolded = !!folded[btn.dataset.fold];
      const label = btn.querySelector('.fold-label')?.textContent ?? '';
      btn.setAttribute('aria-expanded', String(!isFolded));
      btn.title = t(isFolded ? 'fold_show' : 'fold_hide', { name: label });
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function fold(name, value = !folded[name]) {
    folded[name] = !!value;
    const all = read();
    all[mode()] = { ...folded };
    write(all);
    renderFold();
  }

  for (const btn of document.querySelectorAll('[data-fold]')) btn.addEventListener('click', () => fold(btn.dataset.fold));

  // Crossing the wide/narrow breakpoint (rotating a phone, resizing a window): use that mode's own state.
  mq.addEventListener?.('change', () => {
    folded = { ...defaults(mode()), ...(read()[mode()] ?? {}) };
    renderFold();
  });

  /* --------------------------------------------------------------- fullscreen */

  // The full-window view (`pseudo`) is shown at once on click; the browser's real fullscreen is requested on top
  // and takes over if it succeeds. Some browsers (iPhone Safari, embedded webviews) never answer the request, so
  // nothing may wait for it.
  let pseudo = false;
  let wanted = false; // the user asked for fullscreen and hasn't left it
  let move = null; // { label: () => string, play: () => void } — the active move, if any

  const isReal = () => document.fullscreenElement === stage;
  const isFullscreen = () => isReal() || pseudo;

  function renderFs() {
    const on = isFullscreen();
    stage.classList.toggle('fs', on);
    stage.classList.toggle('pseudo-fs', pseudo);
    document.documentElement.style.overflow = pseudo ? 'hidden' : '';
    fsToggle.textContent = on ? '✕' : '⛶';
    fsToggle.title = t(on ? 'fs_exit' : 'fs_enter');
    fsToggle.setAttribute('aria-label', fsToggle.title);
    fsToggle.setAttribute('aria-pressed', String(on));
    // The play button only exists for a move, and only matters while the controls are tucked away.
    fsPlay.hidden = !(on && move);
    if (move) {
      const name = move.label();
      fsPlay.textContent = `▶ ${name}`;
      fsPlay.title = t('mv_play_title', { name });
      fsPlay.setAttribute('aria-label', fsPlay.title);
    }
  }

  async function enterFullscreen() {
    if (isFullscreen()) return;
    wanted = true;
    pseudo = true;
    renderFs(); // immediate feedback, whatever the browser does next
    try {
      await stage.requestFullscreen?.(); // may reject, or never settle: both are fine
    } catch { /* keep the full-window view */ }
  }

  /** The browser entered or left real fullscreen (button, or the user pressing Esc). */
  function onFullscreenChange() {
    if (isReal()) {
      if (!wanted) {
        // it answered late, after the user had already left: don't resurrect fullscreen
        document.exitFullscreen?.().catch(() => {});
        return;
      }
      pseudo = false; // the real thing replaces the full-window view
    } else if (wanted && !pseudo) {
      wanted = false; // the browser left fullscreen on its own (Esc)
    }
    renderFs();
  }

  async function exitFullscreen() {
    wanted = false;
    pseudo = false;
    if (isReal()) {
      try {
        await document.exitFullscreen();
      } catch { /* already leaving */ }
    }
    renderFs();
  }

  const toggleFullscreen = () => (isFullscreen() ? exitFullscreen() : enterFullscreen());

  fsToggle.addEventListener('click', toggleFullscreen);
  fsPlay.addEventListener('click', () => move?.play());
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pseudo) exitFullscreen(); // real fullscreen: the browser handles Esc itself
  });

  /* ------------------------------------------------------------------- public */

  const relocalize = () => {
    renderFold();
    renderFs();
  };
  onLangChange(relocalize);
  relocalize();

  return {
    fold,
    isFolded: (name) => !!folded[name],
    isFullscreen,
    toggleFullscreen,
    exitFullscreen,
    /** The move now shown (null for a plain pose): fullscreen offers a ▶ button for it. */
    setMove(info) {
      move = info;
      renderFs();
    },
    relocalize,
  };
}
