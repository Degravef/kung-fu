/**
 * Kinematics / sign-convention tests for the stickboy skeleton.
 *
 * World frame (see src/skeleton/jointDefs.js): +Y up, +Z = the way the character
 * faces, +X = the character's LEFT. Rest pose = standing, arms hanging.
 *
 * The anatomy tests below are derived from anatomy + each channel's LABEL text,
 * NOT from the sign table: for every channel they move the joint and look at
 * where a probe point (child joint, fingertip, ...) goes in the world.
 *
 * Expectations are written for the LEFT side. Right-side expectations are the
 * mirror image (x negated), which is exactly what "one channel value has the
 * same meaning on both sides" promises.
 *
 * Run:  node --test tests/kinematics.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Stickboy } from '../src/skeleton/Stickboy.js';
import { JOINT_DEFS, JOINT_BY_NAME, GROUND_CONTACTS, WEBS } from '../src/skeleton/jointDefs.js';
import { POSES } from '../src/poses.js';

/* ------------------------------------------------------------------ helpers */

const DEG = Math.PI / 180;
const ARTICULATED = JOINT_DEFS.filter((d) => d.dof.length > 0);
const NODE_NAMES = JOINT_DEFS.map((d) => d.name);
const REST_Y = JOINT_BY_NAME.get('pelvis').offset[1];

const X = [1, 0, 0];
const NX = [-1, 0, 0];
const Y = [0, 1, 0];
const NY = [0, -1, 0];
const Z = [0, 0, 1];
const NZ = [0, 0, -1];

const hasSides = (base) => JOINT_BY_NAME.has(`${base}_L`);
const full = (base, side) => (hasSides(base) ? `${base}_${side}` : base);
const mirrorName = (n) => (n.endsWith('_L') ? `${n.slice(0, -1)}R` : n.endsWith('_R') ? `${n.slice(0, -1)}L` : n);
const reflect = (v) => new THREE.Vector3(-v.x, v.y, v.z);
const fmt = (v) => `${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}`;

function rig({ autoGround = false } = {}) {
  const s = new Stickboy();
  s.autoGround = autoGround;
  s.setPose({});
  return s;
}

/** A shared rig WITHOUT auto-ground, so the pelvis stays put and joint motion is directly measurable. */
const sb = rig();

const snapshot = (s) => new Map(NODE_NAMES.map((n) => [n, s.worldPosition(n)]));

function assertClose(actual, expected, tol, msg) {
  const d = actual.distanceTo(expected);
  assert.ok(d <= tol, `${msg}: got (${fmt(actual)}), expected (${fmt(expected)}), off by ${d.toExponential(2)}`);
}

function assertSnapshotsClose(a, b, tol, msg) {
  for (const n of NODE_NAMES) assertClose(a.get(n), b.get(n), tol, `${msg} [node ${n}]`);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random pose inside the joint limits. mode 'extreme' puts every channel on min or max. */
function randomPose(r, mode = 'uniform', withRoot = true) {
  const joints = {};
  for (const def of ARTICULATED) {
    joints[def.name] = {};
    for (const d of def.dof) {
      joints[def.name][d.channel] = mode === 'extreme' ? (r() < 0.5 ? d.min : d.max) : d.min + r() * (d.max - d.min);
    }
  }
  const root = withRoot ? { x: (r() - 0.5) * 2, z: (r() - 0.5) * 2, lift: r() < 0.3 ? r() * 0.5 : 0 } : {};
  return { root, joints };
}

/** Mirror image of a pose: swap L/R, negate root.x; centre joints keep `flex`, negate `bend` / `twist`. */
function mirrorPose(pose) {
  const joints = {};
  for (const [n, ch] of Object.entries(pose.joints ?? {})) {
    const m = mirrorName(n);
    if (m !== n) joints[m] = { ...ch };
    else joints[n] = Object.fromEntries(Object.entries(ch).map(([c, v]) => [c, c === 'flex' ? v : -v]));
  }
  const r = pose.root ?? {};
  return { root: { x: -(r.x ?? 0), z: r.z ?? 0, lift: r.lift ?? 0 }, joints };
}

/* ------------------------------------------------------- independent matrix math */

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Rodrigues rotation matrix (row-major 3x3), independent of three.js. */
function rot(axis, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  const [x, y, z] = axis;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const IDENT = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** Rotation part of a THREE.Matrix4 as row-major 3x3. */
const rotOf = (m4) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => m4.elements[j * 4 + i]));
const maxDiff = (A, B) => Math.max(...A.flatMap((row, i) => row.map((v, j) => Math.abs(v - B[i][j]))));

/* -------------------------------------------------------------------- probes */

const pos = (base) => (s, side) => s.worldPosition(full(base, side));
const vec = (from, to) => (s, side) => s.worldPosition(full(to, side)).sub(s.worldPosition(full(from, side)));
const skullMesh = (s) => s.nodes.get('head').object.children.find((c) => c.name === 'head:skull');
const skull = (s) => skullMesh(s).getWorldPosition(new THREE.Vector3());
const nose = (s) =>
  skullMesh(s)
    .children.find((c) => c.geometry?.type === 'ConeGeometry')
    .getWorldPosition(new THREE.Vector3());

/** Direction the palm faces. Plane of wrist / index knuckle / pinky knuckle; the palm is the side fingers curl toward. */
const palmNormal = (s, side) => {
  const w = s.worldPosition(`wrist_${side}`);
  const n = s.worldPosition(`index_mcp_${side}`).sub(w).cross(s.worldPosition(`pinky_mcp_${side}`).sub(w)).normalize();
  // Hanging arm, thumb in front: the left palm faces the thigh (-X), the right palm faces +X.
  return n.multiplyScalar(side === 'L' ? -1 : 1);
};

/* ------------------------------------------------- anatomy table (LEFT side, world) */

const SPEC = [];
/** dir = world direction (left-side convention) the probe must move toward for a POSITIVE value. */
const add = (joint, ch, probe, probeName, dir, up, down, setup) => SPEC.push({ joint, ch, probe, probeName, dir, up, down, setup });

const FINGER_IDS = ['index', 'middle', 'ring', 'pinky'];

// ---- trunk and head (centre joints; +X is the character's left)
add('pelvis', 'twist', vec('heel', 'toe_tip'), 'left foot heel->toe', X, 'body turns toward the character\'s LEFT (foot direction swings to +X)', 'turns to the RIGHT (-X)');
add('pelvis', 'twist', pos('shoulder'), 'left shoulder', NZ, 'turning left swings the left shoulder BACK (-Z)', 'turning right swings the left shoulder FORWARD (+Z)');
add('pelvis', 'flex', pos('neck'), 'neck', Z, 'tilts the upper body FORWARD (+Z)', 'tilts it BACK (-Z)');
add('pelvis', 'bend', pos('neck'), 'neck', X, 'leans the upper body to the LEFT (+X)', 'leans it to the RIGHT (-X)');
for (const j of ['spine', 'chest']) {
  add(j, 'flex', pos('neck'), 'neck', Z, 'bends the chest FORWARD (+Z)', 'bends it BACK (-Z)');
  add(j, 'bend', pos('neck'), 'neck', X, 'leans LEFT (+X)', 'leans RIGHT (-X)');
  add(j, 'twist', pos('shoulder'), 'left shoulder', NZ, 'turns LEFT (left shoulder goes back, -Z)', 'turns RIGHT (left shoulder comes forward, +Z)');
}
for (const j of ['neck', 'head']) {
  add(j, 'flex', skull, 'skull centre', Z, 'nods FORWARD (+Z)', 'tilts BACK (-Z)');
  add(j, 'bend', skull, 'skull centre', X, 'tilts toward the LEFT shoulder (+X)', 'tilts toward the RIGHT shoulder (-X)');
  add(j, 'twist', nose, 'nose', X, 'turns the face toward the character\'s LEFT (+X)', 'turns the face RIGHT (-X)');
}

