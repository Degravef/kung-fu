import test from 'node:test';
import assert from 'node:assert/strict';
import { Stickboy } from '../src/skeleton/Stickboy.js';
import { JOINT_DEFS } from '../src/skeleton/jointDefs.js';
import fr from '../src/i18n/fr.js';
import nl from '../src/i18n/nl.js';
import {
  PARTS, SIDED, BUILTIN, FORMAT, VERSION, partBaseNames, partJointNames, capturePosition, applyPosition,
  emptyLibrary, addPosition, addMove, updateMove, movesUsing, addWholePose, captureWholePose, removePosition, renamePosition, serialize, parseLibrary, validateLibrary, mergeLibrary, loadLibrary, countPositions,
} from '../src/positions.js';

const wrap = (part, entry) => ({ format: FORMAT, version: VERSION, positions: { [part]: [entry] } });
const snapshot = (sb) => JSON.stringify([...sb.values].map(([k, v]) => [k, v]));
const only = (sb, names) => JSON.stringify(names.map((n) => [n, sb.values.get(n)]));

test('the four parts partition the 51 articulated joints exactly', () => {
  const all = PARTS.flatMap((p) => (SIDED[p] ? ['L', 'R'] : [null]).flatMap((s) => partJointNames(p, s)));
  const expected = JOINT_DEFS.filter((d) => d.kind === 'joint').map((d) => d.name);
  assert.equal(new Set(all).size, all.length, 'no joint belongs to two parts');
  assert.deepEqual([...all].sort(), [...expected].sort());
  assert.deepEqual(PARTS.map((p) => partBaseNames(p).length), [15, 4, 4, 5]);
  assert.deepEqual(partJointNames('arm', 'R'), ['clavicle_R', 'shoulder_R', 'elbow_R', 'wrist_R']);
  assert.deepEqual(partJointNames('torso', 'L'), partBaseNames('torso'), 'the torso has no side');
});

test('every built-in position is valid, within limits, uniquely identified and translated', () => {
  const ids = new Set();
  for (const part of PARTS) {
    assert.ok(BUILTIN[part].length >= 3, `${part}: a useful starter set`);
    for (const p of BUILTIN[part]) {
      assert.ok(p.builtin && p.id.startsWith(`builtin:${part}:`) && !ids.has(p.id), p.id);
      ids.add(p.id);
      const r = validateLibrary(wrap(part, { name: p.name, joints: p.joints }));
      assert.deepEqual([r.errors, r.warnings], [[], []], `${p.id}: ${r.errors.concat(r.warnings)}`);
      assert.ok(fr.positionNames[p.id] && nl.positionNames[p.id], `${p.id} needs FR and NL names`);
    }
  }
  assert.deepEqual(Object.keys(fr.positionNames).sort(), [...ids].sort(), 'no stale French names');
  assert.deepEqual(Object.keys(nl.positionNames).sort(), [...ids].sort(), 'no stale Dutch names');
});

test('applying a position changes ONLY the joints of its part and side', () => {
  for (const part of PARTS) {
    for (const side of SIDED[part] ? ['L', 'R'] : [null]) {
      const sb = new Stickboy();
      sb.setPose({ joints: { elbow_L: { flex: 50 }, knee_R: { flex: 40 }, spine: { flex: 10 }, index_pip_R: { flex: 30 }, shoulder_R: { abd: 20 } } });
      const mine = new Set(partJointNames(part, side));
      const before = new Map([...sb.values].map(([k, v]) => [k, JSON.stringify(v)]));
      const pos = BUILTIN[part].find((p) => Object.keys(p.joints).length);
      applyPosition(sb, part, side, pos);
      for (const [k, v] of sb.values) if (!mine.has(k)) assert.equal(JSON.stringify(v), before.get(k), `${part}/${side}: ${k} must not change`);
    }
  }
});

test('applying replaces the whole part: previous values of that part are reset first', () => {
  const sb = new Stickboy();
  sb.setPose({ joints: { elbow_L: { flex: 90, twist: 40 }, wrist_L: { flex: 30 } } });
  applyPosition(sb, 'arm', 'L', { joints: { shoulder: { flex: 60 } } });
  assert.deepEqual(sb.values.get('elbow_L'), { flex: 0, twist: 0 });
  assert.deepEqual(sb.values.get('wrist_L'), { flex: 0, dev: 0 });
  assert.equal(sb.values.get('shoulder_L').flex, 60);
});

