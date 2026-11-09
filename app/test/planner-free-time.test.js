// Free slots (pick: null) carry options: sessions on anyway, meals and
// breaks, booths, and a suggestion line (docs/CONTRACTS.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../planner/plan');
const { buildPlan } = require('../planner');
const { tierRank } = require('../planner/terms');

const DAY = '2026-11-10';
const at = (hhmm) => `${DAY}T${hhmm}:00-07:00`;

function session(id, start, end, extra = {}) {
  return {
    id: `t:${id}`,
    conferenceId: 't',
    title: `Talk ${id}`,
    start: at(start),
    end: at(end),
    room: `Room ${id}`,
    speakers: [],
    track: null,
    level: null,
    tags: [],
    sponsored: false,
    kind: 'session',
    url: 'https://example.test',
    ...extra,
  };
}

const logistics = (id, title, start, end, room = 'Salt Palace | Level 1 | Halls A-C') =>
  session(id, start, end, { kind: 'logistics', title, room });
const rec = (s, score, reasons = []) => ({ session: s, score, reasons });
const sponsor = (id, name, score) => ({
  sponsor: { id: `t:${id}`, conferenceId: 't', name, tier: 'Gold', url: 'https://s.test' },
  score,
  reasons: [`Works with ${name}`],
});

function run(sessions, candidates, options = {}, sponsors = []) {
  const snapshot = {
    conference: { id: 't', name: 'Test', timezone: 'America/Denver', utcOffset: '-07:00', startDate: DAY, endDate: DAY },
    sessions,
    sponsors: sponsors.map((s) => s.sponsor),
  };
  return plan.planDays({ snapshot, candidates, sponsors, options: plan.normalizeOptions(options, snapshot), tierRank });
}

const freeSlots = (day) => day.slots.filter((s) => !s.pick);

test('free slot: sessions on during the window become ranked options, even below the pick floor', () => {
  const sessions = [
    session('a', '09:00', '12:00'),
    session('b', '12:30', '13:00'), // starts and ends in the window
    session('c', '12:00', '13:30'), // starts in the window, runs past it
    session('d', '11:00', '12:10'), // already running, only 10 min left in the window: no option
    session('e', '12:15', '12:45', { sponsored: true, track: 'Sponsor Demo Theater' }),
    session('f', '13:00', '18:00'),
    session('g', '12:20', '12:50'), // skipped
  ];
  const candidates = [rec(sessions[0], 0.9), rec(sessions[1], 0.1, ['Matches helm']), rec(sessions[5], 0.9)];
  const [day] = run(sessions, candidates, { skipped: ['t:g'] });
  const [free] = freeSlots(day);
  assert.deepEqual([free.start, free.end], [at('12:00'), at('13:00')]);
  assert.deepEqual(free.backups.map((b) => b.session.id), ['t:b', 't:c']); // no demo, no skipped, no stub
  assert.deepEqual(free.backups[0].reasons, ['Fits this window', 'Matches helm']);
  assert.deepEqual(free.backups[1].reasons, ['Starts in this window']);
  assert.equal(free.backups[1].score, 0);
  assert.equal(free.pinned, false);
});

test('free slot: sponsored demos are offered only when nothing else is on', () => {
  const sessions = [
    session('a', '09:00', '12:00'),
    session('demo', '12:15', '12:45', { sponsored: true, track: 'Sponsor Demo Theater' }),
    session('f', '13:00', '18:00'),
  ];
  const [day] = run(sessions, [rec(sessions[0], 0.9), rec(sessions[2], 0.9)]);
  assert.deepEqual(freeSlots(day)[0].backups.map((b) => b.session.id), ['t:demo']);
});

test('free slot: meals and breaks in the window, all-day services left out, and a suggestion', () => {
  const sessions = [
    session('a', '09:00', '12:30'),
    session('f', '14:00', '18:00'),
    logistics('lunch', '🍲 Lunch', '12:20', '14:20'),
    logistics('coat', 'Coat + Bag Check', '07:30', '20:00', 'East Registration'),
    logistics('later', 'HAPPY HOUR', '17:00', '18:15'),
  ];
  const [day] = run(sessions, [rec(sessions[0], 0.9), rec(sessions[1], 0.9)]);
  const [free] = freeSlots(day);
  assert.deepEqual(free.logistics, [
    { title: 'Lunch', type: 'meal', start: at('12:20'), end: at('14:20'), room: 'Salt Palace | Level 1 | Halls A-C' },
  ]);
  assert.equal(free.suggestion, 'Lunch is served 12:20–2:20 PM MT in Halls A-C.');
});

