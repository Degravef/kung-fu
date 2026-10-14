/**
 * Skeleton data-integrity suite for src/skeleton/jointDefs.js (+ the rest pose
 * built by Stickboy.js). Pure Node, no DOM:  node --test tests/jointDefs.test.js
 *
 * The suite encodes the INTENDED behaviour (what jointDefs.js documents, and what
 * is anatomically right). A failing test means the data contradicts that
 * intention, not that the test should be loosened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  JOINT_DEFS,
  JOINT_BY_NAME,
  REGIONS,
  WEBS,
  GROUND_CONTACTS,
  HAND_SCALE,
  childrenOf,
} from '../src/skeleton/jointDefs.js';
import { Stickboy } from '../src/skeleton/Stickboy.js';

/* ------------------------------------------------------------------ helpers */

const names = JOINT_DEFS.map((d) => d.name);
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const SIDES = [
  { s: 'L', k: +1, region: 'Left hand' }, // k = world-X direction of "outward" for that side
  { s: 'R', k: -1, region: 'Right hand' },
];
const twin = (n) => n.replace(/_L$/, '_R');
const leftDefs = JOINT_DEFS.filter((d) => d.name.endsWith('_L'));
const rightDefs = JOINT_DEFS.filter((d) => d.name.endsWith('_R'));
const centreDefs = JOINT_DEFS.filter((d) => !/_[LR]$/.test(d.name));
const indexOf = new Map(names.map((n, i) => [n, i]));
const def = (n) => {
  const d = JOINT_BY_NAME.get(n);
  assert.ok(d, `node "${n}" does not exist in JOINT_BY_NAME`);
  return d;
};

const fmt = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
const mm = (m) => `${(m * 1000).toFixed(1)} mm`;
const expectNone = (problems, headline) =>
  assert.equal(problems.length, 0, `${headline} (${problems.length}):\n    - ${problems.join('\n    - ')}`);
const inRange = (value, lo, hi, what) =>
  assert.ok(value >= lo && value <= hi, `${what} = ${+value.toFixed(4)} is outside the plausible human range [${lo}, ${hi}]`);

/** Fraction (0..1) of the SMALLER sphere's volume that lies inside the other sphere. */
function overlapFraction(r1, r2, d) {
  if (d >= r1 + r2) return 0;
  const rMin = Math.min(r1, r2);
  if (d <= Math.abs(r1 - r2)) return 1;
  const s = r1 + r2 - d;
  const lens = (Math.PI * s * s * (d * d + 2 * d * (r1 + r2) - 3 * (r1 - r2) ** 2)) / (12 * d);
  return lens / ((4 / 3) * Math.PI * rMin ** 3);
}

/** The rest pose, exactly as the app builds it (auto-ground ON, the default). */
const rest = new Stickboy();
const restPos = (n) => rest.worldPosition(n, new THREE.Vector3());

/** A second rig for posing experiments (auto-ground OFF so nothing is compensated). */
const rig = new Stickboy();
rig.autoGround = false;
rig.setPose({});
const wp = (n) => rig.worldPosition(n, new THREE.Vector3());
const REST_POS = new Map(names.map((n) => [n, wp(n)]));

function setPose(joints) {
  const clamped = rig.setPose({ joints });
  assert.deepEqual(clamped, [], `test bug: pose uses values outside the joint limits: ${JSON.stringify(clamped)}`);
}
/** World-space displacement of `node` caused by `joints`, relative to the rest pose. */
function moved(joints, node) {
  setPose(joints);
  return wp(node).sub(REST_POS.get(node));
}
/** Direction the head/neck/etc. object's local up / forward / left axes point after posing. */
function axesOf(joints, node) {
  setPose(joints);
  const m = rig.nodes.get(node).object.matrixWorld;
  const t = (x, y, z) => new THREE.Vector3(x, y, z).transformDirection(m);
  return { up: t(0, 1, 0), fwd: t(0, 0, 1), left: t(1, 0, 0) };
}

/* ==================================================================== STRUCTURE */

test('structure: node names are unique, snake_case, and JOINT_BY_NAME mirrors JOINT_DEFS', () => {
  const seen = new Set();
  const dups = [];
  for (const n of names) {
    if (seen.has(n)) dups.push(n);
    seen.add(n);
  }
  expectNone(dups, 'duplicate node names');
  assert.equal(JOINT_BY_NAME.size, JOINT_DEFS.length, 'JOINT_BY_NAME has a different size than JOINT_DEFS');
  for (const d of JOINT_DEFS) assert.equal(JOINT_BY_NAME.get(d.name), d, `JOINT_BY_NAME["${d.name}"] is not the same def object`);
  expectNone(
    names.filter((n) => !/^[a-z]+(?:_[a-z]+)*(?:_[LR])?$/.test(n)),
    'names that are not lowercase snake_case with an optional _L/_R suffix',
  );
});

test('structure: exactly one root, it is "pelvis", and it comes first', () => {
  const roots = JOINT_DEFS.filter((d) => d.parent == null);
  assert.deepEqual(roots.map((d) => d.name), ['pelvis'], 'expected a single parentless node named "pelvis"');
  assert.equal(JOINT_DEFS[0].name, 'pelvis', 'pelvis must be the first entry (parents always before children)');
});

test('structure: every parent exists and appears BEFORE its child in JOINT_DEFS', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    if (d.parent == null) continue;
    if (!JOINT_BY_NAME.has(d.parent)) problems.push(`${d.name}: parent "${d.parent}" does not exist`);
    else if (indexOf.get(d.parent) >= indexOf.get(d.name)) problems.push(`${d.name}: parent "${d.parent}" is listed after it`);
    if (d.parent === d.name) problems.push(`${d.name}: is its own parent`);
  }
  expectNone(problems, 'broken parent links');
});

test('structure: every node reaches the pelvis, and a side never parents the opposite side', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    let n = d.name;
    for (let i = 0; i < 40 && n; i++) n = JOINT_BY_NAME.get(n).parent;
    if (n) problems.push(`${d.name}: parent chain does not terminate (cycle?)`);
    if (!d.parent) continue;
    const p = JOINT_BY_NAME.get(d.parent);
    if (d.side !== 'C' && p.side !== 'C' && p.side !== d.side) problems.push(`${d.name} (${d.side}) has parent ${p.name} (${p.side})`);
    if (d.side === 'C' && p.side !== 'C') problems.push(`centre node ${d.name} hangs off ${p.name} (${p.side})`);
  }
  expectNone(problems, 'bad hierarchy');
});

test('structure: `side` matches the _L/_R suffix and `kind` matches whether the node has channels', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    const want = d.name.endsWith('_L') ? 'L' : d.name.endsWith('_R') ? 'R' : 'C';
    if (d.side !== want) problems.push(`${d.name}: side=${d.side}, expected ${want}`);
    const kind = d.dof.length ? 'joint' : 'end';
    if (d.kind !== kind) problems.push(`${d.name}: kind=${d.kind} but has ${d.dof.length} channels`);
  }
  expectNone(problems, 'inconsistent side/kind');
});

test('structure: offsets are 3 finite numbers; only the root may have zero length; centre line sits at x = 0', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    if (!Array.isArray(d.offset) || d.offset.length !== 3 || !d.offset.every(Number.isFinite)) {
      problems.push(`${d.name}: offset ${JSON.stringify(d.offset)} is not 3 finite numbers`);
      continue;
    }
    const len = Math.hypot(...d.offset);
    if (d.parent && len < 0.005) problems.push(`${d.name}: bone to parent is only ${mm(len)} long`);
    if (d.side === 'C' && Math.abs(d.offset[0]) > 1e-12) problems.push(`${d.name}: centre-line node has x offset ${d.offset[0]}`);
  }
  expectNone(problems, 'bad offsets');
});

