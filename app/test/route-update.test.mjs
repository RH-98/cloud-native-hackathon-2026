// "Update my route": pins and skips of the route on screen carry over; swaps
// and another conference's choices don't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRouteUpdate, keepForUpdate, planRequest } from '../public/state.js';

const s = () => ({
  plan: { conferenceId: 'kubecon-na-2026', days: [] },
  pinned: new Set(['kubecon-na-2026:1', 'convergence-2026:9']),
  skipped: new Set(['kubecon-na-2026:2']),
  swaps: new Map([['2026-11-10|x', 'kubecon-na-2026:3']]),
});

test('update only when a route for the selected conference is on screen', () => {
  assert.equal(isRouteUpdate(s(), 'kubecon-na-2026'), true);
  assert.equal(isRouteUpdate(s(), 'convergence-2026'), false);
  assert.equal(isRouteUpdate({ ...s(), plan: null }, 'kubecon-na-2026'), false);
});

test('pins and skips of this conference are sent with the update', () => {
  const state = s();
  const keep = keepForUpdate(state, 'kubecon-na-2026');
  assert.deepEqual([...keep.pinned], ['kubecon-na-2026:1']);
  assert.deepEqual([...keep.skipped], ['kubecon-na-2026:2']);
  assert.equal(state.pinned.size, 2); // input unchanged
  const body = planRequest({ conferenceId: 'kubecon-na-2026', github: 'octocat', options: { firstTimer: true } }, keep.pinned, keep.skipped);
  assert.deepEqual(body.options, { firstTimer: true, pinned: ['kubecon-na-2026:1'], skipped: ['kubecon-na-2026:2'] });
});
