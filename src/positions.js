import { JOINT_DEFS } from './skeleton/jointDefs.js';
import { POSE_ORDER } from './poses.js';

/**
 * Saved POSITIONS of a body part (hand, arm, leg, torso) — DOM-free, so it runs in Node and tests.
 *
 * A position only touches the joints of its part, and is stored with SIDE-LESS joint names
 * (`shoulder`, `index_mcp`). Channel values mean the same thing on both sides (see jointDefs.js),
 * so one list of hand / arm / leg positions serves the left AND the right side: applying it to the
 * other side is the mirror image. Torso joints sit on the centre line and have no side.
 *
 * File format (export / import):
 *   { "format": "kungfu-positions", "version": 1,
 *     "positions": { "hand": [ { "id", "name", "joints": { "index_mcp": { "flex": 88 } } } ], "arm": [], "leg": [], "torso": [] },
 *     "poses": [ { "id", "name", "root": { "x", "z", "lift" }, "joints": { "elbow_L": { "flex": 90 }, … } } ] }
 *
 * `poses` are WHOLE-BODY poses: they use real (sided) joint names and also keep the root offset.
 * They show up in the pose bar at the bottom of the page.
 *
 * `moves`: [ { "id", "name", "steps": [ { "pose": "guard" | "user:…", "duration": 0.45 } ] } ]
 * An ordered list of poses (a built-in pose key, or the id of a saved pose); `duration` is the number of
 * seconds taken to blend INTO that pose from the previous one (the first step blends from wherever you are).
 */

export const FORMAT = 'kungfu-positions';
export const VERSION = 1;
export const PARTS = ['hand', 'arm', 'leg', 'torso'];
export const SIDED = { hand: true, arm: true, leg: true, torso: false };
export const MAX_NAME = 60;
export const MAX_STEPS = 50;
export const DURATION = { min: 0.05, max: 10 };

const baseOf = (name) => name.replace(/_[LR]$/, '');

/** Which skeleton joints belong to a part (articulated joints only, side-less names). */
const PART_FILTER = {
  hand: (d) => d.region === 'Left hand',
  arm: (d) => d.region === 'Left arm',
  leg: (d) => d.region === 'Left leg',
  torso: (d) => d.region === 'Body',
};

const defsOf = (part) => JOINT_DEFS.filter((d) => d.kind === 'joint' && d.side !== 'R' && PART_FILTER[part](d));

/** Side-less joint names of a part, in skeleton order. */
export const partBaseNames = (part) => defsOf(part).map((d) => baseOf(d.name));

/** Real joint names for a part on one side ('L' | 'R'); torso ignores the side. */
export const partJointNames = (part, side) => partBaseNames(part).map((b) => (SIDED[part] ? `${b}_${side}` : b));

const limitsOf = (part) => new Map(defsOf(part).map((d) => [baseOf(d.name), new Map(d.dof.map((c) => [c.channel, c]))]));

/* --------------------------------------------------------------- capture / apply */

const round = (v) => Math.round(v * 10) / 10;