test('one list serves both sides: the same position on L and R is the mirror image', () => {
  for (const part of ['hand', 'arm', 'leg']) {
    for (const pos of BUILTIN[part]) {
      const a = new Stickboy();
      const b = new Stickboy();
      applyPosition(a, part, 'L', pos);
      applyPosition(b, part, 'R', pos);
      assert.deepEqual(capturePosition(a, part, 'L'), capturePosition(b, part, 'R'), `${pos.id}: same values`);
      // world-space mirror of every joint of the part (compare relative to the pelvis, since auto-ground may shift height equally)
      for (const base of partBaseNames(part)) {
        const pl = a.worldPosition(`${base}_L`);
        const pr = b.worldPosition(`${base}_R`);
        assert.ok(Math.abs(pl.x + pr.x) < 1e-9 && Math.abs(pl.y - pr.y) < 1e-9 && Math.abs(pl.z - pr.z) < 1e-9, `${pos.id}/${base}: not a mirror image`);
      }
    }
  }
});

test("'both' applies to the two sides at once", () => {
  const sb = new Stickboy();
  applyPosition(sb, 'hand', 'both', BUILTIN.hand.find((p) => p.id.endsWith(':fist')));
  assert.deepEqual(capturePosition(sb, 'hand', 'L'), capturePosition(sb, 'hand', 'R'));
  assert.ok(Object.keys(capturePosition(sb, 'hand', 'L')).length === 15);
});

test('capture → reset → apply round-trips a hand-made position (to 0.1°)', () => {
  const sb = new Stickboy();
  sb.setPose({ joints: { shoulder_R: { flex: 71.23, abd: -12.5 }, elbow_R: { flex: 98, twist: -33.3 }, wrist_R: { dev: 7 } } });
  const saved = capturePosition(sb, 'arm', 'R');
  assert.deepEqual(saved.shoulder, { flex: 71.2, abd: -12.5 });
  const fresh = new Stickboy();
  applyPosition(fresh, 'arm', 'L', { joints: saved });
  assert.equal(fresh.values.get('elbow_L').twist, -33.3);
  assert.equal(only(fresh, ['wrist_R']), only(new Stickboy(), ['wrist_R']), 'right side untouched');
});

test('capture only stores non-zero channels, and only side-less joint names', () => {
  const sb = new Stickboy();
  assert.deepEqual(capturePosition(sb, 'leg', 'L'), {});
  sb.setPose({ joints: { knee_L: { flex: 20 } } });
  assert.deepEqual(capturePosition(sb, 'leg', 'L'), { knee: { flex: 20 } });
  assert.deepEqual(capturePosition(sb, 'leg', 'R'), {});
});

test('out-of-limit values are clamped when applied, and reported', () => {
  const sb = new Stickboy();
  const clamped = applyPosition(sb, 'leg', 'L', { joints: { knee: { flex: 400 } } });
  assert.equal(sb.values.get('knee_L').flex, 150);
  assert.deepEqual(clamped, [{ joint: 'knee_L', channel: 'flex', requested: 400, applied: 150 }]);
});

test('library: add / rename / remove keep names unique per part', () => {
  const lib = emptyLibrary();
  const a = addPosition(lib, 'hand', '  Fist  ', {});
  const b = addPosition(lib, 'hand', 'fist', {});
  assert.deepEqual([a.name, b.name], ['Fist', 'fist (2)']);
  assert.equal(addPosition(lib, 'arm', 'Fist', {}).name, 'Fist', 'names only collide within a part');
  assert.equal(addPosition(lib, 'hand', '   ', {}).name, 'Position');
  assert.ok(renamePosition(lib, 'hand', a.id, 'Claw'));
  assert.equal(renamePosition(lib, 'hand', a.id, '   '), false);
  assert.equal(addPosition(lib, 'hand', 'x'.repeat(200), {}).name.length, 60);
  assert.ok(removePosition(lib, 'hand', a.id));
  assert.equal(removePosition(lib, 'hand', a.id), false);
});

