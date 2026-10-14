import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Stickboy } from './skeleton/Stickboy.js';
import { POSES, MOVES, lerpPose, easeInOut } from './poses.js';
import { createUI } from './ui.js';
import { createPositionsPanel } from './positionsUI.js';
import { detectLang, setLang, onLangChange, t, jointText, sideLetter } from './i18n/index.js';
import './style.css';

const $ = (sel) => document.querySelector(sel);
const viewport = $('#viewport');
const canvas = $('#canvas');

/* ------------------------------------------------------------ scene */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f1a);
scene.fog = new THREE.Fog(0x0b0f1a, 9, 22);

const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);
camera.position.set(2.3, 1.5, 3.6);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.9, 0);
controls.enableDamping = true;
controls.minDistance = 0.12;
controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI * 0.495;

scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x1a1d2b, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 5, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 1, far: 14 });
sun.shadow.bias = -0.0004;
scene.add(sun);

const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 72), new THREE.MeshStandardMaterial({ color: 0x141a2e, roughness: 1 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
let grid = null;
// Floor arrow = the direction the character faces (+Z).
const front = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.004, 0.75), 0.45, 0x5566a0, 0.14, 0.1);
scene.add(front);

const SCENE_THEME = {
  dark: { bg: 0x0b0f1a, floor: 0x141a2e, grid: [0x34406a, 0x222b4a], arrow: 0x5566a0 },
  light: { bg: 0xeef1f7, floor: 0xffffff, grid: [0xaab4cc, 0xc6cee0], arrow: 0x7f8fb5 },
};

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const btn = $('#theme-toggle');
  btn.textContent = t(dark ? 'theme_to_light' : 'theme_to_dark');
  btn.title = t(dark ? 'theme_title_light' : 'theme_title_dark');
}

function applyTheme(theme, persist = true) {
  const t = SCENE_THEME[theme];
  document.documentElement.dataset.theme = theme;
  scene.background.set(t.bg);
  scene.fog.color.set(t.bg);
  floor.material.color.set(t.floor);
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  grid = new THREE.GridHelper(14, 28, ...t.grid);
  grid.position.y = 0.002;
  scene.add(grid);
  front.setColor(t.arrow);
  stickboy.setTheme(theme);
  updateThemeButton();
  if (persist) {
    try { localStorage.setItem('theme', theme); } catch { /* private mode: just don't remember it */ }
  }
}

const stickboy = new Stickboy();
scene.add(stickboy.root);

// Language: saved choice, else the browser's preference (fr/nl -> Belgian variants), else English.
let savedLang = null;
try { savedLang = localStorage.getItem('lang'); } catch { /* storage blocked */ }
setLang(detectLang(savedLang, navigator.languages ?? [navigator.language]));
onLangChange((code) => {
  updateThemeButton();
  try { localStorage.setItem('lang', code); } catch { /* just don't remember it */ }
});

let savedTheme = null;
try { savedTheme = localStorage.getItem('theme'); } catch { /* storage blocked */ }
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(savedTheme ?? (darkQuery.matches ? 'dark' : 'light'), false);
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
// Until the user picks a theme themselves, follow the OS.
darkQuery.addEventListener('change', (e) => {
  let chosen = null;
  try { chosen = localStorage.getItem('theme'); } catch { /* ignore */ }
  if (!chosen) applyTheme(e.matches ? 'dark' : 'light', false);
});

/* ------------------------------------------------- state & helpers */

let hovered = null;
let selected = null;
let anim = null; // pose blend in progress
let focus = null; // camera fly-to in progress
let showAllLabels = false;

const tmp = new THREE.Vector3();
const dirTmp = new THREE.Vector3();
const pos = (name) => stickboy.worldPosition(name, new THREE.Vector3());

let panel = null; // the Positions tab (owns the user's saved poses)
const resolvePose = (key) => POSES[key] ?? panel?.poses().find((p) => p.id === key);

let queue = []; // steps still to play after the current blend (a MOVE)
let currentPoseKey = 'attention'; // last pose reached, null once the user edits by hand

function startStep({ pose, duration }) {
  const to = resolvePose(pose);
  if (!to) return; // e.g. a saved pose deleted in the meantime
  anim = { from: stickboy.getPose(), to, key: pose, t: 0, dur: duration };
  ui.setActivePose(pose);
}

function playPose(key, duration = 0.9) {
  queue = [];
  ui.setActiveMove(null);
  startStep({ pose: key, duration });
}

/**
 * Play a move. A built-in move settles into its starting pose (unless already there), then runs its steps.
 * A saved move is just its ordered steps. Steps whose pose no longer exists (deleted) are skipped.
 */
function playMove(key) {
  const builtin = MOVES[key];
  const saved = builtin ? null : panel?.moves().find((m) => m.id === key);
  if (!builtin && !saved) return;
  const steps = builtin ? [...(currentPoseKey === builtin.from ? [] : [{ pose: builtin.from, duration: 0.5 }]), ...builtin.steps] : saved.steps;
  if (!runSteps(steps)) return;
  ui.setActiveMove(key);
}

