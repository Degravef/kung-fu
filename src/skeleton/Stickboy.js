import * as THREE from 'three';
import { JOINT_DEFS, GROUND_CONTACTS, WEBS } from './jointDefs.js';

/**
 * Builds the three.js scene graph for the skeleton described in jointDefs.js
 * (one Object3D per joint, nested like the skeleton) and poses it from
 * channel values in degrees. Needs no DOM or renderer, so it also runs in Node.
 *
 * Pose format (everything optional, missing = 0 / rest):
 *   { root: { x, z, lift }, joints: { elbow_R: { flex: 90 }, … } }
 */

const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const DEG2RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

const THEMES = {
  dark: { L: 0x38bdf8, R: 0xfb923c, C: 0xe5e7eb, bone: 0x9aa7bb, skull: 0xf1f5f9 },
  light: { L: 0x0284c7, R: 0xea580c, C: 0x475569, bone: 0x7d8aa3, skull: 0xd5dbe8 },
};
export const SIDE_COLOR = THEMES.dark;
const BONE_COLOR = THEMES.dark.bone;
const HOVER_EMISSIVE = 0x7a6200;
const SELECT_COLOR = 0xffe14d;
/** NaN / non-numeric channel values count as 0 (rest); ±Infinity is left for the limits to clamp. */
const num = (v) => (Number.isNaN(Number(v)) ? 0 : Number(v));
/** Root offsets must be finite or the whole skeleton turns to NaN. */
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export class Stickboy {
  constructor(defs = JOINT_DEFS) {
    this.defs = defs;
    this.root = new THREE.Group();
    this.root.name = 'stickboy';
    /** name -> { def, object, marker, bone } */
    this.nodes = new Map();
    /** name -> { channel: degrees } (only joints that have channels) */
    this.values = new Map();
    this.rootOffset = { x: 0, z: 0, lift: 0 };
    this.autoGround = true;
    this.hovered = null;
    this.selected = null;

    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._geoCache = new Map();
    this._boneGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
    this._axes = new THREE.AxesHelper(1);
    this._axes.material.depthTest = false;
    this._axes.renderOrder = 20;

    this.markers = [];
    for (const def of defs) this._buildNode(def);
    this._buildWebs();
    this.setPose({});
  }

  /* ----------------------------------------------------------------- build */

  _sphere(radius) {
    if (!this._geoCache.has(radius)) this._geoCache.set(radius, new THREE.SphereGeometry(radius, 20, 14));
    return this._geoCache.get(radius);
  }

  _buildNode(def) {
    const object = new THREE.Group();
    object.name = def.name;
    object.position.fromArray(def.offset);
    (def.parent ? this.nodes.get(def.parent).object : this.root).add(object);

    const baseColor = new THREE.Color(SIDE_COLOR[def.side]);
    const material = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.4,
      metalness: 0.05,
      emissive: 0x000000,
    });
    const marker = new THREE.Mesh(this._sphere(def.radius), material);
    marker.name = `${def.name}:marker`;
    marker.castShadow = true;
    marker.userData = { joint: def.name, baseColor };
    object.add(marker);
    this.markers.push(marker);

    let bone = null;
    if (def.parent) {
      const len = Math.hypot(...def.offset);
      bone = new THREE.Mesh(this._boneGeo, new THREE.MeshStandardMaterial({ color: BONE_COLOR, roughness: 0.6 }));
      bone.name = `${def.name}:bone`;
      bone.scale.set(def.boneRadius, len, def.boneRadius);
      // A bone is rigid in its PARENT's frame (parent origin -> this joint's rest offset).
      bone.position.set(...def.offset.map((c) => c / 2));
      bone.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...def.offset).normalize());
      bone.castShadow = true;
      this.nodes.get(def.parent).object.add(bone);
    }

    if (def.name === 'head') this._buildHead(object);

    this.nodes.set(def.name, { def, object, marker, bone });
    if (def.dof.length) this.values.set(def.name, Object.fromEntries(def.dof.map((d) => [d.channel, 0])));
  }

  /** Head ball + face, so you can tell which way the character looks. */
  _buildHead(object) {
    const skin = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.5 });
    this._skin = skin;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 32, 20), skin);
    head.position.set(0, 0.125, 0);
    head.castShadow = true;
    head.name = 'head:skull';
    const dark = new THREE.MeshBasicMaterial({ color: 0x1b2236 });
    for (const x of [-0.04, 0.04]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), dark);
      eye.position.set(x, 0.04, 0.105);
      head.add(eye);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.04, 10), new THREE.MeshStandardMaterial({ color: 0xfb7185 }));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.005, 0.125);
    head.add(nose);
    object.add(head);
  }

  _buildWebs() {
    this._webPairs = WEBS.filter(([a, b]) => this.nodes.has(a) && this.nodes.has(b));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this._webPairs.length * 6), 3));
    this.webs = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: BONE_COLOR }));
    this.webs.frustumCulled = false;
    this.root.add(this.webs);
  }

  /* ------------------------------------------------------------------ pose */

  /** Replace the whole pose. Returns a list of values that were clamped to joint limits. */
  setPose(pose = {}) {
    const clamped = [];
    for (const [name, ch] of this.values) {
      const given = pose.joints?.[name] ?? {};
      for (const d of this.nodes.get(name).def.dof) {
        const want = num(given[d.channel]);
        const got = Math.min(d.max, Math.max(d.min, want));
        if (got !== want) clamped.push({ joint: name, channel: d.channel, requested: want, applied: got });
        ch[d.channel] = got;
      }
    }
    this.rootOffset = { x: finite(pose.root?.x), z: finite(pose.root?.z), lift: finite(pose.root?.lift) };
    this.update();
    return clamped;
  }

  /** Dense copy of the current pose (every channel present). */
  getPose() {
    const joints = {};
    for (const [name, ch] of this.values) joints[name] = { ...ch };
    return { root: { ...this.rootOffset }, joints };
  }

  /** `free` = ignore the joint's anatomical limits and allow the full ±180° (the UI's "unlock"). */
  setChannel(name, channel, degrees, free = false) {
    const d = this.nodes.get(name)?.def.dof.find((c) => c.channel === channel);
    if (!d) return;
    const [lo, hi] = free ? [-180, 180] : [d.min, d.max];
    this.values.get(name)[channel] = Math.min(hi, Math.max(lo, num(degrees)));
    this.update();
  }

  resetJoint(name) {
    const ch = this.values.get(name);
    if (ch) for (const k of Object.keys(ch)) ch[k] = 0;
    this.update();
  }

  /** Recompute every joint rotation from the channel values, then ground the feet. */
  update() {
    for (const [name, ch] of this.values) {
      const { def, object } = this.nodes.get(name);
      object.quaternion.identity();
      for (const d of def.dof) {
        const v = ch[d.channel];
        if (v) object.quaternion.multiply(this._q.setFromAxisAngle(AXIS[d.axis], d.sign * v * DEG2RAD));
      }
    }

    const pelvis = this.nodes.get('pelvis');
    const restY = pelvis.def.offset[1];
    pelvis.object.position.set(this.rootOffset.x, restY, this.rootOffset.z);
    this.root.updateMatrixWorld(true);

    let drop = 0;
    if (this.autoGround) {
      let minY = Infinity;
      for (const n of GROUND_CONTACTS) minY = Math.min(minY, this.worldPosition(n, this._v).y);
      drop = minY; // contact node centres touch the floor; the 1 cm marker balls sink in slightly
    }
    pelvis.object.position.y = restY - drop + this.rootOffset.lift;
    this.root.updateMatrixWorld(true);
    this._updateWebs();
  }

  _updateWebs() {
    const attr = this.webs.geometry.attributes.position;
    this._webPairs.forEach(([a, b], i) => {
      this.root.worldToLocal(this.worldPosition(a, this._v));
      attr.setXYZ(i * 2, this._v.x, this._v.y, this._v.z);
      this.root.worldToLocal(this.worldPosition(b, this._v));
      attr.setXYZ(i * 2 + 1, this._v.x, this._v.y, this._v.z);
    });
    attr.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- queries */

  worldPosition(name, target = new THREE.Vector3()) {
    return target.setFromMatrixPosition(this.nodes.get(name).object.matrixWorld);
  }

  /** Names from the root down to `name`, e.g. pelvis › spine › chest › … */
  chain(name) {
    const out = [];
    for (let n = name; n; n = this.nodes.get(n).def.parent) out.unshift(n);
    return out;
  }

  /* --------------------------------------------------------------- display */

  setHover(name) {
    if (name === this.hovered || (name && !this.nodes.has(name))) return;
    const prev = this.hovered;
    this.hovered = name;
    if (prev) this._paint(prev);
    if (name) this._paint(name);
  }

  setSelected(name) {
    if (name === this.selected || (name && !this.nodes.has(name))) return;
    const prev = this.selected;
    this.selected = name;
    if (prev) this._paint(prev);
    if (name) {
      this._paint(name);
      const { def, object } = this.nodes.get(name);
      object.add(this._axes);
      this._axes.scale.setScalar(Math.max(0.045, def.radius * 4.5));
    } else {
      this._axes.removeFromParent();
    }
  }

  _paint(name) {
    const { marker } = this.nodes.get(name);
    const sel = name === this.selected;
    const hov = name === this.hovered;
    marker.material.color.set(sel ? SELECT_COLOR : marker.userData.baseColor);
    marker.material.emissive.set(hov || sel ? HOVER_EMISSIVE : 0x000000);
    marker.scale.setScalar(sel ? 1.5 : hov ? 1.35 : 1);
  }

  /** Recolour the figure for 'dark' or 'light' backgrounds. */
  setTheme(theme) {
    const t = THEMES[theme] ?? THEMES.dark;
    for (const { def, marker, bone } of this.nodes.values()) {
      marker.userData.baseColor.set(t[def.side]);
      this._paint(def.name);
      bone?.material.color.set(t.bone);
    }
    this.webs.material.color.set(t.bone);
    this._skin.color.set(t.skull);
  }

  setBonesVisible(on) {
    for (const { bone } of this.nodes.values()) if (bone) bone.visible = on;
    this.webs.visible = on;
  }
}