// ---- arm
add('clavicle', 'elev', pos('shoulder'), 'shoulder joint', Y, 'shrugs the shoulder UP (+Y)', 'drops the shoulder DOWN (-Y)');
add('clavicle', 'protract', pos('shoulder'), 'shoulder joint', Z, 'pushes the shoulder FORWARD (+Z)', 'pulls it BACK (-Z)');
add('shoulder', 'flex', pos('elbow'), 'elbow', Z, 'swings the arm FORWARD (+Z)', 'swings the arm BACK (-Z)');
add('shoulder', 'abd', pos('elbow'), 'elbow', X, 'raises the arm OUT to the side (left arm toward +X, right toward -X)', 'swings the arm ACROSS the body (toward the midline)');
add('shoulder', 'twist', pos('wrist'), 'wrist (elbow bent 90deg, forearm pointing forward)', X, 'rotates OUTWARD (forearm swings away from the midline)', 'rotates INWARD (forearm swings across the belly)', { elbow: { flex: 90 } });
add('elbow', 'flex', pos('wrist'), 'wrist', Z, 'brings the forearm/hand FORWARD (and up)', 'would bend backwards (not allowed)');
add('elbow', 'twist', palmNormal, 'palm normal (elbow bent 90deg)', Y, 'turns the palm UP (supination)', 'turns the palm DOWN (pronation)', { elbow: { flex: 90 } });
add('wrist', 'flex', pos('middle_mcp'), 'middle knuckle', NX, 'bends the hand toward the PALM side (left hand: -X)', 'bends the hand toward the BACK of the hand (+X)');
add('wrist', 'dev', pos('middle_mcp'), 'middle knuckle', Z, 'deviates the hand toward the THUMB (thumb is in front: +Z)', 'deviates toward the PINKY (-Z)');

// ---- leg
add('hip', 'flex', pos('knee'), 'knee', Z, 'swings the thigh FORWARD (+Z)', 'swings the thigh BACK (-Z)');
add('hip', 'abd', pos('knee'), 'knee', X, 'raises the leg OUT to the side (left leg toward +X)', 'crosses the leg in FRONT of / toward the other leg');
add('hip', 'twist', vec('heel', 'toe_tip'), 'heel->toe direction', X, 'turns the foot OUT (left foot toward +X)', 'turns the foot IN (toward the midline)');
add('knee', 'flex', pos('ankle'), 'ankle', NZ, 'swings the shin BACKWARD (heel toward butt, -Z)', 'would hyper-extend (not allowed)');
add('knee', 'flex', pos('heel'), 'heel', NZ, 'swings the heel BACKWARD (-Z)', 'would hyper-extend (not allowed)');
add('ankle', 'flex', pos('toe_tip'), 'toe tip', NY, 'points the toes DOWN (plantar flexion)', 'pulls the toes UP (dorsiflexion)');
add('ankle', 'inv', pos('heel'), 'heel (a point below the ankle)', NX, 'turns the sole IN (below-ankle points move medially: left foot -X)', 'turns the sole OUT (+X)');
add('toe', 'flex', pos('toe_tip'), 'toe tip', NY, 'curls the toes DOWN', 'lifts the toes UP');

// ---- hand (hanging arm, thumb in front, left palm faces -X)
for (const f of FINGER_IDS) {
  add(`${f}_mcp`, 'flex', pos(`${f}_tip`), `${f} fingertip`, NX, 'curls the finger toward the PALM (left hand: -X)', 'extends the finger toward the BACK of the hand (+X)');
  add(`${f}_pip`, 'flex', pos(`${f}_tip`), `${f} fingertip`, NX, 'curls toward the PALM (left hand: -X)', 'extends toward the BACK of the hand (+X)');
  add(`${f}_dip`, 'flex', pos(`${f}_tip`), `${f} fingertip`, NX, 'curls toward the PALM (left hand: -X)', 'extends toward the BACK of the hand (+X)');
}
add('index_mcp', 'spread', pos('index_tip'), 'index fingertip', Z, 'spreads the index AWAY from the middle finger (toward the thumb side, +Z)', 'brings the index TOWARD the middle finger (-Z)');
add('ring_mcp', 'spread', pos('ring_tip'), 'ring fingertip', NZ, 'spreads the ring finger AWAY from the middle finger (toward the pinky side, -Z)', 'brings the ring finger TOWARD the middle finger (+Z)');
add('pinky_mcp', 'spread', pos('pinky_tip'), 'pinky fingertip', NZ, 'spreads the pinky AWAY from the other fingers (-Z)', 'brings the pinky TOWARD the other fingers (+Z)');
add('thumb_cmc', 'flex', pos('thumb_tip'), 'thumb tip', NX, 'brings the thumb ACROSS the palm (left hand: -X)', 'moves the thumb BACK toward the back of the hand (+X)');
add('thumb_cmc', 'spread', pos('thumb_tip'), 'thumb tip', Z, 'moves the thumb AWAY from the fingers (thumb side, +Z)', 'moves the thumb TOWARD the fingers (-Z)');
add('thumb_cmc', 'twist', pos('thumb_tip'), 'thumb tip', X, 'rotates the thumb OUTWARD (lateral, away from the body: left hand +X)', 'rotates the thumb INWARD (toward the palm, -X)');
add('thumb_mcp', 'flex', pos('thumb_tip'), 'thumb tip', NX, 'curls the thumb toward the PALM (-X)', 'extends the thumb toward the BACK of the hand (+X)');
add('thumb_ip', 'flex', pos('thumb_tip'), 'thumb tip', NX, 'curls the thumb tip toward the PALM (-X)', 'extends the thumb tip toward the BACK of the hand (+X)');

/** Moves joint `name`.`ch` to `value` (after applying `setup` to the same side) and returns the probe displacement. */
function probeMove(spec, side, value) {
  const name = full(spec.joint, side);
  const setup = {};
  for (const [b, chs] of Object.entries(spec.setup ?? {})) setup[full(b, side)] = { ...chs };
  sb.setPose({ joints: setup });
  const before = spec.probe(sb, side).clone();
  const clamps = sb.setPose({ joints: { ...setup, [name]: { ...(setup[name] ?? {}), [spec.ch]: value } } });
  assert.deepEqual(clamps, [], `test value ${value} for ${name}.${spec.ch} is outside the joint limits`);
  return spec.probe(sb, side).clone().sub(before);
}