test('counts: 65 nodes = 51 articulated joints (>= 1 channel) + 14 end points (no channels)', () => {
  assert.equal(JOINT_DEFS.length, 65, 'total nodes');
  const joints = JOINT_DEFS.filter((d) => d.dof.length >= 1);
  const ends = JOINT_DEFS.filter((d) => d.dof.length === 0);
  assert.equal(joints.length, 51, `articulated joints; got ${joints.length}`);
  assert.equal(ends.length, 14, `end points; got ${ends.length}: ${ends.map((d) => d.name)}`);
  assert.equal(JOINT_DEFS.filter((d) => d.kind === 'joint').length, 51, 'kind === "joint" count');
  assert.equal(JOINT_DEFS.filter((d) => d.kind === 'end').length, 14, 'kind === "end" count');
  assert.equal(centreDefs.length, 5, 'centre-line nodes (pelvis, spine, chest, neck, head)');
  assert.equal(leftDefs.length, 30, 'left-side nodes');
  assert.equal(rightDefs.length, 30, 'right-side nodes');
  assert.deepEqual(
    ends.map((d) => d.name).sort(),
    ['heel_L', 'heel_R', 'toe_tip_L', 'toe_tip_R', ...['index', 'middle', 'ring', 'pinky', 'thumb'].flatMap((f) => [`${f}_tip_L`, `${f}_tip_R`])].sort(),
    'the 14 end points should be heel, toe tip and 5 fingertips per side',
  );
});

test('structure: end points (tips / landmarks, "nothing to rotate") are leaves', () => {
  const ends = JOINT_DEFS.filter((d) => d.kind === 'end');
  expectNone(ends.filter((d) => childrenOf(d.name).length).map((d) => d.name), 'end points that have children');
});

test('structure: every articulated joint has a child node, so rotating it visibly moves a tracked landmark', () => {
  // 'head' is exempt: its skull/face mesh is the visible landmark (decided: not worth a head_top node yet).
  const orphans = JOINT_DEFS.filter((d) => d.kind === 'joint' && d.name !== 'head' && childrenOf(d.name).length === 0).map(
    (d) => `${d.name} (${d.dof.map((c) => c.channel).join('/')}): rotating it moves no node at all`,
  );
  expectNone(orphans, 'joints with channels but nothing attached');
});

test('structure: childrenOf() is the inverse of `parent`', () => {
  let total = 0;
  for (const d of JOINT_DEFS) {
    const kids = childrenOf(d.name);
    total += kids.length;
    for (const k of kids) assert.equal(def(k).parent, d.name, `childrenOf(${d.name}) lists ${k} whose parent is ${def(k).parent}`);
  }
  assert.equal(total, JOINT_DEFS.length - 1, 'every node except the root must be the child of exactly one node');
});

/* ======================================================================= LABELS */

test('labels: every label and short label is a non-empty trimmed string; full labels are globally unique', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    for (const key of ['label', 'short']) {
      if (typeof d[key] !== 'string' || !d[key].trim()) problems.push(`${d.name}: ${key} is empty`);
      else if (d[key] !== d[key].trim()) problems.push(`${d.name}: ${key} has surrounding whitespace`);
    }
  }
  expectNone(problems, 'empty labels');
  const byLabel = new Map();
  for (const d of JOINT_DEFS) byLabel.set(d.label, [...(byLabel.get(d.label) ?? []), d.name]);
  expectNone(
    [...byLabel].filter(([, n]) => n.length > 1).map(([l, n]) => `"${l}" is shared by ${n.join(', ')}`),
    'duplicate full labels',
  );
});

test('labels: short labels are unique within a UI region (they are what the joint list shows)', () => {
  const seen = new Map();
  const problems = [];
  for (const d of JOINT_DEFS) {
    const key = `${d.region}|${d.short}`;
    if (seen.has(key)) problems.push(`${d.region}: "${d.short}" used by both ${seen.get(key)} and ${d.name}`);
    seen.set(key, d.name);
  }
  expectNone(problems, 'ambiguous short labels');
});

test('labels: Left/Right wording matches the side, and the region prefix matches the side', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    const word = { L: /\bLeft\b/, R: /\bRight\b/, C: /\b(Left|Right)\b/ }[d.side];
    if (d.side === 'C' ? word.test(d.label) : !word.test(d.label)) problems.push(`${d.name}: label "${d.label}" has the wrong side wording`);
    const other = d.side === 'L' ? /\bRight\b/ : d.side === 'R' ? /\bLeft\b/ : null;
    if (other?.test(d.label)) problems.push(`${d.name}: label "${d.label}" mentions the opposite side`);
    const regionOk = d.side === 'L' ? d.region.startsWith('Left ') : d.side === 'R' ? d.region.startsWith('Right ') : d.region === 'Body';
    if (!regionOk) problems.push(`${d.name}: region "${d.region}" does not match side ${d.side}`);
  }
  expectNone(problems, 'side/label/region mismatches');
});

test('labels: finger/thumb joint labels name the finger and carry the right anatomical abbreviation', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    const m = d.name.match(/^(index|middle|ring|pinky|thumb)_(mcp|pip|dip|ip|cmc|tip)_[LR]$/);
    if (!m) continue;
    const [, finger, joint] = m;
    if (!d.label.toLowerCase().includes(finger)) problems.push(`${d.name}: label "${d.label}" does not say "${finger}"`);
    if (joint === 'tip') {
      if (!/tip/i.test(d.label)) problems.push(`${d.name}: label "${d.label}" does not say tip`);
    } else if (!d.label.includes(`(${joint.toUpperCase()})`)) problems.push(`${d.name}: label "${d.label}" lacks "(${joint.toUpperCase()})"`);
    if (!d.short.startsWith(`${d.part} · `)) problems.push(`${d.name}: short "${d.short}" should start with its part "${d.part} · " (the hand list splits on " · ")`);
  }
  expectNone(problems, 'bad finger labels');
});

/* ================================================================== LEFT / RIGHT */

test('mirror: every _L node has an _R twin and vice versa; no stray nodes', () => {
  expectNone(leftDefs.filter((d) => !JOINT_BY_NAME.has(twin(d.name))).map((d) => d.name), '_L nodes without an _R twin');
  const leftNames = new Set(leftDefs.map((d) => twin(d.name)));
  expectNone(rightDefs.filter((d) => !leftNames.has(d.name)).map((d) => d.name), '_R nodes without an _L twin');
});

test('mirror: twin offsets have x negated and y/z equal; twin parents are twins (or the same centre node)', () => {
  const problems = [];
  for (const l of leftDefs) {
    const r = def(twin(l.name));
    if (Math.abs(r.offset[0] + l.offset[0]) > 1e-12) problems.push(`${l.name}: x ${l.offset[0]} vs ${r.name} x ${r.offset[0]} (should be negated)`);
    if (Math.abs(r.offset[1] - l.offset[1]) > 1e-12) problems.push(`${l.name}: y ${l.offset[1]} vs ${r.offset[1]}`);
    if (Math.abs(r.offset[2] - l.offset[2]) > 1e-12) problems.push(`${l.name}: z ${l.offset[2]} vs ${r.offset[2]}`);
    const wantParent = l.parent.endsWith('_L') ? twin(l.parent) : l.parent;
    if (r.parent !== wantParent) problems.push(`${r.name}: parent ${r.parent}, expected ${wantParent}`);
  }
  expectNone(problems, 'asymmetric geometry');
});

test('mirror: twin radius, boneRadius, kind, part are equal; region/label differ only by Left→Right', () => {
  const problems = [];
  for (const l of leftDefs) {
    const r = def(twin(l.name));
    for (const k of ['radius', 'boneRadius', 'kind', 'part', 'short']) if (l[k] !== r[k]) problems.push(`${l.name}/${r.name}: ${k} ${l[k]} vs ${r[k]}`);
    if (l.label.replace(/\bLeft\b/g, 'Right') !== r.label) problems.push(`${r.name}: label "${r.label}" is not the left label with Left→Right ("${l.label}")`);
    if (l.region.replace('Left', 'Right') !== r.region) problems.push(`${r.name}: region "${r.region}" vs left "${l.region}"`);
  }
  expectNone(problems, 'twin attribute mismatch');
});