/** Queue steps (skipping missing poses) and start; false if nothing could play. */
function runSteps(steps) {
  const playable = steps.filter((s) => resolvePose(s.pose));
  if (!playable.length) return false;
  queue = playable.slice(1);
  startStep(playable[0]);
  return true;
}

/** Preview an unsaved list of steps (the move builder's draft). */
function playSteps(steps) {
  ui.setActiveMove(null);
  runSteps(steps);
}

function applyPose(p) {
  const clamped = stickboy.setPose(p);
  if (clamped.length) console.warn('Pose values outside joint limits were clamped:', clamped);
  ui.sync();
}

/** `where` is [target, distance] or a function returning it (re-read every frame, so the camera follows a moving pose). */
function flyTo(where, distance, duration = 0.7) {
  dirTmp.copy(camera.position).sub(controls.target).normalize();
  focus = {
    t: 0,
    dur: duration,
    dir: dirTmp.clone(),
    where: typeof where === 'function' ? where : () => [where, distance],
    fromTarget: controls.target.clone(),
    fromPos: camera.position.clone(),
  };
}

const VIEWS = {
  body: () => [new THREE.Vector3(0, 0.9, 0), 4.2],
  head: () => [pos('head').add(new THREE.Vector3(0, 0.1, 0)), 0.9],
  handL: () => [pos('middle_mcp_L'), 0.5],
  handR: () => [pos('middle_mcp_R'), 0.5],
  feet: () => [pos('ankle_L').add(pos('ankle_R')).multiplyScalar(0.5), 1.8],
};

/* ---------------------------------------------------------------- UI */

/** The user changed the figure by hand (slider, saved position…): stop any running animation. */
function handEdited() {
  anim = null;
  queue = [];
  currentPoseKey = null;
  ui.setActivePose(null);
  ui.setActiveMove(null);
}

const ui = createUI(stickboy, {
  select,
  hover,
  pose: (key) => playPose(key),
  userPoses: () => panel?.poses() ?? [],
  userMoves: () => panel?.moves() ?? [],
  move: (key) => playMove(key),
  view: (key) => flyTo(VIEWS[key]),
  focus: (name) => flyTo(() => [pos(name), focusDistance(name)]),
  edited: handEdited,
  toggleLabels: (on) => (showAllLabels = on),
  toggleBones: (on) => stickboy.setBonesVisible(on),
  toggleGround(on) {
    stickboy.autoGround = on;
    stickboy.update();
  },
});

panel = createPositionsPanel(stickboy, {
  applied() {
    handEdited();
    ui.sync();
  },
  playPose: (key) => playPose(key),
  posesChanged: () => ui.refreshPoseBar(),
  movesChanged: () => ui.refreshPoseBar(),
  playSteps,
  playMove,
});
ui.refreshPoseBar(); // saved poses from the last visit

const focusDistance = (name) => Math.max(0.35, stickboy.nodes.get(name).def.radius * 20);

function select(name) {
  if (name && !stickboy.nodes.has(name)) return;
  selected = name;
  stickboy.setSelected(name);
  ui.select(name);
}

function hover(name) {
  if (name && !stickboy.nodes.has(name)) return;
  hovered = name;
  stickboy.setHover(name);
  ui.hover(name);
  canvas.classList.toggle('hot', !!name);
}

/* ------------------------------------------- picking (screen space) */
// Finger joints are a few pixels wide, so instead of ray-casting against tiny
// spheres we pick the joint whose *projected centre* is closest to the cursor.

const world = new THREE.Vector3();
function pickJoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const pxPerMetre = rect.height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let best = null;
  let bestKey = null;
  // Candidate = a joint ball near the cursor. Balls the cursor is actually ON beat
  // merely-near ones, and among those the one closest to the camera wins (so a big
  // joint behind a hand can't steal the click from the finger in front of it).
  const consider = (name, centre, radius) => {
    const dist = centre.distanceTo(camera.position);
    const radiusPx = (radius * pxPerMetre) / dist;
    centre.project(camera);
    if (centre.z > 1) return;
    const d = Math.hypot((centre.x * 0.5 + 0.5) * rect.width - px, (-centre.y * 0.5 + 0.5) * rect.height - py);
    const score = d / (radiusPx * 1.3 + 8);
    if (score >= 1) return;
    const key = d <= radiusPx ? [0, dist] : [1, score];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      bestKey = key;
      best = name;
    }
  };
  for (const [name, { def }] of stickboy.nodes) consider(name, stickboy.worldPosition(name, world), def.radius);
  // The skull is drawn as a big ball above the 'head' joint: clicking it should pick 'head' too.
  const head = stickboy.nodes.get('head').object;
  consider('head', world.set(0, 0.125, 0).applyMatrix4(head.matrixWorld), 0.115);
  return best;
}

