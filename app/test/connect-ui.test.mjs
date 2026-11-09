// The Connect controls' pure helpers: which state a card shows, and the badge text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, connectView } from '../public/connect.js';

const demo = { attendee: { handle: 'demo-a', demo: true } };
const real = { attendee: { handle: 'hubot', demo: false, userId: '7' } };

test('nothing when accounts are off; sign-in prompt when signed out', () => {
  assert.equal(connectView(demo, { enabled: false, signedIn: false }), null);
  assert.equal(connectView(demo, undefined), null);
  assert.deepEqual(connectView(real, { enabled: true, signedIn: false }), { kind: 'signin' });
});

test('signed in: the request state, defaulting to none', () => {
  const on = { enabled: true, signedIn: true };
  assert.deepEqual(connectView(demo, on), { kind: 'none', requestId: null, demo: true });
  assert.deepEqual(connectView({ ...real, requestState: 'incoming', requestId: '3' }, on), { kind: 'incoming', requestId: '3', demo: false });
  assert.equal(connectView({ ...real, requestState: 'connected', requestId: '3' }, on).kind, 'connected');
  assert.equal(connectView({ ...real, requestState: 'bogus' }, on).kind, 'none');
  // A real attendee without an account id can't be asked.
  assert.equal(connectView({ attendee: { handle: 'x', demo: false } }, on), null);
});

test('badge text: hidden at zero, spoken in full, capped visually', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(undefined), null);
  assert.deepEqual(badgeText(1), { visible: '1', spoken: '1 connection request' });
  assert.deepEqual(badgeText(2), { visible: '2', spoken: '2 connection requests' });
  assert.equal(badgeText(12).visible, '9+');
});