test('mirror: twin channels — same names/order/min/max/axis; sign equal on x-axis, flipped on y/z', () => {
  const problems = [];
  for (const l of leftDefs) {
    const r = def(twin(l.name));
    if (l.dof.length !== r.dof.length) {
      problems.push(`${l.name}: ${l.dof.length} channels vs ${r.dof.length} on ${r.name}`);
      continue;
    }
    l.dof.forEach((a, i) => {
      const b = r.dof[i];
      const id = `${l.name}.${a.channel}`;
      if (a.channel !== b.channel) problems.push(`${id}: channel order differs (${b.channel} on the right)`);
      if (a.axis !== b.axis) problems.push(`${id}: axis ${a.axis} vs ${b.axis}`);
      if (a.min !== b.min || a.max !== b.max) problems.push(`${id}: range [${a.min},${a.max}] vs [${b.min},${b.max}]`);
      if (a.label !== b.label) problems.push(`${id}: label differs between sides`);
      const wantSign = a.axis === 'x' ? a.sign : -a.sign;
      if (b.sign !== wantSign) problems.push(`${id}: right sign ${b.sign}, expected ${wantSign} (axis ${a.axis}, left sign ${a.sign})`);
    });
  }
  expectNone(problems, 'channel mirroring broken');
});

test('mirror (kinematics): the same single-channel value on L and R gives mirror-image world positions', () => {
  const problems = [];
  for (const l of leftDefs.filter((d) => d.dof.length)) {
    for (const c of l.dof) {
      for (const v of [c.max * 0.5, c.min * 0.5]) {
        if (!v) continue;
        setPose({ [l.name]: { [c.channel]: v }, [twin(l.name)]: { [c.channel]: v } });
        for (const a of leftDefs) {
          const pa = wp(a.name);
          const pb = wp(twin(a.name));
          const err = Math.max(Math.abs(pa.x + pb.x), Math.abs(pa.y - pb.y), Math.abs(pa.z - pb.z));
          if (err > 1e-9) problems.push(`${l.name}.${c.channel}=${v}: ${a.name} ${fmt(pa)} is not the mirror of ${twin(a.name)} ${fmt(pb)}`);
        }
      }
    }
  }
  expectNone(problems.slice(0, 20), 'L/R channel values do not mean the same thing');
});

test('mirror (kinematics): a random full-body pose applied symmetrically stays symmetric (deterministic seed)', () => {
  let seed = 0xc0ffee;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const joints = {};
  for (const l of leftDefs.filter((d) => d.dof.length)) {
    joints[l.name] = Object.fromEntries(l.dof.map((c) => [c.channel, c.min + rnd() * (c.max - c.min)]));
    joints[twin(l.name)] = { ...joints[l.name] };
  }
  setPose(joints);
  const problems = leftDefs
    .map((a) => [a.name, wp(a.name), wp(twin(a.name))])
    .filter(([, pa, pb]) => Math.max(Math.abs(pa.x + pb.x), Math.abs(pa.y - pb.y), Math.abs(pa.z - pb.z)) > 1e-9)
    .map(([n, pa, pb]) => `${n} ${fmt(pa)} vs ${twin(n)} ${fmt(pb)}`);
  expectNone(problems, 'symmetric pose became asymmetric');
});

/* ====================================================================== HANDS */

for (const { s, region } of SIDES) {
  test(`hands (${s}): thumb has cmc, mcp, ip, tip chained wrist → cmc → mcp → ip → tip`, () => {
    const chain = ['wrist', 'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip'].map((n) => `${n}_${s}`);
    for (let i = 1; i < chain.length; i++) assert.equal(def(chain[i]).parent, chain[i - 1], `${chain[i]} should hang off ${chain[i - 1]}`);
    for (const n of chain.slice(1, 4)) assert.equal(def(n).kind, 'joint', `${n} should be an articulated joint`);
    assert.equal(def(chain[4]).kind, 'end', 'thumb tip should be an end point');
    assert.equal(def(`thumb_cmc_${s}`).dof.length, 3, 'thumb CMC is a saddle joint: spread, flex, twist');
  });

  for (const f of FINGERS) {
    test(`hands (${s}): ${f} has mcp, pip, dip, tip chained wrist → mcp → pip → dip → tip`, () => {
      const chain = ['wrist', `${f}_mcp`, `${f}_pip`, `${f}_dip`, `${f}_tip`].map((n) => (n === 'wrist' ? `wrist_${s}` : `${n}_${s}`));
      for (let i = 1; i < chain.length; i++) assert.equal(def(chain[i]).parent, chain[i - 1], `${chain[i]} should hang off ${chain[i - 1]}`);
      for (const n of chain.slice(1, 4)) assert.equal(def(n).kind, 'joint', `${n} should be an articulated joint`);
      assert.equal(def(chain[4]).kind, 'end', `${f} tip should be an end point`);
      assert.deepEqual(def(`${f}_mcp_${s}`).dof.map((c) => c.channel).sort(), ['flex', 'spread'], 'MCP: flex + spread');
      assert.deepEqual(def(`${f}_pip_${s}`).dof.map((c) => c.channel), ['flex'], 'PIP: flex only');
      assert.deepEqual(def(`${f}_dip_${s}`).dof.map((c) => c.channel), ['flex'], 'DIP: flex only');
    });
  }

  test(`hands (${s}): the hand region holds exactly 5 fingers x (3 joints + tip) = 15 joints + 5 tips, all with a part`, () => {
    const hand = JOINT_DEFS.filter((d) => d.region === region);
    assert.equal(hand.length, 20, 'nodes in the hand region');
    assert.equal(hand.filter((d) => d.kind === 'joint').length, 15, 'articulated hand joints');
    assert.equal(hand.filter((d) => d.kind === 'end').length, 5, 'fingertips');
    assert.deepEqual([...new Set(hand.map((d) => d.part))].sort(), ['Index', 'Middle', 'Pinky', 'Ring', 'Thumb'], 'hand parts');
    for (const d of hand) assert.equal(d.part.toLowerCase(), d.name.split('_')[0], `${d.name}: part "${d.part}" does not match the finger in its name`);
    expectNone(JOINT_DEFS.filter((d) => d.region !== region && d.name.endsWith(`_${s}`) && d.part).map((d) => d.name), 'non-hand nodes that claim a finger part');
  });
}

test('hands (rest pose): finger rows run index → middle → ring → pinky from the front, thumb on the index side, fingers point down', () => {
  for (const { s } of SIDES) {
    const z = (n) => restPos(`${n}_${s}`).z;
    const zs = FINGERS.map((f) => z(`${f}_mcp`));
    assert.ok(zs.every((v, i) => i === 0 || v < zs[i - 1]), `${s}: MCP z should strictly decrease index→pinky (front to back), got ${zs.map((v) => v.toFixed(3))}`);
    assert.ok(z('thumb_cmc') > z('wrist'), `${s}: thumb base should be in front of the wrist (thumb forward when arms hang)`);
    assert.ok(z('thumb_tip') > z('pinky_mcp'), `${s}: thumb should be on the index (front) side of the hand`);
    for (const f of [...FINGERS, 'thumb']) {
      const chain = f === 'thumb' ? ['cmc', 'mcp', 'ip', 'tip'] : ['mcp', 'pip', 'dip', 'tip'];
      const ys = chain.map((j) => restPos(`${f}_${j}_${s}`).y);
      assert.ok(ys.every((v, i) => i === 0 || v < ys[i - 1]), `${s} ${f}: joints should descend toward the tip with the hand hanging; got y ${ys.map((v) => v.toFixed(3))}`);
    }
  }
});

test('rest pose: every _L node lies on the +X (character-left) side, every _R node on −X, centre nodes on x = 0', () => {
  const bad = [];
  for (const d of JOINT_DEFS) {
    const x = restPos(d.name).x;
    if (d.side === 'L' && !(x > 0)) bad.push(`${d.name} x=${x}`);
    if (d.side === 'R' && !(x < 0)) bad.push(`${d.name} x=${x}`);
    if (d.side === 'C' && Math.abs(x) > 1e-9) bad.push(`${d.name} x=${x}`);
  }
  expectNone(bad, '+X must be the character\'s left');
});

/* ==================================================================== CHANNELS */

