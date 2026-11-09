// The account page's pure helpers: relative times, plan summaries and links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { conferenceMeta, formatDate, openPlanHref, pickLabel, relativeTime, splitConferences } from '../public/account-page.js';

const NOW = Date.parse('2026-11-09T22:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('relativeTime reads naturally', () => {
  assert.equal(relativeTime(ago(10 * 1000), NOW), 'just now');
  assert.equal(relativeTime(ago(-60 * 1000), NOW), 'just now'); // clock skew
  assert.equal(relativeTime(ago(5 * 60 * 1000), NOW), '5 min ago');
  assert.equal(relativeTime(ago(60 * 60 * 1000), NOW), '1 hour ago');
  assert.equal(relativeTime(ago(3 * 60 * 60 * 1000), NOW), '3 hours ago');
  assert.equal(relativeTime(ago(26 * 60 * 60 * 1000), NOW), 'yesterday');
  assert.equal(relativeTime(ago(3 * 24 * 60 * 60 * 1000), NOW), '3 days ago');
  assert.equal(relativeTime('2026-10-01T12:00:00Z', NOW), 'on Oct 1, 2026');
  assert.equal(relativeTime('nonsense', NOW), '');
  assert.equal(formatDate('2026-11-09T15:00:00Z'), 'Nov 9, 2026');
});

test('pickLabel handles unknown, zero, one and many', () => {
  assert.equal(pickLabel(null), 'Plan saved');
  assert.equal(pickLabel(0), 'No sessions picked yet');
  assert.equal(pickLabel(1), '1 session picked');
  assert.equal(pickLabel(12), '12 sessions picked');
});

test('splitConferences keeps the API order, dedupes and lists the rest', () => {
  const conferences = [
    { id: 'kubecon-na-2026', name: 'KubeCon NA 2026', startDate: '2026-11-09', endDate: '2026-11-12', location: 'Salt Palace Convention Center, Salt Lake City, Utah' },
    { id: 'convergence-2026', name: 'Convergence 2026' },
  ];
  const plans = [
    { conferenceId: 'kubecon-na-2026', savedAt: 'b', pickCount: 3 },
    { conferenceId: 'kubecon-na-2026', savedAt: 'a', pickCount: 1 },
    { conferenceId: 'old-conf', savedAt: 'c', pickCount: null },
  ];
  const { withPlans, without } = splitConferences(conferences, plans);
  assert.deepEqual(withPlans.map((x) => x.conference.name), ['KubeCon NA 2026', 'old-conf']);
  assert.equal(withPlans[0].plan.savedAt, 'b');
  assert.deepEqual(without.map((c) => c.id), ['convergence-2026']);
  assert.equal(conferenceMeta(conferences[0]), 'Nov 9–12, 2026 · Salt Lake City, Utah');
  assert.equal(conferenceMeta({}), '');
  assert.deepEqual(splitConferences(null, null), { withPlans: [], without: [] });
});

test('Open plan links go to the planner with the conference', () => {
  assert.equal(openPlanHref('convergence-2026'), '/?conference=convergence-2026');
  assert.equal(openPlanHref('a&b'), '/?conference=a%26b');
});