describe('anatomy: every channel moves the limb the way its label says', () => {
  const covered = new Set();
  for (const spec of SPEC) {
    const sides = hasSides(spec.joint) ? ['L', 'R'] : ['L'];
    for (const side of sides) {
      const name = full(spec.joint, side);
      covered.add(`${name}.${spec.ch}`);
      it(`${name}.${spec.ch}: ${spec.probeName}`, () => {
        const def = JOINT_BY_NAME.get(name);
        const d = def.dof.find((c) => c.channel === spec.ch);
        assert.ok(d, `${name} has no channel '${spec.ch}'`);

        const want = new THREE.Vector3(...spec.dir);
        if (side === 'R' && hasSides(spec.joint)) want.x = -want.x;

        const check = (value, expect, wantDir) => {
          const move = probeMove(spec, side, value);
          const len = move.length();
          assert.ok(len > 1e-3, `${name}.${spec.ch}=${value} did not move the ${spec.probeName} (moved ${len.toExponential(2)} m)`);
          const cos = move.dot(wantDir) / len;
          assert.ok(
            cos > 0.7,
            `${name}.${spec.ch}=${value} should ${expect}; ${spec.probeName} moved (${fmt(move)}), ` +
              `expected direction (${fmt(wantDir)}), cosine ${cos.toFixed(3)}`,
          );
        };

        check(Math.min(20, d.max), spec.up, want);
        if (d.min < 0) check(-Math.min(10, -d.min), spec.down, want.clone().negate());
      });
    }
  }

  it('the table covers every channel of every articulated joint (both sides)', () => {
    // The middle finger is the reference axis of the hand: "spread" has no outward direction for it,
    // so it is judged by the uniform-spread test in 'anatomy: exact poses' instead.
    const EXEMPT = new Set(['middle_mcp_L.spread', 'middle_mcp_R.spread']);
    const missing = [];
    for (const def of ARTICULATED) {
      for (const d of def.dof) {
        const key = `${def.name}.${d.channel}`;
        if (!covered.has(key) && !EXEMPT.has(key)) missing.push(key);
      }
    }
    assert.deepEqual(missing, [], 'channels with no anatomical expectation');
  });
});

describe('anatomy: exact poses', () => {
  const len = (name) => Math.hypot(...JOINT_BY_NAME.get(name).offset);
  const rel = (s, child, parent) => s.worldPosition(child).sub(s.worldPosition(parent));
  const set = (joints) => sb.setPose({ joints });

  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const E = (x, y, z) => new THREE.Vector3(sx * x, y, z);

    it(`shoulder_${side}: flex 90 = arm horizontal in front, abd 90 = arm horizontal to its own side, flex 180 = arm straight up`, () => {
      const L = len(`elbow_${side}`);
      set({ [`shoulder_${side}`]: { flex: 90 } });
      assertClose(rel(sb, `elbow_${side}`, `shoulder_${side}`), E(0, 0, L), 1e-9, 'flex 90');
      set({ [`shoulder_${side}`]: { abd: 90 } });
      assertClose(rel(sb, `elbow_${side}`, `shoulder_${side}`), E(L, 0, 0), 1e-9, 'abd 90');
      set({ [`shoulder_${side}`]: { flex: 180 } });
      assertClose(rel(sb, `elbow_${side}`, `shoulder_${side}`), E(0, L, 0), 1e-9, 'flex 180');
      set({ [`shoulder_${side}`]: { flex: -45 } });
      assert.ok(rel(sb, `elbow_${side}`, `shoulder_${side}`).z < -0.1, 'flex -45 must swing the arm backwards');
    });

    it(`elbow_${side}: flex 90 = forearm horizontal forward, flex 150 = hand above the elbow, flex -20 is refused (no hyper-extension)`, () => {
      const L = len(`wrist_${side}`);
      set({ [`elbow_${side}`]: { flex: 90 } });
      assertClose(rel(sb, `wrist_${side}`, `elbow_${side}`), E(0, 0, L), 1e-9, 'flex 90');
      set({ [`elbow_${side}`]: { flex: 150 } });
      const r = rel(sb, `wrist_${side}`, `elbow_${side}`);
      assert.ok(r.y > 0.1 && r.z > 0, `flex 150: hand must be forward and above the elbow, got (${fmt(r)})`);
      const clamps = sb.setPose({ joints: { [`elbow_${side}`]: { flex: -20 } } });
      assert.equal(clamps.length, 1, 'elbow must refuse negative (hyper-extension) flex');
      assert.equal(clamps[0].applied, 0);
    });

    it(`hip_${side}: flex 90 = thigh horizontal forward, abd 90 = leg horizontal to its own side`, () => {
      const L = len(`knee_${side}`);
      set({ [`hip_${side}`]: { flex: 90 } });
      assertClose(rel(sb, `knee_${side}`, `hip_${side}`), E(0, 0, L), 1e-9, 'flex 90');
      set({ [`hip_${side}`]: { abd: 90 } });
      assertClose(rel(sb, `knee_${side}`, `hip_${side}`), E(L, 0, 0), 1e-9, 'abd 90');
    });

    it(`knee_${side}: flex 90 = shin straight back; sitting (hip 90 + knee 90) puts the ankle directly below the knee; flex -20 is refused`, () => {
      const L = len(`ankle_${side}`);
      set({ [`knee_${side}`]: { flex: 90 } });
      assertClose(rel(sb, `ankle_${side}`, `knee_${side}`), E(0, 0, -L), 1e-9, 'standing, knee 90');
      set({ [`hip_${side}`]: { flex: 90 }, [`knee_${side}`]: { flex: 90 } });
      assertClose(rel(sb, `ankle_${side}`, `knee_${side}`), E(0, -L, 0), 1e-9, 'sitting');
      const clamps = sb.setPose({ joints: { [`knee_${side}`]: { flex: -20 } } });
      assert.equal(clamps.length, 1, 'knee must refuse negative (hyper-extension) flex');
    });

    it(`ankle_${side} / toe_${side}: toes-down flex lowers the toe tip, and the foot still points forward`, () => {
      set({});
      const restY = sb.worldPosition(`toe_tip_${side}`).y;
      set({ [`ankle_${side}`]: { flex: 30 } });
      assert.ok(sb.worldPosition(`toe_tip_${side}`).y < restY - 0.05, 'plantar flexion must lower the toe tip');
      set({ [`toe_${side}`]: { flex: 40 } });
      assert.ok(sb.worldPosition(`toe_tip_${side}`).y < restY - 0.02, 'toe flex + must lower the toe tip');
      set({});
      assert.ok(sb.worldPosition(`toe_tip_${side}`).z > sb.worldPosition(`heel_${side}`).z + 0.15, 'foot must point forward (+Z) at rest');
    });
  }

  it('rest pose layout: faces +Z, left side is +X, thumb in front, palms face the thighs, fingers hang down', () => {
    set({});
    assert.ok(nose(sb).z > skull(sb).z + 0.1, 'nose must be in front of the skull centre (face looks toward +Z)');
    for (const def of JOINT_DEFS) {
      const p = sb.worldPosition(def.name);
      if (def.side === 'L') assert.ok(p.x > 0, `${def.name} (left) must have x > 0, got ${p.x}`);
      if (def.side === 'R') assert.ok(p.x < 0, `${def.name} (right) must have x < 0, got ${p.x}`);
      if (def.side === 'C') assert.ok(Math.abs(p.x) < 1e-12, `${def.name} (centre) must sit on x = 0, got ${p.x}`);
    }
    for (const s of ['L', 'R']) {
      const z = (n) => sb.worldPosition(`${n}_${s}`).z;
      assert.ok(z('thumb_tip') > z('index_mcp') && z('index_mcp') > z('middle_mcp') && z('middle_mcp') > z('ring_mcp') && z('ring_mcp') > z('pinky_mcp'),
        `${s} hand: thumb must be foremost, then index, middle, ring, pinky (thumb in front, pinky behind)`);
      assert.ok(sb.worldPosition(`middle_tip_${s}`).y < sb.worldPosition(`wrist_${s}`).y - 0.1, `${s} fingers must hang below the wrist`);
      assertClose(palmNormal(sb, s), new THREE.Vector3(s === 'L' ? -1 : 1, 0, 0), 1e-9, `${s} palm must face the thigh`);
    }
  });

  it('rest pose: every node sits at the sum of the offsets of its ancestors (the hierarchy is wired as defined)', () => {
    set({});
    const expect = (name) => {
      const d = JOINT_BY_NAME.get(name);
      const base = d.parent ? expect(d.parent) : new THREE.Vector3();
      return base.add(new THREE.Vector3(...d.offset));
    };
    for (const n of NODE_NAMES) assertClose(sb.worldPosition(n), expect(n), 1e-9, `rest position of ${n}`);
  });

  it('uniform finger spread (+) fans the hand: the span from index tip to pinky tip widens', () => {
    // The middle finger's channel is "lean toward index (+)" and ring/pinky share one angle,
    // so not EVERY adjacent gap grows; the overall fan does.
    const span = (spread) => {
      const joints = {};
      for (const f of FINGER_IDS) joints[`${f}_mcp_L`] = { spread };
      sb.setPose({ joints });
      return sb.worldPosition('index_tip_L').distanceTo(sb.worldPosition('pinky_tip_L'));
    };
    assert.ok(span(15) > span(0) + 0.02, `index-pinky tip span rest ${span(0).toFixed(4)} -> spread ${span(15).toFixed(4)}`);
  });
});

