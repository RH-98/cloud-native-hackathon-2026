import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedPicks, latestChanges, replanChoices, watchedSessionIds } from '../public/changes-logic.js';

const rec = (id, start, end) => ({ session: { id: `kubecon-na-2026:${id}`, title: `Talk ${id}`, start, end }, score: 0.8, reasons: [] });

function plan() {
  return {
    conferenceId: 'kubecon-na-2026',
    generatedAt: '2026-11-09T21:00:00.000Z',
    days: [
      {
        date: '2026-11-10',
        slots: [
          {
            start: '2026-11-10T11:30:00-07:00',
            end: '2026-11-10T12:00:00-07:00',
            pick: rec(1, '2026-11-10T11:30:00-07:00', '2026-11-10T12:00:00-07:00'),
            backups: [rec(2, '2026-11-10T11:30:00-07:00', '2026-11-10T12:00:00-07:00'), rec(3, '2026-11-10T11:35:00-07:00', '2026-11-10T12:05:00-07:00')],
          },
          {
            start: '2026-11-10T14:00:00-07:00',
            end: '2026-11-10T14:30:00-07:00',
            pick: rec(4, '2026-11-10T14:00:00-07:00', '2026-11-10T14:30:00-07:00'),
            backups: [],
            pinned: true,
          },
        ],
      },
    ],
  };
}

const change = (id, type, extra = {}) => ({
  id: `kubecon-na-2026:${id}@2026-11-09T21:10:00.000Z`,
  sessionId: `kubecon-na-2026:${id}`,
  sessionTitle: `Talk ${id}`,
  type,
  detectedAt: '2026-11-09T21:10:00.000Z',
  before: { start: '2026-11-10T11:30:00-07:00', end: '2026-11-10T12:00:00-07:00', room: 'A' },
  after: null,
  source: 'simulated',
  ...extra,
});

test('watchedSessionIds lists picks first, then backups, without duplicates', () => {
  assert.deepEqual(watchedSessionIds(plan()), ['1', '4', '2', '3'].map((n) => `kubecon-na-2026:${n}`));
  assert.equal(watchedSessionIds(plan(), 2).length, 2);
});

test('latestChanges keeps the newest change per session and ignores additions', () => {
  const latest = latestChanges([
    change(1, 'room_changed', { detectedAt: '2026-11-09T21:00:00Z' }),
    change(1, 'cancelled', { detectedAt: '2026-11-09T22:00:00Z' }),
    change(9, 'added'),
  ]);
  assert.equal(latest.size, 1);
  assert.equal(latest.get('kubecon-na-2026:1').type, 'cancelled');
});

test('a cancelled pick recommends its first backup', () => {
  const [entry] = affectedPicks(plan(), [change(1, 'cancelled')]);
  assert.equal(entry.date, '2026-11-10');
  assert.equal(entry.index, 0);
  assert.equal(entry.swap.index, 0);
  assert.equal(entry.swap.rec.session.id, 'kubecon-na-2026:2');
  assert.deepEqual(entry.replan, { pin: false });
});

test('a backup that moved or was cancelled itself is not recommended', () => {
  const [entry] = affectedPicks(plan(), [change(1, 'cancelled'), change(2, 'cancelled')]);
  assert.equal(entry.swap.rec.session.id, 'kubecon-na-2026:3');
  const [none] = affectedPicks(plan(), [change(1, 'cancelled'), change(2, 'cancelled'), change(3, 'time_changed')]);
  assert.equal(none.swap, null);
  assert.deepEqual(none.replan, { pin: false });
});

test('a moved pick is pinned at its new time unless that clashes with another pinned session', () => {
  const moved = (start, end) => change(1, 'time_changed', { after: { start, end, room: 'B' } });
  const [free] = affectedPicks(plan(), [moved('2026-11-10T16:00:00-07:00', '2026-11-10T16:30:00-07:00')], { pinned: new Set(['kubecon-na-2026:4']) });
  assert.deepEqual(free.replan, { pin: true });
  const [clash] = affectedPicks(plan(), [moved('2026-11-10T14:10:00-07:00', '2026-11-10T14:40:00-07:00')], { pinned: new Set(['kubecon-na-2026:4']) });
  assert.deepEqual(clash.replan, { pin: false });
  // The other session clashes but isn't pinned: the re-plan can move it.
  const [unpinned] = affectedPicks(plan(), [moved('2026-11-10T14:10:00-07:00', '2026-11-10T14:40:00-07:00')]);
  assert.deepEqual(unpinned.replan, { pin: true });
});

test('room changes inform without an action; dismissed and non-pick changes are left out', () => {
  const [room] = affectedPicks(plan(), [change(4, 'room_changed', { after: { start: null, end: null, room: 'C' } })]);
  assert.equal(room.swap, null);
  assert.equal(room.replan, null);
  assert.deepEqual(affectedPicks(plan(), [change(2, 'cancelled')]), []);
  const c = change(1, 'cancelled');
  assert.deepEqual(affectedPicks(plan(), [c], { dismissed: new Set([c.id]) }), []);
});

test('replanChoices pins or skips the changed session without touching the inputs', () => {
  const pinned = new Set(['kubecon-na-2026:4']);
  const skipped = new Set(['kubecon-na-2026:1']);
  const pin = replanChoices({ change: change(1, 'time_changed'), replan: { pin: true } }, pinned, skipped);
  assert.deepEqual([...pin.pinned].sort(), ['kubecon-na-2026:1', 'kubecon-na-2026:4']);
  assert.deepEqual([...pin.skipped], []);
  const skip = replanChoices({ change: change(1, 'cancelled'), replan: { pin: false } }, pinned, new Set());
  assert.deepEqual([...skip.skipped], ['kubecon-na-2026:1']);
  assert.equal(pinned.size, 1);
  assert.equal(skipped.size, 1);
});
