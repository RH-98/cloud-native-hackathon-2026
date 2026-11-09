// The browser account module's pure helpers: what gets saved and restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshot, canOptInProfile, isOwnGithubProfile, snapshotState } from '../public/account.js';

const sample = () => ({
  request: { conferenceId: 'kubecon-na-2026', github: 'octocat', options: {} },
  profile: { source: 'github', username: 'octocat' },
  plan: { conferenceId: 'kubecon-na-2026', days: [{ date: '2026-11-10', slots: [] }] },
  pinned: new Set(['kubecon-na-2026:1']),
  skipped: new Set(['kubecon-na-2026:2']),
  swaps: new Map([['2026-11-10|x', 'kubecon-na-2026:3']]),
  activeDay: '2026-11-10',
});

test('snapshot round-trips through JSON into a fresh state', () => {
  const snap = JSON.parse(JSON.stringify(snapshotState(sample())));
  const s = { pinned: new Set(), skipped: new Set(), swaps: new Map() };
  assert.equal(applySnapshot(s, snap), true);
  assert.deepEqual([...s.pinned], ['kubecon-na-2026:1']);
  assert.deepEqual([...s.swaps], [['2026-11-10|x', 'kubecon-na-2026:3']]);
  assert.equal(s.plan.days.length, 1);
  assert.equal(s.activeDay, '2026-11-10');
});

test('snapshot without the plan, and nothing to restore', () => {
  assert.equal(snapshotState(sample(), { includePlan: false }).plan, null);
  assert.equal(applySnapshot({}, null), false);
  assert.equal(applySnapshot({}, { pinned: [] }), false);
});

test('only your own GitHub profile counts as yours', () => {
  const user = { login: 'OctoCat' };
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'octocat' }, user), true);
  assert.equal(isOwnGithubProfile({ source: 'github+interests', username: 'octocat' }, user), true);
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'torvalds' }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'github+interests', username: 'torvalds' }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'interests', username: null }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'octocat' }, null), false);
});

test('opt-in is offered for your own GitHub profile or an interests / LinkedIn-pasted one', () => {
  const user = { login: 'OctoCat' };
  assert.equal(canOptInProfile({ source: 'github+interests', username: 'octocat', pastedFrom: 'linkedin' }, user), true);
  assert.equal(canOptInProfile({ source: 'interests', username: null, pastedFrom: 'linkedin' }, user), true);
  assert.equal(canOptInProfile({ source: 'interests', username: null }, user), true);
  assert.equal(canOptInProfile({ source: 'github+interests', username: 'torvalds', pastedFrom: 'linkedin' }, user), false);
  assert.equal(canOptInProfile({ source: 'interests', username: 'torvalds' }, user), false);
  assert.equal(canOptInProfile({ source: 'interests', username: null }, null), false);
});
