# Kung Fu — 3D stickboy demo

A 3D stickboy in the browser where **every joint of the body and both hands is identifiable**:
hover for its name, click to select it, find it in the joint list, rotate it with sliders.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 381 checks on the skeleton data, kinematics and poses (no browser needed)
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

A *move* is a transition between two such poses (`lerpPose(a, b, t)`) — that's what the pose buttons animate.

## Good to know

- Finger joints are tiny, so picking is done in screen space (nearest joint under the cursor, front-most wins) rather than by ray-casting. Use the **Left hand / Right hand** views or double-click a joint to fly to it.
- `shoulder`/`hip` `abd` is capped at 90°: past that the flex·abd·twist Euler order hits a pole (`flex` would stop working). Reach overhead with `flex` (up to 180°).
- `Stickboy.setPose` clamps values to joint limits and returns what it clamped.
- Debug hooks are on `window.kungfu` in the browser console.
