import test from 'node:test';
import assert from 'node:assert/strict';
import { Stickboy } from '../src/skeleton/Stickboy.js';
import { POSES, POSE_ORDER, MOVES, MOVE_ORDER } from '../src/poses.js';
import fr from '../src/i18n/fr.js';
import nl from '../src/i18n/nl.js';

const sb = new Stickboy();
const at = (poseKey, node) => {
  const clamped = sb.setPose(POSES[poseKey]);
  assert.deepEqual(clamped, [], `${poseKey} must not be clamped`);
  return sb.worldPosition(node).clone();
};

test('every move is well-formed and only uses existing poses', () => {
  assert.deepEqual([...MOVE_ORDER].sort(), Object.keys(MOVES).sort());
  for (const [key, m] of Object.entries(MOVES)) {
    assert.ok(m.label && POSES[m.from], `${key}: needs a label and a valid 'from' pose`);
    assert.ok(m.steps.length >= 1);
    for (const s of m.steps) {
      assert.ok(POSES[s.pose], `${key}: unknown pose ${s.pose}`);
      assert.ok(s.duration > 0 && s.duration <= 3, `${key}: bad duration ${s.duration}`);
    }
    assert.ok(POSE_ORDER.includes(m.from) && m.steps.every((s) => POSE_ORDER.includes(s.pose)), `${key}: poses should be reachable from the pose bar`);
  }
});

test('roundhouse: starts and ends in the guard, impact is the fastest step', () => {
  const m = MOVES.roundhouse;
  assert.equal(m.from, 'guard');
  assert.equal(m.steps.at(-1).pose, 'guard');
  const impact = m.steps.find((s) => s.pose === 'roundhouse');
  assert.ok(impact.duration === Math.min(...m.steps.map((s) => s.duration)), 'the strike should be the quickest part of the move');
});

test('roundhouse chamber: knee raised to the side at about hip height, foot tucked', () => {
  const knee = at('chamber', 'knee_R');
  const foot = at('chamber', 'toe_tip_R');
  const hip = sb.worldPosition('hip_R');
  assert.ok(knee.y > 0.8 && knee.y < 1.15, `knee height ${knee.y.toFixed(2)} m should be about hip level`);
  assert.ok(knee.x < hip.x - 0.2, `knee should point out to the right side (x ${knee.x.toFixed(2)} vs hip ${hip.x.toFixed(2)})`);
  assert.ok(foot.y < knee.y, 'foot is tucked below the knee');
  assert.ok(Math.abs(foot.x - hip.x) < 0.45, 'foot stays close to the body in the chamber');
});

test('roundhouse impact: leg extended at rib height, well in front, whipped across toward the midline', () => {
  const cham = at('chamber', 'toe_tip_R');
  const foot = at('roundhouse', 'toe_tip_R');
  const hip = sb.worldPosition('hip_R');
  const knee = sb.worldPosition('knee_R');
  const ankle = sb.worldPosition('ankle_R');
  assert.ok(foot.y > 0.95 && foot.y < 1.4, `foot at ${foot.y.toFixed(2)} m should be around rib/chest height`);
  assert.ok(foot.z > 0.8, `foot ${foot.z.toFixed(2)} m in front of the body`);
  assert.ok(foot.x > cham.x + 0.3, `circular path: foot moves from the side toward the midline (${cham.x.toFixed(2)} -> ${foot.x.toFixed(2)})`);
  const a = hip.clone().sub(knee).normalize();
  const b = ankle.clone().sub(knee).normalize();
  const kneeAngle = (Math.acos(a.dot(b)) * 180) / Math.PI;
  assert.ok(kneeAngle > 150, `leg nearly straight at impact, knee angle ${kneeAngle.toFixed(0)} deg`);
});

test('roundhouse: the supporting (left) foot stays planted and the figure keeps its balance throughout', () => {
  const heel0 = at('guard', 'heel_L');
  for (const key of ['chamber', 'roundhouse']) {
    const heel = at(key, 'heel_L');
    const toe = sb.worldPosition('toe_tip_L');
    assert.ok(Math.min(heel.y, toe.y) < 0.02, `${key}: supporting foot on the floor`);
    assert.ok(Math.hypot(heel.x - heel0.x, heel.z - heel0.z) < 0.25, `${key}: supporting foot hasn't skated away from its guard position`);
  }
  const head = at('roundhouse', 'head');
  assert.ok(head.y > 1.3, 'head stays up during the kick');
});

test('roundhouse: right leg is the one that kicks, the left stays low', () => {
  at('roundhouse', 'pelvis');
  assert.ok(sb.worldPosition('toe_tip_R').y > sb.worldPosition('knee_L').y + 0.4);
});

test('the move has French and Dutch names', () => {
  for (const d of [fr, nl]) {
    assert.ok(d.moves.roundhouse);
    for (const k of ['chamber', 'roundhouse']) assert.ok(d.poses[k], `pose label ${k}`);
  }
});
