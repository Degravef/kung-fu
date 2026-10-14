# Kung Fu — 3D stickboy demo

A 3D stickboy in the browser where **every joint of the body and both hands is identifiable**:
hover for its name, click to select it, find it in the joint list, rotate it with sliders.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 400+ checks on the skeleton data, kinematics and poses (no browser needed)
```

## How it's built

| File | Role |
| --- | --- |
| `src/skeleton/jointDefs.js` | **The skeleton as pure data**: 65 named nodes (51 joints + 14 end points: fingertips, toe tips, heels), parent hierarchy, rest offsets, and per-joint rotation *channels* (`flex`, `abd`, `twist`, `spread`…) with axis, sign, limits and a human-readable meaning. Only the left side is written; the right side is mirrored. |
| `src/skeleton/Stickboy.js` | Builds the three.js scene graph from that data (one `Object3D` per joint, nested like the skeleton, a sphere marker + a bone each), applies a pose, keeps the feet on the floor. Runs in Node too. |
| `src/poses.js` | Named poses as plain JSON, plus `lerpPose` for blending A → B. |
| `src/main.js` | Scene, camera, screen-space joint picking, labels, pose animation. |
| `src/ui.js` | Joint tree + search, inspector with sliders, toolbar, pose bar. |

**Conventions** (also in the header of `jointDefs.js`): +Y up, +Z = the way the character faces, +X = its *left*.
Colours: cyan = left, orange = right, white = centre line. A channel value means the same thing on both sides, so `{ shoulder_L: { abd: 90 }, shoulder_R: { abd: 90 } }` raises both arms.

**A pose** is data, not code:

```js
{ label: 'Straight punch', root: { x: 0, z: 0, lift: 0 },
  joints: { shoulder_R: { flex: 98 }, elbow_R: { flex: 4, twist: -90 }, index_mcp_R: { flex: 88 } } }
```

A **move** is a timed path through poses (see `MOVES` in `src/poses.js`); the ▶ button in the pose bar plays it:

```js
roundhouse: { label: 'Roundhouse kick', from: 'guard',
  steps: [{ pose: 'chamber', duration: 0.45 }, { pose: 'roundhouse', duration: 0.22 },
          { pose: 'chamber', duration: 0.3 },  { pose: 'guard', duration: 0.45 }] }
```

Each step blends channel-by-channel from the previous pose (`lerpPose(a, b, t)`). Moving a slider by hand cancels a running move.

## Saved positions (hands, arms, legs, torso)

The **Positions** tab (left panel) saves the current position of one body part and applies it later.
Hands, arms and legs share **one list for both sides**: a position is stored with side-less joint names
(`shoulder`, `index_mcp`) and applied to Left, Right or both — the right side is the exact mirror image,
because a channel value means the same thing on both sides. The torso is on the centre line and has no side.

- **Whole pose** (first button of the tab) saves the entire current pose — every joint plus the root offset — under a name.
  It appears as a dashed **★ button in the pose bar at the bottom** next to the built-in poses, plays with the same smooth blend,
  and is exported/imported with the rest (`"poses": [...]` in the file; unlike part positions it keeps real joint names such as `elbow_R`).
- **Move** (second button) builds a move from an ordered list of poses — built-in or your ★ poses — each with the
  seconds taken to blend into it (the first step blends from wherever the figure is). Reorder, remove, **Preview**, then
  **Save move**: it gets a dashed **▶ button in the bottom bar** after the built-in move. Saved moves can be edited, played
  and deleted from the same tab, and are exported/imported as `"moves": [...]`:

  ```json
  { "id": "user:a1", "name": "Punch combo", "steps": [ { "pose": "guard", "duration": 0.6 }, { "pose": "punch", "duration": 0.2 } ] }
  ```

  `pose` is a built-in pose key or the id of a saved pose. Deleting a pose that a move uses asks first; its step is then skipped.
- Your positions live in the browser (`localStorage`); built-in examples are read-only.
- **Export…** writes `kungfu-positions.json`, **Import…** merges a file back (same `id` = updated, names kept unique).
- Imports are validated: broken positions are skipped with the exact path of the problem
  (`positions.hand[1].joints.elbow: not a joint of the hand (valid: …)`), out-of-range degrees are clamped and reported.

```json
{ "format": "kungfu-positions", "version": 1,
  "positions": {
    "hand": [ { "id": "user:k3x9", "name": "Claw", "joints": { "index_mcp": { "flex": 40, "spread": 5 } } } ],
    "arm": [], "leg": [], "torso": []
  } }
```

Code: `src/positions.js` (pure data + validation, runs in Node), `src/positionsUI.js` (the tab).

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` tests, builds and publishes the site on every push to `main`
(a failing test stops the deployment). One-time setup in the repo: **Settings → Pages → Source: GitHub Actions**.
The site is served from `https://<user>.github.io/<repo>/`; the build uses relative asset paths, so the sub-folder is fine.
To take it down, set Source to "None" (or delete the repo).

## Layout and fullscreen

Nothing is pinned or fixed-size. The side panels are fluid (`clamp()` widths) and **fold** into a slim rail; the
toolbar and the pose bar fold too (the buttons with ‹ › ▾ ▸). Folding is remembered, separately for wide and narrow
screens. Below 900 px everything stacks — 3D view first, then the panels as foldable sections — and starts folded
so the 3D view gets the room; the pose bar becomes a single swipeable row.

The **⛶** button on the 3D view goes full screen (the browser's Fullscreen API, with a full-window fallback where
it is missing, e.g. iPhone). When a move is on screen — a built-in or saved move, or a preview from the builder —
fullscreen shows a big **▶ <move name>** button that replays it; for a plain pose there is none. Esc or **✕** leaves.

Code: `src/layout.js` (folding + fullscreen, DOM-light and tested with jsdom), layout rules at the top and bottom of `src/style.css`.

## Good to know

- Finger joints are tiny, so picking is done in screen space (nearest joint under the cursor, front-most wins) rather than by ray-casting. Use the **Left hand / Right hand** views or double-click a joint to fly to it.
- `shoulder`/`hip` `abd` is capped at 90°: past that the flex·abd·twist Euler order hits a pole (`flex` would stop working). Reach overhead with `flex` (up to 180°).
- `Stickboy.setPose` clamps values to joint limits and returns what it clamped.
- Debug hooks are on `window.kungfu` in the browser console.