describe('joint ranges are anatomically plausible', () => {
  const lim = (name, ch) => JOINT_BY_NAME.get(name).dof.find((d) => d.channel === ch);

  it('knee and elbow cannot hyper-extend, and can bend at least 135 degrees', () => {
    for (const s of ['L', 'R']) {
      for (const j of ['knee', 'elbow']) {
        const d = lim(`${j}_${s}`, 'flex');
        assert.ok(d.min >= 0, `${j}_${s}.flex min ${d.min} allows hyper-extension`);
        assert.ok(d.max >= 135, `${j}_${s}.flex max ${d.max} is too small for a bent ${j}`);
      }
    }
  });

  it('toe (ball of foot) can extend (toes up) at least as far as it can flex (toes down)', () => {
    // MTP joint: ~70-90 degrees of dorsiflexion (needed to rise on the toes) versus ~30-45 of plantar flexion.
    const d = lim('toe_L', 'flex');
    assert.ok(-d.min >= d.max, `toe flex allows ${-d.min} deg toes-up but ${d.max} deg toes-down (range is reversed: ${d.min}..${d.max})`);
  });

  it('left and right limits are identical for every channel (a channel value means the same on both sides)', () => {
    for (const def of JOINT_DEFS.filter((d) => d.side === 'L')) {
      const r = JOINT_BY_NAME.get(mirrorName(def.name));
      for (const d of def.dof) {
        const o = r.dof.find((c) => c.channel === d.channel);
        assert.ok(o, `${r.name} lacks channel ${d.channel}`);
        assert.deepEqual([o.min, o.max], [d.min, d.max], `${def.name}.${d.channel} limits differ from ${r.name}`);
      }
    }
  });
});

describe('(1) left/right symmetry', () => {
  const sA = rig();
  const sB = rig();

  const values = (d) => [d.max, 0.4 * d.max, ...(d.min < 0 ? [d.min, 0.4 * d.min] : [])];

  for (const def of ARTICULATED.filter((d) => d.side !== 'R')) {
    for (const d of def.dof) {
      it(`${def.name}.${d.channel}: value v on ${def.side === 'L' ? 'L and R' : 'the centre joint and its mirrored pose'} gives mirror-image positions of all 65 nodes`, () => {
        assert.equal(NODE_NAMES.length, 65);
        for (const v of values(d)) {
          const pose = { joints: { [def.name]: { [d.channel]: v } } };
          sA.setPose(pose);
          sB.setPose(mirrorPose(pose));
          const a = snapshot(sA);
          const b = snapshot(sB);
          for (const n of NODE_NAMES) {
            assertClose(a.get(n), reflect(b.get(mirrorName(n))), 1e-9, `${def.name}.${d.channel}=${v}: node ${n} vs mirrored ${mirrorName(n)}`);
          }
        }
      });
    }
  }

  it('a symmetric pose (centre flex only, equal L/R values) is its own mirror image', () => {
    const joints = { spine: { flex: 20 }, chest: { flex: 15 }, neck: { flex: -10 }, head: { flex: 12 } };
    for (const b of ['shoulder', 'elbow', 'hip', 'knee', 'wrist', 'clavicle', 'index_mcp', 'thumb_cmc']) {
      for (const s of ['L', 'R']) joints[`${b}_${s}`] = Object.fromEntries(JOINT_BY_NAME.get(`${b}_L`).dof.map((d) => [d.channel, 0.3 * d.max]));
    }
    sA.setPose({ joints });
    const a = snapshot(sA);
    for (const n of NODE_NAMES) assertClose(a.get(n), reflect(a.get(mirrorName(n))), 1e-9, `symmetric pose: ${n}`);
  });

  it('200 random full-body poses (all 51 joints + root, auto-ground on): the mirrored pose gives mirrored positions', () => {
    const r = rng(1234);
    const g1 = rig({ autoGround: true });
    const g2 = rig({ autoGround: true });
    for (let i = 0; i < 200; i++) {
      const pose = randomPose(r);
      g1.setPose(pose);
      g2.setPose(mirrorPose(pose));
      const a = snapshot(g1);
      const b = snapshot(g2);
      for (const n of NODE_NAMES) assertClose(a.get(n), reflect(b.get(mirrorName(n))), 1e-9, `random pose #${i}: node ${n}`);
    }
  });
});

