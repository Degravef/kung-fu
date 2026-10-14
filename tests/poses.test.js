/**
 * Poses and blending: data integrity, lerpPose / easeInOut, auto-grounding, and
 * physical plausibility of every named pose, measured on WORLD positions.
 *
 * Run: node --test tests/poses.test.js
 *
 * The suite encodes the INTENDED behaviour. Where a pose contradicts what is
 * anatomically / physically right the assertion is left failing on purpose
 * (the failure message carries the measured numbers) - do not loosen it.
 *
 * Conventions: metres and degrees. +Y up, +Z = facing direction, +X = the
 * character's LEFT. Everything is deterministic and runs without a DOM.
 */
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Stickboy } from '../src/skeleton/Stickboy.js';
import { JOINT_DEFS, JOINT_BY_NAME, GROUND_CONTACTS } from '../src/skeleton/jointDefs.js';
import { POSES, POSE_ORDER, lerpPose, easeInOut } from '../src/poses.js';

/* ------------------------------------------------------------------ helpers */

const SIDES = ['L', 'R'];
const FOUR = ['index', 'middle', 'ring', 'pinky'];
const FINGERS = ['thumb', ...FOUR];
const HAND_DEFS = JOINT_DEFS.filter((d) => d.region.endsWith('hand'));
const ALL_KEYS = [...new Set([...POSE_ORDER, ...Object.keys(POSES)])];
const FLOOR_TOL = 0.002; // 2 mm

const chain = (f, s) =>
  f === 'thumb'
    ? [`thumb_cmc_${s}`, `thumb_mcp_${s}`, `thumb_ip_${s}`, `thumb_tip_${s}`]
    : [`${f}_mcp_${s}`, `${f}_pip_${s}`, `${f}_dip_${s}`, `${f}_tip_${s}`];

// tiny vector toolkit on plain {x,y,z}
const vec = (p) => ({ x: p.x, y: p.y, z: p.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.sqrt(dot(a, a));
const dist = (a, b) => len(sub(a, b));
const centroid = (pts) => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  z: pts.reduce((s, p) => s + p.z, 0) / pts.length,
});
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) * 180) / Math.PI;
/** interior angle at b of the chain a-b-c (180 = straight) */
const jointAngle = (a, b, c) => angleDeg(sub(a, b), sub(c, b));
const yawDeg = (f) => (Math.atan2(f.x, f.z) * 180) / Math.PI; // + = towards the character's left

function segDist(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t });
}