test('free slot: booths in long and 15-30 minute gaps on expo days, a walk for short ones', () => {
  const sessions = [
    session('k', '08:00', '09:00', { track: 'Keynote Sessions' }), // makes this an expo day
    session('a', '09:00', '10:00'),
    session('b', '10:20', '11:00'), // 20 min gap before
    session('c', '11:12', '12:00'), // 12 min gap before
    session('d', '13:00', '18:00'), // 60 min gap before
  ];
  const sponsors = [sponsor('x', 'Akuity', 0.6), sponsor('y', 'Dash0', 0.5), sponsor('z', 'Elastic', 0.4), sponsor('w', 'Grafana', 0.3), sponsor('v', 'Honeycomb', 0.2), sponsor('u', 'Kong', 0.1)];
  const candidates = sessions.slice(1).map((s) => rec(s, 0.9));
  const [day] = run(sessions, candidates, {}, sponsors);
  const free = freeSlots(day);
  assert.deepEqual(free.map((s) => [s.start, s.end]), [
    [at('10:00'), at('10:20')],
    [at('11:00'), at('11:12')],
    [at('12:00'), at('13:00')],
  ]);
  const [twenty, twelve, hour] = free;
  assert.deepEqual(hour.booths.map((b) => b.sponsor.name), ['Akuity', 'Dash0']);
  assert.equal(hour.suggestion, 'Time for 2 booth visits.');
  assert.equal(twenty.booths.length, 1);
  assert.ok(!['Akuity', 'Dash0'].includes(twenty.booths[0].sponsor.name), 'not a booth already suggested today');
  assert.equal(twenty.suggestion, 'Time for a booth visit.');
  assert.deepEqual(twelve.booths, []);
  assert.deepEqual(twelve.backups, []);
  assert.equal(twelve.suggestion, 'Short break: walk to your next room.');
  // The day's booth list has them all: the long gap's two and the short gap's one.
  assert.deepEqual(day.booths.filter((b) => b.gap).map((b) => [b.sponsor.name, b.gap.start]), [
    ['Akuity', at('12:00')],
    ['Dash0', at('12:00')],
    [twenty.booths[0].sponsor.name, at('10:00')],
  ]);
});

test('free slot: no booths and no sad dead end on a day without an expo', () => {
  const sessions = [
    session('a', '09:00', '10:00'),
    session('b', '12:00', '18:00'),
    session('elsewhere', '08:00', '09:00', { title: 'Workshop', track: 'Keynote' }),
  ];
  // Keynotes on another day only: this day has no expo.
  sessions[2].start = '2026-11-11T08:00:00-07:00';
  sessions[2].end = '2026-11-11T09:00:00-07:00';
  const snapshot = {
    conference: { id: 't', name: 'Test', timezone: 'America/Denver', utcOffset: '-07:00', startDate: DAY, endDate: '2026-11-11' },
    sessions,
    sponsors: [],
  };
  const options = plan.normalizeOptions({ days: [DAY] }, snapshot);
  const [day] = plan.planDays({ snapshot, candidates: [rec(sessions[0], 0.9), rec(sessions[1], 0.9)], sponsors: [sponsor('x', 'Akuity', 0.6)], options, tierRank });
  const [free] = freeSlots(day);
  assert.deepEqual(free.booths, []);
  assert.deepEqual(free.logistics, []);
  assert.equal(free.suggestion, 'Rest, refill your water, or wander the hallway track.');
});

const profile = {
  source: 'interests',
  tools: [{ name: 'kubernetes', weight: 1, evidence: [] }],
  topics: [],
  keywords: ['observability'],
  languages: [],
};

for (const conferenceId of ['kubecon-na-2026', 'convergence-2026']) {
  test(`buildPlan (${conferenceId}): every free slot has options and a suggestion`, async () => {
    const result = await buildPlan({ conferenceId, profile }, { env: {} });
    let free = 0;
    for (const day of result.days) {
      for (const slot of day.slots) {
        if (slot.pick) continue;
        free += 1;
        assert.equal(typeof slot.suggestion, 'string');
        assert.ok(slot.suggestion.length > 0);
        assert.ok(Array.isArray(slot.backups) && slot.backups.length <= 3);
        assert.ok(Array.isArray(slot.booths) && Array.isArray(slot.logistics));
        for (const b of slot.backups) {
          assert.ok(Date.parse(b.session.start) < Date.parse(slot.end) && Date.parse(b.session.end) > Date.parse(slot.start));
          assert.equal(b.session.kind, 'session');
        }
        for (const l of slot.logistics) {
          assert.ok(l.title && l.start && l.end);
          assert.ok(!/coat|badge/i.test(l.title), 'all-day services are not options');
        }
      }
    }
    assert.ok(free > 0, 'the plan has some free time');
  });
}