test('channels: axis in x/y/z, sign ±1, finite min <= 0 <= max (min < max), 1–3 channels, unique names and axes per joint', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    if (d.dof.length > 3) problems.push(`${d.name}: ${d.dof.length} channels (max 3 rotational DOF)`);
    const chans = new Set();
    const axes = new Set();
    for (const c of d.dof) {
      const id = `${d.name}.${c.channel}`;
      if (typeof c.channel !== 'string' || !/^[a-z]+$/.test(c.channel)) problems.push(`${id}: channel name must be lowercase letters`);
      if (chans.has(c.channel)) problems.push(`${id}: duplicate channel name within the joint`);
      chans.add(c.channel);
      if (!['x', 'y', 'z'].includes(c.axis)) problems.push(`${id}: axis "${c.axis}"`);
      if (axes.has(c.axis)) problems.push(`${id}: axis ${c.axis} already used by another channel of this joint`);
      axes.add(c.axis);
      if (c.sign !== 1 && c.sign !== -1) problems.push(`${id}: sign ${c.sign}`);
      if (!Number.isFinite(c.min) || !Number.isFinite(c.max)) problems.push(`${id}: non-finite limits`);
      else {
        if (c.min > 0 || c.max < 0) problems.push(`${id}: range [${c.min}, ${c.max}] does not contain 0 (rest pose would be out of limits)`);
        if (c.min >= c.max) problems.push(`${id}: empty range [${c.min}, ${c.max}]`);
        if (c.min < -180 || c.max > 180) problems.push(`${id}: range [${c.min}, ${c.max}] exceeds ±180°`);
      }
    }
  }
  expectNone(problems, 'invalid channel definitions');
});

test('channels: every label is non-empty and contains a direction hint "(+)" or "(−)"/"(-)"', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    for (const c of d.dof) {
      if (typeof c.label !== 'string' || !c.label.trim()) problems.push(`${d.name}.${c.channel}: empty label`);
      else if (!/\(\+\)|\(−\)|\(-\)/.test(c.label)) problems.push(`${d.name}.${c.channel}: "${c.label}" gives no (+)/(−) direction hint`);
    }
  }
  expectNone(problems, 'channel labels without a sign convention');
});

test('channels: the label documents the negative direction exactly when the range goes below 0', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    for (const c of d.dof) {
      const mentionsNeg = /\(−\)|\(-\)/.test(c.label);
      if (c.min < 0 && !mentionsNeg) problems.push(`${d.name}.${c.channel}: allows ${c.min}° but label "${c.label}" never says what (−) does`);
      if (c.min === 0 && mentionsNeg) problems.push(`${d.name}.${c.channel}: label mentions (−) but the limit is min = 0`);
    }
  }
  expectNone(problems, 'label/range disagreement');
});

test('radius: every marker radius and bone radius is a positive number; a bone is thinner than the markers at both ends', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    if (!(Number.isFinite(d.radius) && d.radius > 0)) problems.push(`${d.name}: radius ${d.radius}`);
    if (!(Number.isFinite(d.boneRadius) && d.boneRadius > 0)) problems.push(`${d.name}: boneRadius ${d.boneRadius}`);
    if (d.radius > 0.1) problems.push(`${d.name}: radius ${d.radius} m is absurdly big for a joint marker`);
    if (d.parent) {
      const p = def(d.parent);
      if (d.boneRadius >= d.radius) problems.push(`${d.name}: bone (${d.boneRadius}) is not thinner than its own marker (${d.radius})`);
      if (d.boneRadius >= p.radius) problems.push(`${d.name}: bone (${d.boneRadius}) is not thinner than the parent marker ${p.name} (${p.radius})`);
    }
  }
  expectNone(problems, 'bad radii');
});

/* ====================================================== REGIONS / WEBS / GROUND */

test('regions: REGIONS has no duplicates, every def uses a listed region, and every listed region is non-empty', () => {
  assert.equal(new Set(REGIONS).size, REGIONS.length, 'REGIONS contains duplicates');
  expectNone(JOINT_DEFS.filter((d) => !REGIONS.includes(d.region)).map((d) => `${d.name}: "${d.region}"`), 'defs with a region missing from REGIONS');
  expectNone(REGIONS.filter((r) => !JOINT_DEFS.some((d) => d.region === r)), 'empty regions');
  const counts = Object.fromEntries(REGIONS.map((r) => [r, JOINT_DEFS.filter((d) => d.region === r).length]));
  assert.deepEqual(counts, { Body: 5, 'Left arm': 4, 'Left hand': 20, 'Right arm': 4, 'Right hand': 20, 'Left leg': 6, 'Right leg': 6 }, 'nodes per region');
});

test('webs: every WEBS pair references two existing, distinct, same-side hand nodes, with no duplicate pairs', () => {
  const problems = [];
  const seen = new Set();
  for (const [a, b] of WEBS) {
    if (!JOINT_BY_NAME.has(a) || !JOINT_BY_NAME.has(b)) {
      problems.push(`[${a}, ${b}] references a node that does not exist`);
      continue;
    }
    if (a === b) problems.push(`[${a}, ${b}] is degenerate`);
    const key = [a, b].sort().join('|');
    if (seen.has(key)) problems.push(`[${a}, ${b}] is listed twice`);
    seen.add(key);
    if (def(a).side !== def(b).side) problems.push(`[${a}, ${b}] connects different sides`);
    if (!def(a).region.endsWith('hand') || !def(b).region.endsWith('hand')) problems.push(`[${a}, ${b}] is not inside a hand`);
  }
  expectNone(problems, 'bad webs');
  assert.equal(WEBS.length, 8, 'webs: thumb→index, index→middle, middle→ring, ring→pinky for each hand');
});

test('ground: GROUND_CONTACTS reference existing foot nodes, are unique, and cover both feet symmetrically', () => {
  assert.equal(new Set(GROUND_CONTACTS).size, GROUND_CONTACTS.length, 'duplicates in GROUND_CONTACTS');
  expectNone(GROUND_CONTACTS.filter((n) => !JOINT_BY_NAME.has(n)), 'GROUND_CONTACTS entries that do not exist');
  for (const n of GROUND_CONTACTS) assert.ok(def(n).region.endsWith('leg'), `${n} is not part of a leg`);
  for (const n of GROUND_CONTACTS) {
    if (n.endsWith('_L')) assert.ok(GROUND_CONTACTS.includes(twin(n)), `${n} has no _R twin in GROUND_CONTACTS`);
  }
  for (const side of ['L', 'R']) {
    for (const part of ['heel', 'toe', 'toe_tip']) assert.ok(GROUND_CONTACTS.includes(`${part}_${side}`), `${part}_${side} must be able to ground the body`);
  }
});

/* ==================================================================== REST POSE */

test('rest pose: every joint rotation is the identity and every world position is the sum of offsets down the chain', () => {
  const problems = [];
  for (const d of JOINT_DEFS) {
    const q = rest.nodes.get(d.name).object.quaternion;
    if (Math.abs(Math.abs(q.w) - 1) > 1e-12) problems.push(`${d.name}: rotation is not identity (w=${q.w})`);
    const want = new THREE.Vector3();
    for (let n = d.name; n; n = def(n).parent) want.add(new THREE.Vector3(...def(n).offset));
    const got = restPos(d.name);
    if (got.distanceTo(want) > 1e-9) problems.push(`${d.name}: world ${fmt(got)} but offsets sum to ${fmt(want)}`);
  }
  expectNone(problems, 'rest pose is not the documented "all rotations identity" pose');
});

test('rest pose: feet touch the floor (lowest foot landmark at y = 0) and nothing is below it; auto-ground is a no-op', () => {
  const lowestContact = Math.min(...GROUND_CONTACTS.map((n) => restPos(n).y));
  assert.ok(Math.abs(lowestContact) < 1e-6, `lowest ground-contact landmark is at y = ${lowestContact}, expected 0`);
  const below = JOINT_DEFS.filter((d) => restPos(d.name).y < -1e-6).map((d) => `${d.name} y=${restPos(d.name).y}`);
  expectNone(below, 'nodes below the floor');
  for (const part of ['ankle', 'heel', 'toe', 'toe_tip']) {
    const l = restPos(`${part}_L`).y;
    const r = restPos(`${part}_R`).y;
    assert.ok(Math.abs(l - r) < 1e-9, `${part}: left foot y=${l} but right foot y=${r}; the two feet must stand at the same height`);
  }
  assert.ok(Math.abs(restPos('pelvis').y - def('pelvis').offset[1]) < 1e-9, `auto-ground moved the pelvis in the rest pose (${restPos('pelvis').y} vs ${def('pelvis').offset[1]}): the rest pose is not grounded`);
});

test('rest pose: the lowest node is always one of GROUND_CONTACTS (auto-ground cannot miss a lower landmark)', () => {
  const contacts = new Set(GROUND_CONTACTS);
  const lowest = Math.min(...GROUND_CONTACTS.map((n) => restPos(n).y));
  const lower = JOINT_DEFS.filter((d) => !contacts.has(d.name) && restPos(d.name).y < lowest - 1e-9).map((d) => d.name);
  expectNone(lower, 'nodes lower than every ground contact');
});

