import test from 'node:test';
import assert from 'node:assert/strict';
import { Stickboy } from '../src/skeleton/Stickboy.js';

test('setChannel clamps to joint limits by default', () => {
  const sb = new Stickboy();
  sb.setChannel('elbow_L', 'flex', 170);
  assert.equal(sb.values.get('elbow_L').flex, 150);
  sb.setChannel('elbow_L', 'flex', -40);
  assert.equal(sb.values.get('elbow_L').flex, 0);
});

test('free (unlocked) setChannel allows the full -180..180 and no more', () => {
  const sb = new Stickboy();
  sb.setChannel('elbow_L', 'flex', -170, true);
  assert.equal(sb.values.get('elbow_L').flex, -170);
  sb.setChannel('elbow_L', 'flex', 400, true);
  assert.equal(sb.values.get('elbow_L').flex, 180);
  sb.setChannel('elbow_L', 'flex', -999, true);
  assert.equal(sb.values.get('elbow_L').flex, -180);
});

test('an unlocked value really rotates the joint', () => {
  const sb = new Stickboy();
  sb.setChannel('elbow_L', 'flex', -90, true); // backwards: forearm swings behind
  assert.ok(sb.worldPosition('wrist_L').z < -0.2);
});