describe('(2) bones follow joints', () => {
  const ends = (bone) => [new THREE.Vector3(0, -0.5, 0).applyMatrix4(bone.matrixWorld), new THREE.Vector3(0, 0.5, 0).applyMatrix4(bone.matrixWorld)];

  function checkBones(s, label) {
    for (const def of JOINT_DEFS) {
      if (!def.parent) continue;
      const bone = s.nodes.get(def.name).bone;
      assert.ok(bone, `${def.name} has no bone`);
      const [a, b] = ends(bone);
      const P = s.worldPosition(def.parent);
      const C = s.worldPosition(def.name);
      const direct = a.distanceTo(P) + b.distanceTo(C);
      const flipped = a.distanceTo(C) + b.distanceTo(P);
      assert.ok(
        Math.min(direct, flipped) < 1e-6,
        `${label}: bone ${def.parent} -> ${def.name} ends at (${fmt(a)}) / (${fmt(b)}) but joints are at (${fmt(P)}) / (${fmt(C)})`,
      );
    }
  }

  it('rest pose', () => {
    checkBones(rig(), 'rest');
  });

  it('150 random poses (auto-ground on and off): every bone cylinder runs exactly from parent joint to child joint', () => {
    const r = rng(99);
    const on = rig({ autoGround: true });
    const off = rig({ autoGround: false });
    for (let i = 0; i < 150; i++) {
      const pose = randomPose(r);
      on.setPose(pose);
      off.setPose(pose);
      checkBones(on, `pose #${i} (autoGround)`);
      checkBones(off, `pose #${i}`);
    }
  });

  it('extreme poses (every channel at a limit): bones still match joints', () => {
    const r = rng(5);
    const s = rig();
    for (let i = 0; i < 40; i++) {
      s.setPose(randomPose(r, 'extreme'));
      checkBones(s, `extreme pose #${i}`);
    }
  });

  it('bone length equals the distance between its two joints (rigid, never stretched)', () => {
    const r = rng(7);
    const s = rig();
    for (let i = 0; i < 20; i++) {
      s.setPose(randomPose(r));
      for (const def of JOINT_DEFS.filter((d) => d.parent)) {
        const [a, b] = ends(s.nodes.get(def.name).bone);
        const joints = s.worldPosition(def.parent).distanceTo(s.worldPosition(def.name));
        assert.ok(Math.abs(a.distanceTo(b) - joints) < 1e-9, `${def.name}: bone length ${a.distanceTo(b)} vs joint distance ${joints}`);
        assert.ok(Math.abs(joints - Math.hypot(...def.offset)) < 1e-9, `${def.name}: segment length changed under pose (${joints})`);
      }
    }
  });

  it('hand "web" lines connect exactly the joints they name, in every pose', () => {
    const r = rng(11);
    const s = rig({ autoGround: true });
    for (let i = 0; i < 40; i++) {
      s.setPose(randomPose(r));
      const attr = s.webs.geometry.attributes.position;
      assert.equal(attr.count, WEBS.length * 2, 'one segment per web pair');
      WEBS.forEach(([a, b], k) => {
        assertClose(new THREE.Vector3().fromBufferAttribute(attr, k * 2), s.worldPosition(a), 1e-5, `web ${a}-${b} start`);
        assertClose(new THREE.Vector3().fromBufferAttribute(attr, k * 2 + 1), s.worldPosition(b), 1e-5, `web ${a}-${b} end`);
      });
    }
  });
});

describe('(3) setPose / setChannel / getPose / update', () => {
  it('setPose clamps every channel of every joint to its limits and reports exactly the clamped ones', () => {
    for (const def of ARTICULATED) {
      for (const d of def.dof) {
        const s = rig();
        const over = d.max + 17;
        const under = d.min - 17;
        let clamps = s.setPose({ joints: { [def.name]: { [d.channel]: over } } });
        assert.deepEqual(clamps, [{ joint: def.name, channel: d.channel, requested: over, applied: d.max }], `${def.name}.${d.channel} above max`);
        assert.equal(s.values.get(def.name)[d.channel], d.max, `${def.name}.${d.channel} stored value`);
        clamps = s.setPose({ joints: { [def.name]: { [d.channel]: under } } });
        assert.deepEqual(clamps, [{ joint: def.name, channel: d.channel, requested: under, applied: d.min }], `${def.name}.${d.channel} below min`);
        clamps = s.setPose({ joints: { [def.name]: { [d.channel]: d.max } } });
        assert.deepEqual(clamps, [], `${def.name}.${d.channel} exactly at max must not be reported`);
        clamps = s.setPose({ joints: { [def.name]: { [d.channel]: d.min } } });
        assert.deepEqual(clamps, [], `${def.name}.${d.channel} exactly at min must not be reported`);
      }
    }
  });

  it('setPose reports several clamped values at once and applies the rest unchanged', () => {
    const s = rig();
    const clamps = s.setPose({ joints: { elbow_L: { flex: 999, twist: 30 }, knee_R: { flex: -5 }, shoulder_R: { flex: 45 } } });
    assert.equal(clamps.length, 2);
    assert.ok(clamps.some((c) => c.joint === 'elbow_L' && c.channel === 'flex' && c.requested === 999 && c.applied === 150));
    assert.ok(clamps.some((c) => c.joint === 'knee_R' && c.channel === 'flex' && c.requested === -5 && c.applied === 0));
    assert.equal(s.values.get('elbow_L').twist, 30);
    assert.equal(s.values.get('shoulder_R').flex, 45);
  });

  it('infinite values clamp to the limit instead of breaking the skeleton', () => {
    const s = rig();
    s.setPose({ joints: { elbow_L: { flex: Infinity }, knee_R: { flex: -Infinity } } });
    assert.equal(s.values.get('elbow_L').flex, 150);
    assert.equal(s.values.get('knee_R').flex, 0);
    for (const n of NODE_NAMES) assert.ok(Number.isFinite(s.worldPosition(n).lengthSq()), `${n} became non-finite`);
  });

  it('setPose replaces the WHOLE pose: unmentioned channels and the root go back to rest', () => {
    const s = rig({ autoGround: true });
    s.setPose({ root: { x: 0.3, z: -0.2, lift: 0.1 }, joints: { shoulder_L: { flex: 80 }, hip_R: { abd: 30 } } });
    s.setPose({ joints: { knee_L: { flex: 20 } } });
    const p = s.getPose();
    assert.equal(p.joints.shoulder_L.flex, 0);
    assert.equal(p.joints.hip_R.abd, 0);
    assert.equal(p.joints.knee_L.flex, 20);
    assert.deepEqual(p.root, { x: 0, z: 0, lift: 0 });
    s.setPose({ root: { lift: 0.2 } });
    assert.deepEqual(s.getPose().root, { x: 0, z: 0, lift: 0.2 }, 'a partial root resets the other root fields');
    s.setPose();
    assert.deepEqual(s.getPose().root, { x: 0, z: 0, lift: 0 });
  });

  it('setPose ignores unknown joints and channels without throwing', () => {
    const s = rig();
    assert.doesNotThrow(() => s.setPose({ joints: { not_a_joint: { flex: 10 }, elbow_L: { nonsense: 5, flex: 20 }, toe_tip_L: { flex: 10 } } }));
    assert.equal(s.values.get('elbow_L').flex, 20);
    assert.ok(!('nonsense' in s.values.get('elbow_L')));
    assert.ok(!s.values.has('toe_tip_L'), 'end points have no channels');
  });

  it('setChannel clamps to the joint limits, ignores unknown joints / channels, and moves the skeleton', () => {
    const s = rig();
    s.setChannel('knee_L', 'flex', 999);
    assert.equal(s.getPose().joints.knee_L.flex, 150);
    s.setChannel('knee_L', 'flex', -999);
    assert.equal(s.getPose().joints.knee_L.flex, 0);
    s.setChannel('shoulder_R', 'abd', -999);
    assert.equal(s.getPose().joints.shoulder_R.abd, -60);
    const before = snapshot(s);
    assert.doesNotThrow(() => s.setChannel('nope', 'flex', 10));
    assert.doesNotThrow(() => s.setChannel('knee_L', 'nope', 10));
    assert.doesNotThrow(() => s.setChannel('toe_tip_L', 'flex', 10));
    assertSnapshotsClose(snapshot(s), before, 1e-12, 'no-op setChannel');
    const rest = snapshot(rig());
    s.setChannel('elbow_R', 'flex', 90);
    assert.ok(s.worldPosition('wrist_R').distanceTo(rest.get('wrist_R')) > 0.2, 'setChannel must update the world positions immediately');
  });

  it('setChannel equals setPose with the same value (single source of truth)', () => {
    const s1 = rig({ autoGround: true });
    const s2 = rig({ autoGround: true });
    s1.setChannel('hip_L', 'flex', 70);
    s2.setPose({ joints: { hip_L: { flex: 70 } } });
    assertSnapshotsClose(snapshot(s1), snapshot(s2), 1e-12, 'setChannel vs setPose');
  });

  it('resetJoint zeroes one joint and leaves the others alone', () => {
    const s = rig();
    s.setPose({ joints: { elbow_L: { flex: 90, twist: 30 }, elbow_R: { flex: 40 } } });
    s.resetJoint('elbow_L');
    const p = s.getPose();
    assert.deepEqual(p.joints.elbow_L, { flex: 0, twist: 0 });
    assert.equal(p.joints.elbow_R.flex, 40);
    assert.doesNotThrow(() => s.resetJoint('toe_tip_L'));
  });

  it('getPose is dense (every channel of every joint, root included) and returns copies', () => {
    const s = rig();
    const p = s.getPose();
    assert.equal(Object.keys(p.joints).length, 51, '51 articulated joints');
    assert.equal(Object.keys(p.joints).length, ARTICULATED.length);
    for (const def of ARTICULATED) assert.deepEqual(Object.keys(p.joints[def.name]).sort(), def.dof.map((d) => d.channel).sort(), `${def.name} channels`);
    assert.deepEqual(Object.keys(p.root).sort(), ['lift', 'x', 'z']);
    p.joints.elbow_L.flex = 123;
    p.root.x = 5;
    assert.equal(s.getPose().joints.elbow_L.flex, 0, 'mutating the returned pose must not change the skeleton');
    assert.equal(s.getPose().root.x, 0);
  });

  it('getPose -> setPose round-trips exactly (values, root and world positions), with nothing reported as clamped', () => {
    const r = rng(42);
    for (let i = 0; i < 30; i++) {
      const s1 = rig({ autoGround: true });
      const s2 = rig({ autoGround: true });
      const pose = randomPose(r);
      assert.deepEqual(s1.setPose(pose), []);
      const dump = s1.getPose();
      assert.deepEqual(s2.setPose(dump), [], 'a dumped pose is always within limits');
      assert.deepEqual(s2.getPose(), dump, `round trip #${i}`);
      assertSnapshotsClose(snapshot(s2), snapshot(s1), 1e-12, `round trip #${i}`);
      for (const [n, chs] of Object.entries(pose.joints)) for (const [c, v] of Object.entries(chs)) assert.equal(dump.joints[n][c], v, `${n}.${c}`);
    }
  });

  it('update() is idempotent: calling it again changes neither joints, quaternions nor the grounding', () => {
    const r = rng(3);
    for (const autoGround of [true, false]) {
      const s = rig({ autoGround });
      s.setPose(randomPose(r));
      const before = snapshot(s);
      const quats = [...s.nodes.values()].map((n) => n.object.quaternion.clone());
      for (let k = 0; k < 5; k++) s.update();
      assertSnapshotsClose(snapshot(s), before, 1e-12, `update() x5 (autoGround=${autoGround})`);
      [...s.nodes.values()].forEach((n, i) => {
        const dq = Math.max(...n.object.quaternion.toArray().map((c, k) => Math.abs(c - quats[i].toArray()[k])));
        assert.ok(dq < 1e-12, `${n.def.name} quaternion drifted by ${dq.toExponential(2)}`);
      });
    }
  });

  it('pose is a pure function of the channel values: reaching a pose by different routes gives identical results', () => {
    const r = rng(8);
    const s = rig({ autoGround: true });
    const ref = rig({ autoGround: true });
    const target = randomPose(r);
    ref.setPose(target);
    s.setPose(randomPose(r));
    s.setPose(randomPose(r));
    s.setPose(target);
    assertSnapshotsClose(snapshot(s), snapshot(ref), 1e-12, 'history independence');
    for (const [n, chs] of Object.entries(target.joints)) for (const [c, v] of Object.entries(chs)) s.setChannel(n, c, v);
    assertSnapshotsClose(snapshot(s), snapshot(ref), 1e-12, 'setChannel replay');
  });
});