test('rest pose: no marker sphere sinks more than 2 cm below the floor plane (grounding is by node centre)', () => {
  const problems = JOINT_DEFS
    .map((d) => ({ n: d.name, sink: d.radius - restPos(d.name).y }))
    .filter((o) => o.sink > 0.02)
    .map((o) => `${o.n}: marker (r=${mm(def(o.n).radius)}) extends ${mm(o.sink)} below y=0 (centre y=${mm(restPos(o.n).y)})`);
  expectNone(problems, 'marker spheres buried in the floor');
});

test('rest pose: body proportions are human-plausible (adult, ~1.8 m tall)', () => {
  const skull = rest.nodes.get('head').object.getObjectByName('head:skull');
  assert.ok(skull, 'head object should carry a "head:skull" mesh');
  const box = new THREE.Box3().setFromObject(skull);
  const top = Math.max(box.max.y, ...JOINT_DEFS.map((d) => restPos(d.name).y));
  const headH = box.max.y - box.min.y;
  inRange(top, 1.55, 2.0, 'standing height (top of head)');
  inRange(headH, 0.18, 0.28, 'head height (chin to crown)');
  inRange(top / headH, 6.0, 9.0, 'body height in head-heights');
  inRange(restPos('head').y, 1.4, 1.7, 'head-joint (skull base) height');
  inRange(restPos('neck').y, 1.3, 1.6, 'neck-joint height');
  inRange(restPos('shoulder_L').y, 1.3, 1.6, 'shoulder height');
  inRange(restPos('shoulder_L').distanceTo(restPos('shoulder_R')), 0.3, 0.5, 'shoulder width');
  inRange(restPos('hip_L').distanceTo(restPos('hip_R')), 0.14, 0.26, 'hip-joint width');
  assert.ok(restPos('shoulder_L').distanceTo(restPos('shoulder_R')) > restPos('hip_L').distanceTo(restPos('hip_R')), 'shoulders should be wider than the hip joints');
  const heights = ['pelvis', 'spine', 'chest', 'neck', 'head'].map((n) => restPos(n).y);
  assert.ok(heights.every((v, i) => !i || v > heights[i - 1]), `spine nodes must rise pelvis→head, got ${heights}`);
});

test('rest pose: arm lengths are human-plausible and the hands hang at hip height beside the thighs', () => {
  for (const s of ['L', 'R']) {
    const p = (n) => restPos(`${n}_${s}`);
    inRange(p('shoulder').distanceTo(p('elbow')), 0.27, 0.38, `${s} upper arm`);
    inRange(p('elbow').distanceTo(p('wrist')), 0.22, 0.33, `${s} forearm`);
    inRange(p('shoulder').distanceTo(p('wrist')), 0.5, 0.7, `${s} shoulder→wrist`);
    inRange(p('wrist').y, p('hip').y - 0.15, p('hip').y + 0.05, `${s} wrist height relative to the hip joint`);
    assert.ok(p('wrist').y > p('knee').y, `${s} wrist should hang above the knee`);
    assert.ok(Math.abs(p('wrist').x) > Math.abs(p('hip').x) + def(`hip_${s}`).radius + def(`wrist_${s}`).radius, `${s} wrist should hang beside, not inside, the thigh`);
    assert.ok(p('elbow').y < p('shoulder').y && p('wrist').y < p('elbow').y, `${s} arm should hang straight down`);
  }
});

test('rest pose: leg and foot lengths are human-plausible', () => {
  for (const s of ['L', 'R']) {
    const p = (n) => restPos(`${n}_${s}`);
    inRange(p('hip').distanceTo(p('knee')), 0.38, 0.52, `${s} thigh`);
    inRange(p('knee').distanceTo(p('ankle')), 0.36, 0.5, `${s} shin`);
    inRange(p('hip').distanceTo(p('ankle')), 0.72, 1.0, `${s} hip→ankle (leg length)`);
    inRange(p('hip').y, 0.8, 1.05, `${s} hip-joint height`);
    inRange(p('ankle').y, 0.05, 0.12, `${s} ankle height`);
    inRange(p('toe_tip').z - p('heel').z, 0.2, 0.32, `${s} foot length (heel→toe tip)`);
    assert.ok(p('heel').z < p('ankle').z && p('ankle').z < p('toe').z && p('toe').z < p('toe_tip').z, `${s} foot landmarks must run heel < ankle < ball < toe tip along +Z`);
    inRange(p('toe').z - p('ankle').z, 0.08, 0.18, `${s} ankle→ball of foot`);
  }
});

test('rest pose: hand size is human-plausible (hands are drawn HAND_SCALE× life size on purpose)', () => {
  inRange(HAND_SCALE, 1, 2, 'HAND_SCALE');
  for (const s of ['L', 'R']) {
    const p = (n) => restPos(`${n}_${s}`);
    const len = p('wrist').distanceTo(p('middle_tip')) / HAND_SCALE;
    inRange(len, 0.15, 0.22, `${s} hand length wrist→middle fingertip at life size`);
    inRange(p('wrist').distanceTo(p('middle_mcp')) / HAND_SCALE, 0.08, 0.12, `${s} palm length at life size`);
    inRange(p('index_mcp').distanceTo(p('pinky_mcp')) / HAND_SCALE, 0.05, 0.095, `${s} palm width (index→pinky knuckle) at life size`);
    const total = (f) => p(`${f}_mcp`).distanceTo(p(`${f}_pip`)) + p(`${f}_pip`).distanceTo(p(`${f}_dip`)) + p(`${f}_dip`).distanceTo(p(`${f}_tip`));
    assert.ok(total('middle') > total('ring') && total('middle') > total('index') && total('middle') > total('pinky'), `${s}: middle finger should be the longest finger`);
    assert.ok(total('pinky') < total('index') && total('pinky') < total('ring'), `${s}: pinky should be the shortest finger`);
    for (const f of FINGERS) {
      const a = p(`${f}_mcp`).distanceTo(p(`${f}_pip`));
      const b = p(`${f}_pip`).distanceTo(p(`${f}_dip`));
      const c = p(`${f}_dip`).distanceTo(p(`${f}_tip`));
      assert.ok(a > b && b > c * 0.9, `${s} ${f}: phalanges should shorten toward the tip (proximal ${mm(a)}, middle ${mm(b)}, distal ${mm(c)})`);
    }
  }
});

test('rest pose: no two nodes coincide (every pair of nodes is at least 3 mm apart)', () => {
  const problems = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = restPos(names[i]).distanceTo(restPos(names[j]));
      if (d < 0.003) problems.push(`${names[i]} and ${names[j]} are ${mm(d)} apart`);
    }
  }
  expectNone(problems, 'coincident nodes');
});

test('scene graph: Stickboy builds one nested Object3D + marker per node, a bone per non-root node, and a zero channel per DOF', () => {
  const problems = [];
  assert.equal(rest.nodes.size, 65, 'Stickboy.nodes size');
  assert.equal(rest.markers.length, 65, 'Stickboy.markers length');
  assert.equal(rest.values.size, 51, 'Stickboy.values size (one entry per articulated joint)');
  for (const d of JOINT_DEFS) {
    const n = rest.nodes.get(d.name);
    if (!n) {
      problems.push(`${d.name}: missing from Stickboy.nodes`);
      continue;
    }
    const wantParent = d.parent ? rest.nodes.get(d.parent).object : rest.root;
    if (n.object.parent !== wantParent) problems.push(`${d.name}: Object3D is not nested under ${d.parent ?? 'the root group'}`);
    if (n.marker.userData.joint !== d.name) problems.push(`${d.name}: marker.userData.joint = ${n.marker.userData.joint}`);
    if (Math.abs(n.marker.geometry.parameters.radius - d.radius) > 1e-12) problems.push(`${d.name}: marker radius ${n.marker.geometry.parameters.radius} != def radius ${d.radius}`);
    if (!!n.bone !== !!d.parent) problems.push(`${d.name}: bone presence (${!!n.bone}) does not match having a parent (${!!d.parent})`);
    if (n.bone) {
      // The bone is a unit-height cylinder rigid in the parent's frame: its two caps must sit on parent origin and child origin.
      const half = new THREE.Vector3(0, n.bone.scale.y / 2, 0).applyQuaternion(n.bone.quaternion);
      const a = n.bone.position.clone().sub(half);
      const b = n.bone.position.clone().add(half);
      const off = new THREE.Vector3(...d.offset);
      if (a.length() > 1e-9 || b.distanceTo(off) > 1e-9) problems.push(`${d.name}: bone runs ${fmt(a)} → ${fmt(b)}, expected (0,0,0) → ${fmt(off)}`);
      if (Math.abs(n.bone.scale.x - d.boneRadius) > 1e-12) problems.push(`${d.name}: bone radius ${n.bone.scale.x} != ${d.boneRadius}`);
    }
    const vals = rest.values.get(d.name);
    if (d.dof.length) {
      const want = d.dof.map((c) => c.channel).sort();
      if (!vals || JSON.stringify(Object.keys(vals).sort()) !== JSON.stringify(want)) problems.push(`${d.name}: pose channels ${vals && Object.keys(vals)} != ${want}`);
      else if (Object.values(vals).some((v) => v !== 0)) problems.push(`${d.name}: rest channels are not all 0`);
    } else if (vals) problems.push(`${d.name}: end point has pose channels`);
  }
  expectNone(problems, 'scene graph does not match the definitions');
});