test('export → import round-trip preserves everything', () => {
  const lib = emptyLibrary();
  addPosition(lib, 'hand', 'Claw', { index_mcp: { flex: 40, spread: 5 } });
  addPosition(lib, 'torso', 'Lean', { spine: { flex: 12 }, chest: { twist: -10 } });
  const r = parseLibrary(serialize(lib));
  assert.deepEqual([r.errors, r.warnings, r.fatal], [[], [], false]);
  assert.deepEqual(r.library, lib);
  assert.equal(countPositions(r.library), 2);
  assert.ok(serialize(lib).endsWith('\n') && JSON.parse(serialize(lib)).format === FORMAT);
});

test('import rejects bad files with a precise reason', () => {
  const reasons = (text) => parseLibrary(text).errors.join(' | ');
  assert.match(reasons('not json {'), /not valid JSON/);
  assert.match(reasons('[]'), /not a JSON object/);
  assert.match(reasons('{"format":"other","version":1,"positions":{}}'), /"format" should be "kungfu-positions"/);
  assert.match(reasons(`{"format":"${FORMAT}","version":"1","positions":{}}`), /"version" must be a whole number/);
  assert.match(reasons(`{"format":"${FORMAT}","version":99,"positions":{}}`), /newer than this app/);
  assert.match(reasons(`{"format":"${FORMAT}","version":1}`), /"positions" must be an object/);
  for (const text of ['not json {', '[]']) assert.equal(parseLibrary(text).fatal, true);
});

test('import skips only the broken positions, naming the exact path of each problem', () => {
  const data = {
    format: FORMAT, version: VERSION,
    positions: {
      hand: [
        { name: 'Good', joints: { index_mcp: { flex: 80 } } },
        { name: 'Bad joint', joints: { elbow: { flex: 10 } } },
        { name: 'Bad channel', joints: { index_mcp: { bend: 10 } } },
        { name: 'Bad value', joints: { index_mcp: { flex: '80' } } },
        { name: '', joints: {} },
        { name: 'No joints' },
        { name: 'Reserved', id: 'builtin:hand:fist', joints: {} },
      ],
      wing: [],
      arm: 'nope',
    },
  };
  const r = validateLibrary(data);
  assert.deepEqual(r.library.positions.hand.map((p) => p.name), ['Good']);
  const text = r.errors.join('\n');
  assert.match(text, /positions\.hand\[1\]\.joints\.elbow: not a joint of the hand \(valid: index_mcp,/);
  assert.match(text, /positions\.hand\[2\]\.joints\.index_mcp\.bend: unknown channel \(valid: flex, spread\)/);
  assert.match(text, /positions\.hand\[3\]\.joints\.index_mcp\.flex: must be a finite number of degrees \(found "80"\)/);
  assert.match(text, /positions\.hand\[4\]\.name: a non-empty text is required/);
  assert.match(text, /positions\.hand\[5\]\.joints: must be an object/);
  assert.match(text, /positions\.hand\[6\]\.id: "builtin:" ids are reserved/);
  assert.match(text, /positions\.wing: unknown body part/);
  assert.match(text, /positions\.arm: must be a list/);
});

test('import clamps out-of-range degrees, warns, and rejects NaN / Infinity', () => {
  const r = validateLibrary(wrap('leg', { name: 'Splits', joints: { hip: { abd: 150 }, knee: { flex: -5 } } }));
  assert.deepEqual(r.library.positions.leg[0].joints, { hip: { abd: 90 }, knee: { flex: 0 } });
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /positions\.leg\[0\]\.joints\.hip\.abd: 150° is outside -30…90°, clamped to 90°/);
  const bad = validateLibrary({ format: FORMAT, version: 1, positions: { leg: [{ name: 'x', joints: { knee: { flex: null } } }] } });
  assert.match(bad.errors[0], /must be a finite number/);
  // JSON cannot carry NaN/Infinity, but a hand-built object can
  assert.equal(validateLibrary(wrap('leg', { name: 'x', joints: { knee: { flex: Infinity } } })).library.positions.leg.length, 0);
});

test('torso positions use torso joints only; sided joint names are refused', () => {
  assert.equal(validateLibrary(wrap('torso', { name: 'T', joints: { spine: { flex: 5 } } })).errors.length, 0);
  assert.equal(validateLibrary(wrap('torso', { name: 'T', joints: { shoulder: { flex: 5 } } })).errors.length, 1);
  assert.equal(validateLibrary(wrap('arm', { name: 'A', joints: { shoulder_L: { flex: 5 } } })).errors.length, 1, 'stored names are side-less');
});