describe('(4) auto-ground', () => {
  const g = rig({ autoGround: true });
  const lowest = (s) => Math.min(...GROUND_CONTACTS.map((n) => s.worldPosition(n).y));

  it('rest pose: pelvis sits at its rest height and the lowest foot node is exactly on the floor', () => {
    g.setPose({});
    assert.ok(Math.abs(g.worldPosition('pelvis').y - REST_Y) < 1e-9, `pelvis height ${g.worldPosition('pelvis').y} vs ${REST_Y}`);
    assert.ok(Math.abs(lowest(g)) < 1e-9, `lowest foot node at y=${lowest(g)}`);
  });

  it('rest pose: nothing is below the floor', () => {
    g.setPose({});
    for (const n of NODE_NAMES) assert.ok(g.worldPosition(n).y > -1e-9, `${n} is below the floor at y=${g.worldPosition(n).y}`);
  });

  it('300 random poses: the lowest ground-contact node is at y = 0 (y = lift when lifted)', () => {
    const r = rng(2024);
    for (let i = 0; i < 300; i++) {
      const pose = randomPose(r);
      g.setPose(pose);
      const want = pose.root.lift ?? 0;
      assert.ok(Math.abs(lowest(g) - want) < 1e-9, `pose #${i}: lowest foot node at y=${lowest(g)}, expected ${want} (lift ${pose.root.lift})`);
    }
  });

  it('extreme poses: still grounded', () => {
    const r = rng(77);
    for (let i = 0; i < 60; i++) {
      g.setPose(randomPose(r, 'extreme', false));
      assert.ok(Math.abs(lowest(g)) < 1e-9, `extreme pose #${i}: lowest foot node at y=${lowest(g)}`);
    }
  });

  it('lift raises the whole body by exactly `lift` metres', () => {
    const r = rng(5);
    for (let i = 0; i < 20; i++) {
      const pose = randomPose(r, 'uniform', false);
      g.setPose(pose);
      const base = snapshot(g);
      g.setPose({ ...pose, root: { lift: 0.37 } });
      const up = snapshot(g);
      for (const n of NODE_NAMES) assertClose(up.get(n), base.get(n).clone().add(new THREE.Vector3(0, 0.37, 0)), 1e-9, `lift 0.37, node ${n}`);
    }
  });

  it('root x / z translate the whole body horizontally without changing its shape or height', () => {
    const r = rng(6);
    for (let i = 0; i < 20; i++) {
      const pose = randomPose(r, 'uniform', false);
      g.setPose(pose);
      const base = snapshot(g);
      g.setPose({ ...pose, root: { x: 1.25, z: -0.5 } });
      const moved = snapshot(g);
      for (const n of NODE_NAMES) assertClose(moved.get(n), base.get(n).clone().add(new THREE.Vector3(1.25, 0, -0.5)), 1e-9, `root x/z, node ${n}`);
      assert.ok(Math.abs(g.worldPosition('pelvis').x - 1.25) < 1e-9 && Math.abs(g.worldPosition('pelvis').z + 0.5) < 1e-9);
    }
  });

  it('autoGround = false keeps the pelvis at rest height (plus lift) whatever the legs do, and feet may leave the floor', () => {
    const s = rig({ autoGround: false });
    s.setPose({ joints: { hip_L: { flex: 90 }, hip_R: { flex: 90 } } });
    assert.ok(Math.abs(s.worldPosition('pelvis').y - REST_Y) < 1e-9, 'pelvis must stay at rest height');
    assert.ok(lowest(s) > 0.2, `feet should be well off the floor when not grounded (lowest at ${lowest(s)})`);
    s.setPose({ root: { lift: 0.3, x: 0.2, z: 0.1 }, joints: { knee_L: { flex: 100 } } });
    assertClose(s.worldPosition('pelvis'), new THREE.Vector3(0.2, REST_Y + 0.3, 0.1), 1e-9, 'pelvis with lift and root offset');
  });

  it('standing on one leg with the other raised: the supporting foot is the one on the floor', () => {
    g.setPose({ joints: { hip_R: { flex: 90 }, knee_R: { flex: 90 } } });
    assert.ok(Math.abs(g.worldPosition('toe_tip_L').y) < 1e-9 || Math.abs(g.worldPosition('heel_L').y) < 1e-9, 'left foot must touch the floor');
    assert.ok(g.worldPosition('toe_tip_R').y > 0.3, 'raised foot must be well above the floor');
    g.setPose({ joints: { hip_L: { flex: 90 }, knee_L: { flex: 90 } } });
    assert.ok(g.worldPosition('toe_tip_L').y > 0.3, 'raised foot must be well above the floor');
  });

  it('rest pose is flat-footed: heel, ball of foot and toe tip all rest on the floor (within 5 mm)', () => {
    g.setPose({});
    for (const s of ['L', 'R']) {
      for (const n of ['heel', 'toe', 'toe_tip']) {
        const y = g.worldPosition(`${n}_${s}`).y;
        assert.ok(y < 0.005, `${n}_${s} hovers ${(y * 1000).toFixed(0)} mm above the floor at rest (a flat foot should touch with heel, ball and toes)`);
      }
    }
  });

  it('every named pose keeps every node on or above the floor (nothing sinks through it)', () => {
    for (const [key, pose] of Object.entries(POSES)) {
      g.setPose(pose);
      const lowestAll = NODE_NAMES.map((n) => [n, g.worldPosition(n).y]).sort((a, b) => a[1] - b[1])[0];
      assert.ok(lowestAll[1] > -0.005, `pose '${key}': ${lowestAll[0]} is ${(-lowestAll[1] * 1000).toFixed(0)} mm below the floor`);
    }
  });
});