/* ======================================================= MARKER IDENTIFIABILITY */

/** All pairs among `nodeNames`, with the volume fraction of the smaller ball that the other ball covers. */
function crowding(nodeNames) {
  const out = [];
  for (let i = 0; i < nodeNames.length; i++) {
    for (let j = i + 1; j < nodeNames.length; j++) {
      const a = def(nodeNames[i]);
      const b = def(nodeNames[j]);
      const d = restPos(a.name).distanceTo(restPos(b.name));
      out.push({ a: a.name, b: b.name, d, sum: a.radius + b.radius, ratio: d / (a.radius + b.radius), frac: overlapFraction(a.radius, b.radius, d) });
    }
  }
  return out.sort((x, y) => y.frac - x.frac || x.ratio - y.ratio);
}
const describePair = (o) => `${o.a} ↔ ${o.b}: centres ${mm(o.d)} apart, radii sum ${mm(o.sum)} (d/Σr = ${o.ratio.toFixed(2)}, ${(o.frac * 100).toFixed(0)}% of the smaller ball hidden)`;

for (const { s, region } of SIDES) {
  test(`identifiability (${s} hand): no hand marker ball is more than 10% covered by another; fingers' own joints keep a visible gap`, (t) => {
    const hand = JOINT_DEFS.filter((d) => d.region === region).map((d) => d.name);
    const pairs = crowding([`wrist_${s}`, ...hand]);
    t.diagnostic(`tightest ${s}-hand pairs:\n    ${[...pairs].sort((x, y) => x.ratio - y.ratio).slice(0, 5).map(describePair).join('\n    ')}`);
    expectNone(pairs.filter((o) => o.frac > 0.1).slice(0, 10).map(describePair), 'overlapping hand markers (worst first)');
    // Neighbours on the same finger must not be crammed together: a visible bone between them.
    const neighbours = pairs.filter((o) => def(o.a).parent === o.b || def(o.b).parent === o.a).filter((o) => def(o.a).part && def(o.a).part === def(o.b).part);
    assert.equal(neighbours.length, 5 * 3, 'expected 3 neighbour pairs on each of 5 fingers');
    expectNone(neighbours.filter((o) => o.ratio < 1.25).map(describePair), 'neighbouring joints on one finger closer than 1.25 × summed radii');
  });
}

test('identifiability (whole body): no marker ball is more than 10% covered by another marker at rest', (t) => {
  const pairs = crowding(names);
  t.diagnostic(`tightest body pairs:\n    ${[...pairs].sort((x, y) => x.ratio - y.ratio).slice(0, 5).map(describePair).join('\n    ')}`);
  expectNone(pairs.filter((o) => o.frac > 0.1).map(describePair), 'overlapping joint markers (worst first)');
});

/* =============================================== DOCUMENTED SEMANTICS (kinematics) */

test('semantics: dof is outermost-first, q = q(dof[0])·q(dof[1])·…, as documented in the file header', () => {
  const joints = { shoulder_L: { flex: 30, abd: 40, twist: 20 } };
  setPose(joints);
  const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const q = (c) => new THREE.Quaternion().setFromAxisAngle(AXIS[c.axis], (c.sign * joints.shoulder_L[c.channel] * Math.PI) / 180);
  const dof = def('shoulder_L').dof;
  const expected = dof.map(q).reduce((acc, x) => acc.multiply(x), new THREE.Quaternion());
  const reversed = [...dof].reverse().map(q).reduce((acc, x) => acc.multiply(x), new THREE.Quaternion());
  const actual = rig.nodes.get('shoulder_L').object.quaternion;
  assert.ok(actual.angleTo(expected) < 1e-9, `shoulder_L quaternion differs from q(flex)·q(abd)·q(twist) by ${actual.angleTo(expected)} rad`);
  assert.ok(reversed.angleTo(expected) > 0.01, 'test is not discriminating: the reverse order gives the same rotation');
});

test('semantics: { shoulder_L: {abd: 90}, shoulder_R: {abd: 90} } raises both arms out to the sides symmetrically', () => {
  setPose({ shoulder_L: { abd: 90 }, shoulder_R: { abd: 90 } });
  const L = wp('wrist_L');
  const R = wp('wrist_R');
  assert.ok(L.x > wp('shoulder_L').x + 0.5 && R.x < wp('shoulder_R').x - 0.5, `arms should reach out sideways: wrist_L ${fmt(L)}, wrist_R ${fmt(R)}`);
  assert.ok(Math.abs(L.y - wp('shoulder_L').y) < 0.01 && Math.abs(R.y - wp('shoulder_R').y) < 0.01, 'abd 90 should bring the arms level with the shoulders');
  assert.ok(Math.abs(L.x + R.x) < 1e-9 && Math.abs(L.y - R.y) < 1e-9 && Math.abs(L.z - R.z) < 1e-9, 'the two arms are not mirror images');
});

