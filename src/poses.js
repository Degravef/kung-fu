/**
 * Named poses — plain data, the same shape an LLM will later be asked to produce:
 *
 *   { label, root?: { x, z, lift }, joints: { <joint>: { <channel>: degrees } } }
 *
 * Anything not mentioned stays at rest (0). A "move" is just a transition
 * between two of these (see lerpPose + the animation in main.js).
 */

const FINGERS = ['index', 'middle', 'ring', 'pinky'];

/** Finger shapes, expressed once and applied to either hand. */
const HAND_SHAPES = {
  relaxed: { mcp: 14, pip: 22, dip: 10, thumb: { cmc: { flex: 4 }, mcp: { flex: 10 }, ip: { flex: 10 } } },
  fist: {
    mcp: 88,
    pip: 100,
    dip: 60,
    thumb: { cmc: { spread: -20, flex: 20 }, mcp: { flex: 35 }, ip: { flex: 80 } },
  },
  open: {
    mcp: 0,
    pip: 0,
    dip: 0,
    spread: { index: 12, middle: 0, ring: 10, pinky: 20 },
    thumb: { cmc: { spread: 45 }, mcp: { flex: 0 }, ip: { flex: 0 } },
  },
  knife: {
    mcp: 0,
    pip: 0,
    dip: 0,
    spread: { index: -3, middle: 0, ring: -3, pinky: -3 },
    thumb: { cmc: { spread: -20, flex: 0 }, mcp: { flex: 20 }, ip: { flex: 10 } },
  },
};

function hand(side, shape) {
  const s = HAND_SHAPES[shape];
  const j = {};
  for (const f of FINGERS) {
    j[`${f}_mcp_${side}`] = { flex: s.mcp, spread: s.spread?.[f] ?? 0 };
    j[`${f}_pip_${side}`] = { flex: s.pip };
    j[`${f}_dip_${side}`] = { flex: s.dip };
  }
  j[`thumb_cmc_${side}`] = s.thumb.cmc;
  j[`thumb_mcp_${side}`] = s.thumb.mcp;
  j[`thumb_ip_${side}`] = s.thumb.ip;
  return j;
}

const pose = (label, joints, root = {}) => ({ label, root, joints });

/* --------------------------------------------------------------- the poses */

// Left foot forward, flat; right foot back with the heel lifted. Angles found by
// searching for both toes touching the floor (auto-ground then lowers the pelvis).
const guardLegs = {
  hip_L: { flex: 35, abd: 8 },
  knee_L: { flex: 45 },
  ankle_L: { flex: -10 },
  hip_R: { flex: -30, abd: 8 },
  knee_R: { flex: 6 },
  ankle_R: { flex: -20 },
};

const guardArms = {
  shoulder_L: { flex: 50, abd: -8 },
  elbow_L: { flex: 115 },
  shoulder_R: { flex: 40, abd: -14 },
  elbow_R: { flex: 125 },
};

export const POSES = {
  attention: pose('Attention', {
    shoulder_L: { abd: 4 },
    shoulder_R: { abd: 4 },
    ...hand('L', 'relaxed'),
    ...hand('R', 'relaxed'),
  }),

  guard: pose('Ready stance', {
    spine: { flex: 5, twist: -8 },
    chest: { flex: 6, twist: -10 },
    neck: { flex: -6, twist: 9 },
    head: { flex: -6, twist: 9 },
    ...guardLegs,
    ...guardArms,
    ...hand('L', 'fist'),
    ...hand('R', 'fist'),
  }),

  punch: pose('Straight punch', {
    spine: { flex: 5, twist: 8 },
    chest: { flex: 6, twist: 10 },
    neck: { flex: -6, twist: -9 },
    head: { flex: -6, twist: -9 },
    ...guardLegs,
    shoulder_R: { flex: 98, abd: -4 },
    elbow_R: { flex: 4, twist: -90 },
    shoulder_L: { flex: 50, abd: -8, twist: -30 },
    elbow_L: { flex: 125 },
    ...hand('L', 'fist'),
    ...hand('R', 'fist'),
  }),

  kick: pose('Front kick', {
    spine: { flex: -10 },
    chest: { flex: -6 },
    neck: { flex: 8 },
    head: { flex: 8 },
    hip_R: { flex: 88, abd: 3 },
    knee_R: { flex: 8 },
    ankle_R: { flex: -25 },
    hip_L: { flex: 0, abd: -6 }, // supporting leg angles inward so the foot sits under the body
    knee_L: { flex: 12 },
    ankle_L: { flex: -12 },
    ...guardArms,
    shoulder_R: { flex: 55, abd: -10 },
    elbow_R: { flex: 110 },
    ...hand('L', 'fist'),
    ...hand('R', 'fist'),
  }),

  knife: pose('Knife-hand block', {
    spine: { flex: 4, twist: -10 },
    chest: { flex: 4, twist: -12 },
    neck: { flex: -4, twist: 11 },
    head: { flex: -4, twist: 11 },
    ...guardLegs,
    shoulder_L: { flex: 62, abd: 22 },
    elbow_L: { flex: 95, twist: -35 },
    wrist_L: { dev: 10 },
    shoulder_R: { flex: 30, abd: -22 },
    elbow_R: { flex: 105, twist: -70 },
    ...hand('L', 'knife'),
    ...hand('R', 'knife'),
  }),

  open: pose('Open hands (T-pose)', {
    shoulder_L: { abd: 90 },
    shoulder_R: { abd: 90 },
    elbow_L: { twist: 90 },
    elbow_R: { twist: 90 },
    ...hand('L', 'open'),
    ...hand('R', 'open'),
  }),
};

export const POSE_ORDER = ['attention', 'guard', 'punch', 'kick', 'knife', 'open'];

/* ---------------------------------------------------------------- blending */

const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Channel-wise blend of two poses (t = 0 → a, t = 1 → b). Missing channels count as 0. */
export function lerpPose(a, b, t) {
  const root = {};
  for (const k of ['x', 'z', 'lift']) root[k] = lerp(a.root?.[k] ?? 0, b.root?.[k] ?? 0, t);

  const joints = {};
  const names = new Set([...Object.keys(a.joints ?? {}), ...Object.keys(b.joints ?? {})]);
  for (const n of names) {
    const ja = a.joints?.[n] ?? {};
    const jb = b.joints?.[n] ?? {};
    joints[n] = {};
    for (const c of new Set([...Object.keys(ja), ...Object.keys(jb)])) joints[n][c] = lerp(ja[c] ?? 0, jb[c] ?? 0, t);
  }
  return { root, joints };
}