describe('(5) channel composition order (jointDefs.js header: dof is outermost-first, the LAST channel is innermost)', () => {
  it('every joint\'s local rotation = R(dof[0]) * R(dof[1]) * ... for random channel values (own Rodrigues implementation)', () => {
    const r = rng(31);
    const s = rig();
    for (let i = 0; i < 25; i++) {
      for (const def of ARTICULATED) {
        const vals = Object.fromEntries(def.dof.map((d) => [d.channel, d.min + r() * (d.max - d.min)]));
        s.setPose({ joints: { [def.name]: vals } });
        let want = IDENT;
        for (const d of def.dof) want = mul(want, rot(AXES[d.axis], d.sign * vals[d.channel]));
        const got = rotOf(s.nodes.get(def.name).object.matrix);
        assert.ok(maxDiff(got, want) < 1e-9, `${def.name} with ${JSON.stringify(vals)}: rotation differs from the documented composition by ${maxDiff(got, want).toExponential(2)}`);
      }
    }
  });

  it('the composition test is not vacuous: reversing the order gives a visibly different shoulder rotation', () => {
    const def = JOINT_BY_NAME.get('shoulder_L');
    const vals = { flex: 50, abd: 70, twist: 30 };
    let fwd = IDENT;
    let rev = IDENT;
    for (const d of def.dof) fwd = mul(fwd, rot(AXES[d.axis], d.sign * vals[d.channel]));
    for (const d of [...def.dof].reverse()) rev = mul(rev, rot(AXES[d.axis], d.sign * vals[d.channel]));
    assert.ok(maxDiff(fwd, rev) > 0.1);
  });

  for (const base of ['shoulder', 'hip']) {
    for (const side of ['L', 'R']) {
      const name = `${base}_${side}`;
      const child = base === 'shoulder' ? `elbow_${side}` : `knee_${side}`;
      const sx = side === 'L' ? 1 : -1;
      const d = (ch) => JOINT_BY_NAME.get(name).dof.find((c) => c.channel === ch);

      it(`${name}: flex is applied last in the parent frame, abd first — child direction = (sin abd, -cos abd cos flex, cos abd sin flex)`, () => {
        const L = Math.hypot(...JOINT_BY_NAME.get(child).offset);
        const r = rng(base.length * 7 + sx);
        for (let i = 0; i < 40; i++) {
          const a = d('abd').min + r() * (d('abd').max - d('abd').min);
          const f = d('flex').min + r() * (d('flex').max - d('flex').min);
          const t = d('twist').min + r() * (d('twist').max - d('twist').min);
          sb.setPose({ joints: { [name]: { flex: f, abd: a, twist: t } } });
          const want = new THREE.Vector3(sx * Math.sin(a * DEG), -Math.cos(a * DEG) * Math.cos(f * DEG), Math.cos(a * DEG) * Math.sin(f * DEG)).multiplyScalar(L);
          assertClose(sb.worldPosition(child).sub(sb.worldPosition(name)), want, 1e-9, `${name} flex=${f.toFixed(1)} abd=${a.toFixed(1)} twist=${t.toFixed(1)}`);
        }
      });

      it(`${name}: twist is innermost — it spins the limb about its own axis, so the child joint never moves`, () => {
        const r = rng(13 + sx);
        for (let i = 0; i < 20; i++) {
          const f = d('flex').min + r() * (d('flex').max - d('flex').min);
          const a = d('abd').min + r() * (d('abd').max - d('abd').min);
          sb.setPose({ joints: { [name]: { flex: f, abd: a, twist: 0 } } });
          const p0 = sb.worldPosition(child);
          sb.setPose({ joints: { [name]: { flex: f, abd: a, twist: d('twist').max * 0.8 } } });
          assertClose(sb.worldPosition(child), p0, 1e-9, `${name} twist moved ${child} (flex ${f.toFixed(1)}, abd ${a.toFixed(1)})`);
        }
      });
    }
  }

  it('spine / chest / neck: twist is innermost (the next joint up never moves when twisting)', () => {
    const chain = { spine: 'chest', chest: 'neck', neck: 'head' };
    const r = rng(21);
    for (const [j, child] of Object.entries(chain)) {
      const d = (ch) => JOINT_BY_NAME.get(j).dof.find((c) => c.channel === ch);
      for (let i = 0; i < 10; i++) {
        const f = d('flex').min + r() * (d('flex').max - d('flex').min);
        const b = d('bend').min + r() * (d('bend').max - d('bend').min);
        sb.setPose({ joints: { [j]: { flex: f, bend: b, twist: 0 } } });
        const p0 = sb.worldPosition(child);
        sb.setPose({ joints: { [j]: { flex: f, bend: b, twist: d('twist').max } } });
        assertClose(sb.worldPosition(child), p0, 1e-9, `${j} twist moved ${child}`);
      }
    }
    // head has no child joint: its skull centre lies on the twist axis
    sb.setPose({ joints: { head: { flex: 20, bend: 10, twist: 0 } } });
    const s0 = skull(sb);
    sb.setPose({ joints: { head: { flex: 20, bend: 10, twist: 50 } } });
    assertClose(skull(sb), s0, 1e-9, 'head twist moved the skull centre');
  });

  it('pelvis: twist is outermost — it is a pure rotation about the world vertical, so no node changes height', () => {
    const r = rng(17);
    for (let i = 0; i < 15; i++) {
      const joints = { pelvis: { flex: (r() - 0.5) * 100, bend: (r() - 0.5) * 70, twist: 0 }, hip_L: { flex: 40 }, shoulder_R: { abd: 60 } };
      sb.setPose({ joints });
      const a = snapshot(sb);
      sb.setPose({ joints: { ...joints, pelvis: { ...joints.pelvis, twist: 117 } } });
      const b = snapshot(sb);
      for (const n of NODE_NAMES) assert.ok(Math.abs(a.get(n).y - b.get(n).y) < 1e-9, `pelvis twist changed the height of ${n}`);
    }
  });

  // Consequence of "flex outermost, abd second" (documented): the child direction is
  // (sin abd, -cos abd cos flex, cos abd sin flex). At abd = 90 the arm lies ALONG the flex axis (X) so flex cannot
  // swing it, and for abd > 90 cos(abd) < 0 so a positive flex swings the arm BACKWARD. The label says
  // "Arm forward (+)" / "Thigh forward (+)", so these assertions encode the label and are expected to fail.
  // abd 90 is a documented pole (jointDefs.js header) and abd is capped at 90, so probe below it
  for (const [base, child, abd] of [['shoulder', 'elbow', 30], ['shoulder', 'elbow', 60], ['shoulder', 'elbow', 80], ['hip', 'knee', 45], ['hip', 'knee', 80]]) {
    for (const side of ['L', 'R']) {
      it(`${base}_${side}: flex + still swings the limb FORWARD when it is already abducted ${abd} deg`, () => {
        const name = `${base}_${side}`;
        sb.setPose({ joints: { [name]: { abd } } });
        const before = sb.worldPosition(`${child}_${side}`);
        sb.setPose({ joints: { [name]: { abd, flex: 30 } } });
        const dz = sb.worldPosition(`${child}_${side}`).z - before.z;
        assert.ok(dz > 0.02, `${name}.abd=${abd}: flex=+30 ("forward") moved ${child}_${side} by dz=${dz.toFixed(3)} m (expected clearly forward, > 0.02 m)`);
      });
    }
  }
});