/* Each test: the SIGN convention in the channel label must match what actually happens. */
for (const { s, k } of SIDES) {
  const name = (n) => `${n}_${s}`;
  const out = (v) => k * v.x; // + = lateral (away from the midline) for this side
  const medial = (v) => -k * v.x;

  test(`directions (${s} arm): clavicle, shoulder and elbow channels do what their labels say`, () => {
    let v = moved({ [name('clavicle')]: { elev: 20 } }, name('shoulder'));
    assert.ok(v.y > 0.02, `clavicle elev +20 should shrug the shoulder UP, moved ${fmt(v)}`);
    v = moved({ [name('clavicle')]: { protract: 15 } }, name('shoulder'));
    assert.ok(v.z > 0.02, `clavicle protract +15 should bring the shoulder FORWARD (+Z), moved ${fmt(v)}`);

    v = moved({ [name('shoulder')]: { flex: 60 } }, name('wrist'));
    assert.ok(v.z > 0.3 && v.y > 0.2, `shoulder flex +60 should swing the arm forward and up, wrist moved ${fmt(v)}`);
    v = moved({ [name('shoulder')]: { flex: -30 } }, name('wrist'));
    assert.ok(v.z < -0.15, `shoulder flex −30 should swing the arm BACK, wrist moved ${fmt(v)}`);
    v = moved({ [name('shoulder')]: { abd: 60 } }, name('wrist'));
    assert.ok(out(v) > 0.3 && v.y > 0.2, `shoulder abd +60 should raise the arm out to the SIDE (away from the midline), wrist moved ${fmt(v)}`);
    v = moved({ [name('shoulder')]: { abd: -30 } }, name('wrist'));
    assert.ok(out(v) < -0.1, `shoulder abd −30 should move the arm ACROSS the body, wrist moved ${fmt(v)}`);
    v = moved({ [name('shoulder')]: { twist: 60 }, [name('elbow')]: { flex: 90 } }, name('wrist'));
    assert.ok(out(v) > 0.15, `shoulder twist +60 ("rotate outward") with the elbow bent should swing the forearm OUTWARD, wrist moved ${fmt(v)}`);
    v = moved({ [name('shoulder')]: { twist: -60 }, [name('elbow')]: { flex: 90 } }, name('wrist'));
    assert.ok(out(v) < -0.15, `shoulder twist −60 ("rotate inward") should swing the forearm INWARD, wrist moved ${fmt(v)}`);

    v = moved({ [name('elbow')]: { flex: 90 } }, name('wrist'));
    assert.ok(v.z > 0.2 && v.y > 0.2 && Math.abs(v.x) < 1e-9, `elbow flex +90 should bring the forearm forward and up, wrist moved ${fmt(v)}`);
  });

  test(`directions (${s} arm): elbow twist (+) turns the palm up, (−) turns it down`, () => {
    const palmNormal = (twist) => {
      setPose({ [name('elbow')]: { flex: 90, twist }, [name('middle_mcp')]: { flex: 90 } });
      return wp(name('middle_pip')).sub(wp(name('middle_mcp'))).normalize(); // the way fingers curl = palm side
    };
    const neutral = palmNormal(0);
    assert.ok(medial(neutral) > 0.9, `with the elbow bent and no twist the palm should face the midline (thumb up), palm normal ${fmt(neutral)}`);
    const up = palmNormal(90);
    assert.ok(up.y > 0.9, `elbow twist +90 should turn the palm UP, palm normal ${fmt(up)}`);
    const down = palmNormal(-90);
    assert.ok(down.y < -0.9, `elbow twist −90 should turn the palm DOWN, palm normal ${fmt(down)}`);
  });

  test(`directions (${s} wrist): flex (+) moves the hand toward the palm, (−) toward the back of the hand; dev (+) toward the thumb`, () => {
    let v = moved({ [name('wrist')]: { flex: 60 } }, name('middle_tip'));
    assert.ok(medial(v) > 0.1, `wrist flex +60 should fold the hand toward the palm side (medial at rest), tip moved ${fmt(v)}`);
    v = moved({ [name('wrist')]: { flex: -40 } }, name('middle_tip'));
    assert.ok(medial(v) < -0.05, `wrist flex −40 should bend the hand back, tip moved ${fmt(v)}`);
    const thumbSide = Math.sign(restPos(name('thumb_cmc')).z - restPos(name('pinky_mcp')).z);
    v = moved({ [name('wrist')]: { dev: 15 } }, name('middle_tip'));
    assert.ok(Math.sign(v.z) === thumbSide && Math.abs(v.z) > 0.03, `wrist dev +15 should move the hand toward the thumb (z sign ${thumbSide}), tip moved ${fmt(v)}`);
    v = moved({ [name('wrist')]: { dev: -20 } }, name('middle_tip'));
    assert.ok(Math.sign(v.z) === -thumbSide && Math.abs(v.z) > 0.03, `wrist dev −20 should move the hand toward the pinky, tip moved ${fmt(v)}`);
  });

  test(`directions (${s} leg): hip, knee, ankle and toe channels do what their labels say`, () => {
    let v = moved({ [name('hip')]: { flex: 60 } }, name('knee'));
    assert.ok(v.z > 0.3, `hip flex +60 should swing the thigh FORWARD, knee moved ${fmt(v)}`);
    v = moved({ [name('hip')]: { flex: -20 } }, name('knee'));
    assert.ok(v.z < -0.05, `hip flex −20 should swing the thigh BACK, knee moved ${fmt(v)}`);
    v = moved({ [name('hip')]: { abd: 30 } }, name('knee'));
    assert.ok(out(v) > 0.15, `hip abd +30 should swing the leg OUT to the side, knee moved ${fmt(v)}`);
    v = moved({ [name('hip')]: { abd: -20 } }, name('knee'));
    assert.ok(out(v) < -0.05, `hip abd −20 should bring the leg ACROSS, knee moved ${fmt(v)}`);
    v = moved({ [name('hip')]: { twist: 30 } }, name('toe_tip'));
    assert.ok(out(v) > 0.05, `hip twist +30 ("turn out") should turn the toes OUTWARD, toe tip moved ${fmt(v)}`);
    v = moved({ [name('hip')]: { twist: -30 } }, name('toe_tip'));
    assert.ok(out(v) < -0.05, `hip twist −30 ("turn in") should turn the toes INWARD, toe tip moved ${fmt(v)}`);

    v = moved({ [name('knee')]: { flex: 60 } }, name('ankle'));
    assert.ok(v.z < -0.2 && v.y > 0.05, `knee flex +60 should bring the heel back toward the butt, ankle moved ${fmt(v)}`);

    v = moved({ [name('ankle')]: { flex: 30 } }, name('toe_tip'));
    assert.ok(v.y < -0.05, `ankle flex +30 ("toes down") should push the toes DOWN, toe tip moved ${fmt(v)}`);
    v = moved({ [name('ankle')]: { flex: -20 } }, name('toe_tip'));
    assert.ok(v.y > 0.03, `ankle flex −20 ("toes up") should lift the toes, toe tip moved ${fmt(v)}`);
    v = moved({ [name('ankle')]: { inv: 20 } }, name('toe_tip'));
    assert.ok(medial(v) > 0.015, `ankle inv +20 ("sole turns in") should turn the sole toward the midline, toe tip moved ${fmt(v)}`);
    v = moved({ [name('toe')]: { flex: 30 } }, name('toe_tip'));
    assert.ok(v.y < -0.015, `toe flex +30 ("toes curl down") should lower the toe tip, moved ${fmt(v)}`);
  });

  test(`directions (${s} hand): finger flex curls toward the palm; spread (+) moves fingers apart; thumb channels`, () => {
    for (const f of FINGERS) {
      for (const j of ['mcp', 'pip', 'dip']) {
        const v = moved({ [name(`${f}_${j}`)]: { flex: 45 } }, name(`${f}_tip`));
        assert.ok(medial(v) > 0.01 && v.y > 0, `${f} ${j} flex +45 should curl the fingertip toward the palm and upward, tip moved ${fmt(v)}`);
        const e = moved({ [name(`${f}_${j}`)]: { flex: -10 } }, name(`${f}_tip`));
        assert.ok(medial(e) < 0, `${f} ${j} flex −10 should extend (bend the tip back), tip moved ${fmt(e)}`);
      }
    }
    // "apart": the index leaves the middle finger toward the thumb side (+Z), ring and pinky leave toward the back (−Z).
    let v = moved({ [name('index_mcp')]: { spread: 15 } }, name('index_tip'));
    assert.ok(v.z > 0.01, `index spread +15 should move the index finger away from the middle finger (forward), tip moved ${fmt(v)}`);
    v = moved({ [name('ring_mcp')]: { spread: 15 } }, name('ring_tip'));
    assert.ok(v.z < -0.01, `ring spread +15 should move the ring finger away from the middle finger (backward), tip moved ${fmt(v)}`);
    v = moved({ [name('pinky_mcp')]: { spread: 15 } }, name('pinky_tip'));
    assert.ok(v.z < -0.01, `pinky spread +15 should move the pinky away from the ring finger (backward), tip moved ${fmt(v)}`);
    for (const f of FINGERS) {
      const a = moved({ [name(`${f}_mcp`)]: { spread: 15 } }, name(`${f}_tip`));
      const b = moved({ [name(`${f}_mcp`)]: { spread: -15 } }, name(`${f}_tip`));
      assert.ok(Math.abs(a.z + b.z) < 1e-9 && Math.abs(a.z) > 0.01, `${f} spread ±15 should be equal and opposite in z (${a.z.toFixed(4)} vs ${b.z.toFixed(4)})`);
    }

    v = moved({ [name('thumb_cmc')]: { spread: 30 } }, name('thumb_tip'));
    assert.ok(v.z > 0.02, `thumb spread +30 should move the thumb away from the index finger (forward), tip moved ${fmt(v)}`);
    v = moved({ [name('thumb_cmc')]: { flex: 30 } }, name('thumb_tip'));
    assert.ok(medial(v) > 0.02, `thumb cmc flex +30 ("across the palm") should move the tip toward the palm side, moved ${fmt(v)}`);
    v = moved({ [name('thumb_cmc')]: { twist: 30 } }, name('thumb_tip'));
    assert.ok(out(v) > 0.01, `thumb cmc twist +30 ("rotate outward") should move the tip outward, moved ${fmt(v)}`);
    for (const j of ['mcp', 'ip']) {
      v = moved({ [name(`thumb_${j}`)]: { flex: 30 } }, name('thumb_tip'));
      assert.ok(medial(v) > 0.005, `thumb ${j} flex +30 should curl the thumb toward the palm, tip moved ${fmt(v)}`);
    }
  });
}