test('merge: same id replaces, new ids are added, names stay unique', () => {
  const lib = emptyLibrary();
  const mine = addPosition(lib, 'hand', 'Claw', { index_mcp: { flex: 10 } }, 'user:a');
  const incoming = emptyLibrary();
  addPosition(incoming, 'hand', 'Claw', { index_mcp: { flex: 99 } }, 'user:a'); // same id: update
  addPosition(incoming, 'hand', 'Claw', { index_mcp: { flex: 50 } }, 'user:b'); // new id, same name
  const r = mergeLibrary(lib, incoming);
  assert.deepEqual(r, { added: 1, replaced: 1 });
  assert.equal(mine.id, 'user:a');
  assert.deepEqual(lib.positions.hand.map((p) => [p.id, p.name, p.joints.index_mcp.flex]), [['user:a', 'Claw', 99], ['user:b', 'Claw (2)', 50]]);
});

test('duplicate ids inside one file are re-issued instead of overwriting each other', () => {
  const data = { format: FORMAT, version: 1, positions: { arm: [{ id: 'user:x', name: 'A', joints: {} }, { id: 'user:x', name: 'B', joints: {} }] } };
  const r = validateLibrary(data);
  assert.equal(r.library.positions.arm.length, 2);
  assert.notEqual(r.library.positions.arm[0].id, r.library.positions.arm[1].id);
  assert.equal(r.warnings.length, 1);
});

test('loadLibrary survives empty, corrupt or foreign storage', () => {
  for (const text of [null, '', '{', '[]', '{"format":"x"}', `{"format":"${FORMAT}","version":9,"positions":{}}`]) {
    assert.deepEqual(loadLibrary(text), emptyLibrary(), String(text));
  }
  const lib = emptyLibrary();
  addPosition(lib, 'leg', 'Kick', { hip: { flex: 80 } });
  assert.deepEqual(loadLibrary(serialize(lib)), lib);
});

test('snapshot helper sanity: applying an empty position to a clean figure changes nothing', () => {
  const sb = new Stickboy();
  const s = snapshot(sb);
  for (const part of PARTS) applyPosition(sb, part, 'both', { joints: {} });
  assert.equal(snapshot(sb), s);
});

/* ------------------------------------------------------------ whole-body poses */

test('captureWholePose is sparse, keeps the root offset, and re-applies exactly', () => {
  const sb = new Stickboy();
  sb.setPose({ root: { x: 0.0412, z: -0.2, lift: 0.1 }, joints: { elbow_R: { flex: 91.26, twist: -40 }, knee_L: { flex: 20 }, spine: { twist: 7 } } });
  const whole = captureWholePose(sb);
  assert.deepEqual(whole.joints, { spine: { twist: 7 }, elbow_R: { flex: 91.3, twist: -40 }, knee_L: { flex: 20 } });
  assert.deepEqual(whole.root, { x: 0.041, z: -0.2, lift: 0.1 });
  const other = new Stickboy();
  assert.deepEqual(other.setPose(whole), []);
  assert.equal(other.values.get('elbow_R').flex, 91.3);
  assert.deepEqual(other.getPose().root, whole.root);
});

test('whole poses: unique names, mutations, count and export round-trip', () => {
  const lib = emptyLibrary();
  const sb = new Stickboy();
  const a = addWholePose(lib, 'My stance', captureWholePose(sb));
  const b = addWholePose(lib, 'my stance', { root: { x: 0, z: 0, lift: 0 }, joints: { knee_L: { flex: 30 } } });
  assert.deepEqual([a.name, b.name], ['My stance', 'my stance (2)']);
  assert.equal(countPositions(lib), 2);
  assert.ok(renamePosition(lib, 'pose', a.id, 'Stance A'));
  const r = parseLibrary(serialize(lib));
  assert.deepEqual([r.errors, r.warnings], [[], []]);
  assert.deepEqual(r.library, lib);
  assert.ok(removePosition(lib, 'pose', a.id));
  assert.equal(lib.poses.length, 1);
});

test('older files without "poses" still import; an empty library has an empty list', () => {
  assert.deepEqual(emptyLibrary().poses, []);
  const r = parseLibrary(JSON.stringify({ format: FORMAT, version: 1, positions: {} }));
  assert.deepEqual([r.errors, r.fatal, r.library.poses], [[], false, []]);
});