describe('(6) joint extremes never produce NaN', () => {
  function assertFinite(s, label) {
    for (const [name, { object }] of s.nodes) {
      const e = object.matrixWorld.elements;
      assert.ok(e.every(Number.isFinite), `${label}: matrixWorld of ${name} has a non-finite entry`);
      const q = object.quaternion;
      assert.ok(Math.abs(q.length() - 1) < 1e-9, `${label}: quaternion of ${name} is not unit length (${q.length()})`);
      const R = rotOf(object.matrixWorld);
      assert.ok(maxDiff(mul(R, [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[j][i]))), IDENT) < 1e-9, `${label}: world rotation of ${name} is not orthonormal`);
    }
    for (const v of s.webs.geometry.attributes.position.array) assert.ok(Number.isFinite(v), `${label}: web vertex is not finite`);
  }

  it('every single channel of every joint at its min and at its max (others at rest)', () => {
    for (const autoGround of [true, false]) {
      const s = rig({ autoGround });
      for (const def of ARTICULATED) {
        for (const d of def.dof) {
          for (const v of [d.min, d.max]) {
            s.setPose({ joints: { [def.name]: { [d.channel]: v } } });
            assertFinite(s, `${def.name}.${d.channel}=${v} autoGround=${autoGround}`);
          }
        }
      }
    }
  });

  it('all channels at max, all at min, and 300 random min/max corners', () => {
    const s = rig({ autoGround: true });
    for (const pick of ['min', 'max']) {
      const joints = {};
      for (const def of ARTICULATED) joints[def.name] = Object.fromEntries(def.dof.map((d) => [d.channel, d[pick]]));
      s.setPose({ joints });
      assertFinite(s, `all channels at ${pick}`);
    }
    const r = rng(666);
    for (let i = 0; i < 300; i++) {
      s.setPose(randomPose(r, 'extreme'));
      assertFinite(s, `extreme corner #${i}`);
    }
  });

  it('values far outside the limits are clamped, not extrapolated (no NaN, no wild positions)', () => {
    const s = rig({ autoGround: true });
    const joints = {};
    for (const def of ARTICULATED) joints[def.name] = Object.fromEntries(def.dof.map((d) => [d.channel, 1e9]));
    const clamps = s.setPose({ joints });
    assert.equal(clamps.length, ARTICULATED.reduce((n, d) => n + d.dof.length, 0), 'every channel must be reported as clamped');
    assertFinite(s, 'huge values');
    for (const n of NODE_NAMES) assert.ok(s.worldPosition(n).length() < 5, `${n} flew away: ${fmt(s.worldPosition(n))}`);
  });

  it('a bad ROOT value (undefined / NaN / non-numeric) must not turn the whole skeleton into NaN', () => {
    const cases = {
      'root.x = undefined': { x: undefined },
      'root.x = NaN': { x: NaN },
      'root.z = NaN': { z: NaN },
      'root.lift = "abc"': { lift: 'abc' },
    };
    for (const [label, root] of Object.entries(cases)) {
      const s = rig({ autoGround: true });
      s.setPose({ root });
      const bad = NODE_NAMES.filter((n) => !Number.isFinite(s.worldPosition(n).lengthSq()));
      assert.deepEqual(bad, [], `setPose({ root: ... }) with ${label} turned ${bad.length} of ${NODE_NAMES.length} nodes into NaN`);
    }
  });

  it('a NaN / non-numeric CHANNEL value is rejected or treated as rest: it is never stored as NaN in the pose', () => {
    for (const bad of [NaN, 'abc']) {
      const s = rig({ autoGround: true });
      const clamps = s.setPose({ joints: { elbow_L: { flex: bad } } });
      const stored = s.getPose().joints.elbow_L.flex;
      assert.ok(Number.isFinite(stored), `setPose(elbow_L.flex = ${String(bad)}) stored ${stored} in getPose() (JSON.stringify gives ${JSON.stringify(stored)}); clamp report: ${JSON.stringify(clamps)}`);
      const s2 = rig({ autoGround: true });
      s2.setChannel('knee_R', 'flex', bad);
      const stored2 = s2.getPose().joints.knee_R.flex;
      assert.ok(Number.isFinite(stored2), `setChannel(knee_R.flex = ${String(bad)}) stored ${stored2} in getPose()`);
      const nan = NODE_NAMES.filter((n) => !Number.isFinite(s2.worldPosition(n).lengthSq()));
      assert.deepEqual(nan, [], 'skeleton must stay finite');
    }
  });
});