test('directions (trunk, neck, head): flex (+) leans forward, bend (+) leans to the character\'s left, twist (+) turns left', () => {
  const problems = [];
  for (const n of ['pelvis', 'spine', 'chest', 'neck', 'head']) {
    let a = axesOf({ [n]: { flex: 14 } }, n);
    if (!(a.up.z > 0.2)) problems.push(`${n} flex +14 should tilt "up" forward (+Z), up axis is ${fmt(a.up)}`);
    a = axesOf({ [n]: { flex: -14 } }, n);
    if (!(a.up.z < -0.2)) problems.push(`${n} flex −14 should tilt "up" backward, up axis is ${fmt(a.up)}`);
    a = axesOf({ [n]: { bend: 20 } }, n);
    if (!(a.up.x > 0.25)) problems.push(`${n} bend +20 ("lean left") should tilt "up" toward +X, up axis is ${fmt(a.up)}`);
    a = axesOf({ [n]: { twist: 25 } }, n);
    if (!(a.fwd.x > 0.35)) problems.push(`${n} twist +25 ("turn left") should turn the front toward +X, forward axis is ${fmt(a.fwd)}`);
    a = axesOf({ [n]: { twist: -25 } }, n);
    if (!(a.fwd.x < -0.35)) problems.push(`${n} twist −25 ("turn right") should turn the front toward −X, forward axis is ${fmt(a.fwd)}`);
  }
  expectNone(problems, 'centre-line channel directions');
});

test('directions (trunk twist): spine twist (+) swings the left shoulder back and the right shoulder forward', () => {
  for (const n of ['pelvis', 'spine', 'chest']) {
    const l = moved({ [n]: { twist: 30 } }, 'shoulder_L');
    const r = moved({ [n]: { twist: 30 } }, 'shoulder_R');
    assert.ok(l.z < -0.03 && r.z > 0.03, `${n} twist +30 (turn left): left shoulder should go back, right forward; moved ${fmt(l)} / ${fmt(r)}`);
  }
});

test('directions (face): the head carries a face that looks toward +Z, the documented "front"', () => {
  const skull = rest.nodes.get('head').object.getObjectByName('head:skull');
  const centre = new THREE.Vector3().setFromMatrixPosition(skull.matrixWorld);
  const features = skull.children;
  assert.ok(features.length >= 3, 'expected eyes and a nose on the skull');
  for (const f of features) {
    const p = new THREE.Vector3().setFromMatrixPosition(f.matrixWorld);
    assert.ok(p.z - centre.z > 0.05, `face feature at ${fmt(p)} is not in front (+Z) of the skull centre ${fmt(centre)}`);
  }
});

/* ==================================================== JOINT LIMITS: PLAUSIBILITY */

const limit = (joint, channel) => {
  const c = def(joint).dof.find((d) => d.channel === channel);
  assert.ok(c, `${joint} has no channel "${channel}"`);
  return c;
};

test('limits: elbow and knee are hinges — no hyperextension, 120–160° of flexion', () => {
  for (const s of ['L', 'R']) {
    for (const j of ['elbow', 'knee']) {
      const c = limit(`${j}_${s}`, 'flex');
      assert.ok(c.min >= -5 && c.min <= 0, `${j}_${s}.flex min = ${c.min}: a hinge must not hyperextend`);
      inRange(c.max, 120, 160, `${j}_${s}.flex max`);
    }
    inRange(limit(`elbow_${s}`, 'twist').max, 60, 100, `elbow_${s} supination`);
    inRange(-limit(`elbow_${s}`, 'twist').min, 60, 100, `elbow_${s} pronation`);
  }
});

test('limits: shoulder, hip, wrist and ankle ranges are within human limits and have the right asymmetries', () => {
  for (const s of ['L', 'R']) {
    inRange(limit(`shoulder_${s}`, 'flex').max, 150, 190, `shoulder_${s} flexion`);
    inRange(-limit(`shoulder_${s}`, 'flex').min, 30, 70, `shoulder_${s} extension`);
    // capped at 90: abd > 90 hits the Euler pole documented in jointDefs.js (overhead = flex up to 180)
    inRange(limit(`shoulder_${s}`, 'abd').max, 85, 95, `shoulder_${s} abduction`);
    inRange(limit(`hip_${s}`, 'flex').max, 100, 150, `hip_${s} flexion`);
    inRange(-limit(`hip_${s}`, 'flex').min, 5, 45, `hip_${s} extension`);
    inRange(limit(`hip_${s}`, 'abd').max, 40, 100, `hip_${s} abduction (up to a full split)`);
    inRange(-limit(`hip_${s}`, 'abd').min, 10, 45, `hip_${s} adduction`);
    inRange(limit(`hip_${s}`, 'twist').max, 20, 70, `hip_${s} external rotation`);
    const wf = limit(`wrist_${s}`, 'flex');
    inRange(wf.max, 60, 90, `wrist_${s} palmar flexion`);
    inRange(-wf.min, 50, 85, `wrist_${s} extension`);
    const wd = limit(`wrist_${s}`, 'dev');
    assert.ok(wd.max > 0 && -wd.min > wd.max, `wrist_${s}.dev: ulnar deviation (toward pinky, ${-wd.min}°) must exceed radial deviation (toward thumb, ${wd.max}°)`);
    inRange(wd.max, 10, 30, `wrist_${s} radial deviation`);
    inRange(limit(`ankle_${s}`, 'flex').max, 30, 60, `ankle_${s} plantarflexion`);
    inRange(-limit(`ankle_${s}`, 'flex').min, 10, 35, `ankle_${s} dorsiflexion`);
  }
});

test('limits: finger joints cannot curl past human range', () => {
  for (const s of ['L', 'R']) {
    for (const f of FINGERS) {
      inRange(limit(`${f}_mcp_${s}`, 'flex').max, 70, 100, `${f}_mcp_${s} flexion`);
      inRange(limit(`${f}_pip_${s}`, 'flex').max, 90, 120, `${f}_pip_${s} flexion`);
      inRange(limit(`${f}_dip_${s}`, 'flex').max, 60, 100, `${f}_dip_${s} flexion`);
      inRange(-limit(`${f}_pip_${s}`, 'flex').min, 0, 15, `${f}_pip_${s} hyperextension`);
      inRange(limit(`${f}_mcp_${s}`, 'spread').max, 10, 30, `${f}_mcp_${s} spread`);
    }
  }
});

test('limits: head + neck can turn at most ~110° relative to the chest (a human manages ~80–90°)', () => {
  const total = (ch) => limit('neck', ch).max + limit('head', ch).max;
  assert.ok(total('twist') <= 110, `neck.twist ±${limit('neck', 'twist').max} + head.twist ±${limit('head', 'twist').max} = ±${total('twist')}° relative to the chest; real cervical rotation is ~±85°`);
  assert.ok(total('flex') <= 110, `neck + head flexion ±${total('flex')}° exceeds the human range`);
  assert.ok(total('bend') <= 75, `neck + head lateral bend ±${total('bend')}° exceeds the human range (~±45°)`);
});

test('limits: spine + chest can twist at most ~70° each way between pelvis and neck base (a human manages ~45°)', () => {
  const twist = limit('spine', 'twist').max + limit('chest', 'twist').max;
  const flexF = limit('spine', 'flex').max + limit('chest', 'flex').max;
  const flexB = -(limit('spine', 'flex').min + limit('chest', 'flex').min);
  const bend = limit('spine', 'bend').max + limit('chest', 'bend').max;
  assert.ok(twist <= 70, `spine.twist ±${limit('spine', 'twist').max} + chest.twist ±${limit('chest', 'twist').max} = ±${twist}° of trunk rotation; real thoracolumbar rotation is ~±45°`);
  assert.ok(flexF <= 80 && flexB <= 50, `trunk flexion ${flexF}° / extension ${flexB}° is beyond the human range (~60° / ~30°)`);
  assert.ok(bend <= 55, `trunk lateral bend ±${bend}° exceeds the human range (~±35°)`);
});