test('import validates whole poses with exact paths, clamps and root checks', () => {
  const file = (poses) => JSON.stringify({ format: FORMAT, version: 1, positions: {}, poses });
  const r = parseLibrary(file([
    { id: 'user:ok', name: 'Fine', root: { x: 0.1, z: 0, lift: 0 }, joints: { elbow_R: { flex: 90 }, spine: { twist: 5 } } },
    { name: 'Side-less', joints: { elbow: { flex: 10 } } },
    { name: 'Bad channel', joints: { knee_L: { bend: 10 } } },
    { name: 'Bad root', root: { y: 1, x: 'a' }, joints: {} },
    { name: 'Clamp me', root: { lift: -1, x: 50 }, joints: { knee_L: { flex: 300 } } },
    { name: '', joints: {} },
    { name: 'Reserved', id: 'builtin:x', joints: {} },
  ]));
  assert.deepEqual(r.library.poses.map((p) => p.name), ['Fine', 'Clamp me']);
  const text = r.errors.join('\n');
  assert.match(text, /poses\[1\]\.joints\.elbow: unknown joint \(names look like elbow_L/);
  assert.match(text, /poses\[2\]\.joints\.knee_L\.bend: unknown channel \(valid: flex\)/);
  assert.match(text, /poses\[3\]\.root\.y: unknown \(use x, z, lift/);
  assert.match(text, /poses\[3\]\.root\.x: must be a finite number of metres \(found "a"\)/);
  assert.match(text, /poses\[5\]\.name: a non-empty text is required/);
  assert.match(text, /poses\[6\]\.id: "builtin:" ids are reserved/);
  const clamped = r.library.poses[1];
  assert.deepEqual([clamped.root, clamped.joints.knee_L.flex], [{ x: 10, z: 0, lift: 0 }, 150]);
  assert.equal(r.warnings.length, 3);
  assert.equal(parseLibrary(file('nope')).errors[0], 'poses: must be a list');
});

test('merge: whole poses with the same id are replaced, others added with unique names', () => {
  const lib = emptyLibrary();
  addWholePose(lib, 'Stance', { root: { x: 0, z: 0, lift: 0 }, joints: {} }, 'user:1');
  const incoming = emptyLibrary();
  addWholePose(incoming, 'Stance', { root: { x: 0, z: 0, lift: 0 }, joints: { knee_L: { flex: 9 } } }, 'user:1');
  addWholePose(incoming, 'Stance', { root: { x: 0, z: 0, lift: 0 }, joints: {} }, 'user:2');
  assert.deepEqual(mergeLibrary(lib, incoming), { added: 1, replaced: 1 });
  assert.deepEqual(lib.poses.map((p) => [p.id, p.name]), [['user:1', 'Stance'], ['user:2', 'Stance (2)']]);
  assert.equal(lib.poses[0].joints.knee_L.flex, 9);
});

/* ------------------------------------------------------------------------ moves */

const mfile = (moves, extra = {}) => JSON.stringify({ format: FORMAT, version: 1, positions: {}, moves, ...extra });
const step = (pose, duration = 0.5) => ({ pose, duration });

test('moves: add / update / unique names / movesUsing / counting', () => {
  const lib = emptyLibrary();
  const a = addMove(lib, ' Combo ', [step('guard', 0.6), step('punch', 0.2)]);
  const b = addMove(lib, 'combo', [step('guard')]);
  assert.deepEqual([a.name, b.name], ['Combo', 'combo (2)']);
  assert.equal(addMove(lib, '', [step('guard')]).name, 'Move');
  assert.equal(countPositions(lib), 3);
  const copy = [step('kick', 1)];
  updateMove(lib, a.id, 'Kicks', copy);
  copy[0].duration = 99; // later edits of the draft must not leak into the saved move
  assert.deepEqual(lib.moves[0], { id: a.id, name: 'Kicks', steps: [{ pose: 'kick', duration: 1 }] });
  assert.equal(updateMove(lib, 'nope', 'x', []), null);
  assert.deepEqual(movesUsing(lib, 'kick'), ['Kicks']);
  assert.deepEqual(movesUsing(lib, 'open'), []);
  assert.ok(removePosition(lib, 'move', b.id));
  assert.ok(renamePosition(lib, 'move', a.id, 'Renamed'));
});

test('moves: export → import round-trip, and files without "moves" still import', () => {
  const lib = emptyLibrary();
  addWholePose(lib, 'Mine', { root: { x: 0, z: 0, lift: 0 }, joints: {} }, 'user:p1');
  addMove(lib, 'Combo', [step('guard', 0.6), step('user:p1', 0.3), step('punch', 0.25)]);
  const r = parseLibrary(serialize(lib));
  assert.deepEqual([r.errors, r.warnings], [[], []]);
  assert.deepEqual(r.library, lib);
  assert.deepEqual(parseLibrary(JSON.stringify({ format: FORMAT, version: 1, positions: {} })).library.moves, []);
});

test('moves: import validates steps with exact paths', () => {
  const r = parseLibrary(mfile([
    { id: 'user:ok', name: 'Fine', steps: [step('guard', 0.4), step('chamber', 0.2)] },
    { name: 'Unknown pose', steps: [step('flying')] },
    { name: 'No steps', steps: [] },
    { name: 'Not a list', steps: 'x' },
    { name: 'Bad duration', steps: [{ pose: 'guard', duration: '1' }, { pose: 'punch' }] },
    { name: '', steps: [step('guard')] },
    { name: 'Reserved', id: 'builtin:m', steps: [step('guard')] },
    { name: 'Bad step', steps: [7] },
    { name: 'Clamp', steps: [step('guard', 0), step('punch', 99)] },
  ]));
  assert.deepEqual(r.library.moves.map((m) => m.name), ['Fine', 'Clamp']);
  const text = r.errors.join('\n');
  assert.match(text, /moves\[1\]\.steps\[0\]\.pose: unknown pose "flying" \(built-in: attention, guard/);
  assert.match(text, /moves\[2\]\.steps: must be a non-empty list/);
  assert.match(text, /moves\[3\]\.steps: must be a non-empty list/);
  assert.match(text, /moves\[4\]\.steps\[0\]\.duration: must be a number of seconds \(found "1"\)/);
  assert.match(text, /moves\[4\]\.steps\[1\]\.duration: must be a number of seconds/);
  assert.match(text, /moves\[5\]\.name: a non-empty text is required/);
  assert.match(text, /moves\[6\]\.id: "builtin:" ids are reserved/);
  assert.match(text, /moves\[7\]\.steps\[0\]: must be an object like/);
  assert.deepEqual(r.library.moves[1].steps, [{ pose: 'guard', duration: 0.05 }, { pose: 'punch', duration: 10 }]);
  assert.equal(r.warnings.length, 2);
  assert.equal(parseLibrary(JSON.stringify({ format: FORMAT, version: 1, positions: {}, moves: 5 })).errors[0], 'moves: must be a list');
  const tooMany = parseLibrary(mfile([{ name: 'Long', steps: Array.from({ length: 51 }, () => step('guard')) }]));
  assert.match(tooMany.errors[0], /at most 50 steps \(found 51\)/);
});

test('moves may use saved poses from the same file or from the existing library, not from nowhere', () => {
  const inFile = parseLibrary(mfile([{ name: 'A', steps: [step('user:p9')] }], { poses: [{ id: 'user:p9', name: 'P', joints: {} }] }));
  assert.deepEqual([inFile.errors, inFile.library.moves.length], [[], 1]);
  assert.match(parseLibrary(mfile([{ name: 'A', steps: [step('user:p9')] }])).errors[0], /unknown pose "user:p9"/);
  const known = parseLibrary(mfile([{ name: 'A', steps: [step('user:p9')] }]), { knownPoseIds: ['user:p9'] });
  assert.deepEqual([known.errors, known.library.moves.length], [[], 1]);
});

test('moves: merge replaces by id, adds new ones, keeps names unique', () => {
  const lib = emptyLibrary();
  addMove(lib, 'Combo', [step('guard')], 'user:m1');
  const incoming = emptyLibrary();
  addMove(incoming, 'Combo', [step('punch', 2)], 'user:m1');
  addMove(incoming, 'Combo', [step('kick')], 'user:m2');
  assert.deepEqual(mergeLibrary(lib, incoming), { added: 1, replaced: 1 });
  assert.deepEqual(lib.moves.map((m) => [m.id, m.name, m.steps[0].pose]), [['user:m1', 'Combo', 'punch'], ['user:m2', 'Combo (2)', 'kick']]);
});