/** Read the current values of a part from a Stickboy into a side-less position (non-zero channels only). */
export function capturePosition(stickboy, part, side) {
  const joints = {};
  for (const base of partBaseNames(part)) {
    const ch = stickboy.values.get(SIDED[part] ? `${base}_${side}` : base);
    const nz = Object.fromEntries(Object.entries(ch ?? {}).filter(([, v]) => round(v) !== 0).map(([k, v]) => [k, round(v)]));
    if (Object.keys(nz).length) joints[base] = nz;
  }
  return joints;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/** The whole current pose (sparse: non-zero channels only) with its root offset — what the pose bar stores. */
export function captureWholePose(stickboy) {
  const { root, joints } = stickboy.getPose();
  const out = {};
  for (const [name, ch] of Object.entries(joints)) {
    const nz = Object.fromEntries(Object.entries(ch).filter(([, v]) => round(v) !== 0).map(([k, v]) => [k, round(v)]));
    if (Object.keys(nz).length) out[name] = nz;
  }
  return { root: { x: round3(root.x), z: round3(root.z), lift: round3(root.lift) }, joints: out };
}

/** Save a move (ordered steps of { pose, duration }); returns the stored entry. */
export function addMove(lib, name, steps, id = makeId()) {
  const list = lib.moves;
  const entry = { id, name: uniqueName(list, cleanName(name) || 'Move'), steps: steps.map((s) => ({ pose: s.pose, duration: s.duration })) };
  list.push(entry);
  return entry;
}

/** Replace the name and steps of a saved move. */
export function updateMove(lib, id, name, steps) {
  const m = lib.moves.find((x) => x.id === id);
  if (!m) return null;
  m.name = uniqueName(lib.moves.filter((x) => x !== m), cleanName(name) || m.name);
  m.steps = steps.map((s) => ({ pose: s.pose, duration: s.duration }));
  return m;
}

/** Names of the saved moves that use a pose (to warn before deleting it). */
export const movesUsing = (lib, poseId) => lib.moves.filter((m) => m.steps.some((s) => s.pose === poseId)).map((m) => m.name);

/** Save a whole pose: returns the stored entry ({ id, name, root, joints }). */
export function addWholePose(lib, name, pose, id = makeId()) {
  const entry = addPosition(lib, 'pose', name, pose.joints, id);
  entry.root = pose.root;
  return entry;
}

/**
 * Apply a position to one side ('L' | 'R' | 'both'; ignored for the torso). Every joint of the part is
 * reset first, so the position fully defines it. Returns the values clamped to joint limits.
 */
export function applyPosition(stickboy, part, side, position) {
  const sides = !SIDED[part] ? [null] : side === 'both' ? ['L', 'R'] : [side];
  const clamped = [];
  for (const s of sides) {
    const partial = {};
    for (const [base, ch] of Object.entries(position.joints ?? {})) partial[SIDED[part] ? `${base}_${s}` : base] = ch;
    clamped.push(...stickboy.setPartial(partJointNames(part, s), partial));
  }
  return clamped;
}

/* ------------------------------------------------------------------ built-ins */

const fingers = ['index', 'middle', 'ring', 'pinky'];
function handShape({ mcp, pip, dip, spread = {}, thumb }) {
  const j = {};
  for (const f of fingers) {
    j[`${f}_mcp`] = { flex: mcp, spread: spread[f] ?? 0 };
    j[`${f}_pip`] = { flex: pip };
    j[`${f}_dip`] = { flex: dip };
  }
  j.thumb_cmc = thumb.cmc;
  j.thumb_mcp = thumb.mcp;
  j.thumb_ip = thumb.ip;
  return j;
}

const bi = (part, key, name, joints) => ({ id: `builtin:${part}:${key}`, name, builtin: true, joints });

/** Ready-made positions (read-only). Names are translated by id, see i18n `positionNames`. */
export const BUILTIN = {
  hand: [
    bi('hand', 'relaxed', 'Relaxed hand', handShape({ mcp: 14, pip: 22, dip: 10, thumb: { cmc: { flex: 4 }, mcp: { flex: 10 }, ip: { flex: 10 } } })),
    bi('hand', 'fist', 'Fist', handShape({ mcp: 88, pip: 100, dip: 60, thumb: { cmc: { spread: -20, flex: 20 }, mcp: { flex: 35 }, ip: { flex: 80 } } })),
    bi('hand', 'open', 'Open hand, fingers spread', handShape({ mcp: 0, pip: 0, dip: 0, spread: { index: 12, middle: 0, ring: 10, pinky: 20 }, thumb: { cmc: { spread: 45 }, mcp: { flex: 0 }, ip: { flex: 0 } } })),
    bi('hand', 'knife', 'Knife hand', handShape({ mcp: 0, pip: 0, dip: 0, spread: { index: -3, ring: -3, pinky: -3 }, thumb: { cmc: { spread: -20 }, mcp: { flex: 20 }, ip: { flex: 10 } } })),
  ],
  arm: [
    bi('arm', 'down', 'Arm down', {}),
    bi('arm', 'guardFront', 'Front guard', { shoulder: { flex: 50, abd: -8 }, elbow: { flex: 115 } }),
    bi('arm', 'guardRear', 'Rear guard', { shoulder: { flex: 40, abd: -14 }, elbow: { flex: 125 } }),
    bi('arm', 'punch', 'Straight punch', { shoulder: { flex: 98, abd: -4 }, elbow: { flex: 4, twist: -90 } }),
    bi('arm', 'side', 'Arm out to the side', { shoulder: { abd: 90 }, elbow: { twist: 90 } }),
  ],
  leg: [
    bi('leg', 'straight', 'Standing straight', {}),
    bi('leg', 'front', 'Front leg (guard)', { hip: { flex: 35, abd: 8 }, knee: { flex: 45 }, ankle: { flex: -10 } }),
    bi('leg', 'rear', 'Rear leg (guard)', { hip: { flex: -30, abd: 8 }, knee: { flex: 6 }, ankle: { flex: -20 } }),
    bi('leg', 'frontKick', 'Front kick', { hip: { flex: 88, abd: 3 }, knee: { flex: 8 }, ankle: { flex: -25 } }),
    bi('leg', 'chamber', 'Knee raised to the side', { hip: { flex: 90, abd: 55, twist: -15 }, knee: { flex: 138 }, ankle: { flex: 30 } }),
  ],
  torso: [
    bi('torso', 'upright', 'Upright', {}),
    bi('torso', 'forward', 'Leaning forward', { spine: { flex: 10 }, chest: { flex: 12 }, neck: { flex: -8 }, head: { flex: -8 } }),
    bi('torso', 'back', 'Leaning back', { spine: { flex: -8 }, chest: { flex: -8 }, neck: { flex: 8 }, head: { flex: 8 } }),
    bi('torso', 'twistLeft', 'Turned to the left', { spine: { twist: 20 }, chest: { twist: 25 }, neck: { twist: -15 }, head: { twist: -15 } }),
  ],
};

/* -------------------------------------------------------------------- library */

export const emptyLibrary = () => ({ format: FORMAT, version: VERSION, positions: Object.fromEntries(PARTS.map((p) => [p, []])), poses: [], moves: [] });

/** The list a part name refers to; 'pose' = the whole-body poses. */
const listOf = (lib, part) => (part === 'pose' ? lib.poses : part === 'move' ? lib.moves : lib.positions[part]);

export const makeId = () => `user:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Unique display name within a part: "Fist", then "Fist (2)", "Fist (3)"… */
function uniqueName(list, wanted) {
  const names = new Set(list.map((p) => p.name.toLowerCase()));
  if (!names.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; ; n++) if (!names.has(`${wanted} (${n})`.toLowerCase())) return `${wanted} (${n})`;
}

const cleanName = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);

/** Add a position; returns the stored entry (name made unique). */
export function addPosition(lib, part, name, joints, id = makeId()) {
  const list = listOf(lib, part);
  const entry = { id, name: uniqueName(list, cleanName(name) || 'Position'), joints };
  list.push(entry);
  return entry;
}

export function removePosition(lib, part, id) {
  const list = listOf(lib, part);
  const i = list.findIndex((p) => p.id === id);
  if (i >= 0) list.splice(i, 1);
  return i >= 0;
}

export function renamePosition(lib, part, id, name) {
  const list = listOf(lib, part);
  const p = list.find((x) => x.id === id);
  if (!p) return false;
  const wanted = cleanName(name);
  if (!wanted) return false;
  p.name = uniqueName(list.filter((x) => x !== p), wanted);
  return true;
}

export const allPositions = (lib, part) => [...BUILTIN[part], ...lib.positions[part]];

/* ----------------------------------------------------------- export / import */

export const serialize = (lib) => `${JSON.stringify(lib, null, 2)}\n`;

export const countPositions = (lib) => PARTS.reduce((n, p) => n + lib.positions[p].length, 0) + lib.poses.length + lib.moves.length;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Check untrusted data (an imported file, or later an LLM answer). Never throws.
 * Returns { library, errors, warnings }: `library` holds every VALID position; invalid ones are skipped
 * and described in `errors` with the exact path. Out-of-range values are clamped and listed in `warnings`.
 */
export function validateLibrary(data, { knownPoseIds = [] } = {}) {
  const errors = [];
  const warnings = [];
  const library = emptyLibrary();
  const fail = (reason) => ({ library, errors: [reason], warnings, fatal: true });

  if (!isObj(data)) return fail('the file is not a JSON object');
  if (data.format !== FORMAT) return fail(`"format" should be "${FORMAT}" (found ${JSON.stringify(data.format)})`);
  if (!Number.isInteger(data.version) || data.version < 1) return fail('"version" must be a whole number ≥ 1');
  if (data.version > VERSION) return fail(`file version ${data.version} is newer than this app understands (${VERSION})`);
  if (!isObj(data.positions)) return fail('"positions" must be an object with hand / arm / leg / torso lists');

  for (const key of Object.keys(data.positions)) {
    if (!PARTS.includes(key)) errors.push(`positions.${key}: unknown body part (use ${PARTS.join(', ')})`);
  }

  const seenIds = new Set();
  for (const part of PARTS) {
    const list = data.positions[part];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`positions.${part}: must be a list`);
      continue;
    }
    const limits = limitsOf(part);
    list.forEach((p, i) => {
      const at = `positions.${part}[${i}]`;
      const problems = [];
      if (!isObj(p)) return errors.push(`${at}: must be an object`);
      const name = cleanName(p.name);
      if (!name) problems.push(`${at}.name: a non-empty text is required`);
      if (typeof p.name === 'string' && p.name.trim().length > MAX_NAME) warnings.push(`${at}.name: shortened to ${MAX_NAME} characters`);
      if (p.id !== undefined && (typeof p.id !== 'string' || !p.id)) problems.push(`${at}.id: must be a non-empty text when present`);
      if (typeof p.id === 'string' && p.id.startsWith('builtin:')) problems.push(`${at}.id: "builtin:" ids are reserved`);
      if (!isObj(p.joints)) problems.push(`${at}.joints: must be an object like { "elbow": { "flex": 90 } }`);

      const joints = {};
      const localWarnings = [];
      if (isObj(p.joints)) {
        for (const [joint, channels] of Object.entries(p.joints)) {
          const jl = limits.get(joint);
          if (!jl) {
            problems.push(`${at}.joints.${joint}: not a joint of the ${part} (valid: ${[...limits.keys()].join(', ')})`);
            continue;
          }
          if (!isObj(channels)) {
            problems.push(`${at}.joints.${joint}: must be an object of channel values`);
            continue;
          }
          const out = {};
          for (const [ch, v] of Object.entries(channels)) {
            const c = jl.get(ch);
            if (!c) problems.push(`${at}.joints.${joint}.${ch}: unknown channel (valid: ${[...jl.keys()].join(', ')})`);
            else if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at}.joints.${joint}.${ch}: must be a finite number of degrees (found ${JSON.stringify(v)})`);
            else {
              const got = Math.min(c.max, Math.max(c.min, v));
              if (got !== v) localWarnings.push(`${at}.joints.${joint}.${ch}: ${v}° is outside ${c.min}…${c.max}°, clamped to ${got}°`);
              out[ch] = got;
            }
          }
          if (Object.keys(out).length) joints[joint] = out;
        }
      }

      if (problems.length) return errors.push(...problems);
      warnings.push(...localWarnings);
      let id = p.id ?? makeId();
      if (seenIds.has(`${part}/${id}`)) {
        warnings.push(`${at}.id: "${id}" appears twice, the second one got a new id`);
        id = makeId();
      }
      seenIds.add(`${part}/${id}`);
      library.positions[part].push({ id, name, joints });
    });
  }

  // ---- whole-body poses (real, sided joint names + root offset)
  if (data.poses !== undefined && !Array.isArray(data.poses)) errors.push('poses: must be a list');
  else {
    const limitsAll = new Map(JOINT_DEFS.filter((d) => d.kind === 'joint').map((d) => [d.name, new Map(d.dof.map((c) => [c.channel, c]))]));
    const ROOT_LIMITS = { x: [-10, 10], z: [-10, 10], lift: [0, 5] };
    (data.poses ?? []).forEach((p, i) => {
      const at = `poses[${i}]`;
      const problems = [];
      const localWarnings = [];
      if (!isObj(p)) return errors.push(`${at}: must be an object`);
      const name = cleanName(p.name);
      if (!name) problems.push(`${at}.name: a non-empty text is required`);
      if (p.id !== undefined && (typeof p.id !== 'string' || !p.id)) problems.push(`${at}.id: must be a non-empty text when present`);
      if (typeof p.id === 'string' && p.id.startsWith('builtin:')) problems.push(`${at}.id: "builtin:" ids are reserved`);
      if (!isObj(p.joints)) problems.push(`${at}.joints: must be an object like { "elbow_L": { "flex": 90 } }`);

      const joints = {};
      for (const [joint, channels] of Object.entries(isObj(p.joints) ? p.joints : {})) {
        const jl = limitsAll.get(joint);
        if (!jl) {
          problems.push(`${at}.joints.${joint}: unknown joint (names look like elbow_L, index_pip_R, spine)`);
          continue;
        }
        if (!isObj(channels)) {
          problems.push(`${at}.joints.${joint}: must be an object of channel values`);
          continue;
        }
        const out = {};
        for (const [ch, v] of Object.entries(channels)) {
          const c = jl.get(ch);
          if (!c) problems.push(`${at}.joints.${joint}.${ch}: unknown channel (valid: ${[...jl.keys()].join(', ')})`);
          else if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at}.joints.${joint}.${ch}: must be a finite number of degrees (found ${JSON.stringify(v)})`);
          else {
            const got = Math.min(c.max, Math.max(c.min, v));
            if (got !== v) localWarnings.push(`${at}.joints.${joint}.${ch}: ${v}° is outside ${c.min}…${c.max}°, clamped to ${got}°`);
            out[ch] = got;
          }
        }
        if (Object.keys(out).length) joints[joint] = out;
      }

      const root = { x: 0, z: 0, lift: 0 };
      if (p.root !== undefined && !isObj(p.root)) problems.push(`${at}.root: must be an object like { "x": 0, "z": 0, "lift": 0 }`);
      for (const [k, v] of Object.entries(isObj(p.root) ? p.root : {})) {
        if (!(k in ROOT_LIMITS)) problems.push(`${at}.root.${k}: unknown (use x, z, lift — metres)`);
        else if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at}.root.${k}: must be a finite number of metres (found ${JSON.stringify(v)})`);
        else {
          const [lo, hi] = ROOT_LIMITS[k];
          root[k] = Math.min(hi, Math.max(lo, v));
          if (root[k] !== v) localWarnings.push(`${at}.root.${k}: ${v} m is outside ${lo}…${hi} m, clamped to ${root[k]} m`);
        }
      }

      if (problems.length) return errors.push(...problems);
      warnings.push(...localWarnings);
      let id = p.id ?? makeId();
      if (seenIds.has(`pose/${id}`)) {
        warnings.push(`${at}.id: "${id}" appears twice, the second one got a new id`);
        id = makeId();
      }
      seenIds.add(`pose/${id}`);
      library.poses.push({ id, name, joints, root });
    });
  }

  // ---- moves: ordered steps of poses
  if (data.moves !== undefined && !Array.isArray(data.moves)) errors.push('moves: must be a list');
  else {
    const known = new Set([...POSE_ORDER, ...knownPoseIds, ...library.poses.map((p) => p.id)]);
    (data.moves ?? []).forEach((m, i) => {
      const at = `moves[${i}]`;
      const problems = [];
      const localWarnings = [];
      if (!isObj(m)) return errors.push(`${at}: must be an object`);
      const name = cleanName(m.name);
      if (!name) problems.push(`${at}.name: a non-empty text is required`);
      if (m.id !== undefined && (typeof m.id !== 'string' || !m.id)) problems.push(`${at}.id: must be a non-empty text when present`);
      if (typeof m.id === 'string' && m.id.startsWith('builtin:')) problems.push(`${at}.id: "builtin:" ids are reserved`);
      const steps = [];
      if (!Array.isArray(m.steps) || !m.steps.length) problems.push(`${at}.steps: must be a non-empty list of { "pose", "duration" }`);
      else if (m.steps.length > MAX_STEPS) problems.push(`${at}.steps: at most ${MAX_STEPS} steps (found ${m.steps.length})`);
      else {
        m.steps.forEach((s, j) => {
          const sat = `${at}.steps[${j}]`;
          if (!isObj(s)) return problems.push(`${sat}: must be an object like { "pose": "guard", "duration": 0.5 }`);
          if (typeof s.pose !== 'string' || !known.has(s.pose)) problems.push(`${sat}.pose: unknown pose ${JSON.stringify(s.pose)} (built-in: ${POSE_ORDER.join(', ')}; or the id of a saved pose)`);
          if (typeof s.duration !== 'number' || !Number.isFinite(s.duration)) problems.push(`${sat}.duration: must be a number of seconds (found ${JSON.stringify(s.duration)})`);
          else {
            const d = Math.min(DURATION.max, Math.max(DURATION.min, s.duration));
            if (d !== s.duration) localWarnings.push(`${sat}.duration: ${s.duration} s is outside ${DURATION.min}…${DURATION.max} s, clamped to ${d} s`);
            steps.push({ pose: s.pose, duration: d });
          }
        });
      }
      if (problems.length) return errors.push(...problems);
      warnings.push(...localWarnings);
      let id = m.id ?? makeId();
      if (seenIds.has(`move/${id}`)) {
        warnings.push(`${at}.id: "${id}" appears twice, the second one got a new id`);
        id = makeId();
      }
      seenIds.add(`move/${id}`);
      library.moves.push({ id, name, steps });
    });
  }

  return { library, errors, warnings, fatal: false };
}