const show = (v, unit) => (unit === 'deg' ? `${v.toFixed(1)} deg` : unit === 'ratio' ? v.toFixed(2) : `${(v * 100).toFixed(1)} cm`);
const le = (a, b, what, unit = 'm') => assert.ok(a <= b, `${what}: got ${show(a, unit)}, expected <= ${show(b, unit)}`);
const ge = (a, b, what, unit = 'm') => assert.ok(a >= b, `${what}: got ${show(a, unit)}, expected >= ${show(b, unit)}`);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, expected ${b} (+-${tol})`);

/* -------------------------------------------------------------- pose staging */

const boy = new Stickboy();

/** Apply a pose (auto-ground ON) and snapshot everything the tests need as plain numbers. */
function stage(pose, { hand = true } = {}) {
  boy.autoGround = true;
  const clamped = boy.setPose(pose);
  const pos = {};
  for (const d of JOINT_DEFS) pos[d.name] = vec(boy.worldPosition(d.name));

  const mesh = boy.root.getObjectByName('head:skull');
  assert.ok(mesh, 'Stickboy should expose the visible head as a mesh named "head:skull"');
  const skull = { c: vec(new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld)), r: mesh.geometry.parameters.radius };

  const headObj = boy.nodes.get('head').object;
  const headForward = sub(vec(headObj.localToWorld(new THREE.Vector3(0, 0, 1))), vec(headObj.localToWorld(new THREE.Vector3(0, 0, 0))));

  // every hand node expressed in its WRIST frame (x = palm normal axis, -y = towards fingertips, z = thumb side)
  const local = {};
  if (hand) {
    for (const s of SIDES) {
      const wrist = boy.nodes.get(`wrist_${s}`).object;
      for (const d of HAND_DEFS) if (d.side === s) local[d.name] = vec(wrist.worldToLocal(boy.worldPosition(d.name)));
    }
  }
  return { pos, skull, headForward, local, clamped };
}

const cache = new Map();
const at = (key) => {
  if (!POSES[key]) assert.fail(`POSES.${key} is missing`);
  if (!cache.has(key)) cache.set(key, stage(POSES[key]));
  return cache.get(key);
};
const REST = stage({});

/* handy measurements on a snapshot */
const tipDist = (s, side, f) => dist(s.pos[`wrist_${side}`], s.pos[chain(f, side)[3]]);
const handCentre = (s, side) => centroid(HAND_DEFS.filter((d) => d.side === side).map((d) => s.pos[d.name]));
const footMinY = (s, side) => Math.min(...['heel', 'toe', 'toe_tip'].map((n) => s.pos[`${n}_${side}`].y));
const chinY = (s) => s.skull.c.y - s.skull.r;
const mirrorX = (p) => ({ x: -p.x, y: p.y, z: p.z });

/* crude body model used for hand-vs-body clearance and balance */
const TORSO = [['pelvis', 'spine'], ['spine', 'chest'], ['chest', 'neck']];
const TORSO_R = 0.08; // half-depth of a slim torso around the spine line
const LEGS = [['hip_L', 'knee_L'], ['knee_L', 'ankle_L'], ['hip_R', 'knee_R'], ['knee_R', 'ankle_R']];
const LEG_R = 0.05;
const CORE_NODES = ['head', 'neck', 'chest', 'spine', 'pelvis'];

function clearance(s) {
  const slot = () => ({ gap: Infinity, who: '' });
  const out = { skull: slot(), torso: slot(), legs: slot(), otherHand: slot(), core: slot() };
  const upd = (o, gap, who) => {
    if (gap < o.gap) Object.assign(o, { gap, who });
  };
  for (const d of HAND_DEFS) {
    const p = s.pos[d.name];
    upd(out.skull, dist(p, s.skull.c) - s.skull.r - d.radius, d.name);
    for (const [a, b] of TORSO) upd(out.torso, segDist(p, s.pos[a], s.pos[b]) - TORSO_R - d.radius, `${d.name} ~ ${a}-${b}`);
    for (const [a, b] of LEGS) upd(out.legs, segDist(p, s.pos[a], s.pos[b]) - LEG_R - d.radius, `${d.name} ~ ${a}-${b}`);
    for (const o of HAND_DEFS) if (o.side !== d.side) upd(out.otherHand, dist(p, s.pos[o.name]) - d.radius - o.radius, `${d.name} ~ ${o.name}`);
    for (const n of CORE_NODES) upd(out.core, dist(p, s.pos[n]), `${d.name} ~ ${n}`);
  }
  return out;
}

/** Mass-weighted centre of mass (Dempster-style segment fractions; good to a few cm). */
function centerOfMass(s) {
  const mid = (a, b, t) => ({
    x: s.pos[a].x + (s.pos[b].x - s.pos[a].x) * t,
    y: s.pos[a].y + (s.pos[b].y - s.pos[a].y) * t,
    z: s.pos[a].z + (s.pos[b].z - s.pos[a].z) * t,
  });
  const parts = [[0.497, mid('pelvis', 'neck', 0.5)], [0.081, s.skull.c]];
  for (const k of SIDES) {
    parts.push(
      [0.028, mid(`shoulder_${k}`, `elbow_${k}`, 0.436)],
      [0.016, mid(`elbow_${k}`, `wrist_${k}`, 0.43)],
      [0.006, mid(`wrist_${k}`, `middle_tip_${k}`, 0.5)],
      [0.1, mid(`hip_${k}`, `knee_${k}`, 0.433)],
      [0.0465, mid(`knee_${k}`, `ankle_${k}`, 0.433)],
      [0.0145, mid(`heel_${k}`, `toe_tip_${k}`, 0.5)],
    );
  }
  const M = parts.reduce((a, [m]) => a + m, 0);
  return {
    x: parts.reduce((a, [m, p]) => a + (m * p.x) / M, 0),
    y: parts.reduce((a, [m, p]) => a + (m * p.y) / M, 0),
    z: parts.reduce((a, [m, p]) => a + (m * p.z) / M, 0),
  };
}

/** XZ box around every foot node that is within 4 cm of the floor, grown by `margin` (half a foot width). */
function supportBox(s, margin = 0.05, contactY = 0.04) {
  const pts = ['heel', 'toe', 'toe_tip'].flatMap((n) => SIDES.map((k) => s.pos[`${n}_${k}`])).filter((p) => p.y <= contactY);
  assert.ok(pts.length > 0, 'no foot node touches the floor');
  return {
    minX: Math.min(...pts.map((p) => p.x)) - margin,
    maxX: Math.max(...pts.map((p) => p.x)) + margin,
    minZ: Math.min(...pts.map((p) => p.z)) - margin,
    maxZ: Math.max(...pts.map((p) => p.z)) + margin,
  };
}

const channelOf = (pose, joint, ch) => pose.joints?.[joint]?.[ch] ?? 0;
function allChannels(...poses) {
  const set = new Set();
  for (const p of poses) for (const [j, chs] of Object.entries(p.joints ?? {})) for (const c of Object.keys(chs)) set.add(`${j}.${c}`);
  return [...set].map((k) => k.split('.'));
}
function assertPoseClose(actual, expected, tol, label) {
  for (const k of ['x', 'z', 'lift']) near(actual.root[k], expected.root?.[k] ?? 0, tol, `${label}: root.${k}`);
  for (const [j, c] of allChannels(actual, expected)) near(channelOf(actual, j, c), channelOf(expected, j, c), tol, `${label}: ${j}.${c}`);
}

const PAIRS = POSE_ORDER.flatMap((a) => POSE_ORDER.filter((b) => b !== a).map((b) => [a, b]));

/* ======================================================================= 1. */

describe('pose data', () => {
  it('POSE_ORDER lists every pose in POSES exactly once, in a known order', () => {
    assert.deepEqual([...POSE_ORDER].sort(), Object.keys(POSES).sort(), 'POSE_ORDER and POSES keys must match');
    assert.equal(new Set(POSE_ORDER).size, POSE_ORDER.length, 'POSE_ORDER must not contain duplicates');
    assert.ok(POSE_ORDER.length >= 6, 'expected at least the 6 demo poses');
  });

  for (const key of ALL_KEYS) {
    it(`${key}: has a label and only references existing joints / channels with finite numbers`, () => {
      const p = POSES[key];
      assert.ok(p, `POSES.${key} exists`);
      assert.equal(typeof p.label, 'string');
      assert.ok(p.label.length > 0, 'label is not empty');
      assert.equal(typeof p.joints, 'object', 'joints is an object');
      for (const k of Object.keys(p.root ?? {})) assert.ok(['x', 'z', 'lift'].includes(k), `unknown root key "${k}"`);
      for (const v of Object.values(p.root ?? {})) assert.ok(Number.isFinite(v), 'root values are finite');
      for (const [joint, chs] of Object.entries(p.joints)) {
        const def = JOINT_BY_NAME.get(joint);
        assert.ok(def, `${key}: unknown joint "${joint}"`);
        assert.equal(def.kind, 'joint', `${key}: "${joint}" is an end point and has nothing to rotate`);
        for (const [c, v] of Object.entries(chs)) {
          assert.ok(
            def.dof.some((d) => d.channel === c),
            `${key}: joint "${joint}" has no channel "${c}" (has: ${def.dof.map((d) => d.channel).join(', ')})`,
          );
          assert.ok(Number.isFinite(v), `${key}: ${joint}.${c} = ${v} is not a finite number`);
        }
      }
    });

    it(`${key}: setPose reports NO clamping and getPose round-trips every value`, () => {
      const p = POSES[key];
      const clamped = boy.setPose(p);
      assert.deepEqual(clamped, [], `${key} has values outside joint limits: ${JSON.stringify(clamped)}`);
      const back = boy.getPose();
      for (const [j, chs] of Object.entries(back.joints)) {
        for (const [c, v] of Object.entries(chs)) near(v, channelOf(p, j, c), 1e-12, `${key}: round-trip ${j}.${c}`);
      }
      for (const k of ['x', 'z', 'lift']) near(back.root[k], p.root?.[k] ?? 0, 1e-12, `${key}: round-trip root.${k}`);
    });
  }

  it('bone lengths never change in any pose (rigid skeleton)', () => {
    for (const key of ALL_KEYS) {
      const s = at(key);
      for (const d of JOINT_DEFS) {
        if (!d.parent) continue;
        near(dist(s.pos[d.name], s.pos[d.parent]), Math.hypot(...d.offset), 1e-9, `${key}: bone ${d.parent} -> ${d.name}`);
      }
    }
  });

  it('symmetric poses are exact mirror images (same channel value means the same thing on both sides)', () => {
    for (const key of ['attention', 'open']) {
      const p = POSES[key];
      for (const def of JOINT_DEFS.filter((d) => d.side === 'L' && d.kind === 'joint')) {
        const r = def.name.replace(/_L$/, '_R');
        for (const c of def.dof) near(channelOf(p, def.name, c.channel), channelOf(p, r, c.channel), 0, `${key}: ${def.name}/${r} .${c.channel} must be set identically`);
      }
      const s = at(key);
      for (const def of JOINT_DEFS.filter((d) => d.side === 'L')) {
        const m = mirrorX(s.pos[def.name]);
        const r = s.pos[def.name.replace(/_L$/, '_R')];
        assert.ok(dist(m, r) < 1e-9, `${key}: ${def.name} mirrored is ${show(dist(m, r))} away from its right-hand twin`);
      }
    }
  });

  it('identical hand shapes on both hands give mirror-image hands in every pose', () => {
    for (const key of ALL_KEYS) {
      const s = at(key);
      for (const d of HAND_DEFS.filter((x) => x.side === 'L')) {
        const l = s.local[d.name];
        const r = s.local[d.name.replace(/_L$/, '_R')];
        assert.ok(dist(mirrorX(l), r) < 1e-9, `${key}: ${d.name} is ${show(dist(mirrorX(l), r))} from the mirror image of its right twin (hand shapes are written identically for L and R)`);
      }
    }
  });
});

/* ======================================================================= 2. */

describe('lerpPose', () => {
  it('t=0 returns pose a and t=1 returns pose b for every pair of named poses', () => {
    for (const [ka, kb] of PAIRS) {
      assertPoseClose(lerpPose(POSES[ka], POSES[kb], 0), POSES[ka], 1e-12, `${ka}->${kb} t=0`);
      assertPoseClose(lerpPose(POSES[ka], POSES[kb], 1), POSES[kb], 1e-12, `${ka}->${kb} t=1`);
    }
  });

  it('t=0.5 is the exact channel-wise average (including channels present in only one pose)', () => {
    for (const [ka, kb] of PAIRS) {
      const m = lerpPose(POSES[ka], POSES[kb], 0.5);
      for (const [j, c] of allChannels(POSES[ka], POSES[kb])) {
        near(channelOf(m, j, c), (channelOf(POSES[ka], j, c) + channelOf(POSES[kb], j, c)) / 2, 1e-12, `${ka}->${kb}: ${j}.${c}`);
      }
    }
  });

  it('result is the UNION of joints and channels; a missing channel counts as 0', () => {
    const a = { root: { x: 1 }, joints: { elbow_L: { flex: 90 }, knee_R: { flex: 30 } } };
    const b = { root: { z: 2, lift: 0.4 }, joints: { elbow_L: { twist: 40 }, head: { flex: 10 } } };
    const r = lerpPose(a, b, 0.5);
    assert.deepEqual(r.root, { x: 0.5, z: 1, lift: 0.2 });
    assert.deepEqual(r.joints.elbow_L, { flex: 45, twist: 20 }, 'channels from both poses are kept');
    assert.deepEqual(r.joints.knee_R, { flex: 15 }, 'joint only in a is blended towards 0');
    assert.deepEqual(r.joints.head, { flex: 5 }, 'joint only in b is blended from 0');
    assert.deepEqual(Object.keys(r.joints).sort(), ['elbow_L', 'head', 'knee_R']);
    // quarter point
    assert.deepEqual(lerpPose(a, b, 0.25).joints.elbow_L, { flex: 67.5, twist: 10 });
  });

  it('copes with poses that have no root / no joints', () => {
    assert.deepEqual(lerpPose({}, {}, 0.5), { root: { x: 0, z: 0, lift: 0 }, joints: {} });
    const r = lerpPose({ joints: { head: { flex: 10 } } }, {}, 0.5);
    assert.deepEqual(r.joints.head, { flex: 5 });
  });

  it('does not mutate its inputs', () => {
    const a = structuredClone(POSES.guard);
    const b = structuredClone(POSES.kick);
    lerpPose(a, b, 0.37);
    assert.deepEqual(a, POSES.guard);
    assert.deepEqual(b, POSES.kick);
  });

  it('never produces NaN / Infinity, and every blend stays inside the joint limits (no clamping)', () => {
    for (const [ka, kb] of PAIRS) {
      for (let i = 0; i <= 10; i++) {
        const t = easeInOut(i / 10);
        const pose = lerpPose(POSES[ka], POSES[kb], t);
        for (const [j, chs] of Object.entries(pose.joints)) {
          for (const [c, v] of Object.entries(chs)) assert.ok(Number.isFinite(v), `${ka}->${kb} t=${i / 10}: ${j}.${c} = ${v}`);
        }
        const clamped = boy.setPose(pose);
        assert.deepEqual(clamped, [], `${ka}->${kb} t=${i / 10} leaves the joint limits: ${JSON.stringify(clamped)}`);
      }
    }
  });

  it('applying lerp(a,b,0) / lerp(a,b,1) reproduces the exact world positions of a / b', () => {
    for (const [ka, kb] of PAIRS) {
      for (const [t, k] of [[0, ka], [1, kb]]) {
        const s = stage(lerpPose(POSES[ka], POSES[kb], t), { hand: false });
        const ref = at(k);
        for (const d of JOINT_DEFS) assert.ok(dist(s.pos[d.name], ref.pos[d.name]) < 1e-9, `${ka}->${kb} t=${t}: ${d.name} off by ${show(dist(s.pos[d.name], ref.pos[d.name]))}`);
      }
    }
  });
});

describe('easeInOut', () => {
  it('maps 0 -> 0, 0.5 -> 0.5, 1 -> 1', () => {
    near(easeInOut(0), 0, 1e-12, 'easeInOut(0)');
    near(easeInOut(0.5), 0.5, 1e-12, 'easeInOut(0.5)');
    near(easeInOut(1), 1, 1e-12, 'easeInOut(1)');
  });

  it('is monotonic non-decreasing, stays within [0,1], and is point-symmetric', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const e = easeInOut(t);
      assert.ok(e >= prev, `not monotonic at t=${t}: ${e} < ${prev}`);
      assert.ok(e >= 0 && e <= 1, `out of range at t=${t}: ${e}`);
      near(e + easeInOut(1 - t), 1, 1e-12, `symmetry at t=${t}`);
      prev = e;
    }
  });

  it('is slow at both ends (ease), faster in the middle', () => {
    assert.ok(easeInOut(0.1) < 0.1, 'starts slower than linear');
    assert.ok(easeInOut(0.9) > 0.9, 'ends slower than linear');
  });
});

/* ======================================================================= 3. */

describe('auto-grounding', () => {
  for (const key of ALL_KEYS) {
    it(`${key}: the lowest ground-contact node is on the floor (<2 mm) and no node is below it`, () => {
      const s = at(key);
      const lowest = Math.min(...GROUND_CONTACTS.map((n) => s.pos[n].y));
      assert.ok(Math.abs(lowest) < FLOOR_TOL, `${key}: lowest ground-contact node is at y=${show(lowest)}`);
      const under = JOINT_DEFS.filter((d) => s.pos[d.name].y < -FLOOR_TOL).map((d) => `${d.name} (${show(s.pos[d.name].y)})`);
      assert.deepEqual(under, [], `${key}: nodes below the floor`);
    });
  }

  it('root x / z / lift move the whole figure: pelvis follows x,z and lift raises the feet off the floor', () => {
    const s = stage({ root: { x: 0.3, z: -0.2, lift: 0.15 } }, { hand: false });
    near(s.pos.pelvis.x, 0.3, 1e-9, 'pelvis.x');
    near(s.pos.pelvis.z, -0.2, 1e-9, 'pelvis.z');
    near(Math.min(...GROUND_CONTACTS.map((n) => s.pos[n].y)), 0.15, 1e-9, 'lowest contact with lift 0.15');
  });

  it('stays grounded, finite and above the floor through every transition', () => {
    for (const [ka, kb] of PAIRS) {
      for (let i = 0; i <= 10; i++) {
        const s = stage(lerpPose(POSES[ka], POSES[kb], easeInOut(i / 10)), { hand: false });
        const lowest = Math.min(...GROUND_CONTACTS.map((n) => s.pos[n].y));
        assert.ok(Math.abs(lowest) < FLOOR_TOL, `${ka}->${kb} t=${i / 10}: lowest contact at ${show(lowest)}`);
        for (const d of JOINT_DEFS) {
          const p = s.pos[d.name];
          assert.ok(Number.isFinite(p.x + p.y + p.z), `${ka}->${kb} t=${i / 10}: ${d.name} is NaN`);
          assert.ok(p.y > -FLOOR_TOL, `${ka}->${kb} t=${i / 10}: ${d.name} is ${show(p.y)} below the floor`);
        }
      }
    }
  });
});

/* ======================================================================= 4. */

describe('plausibility: attention', () => {
  it('arms hang: shoulder-to-wrist within 10 deg of straight down, elbows ~straight, wrists between hip and knee height', () => {
    const s = at('attention');
    for (const k of SIDES) {
      le(angleDeg(sub(s.pos[`wrist_${k}`], s.pos[`shoulder_${k}`]), { x: 0, y: -1, z: 0 }), 10, `${k} arm tilt from vertical`, 'deg');
      ge(jointAngle(s.pos[`shoulder_${k}`], s.pos[`elbow_${k}`], s.pos[`wrist_${k}`]), 170, `${k} elbow angle`, 'deg');
      const w = s.pos[`wrist_${k}`];
      ge(w.y, s.pos[`knee_${k}`].y, `${k} wrist height vs knee`);
      le(w.y, s.pos[`hip_${k}`].y, `${k} wrist height vs hip`);
    }
  });

  it('hands rest beside the thighs: 5-20 cm from the thigh axis, level with it front-to-back, not inside it', () => {
    const s = at('attention');
    for (const k of SIDES) {
      const hc = handCentre(s, k);
      const gap = segDist(hc, s.pos[`hip_${k}`], s.pos[`knee_${k}`]);
      ge(gap, 0.05, `${k} hand centre to thigh axis`);
      le(gap, 0.2, `${k} hand centre to thigh axis`);
      ge(hc.y, s.pos[`knee_${k}`].y, `${k} hand height vs knee`);
      le(hc.y, s.pos[`hip_${k}`].y, `${k} hand height vs hip`);
      le(Math.abs(hc.z - s.pos[`hip_${k}`].z), 0.1, `${k} hand front/back offset from hip`);
    }
  });

  it('fingers are relaxed: slightly curled (not stiff, not a fist) on both hands', () => {
    const s = at('attention');
    for (const k of SIDES) {
      for (const f of FOUR) {
        const ratio = tipDist(s, k, f) / tipDist(REST, k, f); // rest = fully straight finger
        ge(ratio, 0.8, `${k} ${f} tip-to-wrist vs straight finger`, 'ratio');
        le(ratio, 0.985, `${k} ${f} tip-to-wrist vs straight finger (must show some curl)`, 'ratio');
      }
    }
  });
});

describe('plausibility: guard (Ready stance)', () => {
  it('left foot is forward and the feet are at least 40 cm apart front/back', () => {
    const s = at('guard');
    assert.ok(s.pos.ankle_L.z > s.pos.ankle_R.z, 'left ankle should be in front of the right ankle');
    ge(s.pos.ankle_L.z - s.pos.ankle_R.z, 0.4, 'ankle-to-ankle front/back distance');
    ge(s.pos.toe_tip_L.z - s.pos.toe_tip_R.z, 0.4, 'toe-to-toe front/back distance');
  });

  it('both feet are at floor level (lowest point of each foot within 2 cm of y=0)', () => {
    const s = at('guard');
    for (const k of SIDES) le(Math.abs(footMinY(s, k)), 0.02, `${k} foot lowest point`);
  });

  it('front (left) foot is planted flat: heel and ball of foot within 3 cm of the floor', () => {
    const s = at('guard');
    le(s.pos.heel_L.y, 0.03, 'left heel height');
    le(s.pos.toe_L.y, 0.03, 'left ball-of-foot height');
  });

  it('both feet point forward (within 25 deg of +Z) with the stance width between 20 and 60 cm', () => {
    const s = at('guard');
    for (const k of SIDES) {
      const dir = sub(s.pos[`toe_tip_${k}`], s.pos[`heel_${k}`]);
      le(Math.abs(yawDeg(dir)), 25, `${k} foot direction`, 'deg');
    }
    const width = Math.abs(s.pos.ankle_L.x - s.pos.ankle_R.x);
    ge(width, 0.2, 'stance width');
    le(width, 0.6, 'stance width');
  });

  it('both fists are between chin and chest height and in front of the torso', () => {
    const s = at('guard');
    for (const k of SIDES) {
      const f = handCentre(s, k);
      le(f.y, chinY(s), `${k} fist height vs chin (${show(chinY(s))})`);
      ge(f.y, s.pos.chest.y, `${k} fist height vs chest (${show(s.pos.chest.y)})`);
      ge(f.z - s.pos.chest.z, 0.15, `${k} fist distance in front of the chest`);
    }
  });

  it('elbows are below the fists', () => {
    const s = at('guard');
    for (const k of SIDES) le(s.pos[`elbow_${k}`].y + 0.1, handCentre(s, k).y, `${k} elbow height + 10 cm vs fist height`);
  });

  it('fists are not inside the head or torso', () => {
    const s = at('guard');
    for (const k of SIDES) {
      const f = handCentre(s, k);
      ge(dist(f, s.skull.c) - s.skull.r, 0.05, `${k} fist centre outside the skull`);
      for (const [a, b] of TORSO) ge(segDist(f, s.pos[a], s.pos[b]) - TORSO_R, 0.04, `${k} fist centre outside the torso (${a}-${b})`);
    }
  });

  it('knees are bent and the figure is lowered compared with attention', () => {
    const g = at('guard');
    const a = at('attention');
    ge(a.pos.pelvis.y - g.pos.pelvis.y, 0.05, 'pelvis drop vs attention');
  });
});

describe('plausibility: punch', () => {
  it('right fist is the foremost point of the whole body, clearly ahead of the front foot', () => {
    const s = at('punch');
    const ranked = JOINT_DEFS.map((d) => [d.name, s.pos[d.name].z, d.region]).sort((a, b) => b[1] - a[1]);
    assert.equal(ranked[0][2], 'Right hand', `foremost node is ${ranked[0][0]} (z=${show(ranked[0][1])}), expected a right-hand node`);
    const bestOther = ranked.find((r) => r[2] !== 'Right hand' && r[2] !== 'Right arm'); // the punching limb itself does not count
    ge(ranked[0][1] - bestOther[1], 0.15, `lead of the fist over ${bestOther[0]}`);
  });

  it('right fist is roughly at shoulder height (+-10 cm)', () => {
    const s = at('punch');
    le(Math.abs(handCentre(s, 'R').y - s.pos.shoulder_R.y), 0.1, 'fist height vs right shoulder');
  });

  it('punching arm is nearly straight: elbow angle > 150 deg', () => {
    const s = at('punch');
    ge(jointAngle(s.pos.shoulder_R, s.pos.elbow_R, s.pos.wrist_R), 150, 'right elbow angle', 'deg');
  });

  it('a STRAIGHT punch travels forward (within 25 deg of +Z), not across the body', () => {
    const s = at('punch');
    const fist = handCentre(s, 'R');
    const d = sub(fist, s.pos.shoulder_R);
    const off = Math.abs(yawDeg({ x: d.x, y: 0, z: d.z }));
    le(off, 25, `punch direction (shoulder->fist ${show(d.x)} sideways, ${show(d.z)} forward; fist at x=${show(fist.x)} vs head x=${show(s.pos.head.x)}) is off the forward axis by`, 'deg');
  });

  it('left (guard) fist stays near the chin: within 25 cm sideways of the head axis, at head/chest height', () => {
    const s = at('punch');
    const f = handCentre(s, 'L');
    const g = handCentre(at('guard'), 'L');
    le(
      Math.abs(f.x - s.skull.c.x),
      0.25,
      `left fist sideways offset from head axis (fist is ${show(dist(f, { x: s.skull.c.x, y: chinY(s), z: s.skull.c.z }))} from the chin, left elbow at x=${show(s.pos.elbow_L.x)}, it moved ${show(dist(f, g))} away from its guard position)`,
    );
    le(f.y, chinY(s) + 0.1, 'left fist height vs chin + 10 cm');
    ge(f.y, s.pos.chest.y, 'left fist height vs chest');
  });
});

describe('plausibility: kick', () => {
  it('right foot is well above the left knee (>= 25 cm) and in front of the body (>= 50 cm ahead of the pelvis)', () => {
    const s = at('kick');
    ge(s.pos.ankle_R.y - s.pos.knee_L.y, 0.25, 'right ankle above left knee');
    ge(footMinY(s, 'R') - s.pos.knee_L.y, 0.2, 'whole right foot above left knee');
    ge(s.pos.ankle_R.z - s.pos.pelvis.z, 0.5, 'right ankle in front of the pelvis');
  });

  it('kicking leg is raised to about hip height and nearly straight (knee angle >= 150 deg)', () => {
    const s = at('kick');
    ge(s.pos.knee_R.y, s.pos.hip_R.y - 0.1, 'right knee height vs hip');
    ge(jointAngle(s.pos.hip_R, s.pos.knee_R, s.pos.ankle_R), 150, 'right knee angle', 'deg');
  });

  it('supporting left foot is on the floor', () => {
    const s = at('kick');
    le(Math.abs(footMinY(s, 'L')), 0.02, 'left foot lowest point');
  });

  it('supporting left foot is planted FLAT (heel within 3 cm and ball of foot within 4 cm of the floor), not on tiptoe', () => {
    const s = at('kick');
    const msg = `supporting foot: heel ${show(s.pos.heel_L.y)}, ball ${show(s.pos.toe_L.y)}, toe tip ${show(s.pos.toe_tip_L.y)} above the floor; ankle ${show(s.pos.ankle_L.y)} high (${show(at('attention').pos.ankle_L.y)} at attention); pelvis ${show(s.pos.pelvis.y)} (${show(at('attention').pos.pelvis.y)} at attention despite a bent knee)`;
    assert.ok(s.pos.heel_L.y <= 0.03 && s.pos.toe_L.y <= 0.04, msg);
  });

  it('torso stays upright-ish: pelvis-to-neck within 20 deg of vertical', () => {
    const s = at('kick');
    le(angleDeg(sub(s.pos.neck, s.pos.pelvis), { x: 0, y: 1, z: 0 }), 20, 'torso lean', 'deg');
  });
});

describe('plausibility: knife-hand block', () => {
  for (const k of SIDES) {
    it(`${k} hand: fingers are straight and as long as the open hand (tip-to-wrist within 5% of the open pose)`, () => {
      const s = at('knife');
      const open = at('open');
      for (const f of FOUR) ge(tipDist(s, k, f) / tipDist(open, k, f), 0.95, `${k} ${f} tip-to-wrist knife/open`, 'ratio');
      for (const f of FOUR) {
        const [mcp, pip, dip, tip] = chain(f, k).map((n) => s.pos[n]);
        le(180 - jointAngle(mcp, pip, dip), 5, `${k} ${f} PIP bend`, 'deg');
        le(180 - jointAngle(pip, dip, tip), 5, `${k} ${f} DIP bend`, 'deg');
      }
    });

    it(`${k} hand: fingers are held together (fingertip spacing across the hand no wider than the knuckle spacing + 5 mm)`, () => {
      const s = at('knife');
      for (let i = 0; i < FOUR.length - 1; i++) {
        const tipGap = Math.abs(s.local[chain(FOUR[i], k)[3]].z - s.local[chain(FOUR[i + 1], k)[3]].z);
        const knuckleGap = Math.abs(REST.local[chain(FOUR[i], k)[0]].z - REST.local[chain(FOUR[i + 1], k)[0]].z);
        le(tipGap, knuckleGap + 0.005, `${k} ${FOUR[i]}-${FOUR[i + 1]} fingertip spacing`);
      }
    });

    it(`${k} hand: thumb is tucked against the palm (tip within 6 cm of the palm plane and 8 cm of the index knuckle)`, () => {
      const s = at('knife');
      const open = at('open');
      const plane = Math.abs(s.local[`thumb_tip_${k}`].x); // fingers lie in the x=0 plane of the wrist frame
      const toIndex = dist(s.pos[`thumb_tip_${k}`], s.pos[`index_mcp_${k}`]);
      const toIndexOpen = dist(open.pos[`thumb_tip_${k}`], open.pos[`index_mcp_${k}`]);
      assert.ok(
        plane <= 0.06 && toIndex <= 0.08,
        `${k} thumb tip: ${show(plane)} off the palm plane (limit 6 cm) and ${show(toIndex)} from the index knuckle (limit 8 cm; spread-open hand ${show(toIndexOpen)}, relaxed hand ${show(dist(at('attention').pos[`thumb_tip_${k}`], at('attention').pos[`index_mcp_${k}`]))})`,
      );
    });
  }
});

describe('plausibility: open hands (T-pose)', () => {
  it('wrists are at shoulder height, arms straight and horizontal', () => {
    const s = at('open');
    for (const k of SIDES) {
      le(Math.abs(s.pos[`wrist_${k}`].y - s.pos[`shoulder_${k}`].y), 0.03, `${k} wrist vs shoulder height`);
      ge(jointAngle(s.pos[`shoulder_${k}`], s.pos[`elbow_${k}`], s.pos[`wrist_${k}`]), 170, `${k} elbow angle`, 'deg');
      ge(Math.abs(s.pos[`wrist_${k}`].x), 0.5, `${k} wrist distance from the body axis`);
    }
  });

  it('arm span (fingertip to fingertip) is between 1.6 and 2.2 m', () => {
    const s = at('open');
    const xs = JOINT_DEFS.map((d) => s.pos[d.name].x);
    const span = Math.max(...xs) - Math.min(...xs);
    ge(span, 1.6, 'arm span');
    le(span, 2.2, 'arm span');
  });

  for (const k of SIDES) {
    it(`${k} hand: fingers are fanned out - every neighbouring fingertip pair is wider apart than at rest`, () => {
      const s = at('open');
      for (let i = 0; i < FOUR.length - 1; i++) {
        const a = chain(FOUR[i], k)[3];
        const b = chain(FOUR[i + 1], k)[3];
        ge(dist(s.pos[a], s.pos[b]), dist(REST.pos[a], REST.pos[b]) + 0.005, `${k} ${FOUR[i]}-${FOUR[i + 1]} fingertip spacing (rest ${show(dist(REST.pos[a], REST.pos[b]))})`);
        ge(Math.abs(s.local[a].z - s.local[b].z), Math.abs(REST.local[a].z - REST.local[b].z) + 0.01, `${k} ${FOUR[i]}-${FOUR[i + 1]} sideways fingertip spacing`);
      }
    });

    it(`${k} hand: all four fingers lie flat in one plane and are fully extended`, () => {
      const s = at('open');
      const n0 = sub(s.pos[`middle_tip_${k}`], s.pos[`wrist_${k}`]);
      const n1 = sub(s.pos[`index_tip_${k}`], s.pos[`pinky_tip_${k}`]);
      const normal = { x: n0.y * n1.z - n0.z * n1.y, y: n0.z * n1.x - n0.x * n1.z, z: n0.x * n1.y - n0.y * n1.x };
      const nl = len(normal);
      assert.ok(nl > 1e-6, 'degenerate hand plane');
      for (const f of FOUR) {
        for (const n of chain(f, k)) {
          const off = Math.abs(dot(sub(s.pos[n], s.pos[`wrist_${k}`]), normal)) / nl;
          le(off, 0.005, `${n} distance from the finger plane`);
        }
        le(180 - jointAngle(...chain(f, k).slice(0, 3).map((n) => s.pos[n])), 3, `${k} ${f} bend`, 'deg');
      }
    });
  }
});

describe('plausibility: head orientation and balance (all poses)', () => {
  for (const key of ['attention', 'guard', 'punch', 'kick', 'knife', 'open']) {
    it(`${key}: head faces forward (within 15 deg of +Z, yaw and pitch)`, () => {
      const f = at(key).headForward;
      le(angleDeg(f, { x: 0, y: 0, z: 1 }), 15, `${key} head direction (yaw ${yawDeg(f).toFixed(1)} deg, pitch ${((Math.asin(f.y / len(f)) * 180) / Math.PI).toFixed(1)} deg)`, 'deg');
    });

    it(`${key}: centre of mass is over the support area (feet + 5 cm)`, () => {
      const s = at(key);
      const box = supportBox(s);
      const c = centerOfMass(s);
      const dx = Math.max(box.minX - c.x, 0, c.x - box.maxX);
      const dz = Math.max(box.minZ - c.z, 0, c.z - box.maxZ);
      le(Math.hypot(dx, dz), 0, `${key}: COM (x=${show(c.x)}, z=${show(c.z)}) distance outside the support box x[${show(box.minX)}..${show(box.maxX)}] z[${show(box.minZ)}..${show(box.maxZ)}]`);
    });
  }
});

/* ======================================================================= 5. */

describe('hands', () => {
  for (const k of SIDES) {
    it(`${k} hand: in the fist every fingertip is much closer to the wrist than in the open hand (fingers <= 60%, thumb <= 80%)`, (t) => {
      const fist = at('guard');
      const open = at('open');
      const bad = [];
      for (const f of FINGERS) {
        const ratio = tipDist(fist, k, f) / tipDist(open, k, f);
        t.diagnostic(`${k} ${f.padEnd(6)} tip->wrist: open ${show(tipDist(open, k, f))}, fist ${show(tipDist(fist, k, f))}, fist/open = ${ratio.toFixed(2)}`);
        if (ratio > (f === 'thumb' ? 0.8 : 0.6)) bad.push(`${f} ${ratio.toFixed(2)}`);
      }
      assert.deepEqual(bad, [], `${k}: fingertips not folded in enough (fist/open distance ratio): ${bad.join(', ')}`);
    });

    it(`${k} hand: in the fist the thumb wraps over the fingers (thumb tip within 4 cm of a finger joint)`, () => {
      const s = at('guard');
      let best = Infinity;
      let who = '';
      for (const f of FOUR) {
        for (const n of chain(f, k).slice(1)) {
          const d = dist(s.pos[`thumb_tip_${k}`], s.pos[n]);
          if (d < best) [best, who] = [d, n];
        }
      }
      le(best, 0.04, `${k} thumb tip to nearest finger joint (${who}); thumb tip is ${show(Math.abs(s.local[`thumb_tip_${k}`].x))} off the palm plane vs ${show(Math.max(...FOUR.flatMap((f) => chain(f, k).map((n) => Math.abs(s.local[n].x)))))} for the curled fingers`);
    });
  }

  it('hand shapes are ordered open >= relaxed > fist in fingertip-to-wrist distance', () => {
    for (const k of SIDES) {
      for (const f of FOUR) {
        const o = tipDist(at('open'), k, f);
        const r = tipDist(at('attention'), k, f);
        const fi = tipDist(at('guard'), k, f);
        assert.ok(o >= r && r > fi * 1.5, `${k} ${f}: open ${show(o)}, relaxed ${show(r)}, fist ${show(fi)}`);
      }
    }
  });

  for (const key of ALL_KEYS) {
    it(`${key}: no hand joint penetrates the head, torso, legs or the other hand`, (t) => {
      const c = clearance(at(key));
      t.diagnostic(
        `${key}: min gap to skull ${show(c.skull.gap)} (${c.skull.who}); torso ${show(c.torso.gap)} (${c.torso.who}); legs ${show(c.legs.gap)} (${c.legs.who}); other hand ${show(c.otherHand.gap)} (${c.otherHand.who}); ` +
          `min distance to a head/neck/chest/spine/pelvis NODE ${show(c.core.gap)} (${c.core.who})`,
      );
      ge(c.skull.gap, 0, `${key}: hand vs skull (${c.skull.who})`);
      ge(c.torso.gap, 0, `${key}: hand vs torso (${c.torso.who})`);
      ge(c.legs.gap, 0, `${key}: hand vs legs (${c.legs.who})`);
      ge(c.otherHand.gap, 0, `${key}: hand vs other hand (${c.otherHand.who})`);
    });
  }

  it('hands never pass through the head / torso / legs while blending between any two poses', () => {
    let worst = { gap: Infinity, what: '' };
    for (const [ka, kb] of PAIRS) {
      for (let i = 0; i <= 10; i++) {
        const c = clearance(stage(lerpPose(POSES[ka], POSES[kb], easeInOut(i / 10)), { hand: false }));
        for (const part of ['skull', 'torso', 'legs', 'otherHand']) {
          if (c[part].gap < worst.gap) worst = { gap: c[part].gap, what: `${ka}->${kb} t=${i / 10}: ${part} ${c[part].who}` };
        }
      }
    }
    ge(worst.gap, 0, `worst hand clearance during blends (${worst.what})`);
  });
});

test('suite sanity: the Stickboy still has the expected 65 nodes', () => {
  assert.equal(JOINT_DEFS.length, 65);
  assert.equal(JOINT_DEFS.filter((d) => d.kind === 'joint').length, 51);
});