let downAt = null;
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  flyCancel();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons === 0) hover(pickJoint(e.clientX, e.clientY));
});
canvas.addEventListener('pointerleave', () => hover(null));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return; // it was an orbit drag
  select(pickJoint(e.clientX, e.clientY));
});
canvas.addEventListener('dblclick', (e) => {
  const name = pickJoint(e.clientX, e.clientY);
  if (name) flyTo(() => [pos(name), focusDistance(name)]);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.activeElement?.type !== 'search') select(null);
});
const flyCancel = () => (focus = null);
controls.addEventListener('start', flyCancel);

/* ------------------------------------------------------------ labels */

const labelLayer = $('#labels');
const tooltip = $('#tooltip');
const tags = new Map();
/** Compact translated tag text, e.g. "Épaule (D)", "Index · bout du doigt (G)". */
function tagText(name) {
  const def = stickboy.nodes.get(name).def;
  const short = jointText(def).short;
  return def.side === 'C' ? short : `${short} (${sideLetter(def.side)})`;
}

for (const [name] of stickboy.nodes) {
  const tag = Object.assign(document.createElement('span'), { className: 'tag', textContent: tagText(name), hidden: true });
  labelLayer.append(tag);
  tags.set(name, tag);
}
const selTag = Object.assign(document.createElement('span'), { className: 'tag sel', hidden: true });
labelLayer.append(selTag);
onLangChange(() => {
  for (const [name, tag] of tags) tag.textContent = tagText(name);
});

/** Project a joint to stage pixels; null if it's behind the camera. */
function screenOf(name) {
  stickboy.worldPosition(name, tmp).project(camera);
  if (tmp.z > 1) return null;
  const r = canvas.getBoundingClientRect();
  return { x: (tmp.x * 0.5 + 0.5) * r.width, y: (-tmp.y * 0.5 + 0.5) * r.height };
}

function placeTag(el, name, dx = 0, dy = 0) {
  const s = screenOf(name);
  el.hidden = !s;
  if (s) el.style.transform = `translate(${s.x + dx}px, ${s.y + dy}px) translate(-50%, -100%)`;
}

function updateLabels() {
  // Finger labels only make sense once you're close; at body distance they'd be a smear.
  const close = camera.position.distanceTo(controls.target) < 1.6;
  for (const [name, tag] of tags) {
    const legible = close || !stickboy.nodes.get(name).def.region.endsWith('hand');
    if (showAllLabels && name !== selected && legible) placeTag(tag, name, 0, -9);
    else tag.hidden = true;
  }

  if (selected && selected !== hovered) {
    selTag.textContent = tagText(selected);
    placeTag(selTag, selected, 0, -14);
  } else {
    selTag.hidden = true;
  }

  const s = hovered && screenOf(hovered);
  tooltip.hidden = !s;
  if (s) {
    const def = stickboy.nodes.get(hovered).def;
    tooltip.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: jointText(def).label }),
      Object.assign(document.createElement('small'), { textContent: def.name }),
    );
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let x = s.x + 16;
    let y = s.y - 12;
    if (x + tw > viewport.clientWidth - 4) x = s.x - 16 - tw; // flip to the left of the joint
    if (y < 4) y = s.y + 16;
    if (y + th > viewport.clientHeight - 4) y = viewport.clientHeight - 4 - th;
    tooltip.style.transform = `translate(${Math.max(4, x)}px, ${y}px)`;
  }
}

/* ------------------------------------------------------------- loop */

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // also follows browser zoom / monitor changes
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

/** Advance pose / camera animations by `dt` seconds (also called directly by tests). */
function advance(dt) {
  if (anim) {
    anim.t = Math.min(1, anim.t + dt / anim.dur);
    applyPose(anim.t < 1 ? lerpPose(anim.from, anim.to, easeInOut(anim.t)) : anim.to);
    if (anim.t >= 1) {
      currentPoseKey = anim.key;
      anim = null;
      if (queue.length) startStep(queue.shift());
      else ui.setActiveMove(null);
    }
  }

  if (focus) {
    focus.t = Math.min(1, focus.t + dt / focus.dur);
    const k = easeInOut(focus.t);
    const [target, dist] = focus.where();
    controls.target.lerpVectors(focus.fromTarget, target, k);
    camera.position.lerpVectors(focus.fromPos, tmp.copy(target).addScaledVector(focus.dir, dist), k);
    if (focus.t >= 1) focus = null;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  advance(dt);

  controls.update();
  camera.updateMatrixWorld(); // labels project with the camera as it is NOW, not last frame
  updateLabels();
  ui.tick();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

applyPose(POSES.attention);
ui.setActivePose('attention');
requestAnimationFrame(frame);

// Handy for poking around from the console while developing.
window.kungfu = { stickboy, camera, controls, POSES, VIEWS, ui, playPose, playMove, applyPose, advance, select, hover, pickJoint, flyTo, focusDistance };