/** Parse + validate a file's text. `opts.knownPoseIds`: saved poses that exist outside the file (moves may use them). */
export function parseLibrary(text, opts) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { library: emptyLibrary(), errors: [`not valid JSON (${e.message})`], warnings: [], fatal: true };
  }
  return validateLibrary(data, opts);
}

/** Merge validated `incoming` into `lib` (mutates lib). Same id in the same part = replaced; names stay unique. */
export function mergeLibrary(lib, incoming) {
  let added = 0;
  let replaced = 0;
  for (const part of PARTS) {
    for (const p of incoming.positions[part]) {
      const list = lib.positions[part];
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        list[i] = { ...p, name: uniqueName(list.filter((_, k) => k !== i), p.name) };
        replaced++;
      } else {
        list.push({ ...p, name: uniqueName(list, p.name) });
        added++;
      }
    }
  }
  for (const key of ['poses', 'moves']) {
    for (const p of incoming[key]) {
      const list = lib[key];
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        list[i] = { ...p, name: uniqueName(list.filter((_, k) => k !== i), p.name) };
        replaced++;
      } else {
        list.push({ ...p, name: uniqueName(list, p.name) });
        added++;
      }
    }
  }
  return { added, replaced };
}

/** Load the stored library; anything invalid is dropped rather than crashing the app. */
export function loadLibrary(text) {
  if (!text) return emptyLibrary();
  const r = parseLibrary(text);
  return r.fatal ? emptyLibrary() : r.library;
}
