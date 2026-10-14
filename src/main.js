import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Stickboy } from './skeleton/Stickboy.js';
import { POSES, lerpPose, easeInOut } from './poses.js';
import { createUI } from './ui.js';
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
const grid = new THREE.GridHelper(14, 28, 0x34406a, 0x222b4a);
grid.position.y = 0.002;
scene.add(grid);
// Floor arrow = the direction the character faces (+Z).
const front = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.004, 0.75), 0.45, 0x5566a0, 0.14, 0.1);
scene.add(front);

const stickboy = new Stickboy();
scene.add(stickboy.root);

/* ------------------------------------------------- state & helpers */

let hovered = null;
let selected = null;
let anim = null; // pose blend in progress
let focus = null; // camera fly-to in progress
let showAllLabels = false;

const tmp = new THREE.Vector3();
const dirTmp = new THREE.Vector3();
const pos = (name) => stickboy.worldPosition(name, new THREE.Vector3());

function playPose(key, duration = 0.9) {
  anim = { from: stickboy.getPose(), to: POSES[key], key, t: 0, dur: duration };
  ui.setActivePose(key);
}

function applyPose(p) {
  const clamped = stickboy.setPose(p);
  if (clamped.length) console.warn('Pose values outside joint limits were clamped:', clamped);
  ui.sync();
}

function flyTo(target, distance, duration = 0.7) {
  dirTmp.copy(camera.position).sub(controls.target).normalize();
  focus = {
    t: 0,
    dur: duration,
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
    fromPos: camera.position.clone(),
    toPos: target.clone().addScaledVector(dirTmp, distance),
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

const ui = createUI(stickboy, {
  select,
  hover,
  pose: (key) => playPose(key),
  view: (key) => flyTo(...VIEWS[key]()),
  focus: (name) => flyTo(pos(name), focusDistance(name)),
  edited() {
    anim = null; // the user took over
    ui.setActivePose(null);
  },
  toggleLabels: (on) => (showAllLabels = on),
  toggleBones: (on) => stickboy.setBonesVisible(on),
  toggleGround(on) {
    stickboy.autoGround = on;
    stickboy.update();
  },
});

const focusDistance = (name) => Math.max(0.35, stickboy.nodes.get(name).def.radius * 20);

function select(name) {
  selected = name;
  stickboy.setSelected(name);
  ui.select(name);
}

function hover(name) {
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
  let bestScore = 1;
  for (const [name, { def }] of stickboy.nodes) {
    stickboy.worldPosition(name, world);
    const dist = world.distanceTo(camera.position);
    const radiusPx = (def.radius * pxPerMetre) / dist;
    world.project(camera);
    if (world.z > 1) continue;
    const d = Math.hypot((world.x * 0.5 + 0.5) * rect.width - px, (-world.y * 0.5 + 0.5) * rect.height - py);
    const score = d / (radiusPx * 1.3 + 8);
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
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
  if (name) flyTo(pos(name), focusDistance(name));
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
for (const [name] of stickboy.nodes) {
  const tag = Object.assign(document.createElement('span'), { className: 'tag', textContent: name, hidden: true });
  labelLayer.append(tag);
  tags.set(name, tag);
}
const selTag = Object.assign(document.createElement('span'), { className: 'tag sel', hidden: true });
labelLayer.append(selTag);

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
  for (const [name, tag] of tags) {
    if (showAllLabels && name !== selected) placeTag(tag, name, 0, -9);
    else tag.hidden = true;
  }

  if (selected && selected !== hovered) {
    selTag.textContent = stickboy.nodes.get(selected).def.name;
    placeTag(selTag, selected, 0, -14);
  } else {
    selTag.hidden = true;
  }

  const s = hovered && screenOf(hovered);
  tooltip.hidden = !s;
  if (s) {
    const def = stickboy.nodes.get(hovered).def;
    tooltip.replaceChildren(
      Object.assign(document.createElement('b'), { textContent: def.label }),
      Object.assign(document.createElement('small'), { textContent: def.name }),
    );
    tooltip.style.transform = `translate(${s.x + 16}px, ${s.y - 12}px)`;
  }
}

/* ------------------------------------------------------------- loop */

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (anim) {
    anim.t = Math.min(1, anim.t + dt / anim.dur);
    applyPose(anim.t < 1 ? lerpPose(anim.from, anim.to, easeInOut(anim.t)) : anim.to);
    if (anim.t >= 1) anim = null;
  }

  if (focus) {
    focus.t = Math.min(1, focus.t + dt / focus.dur);
    const k = easeInOut(focus.t);
    controls.target.lerpVectors(focus.fromTarget, focus.toTarget, k);
    camera.position.lerpVectors(focus.fromPos, focus.toPos, k);
    if (focus.t >= 1) focus = null;
  }

  controls.update();
  updateLabels();
  ui.tick();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

applyPose(POSES.attention);
ui.setActivePose('attention');
requestAnimationFrame(frame);

// Handy for poking around from the console while developing.
window.kungfu = { stickboy, camera, controls, POSES, VIEWS, ui, playPose, applyPose, select, hover, pickJoint, flyTo, focusDistance };
