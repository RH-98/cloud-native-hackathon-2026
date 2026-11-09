const test = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../planner/plan');
const { buildPlan } = require('../planner');
const { tierRank } = require('../planner/terms');

const DAY = '2026-11-10';
const at = (hhmm, date = DAY) => `${date}T${hhmm}:00-07:00`;

function session(id, start, end, extra = {}) {
  return {
    id: `t:${id}`,
    conferenceId: 't',
    sourceId: id,
    title: `Talk ${id}`,
    description: '',
    start: at(start),
    end: at(end),
    room: 'Room',
    speakers: [],
    track: null,
    level: null,
    tags: [],
    sponsored: false,
    kind: 'session',
    slidesAvailable: false,
    url: 'https://example.test',
    ...extra,
  };
}

const rec = (s, score, reasons = []) => ({ session: s, score, reasons });

function snapshotOf(sessions, sponsors = []) {
  return {
    conference: {
      id: 't',
      name: 'Test',
      location: 'Here',
      timezone: 'America/Denver',
      utcOffset: '-07:00',
      startDate: DAY,
      endDate: DAY,
    },
    sessions,
    sponsors,
  };
}

function run(sessions, candidates, options = {}, sponsors = []) {
  const snapshot = snapshotOf(sessions, sponsors.map((s) => s.sponsor));
  return plan.planDays({
    snapshot,
    candidates,
    sponsors,
    options: plan.normalizeOptions(options, snapshot),
    tierRank,
  });
}

const picks = (day) => day.slots.filter((s) => s.pick).map((s) => s.pick.session.id);

test('bestSchedule: two good talks beat one, but one strong talk beats two weak ones', () => {
  const a = rec(session('a', '09:00', '10:00'), 0.7);
  const b = rec(session('b', '09:30', '10:30'), 0.8);
  const c = rec(session('c', '10:00', '11:00'), 0.7);
  assert.deepEqual(plan.bestSchedule([b, c, a]).map((r) => r.session.id), ['t:a', 't:c']);
  const weakA = { ...a, score: 0.5 };
  const weakC = { ...c, score: 0.5 };
  const strongB = { ...b, score: 0.9 };
  assert.deepEqual(plan.bestSchedule([weakA, strongB, weakC]).map((r) => r.session.id), ['t:b']);
});

test('bestSchedule: a strong 30-minute talk beats a string of short weak ones in its slot', () => {
  const strong = rec(session('strong', '14:50', '15:20'), 0.8);
  const shorts = ['14:50', '15:00', '15:10'].map((t, i) =>
    rec(session(`short${i}`, t, `${t.slice(0, 3)}${String(Number(t.slice(3)) + 8).padStart(2, '0')}`), 0.45),
  );
  assert.deepEqual(plan.bestSchedule([...shorts, strong]).map((r) => r.session.id), ['t:strong']);
});

test('planDays: picks must reach half of the day\'s best score; weaker matches leave the time free', () => {
  const sessions = [session('best', '09:00', '10:00'), session('meh', '11:00', '12:00'), session('alt', '11:15', '11:45')];
  const [day] = run(sessions, [rec(sessions[0], 0.9), rec(sessions[1], 0.4), rec(sessions[2], 0.3)]);
  assert.deepEqual(picks(day), ['t:best']);
});

test('bestSchedule honors a minimum gap between picks', () => {
  const a = rec(session('a', '09:00', '10:00'), 0.5);
  const c = rec(session('c', '10:00', '11:00'), 0.6);
  assert.equal(plan.bestSchedule([a, c], 0).length, 2);
  assert.deepEqual(plan.bestSchedule([a, c], 15 * 60_000).map((r) => r.session.id), ['t:c']);
});

test('planDays: picks never overlap, backups overlap their pick and are not picked elsewhere', () => {
  const sessions = [
    session('a', '09:00', '10:00'),
    session('b', '09:00', '10:00'),
    session('c', '09:15', '09:45'),
    session('d', '09:30', '10:00'),
    session('e', '10:00', '11:00'),
  ];
  const [day] = run(sessions, [
    rec(sessions[0], 0.9),
    rec(sessions[1], 0.7),
    rec(sessions[2], 0.6),
    rec(sessions[3], 0.5),
    rec(sessions[4], 0.8),
  ]);
  assert.deepEqual(picks(day), ['t:a', 't:e']);
  const first = day.slots.find((s) => s.pick && s.pick.session.id === 't:a');
  assert.deepEqual(first.backups.map((b) => b.session.id), ['t:b', 't:c']);
  for (const b of first.backups) assert.ok(plan.conflicts(b.session, first.pick.session));
  assert.equal(first.start, at('09:00'));
  assert.equal(first.pinned, false);
});

test('planDays: pinned sessions are forced and conflicting candidates dropped; skipped never appear', () => {
  const sessions = [
    session('a', '09:00', '10:00'),
    session('b', '09:30', '10:30'),
    session('c', '10:30', '11:30'),
  ];
  const candidates = [rec(sessions[0], 0.9, ['Matches x']), rec(sessions[1], 0.3), rec(sessions[2], 0.8)];
  const [day] = run(sessions, candidates, { pinned: ['t:b'], skipped: ['t:c'] });
  assert.deepEqual(picks(day), ['t:b']);
  const slot = day.slots.find((s) => s.pick);
  assert.equal(slot.pinned, true);
  assert.equal(slot.pick.reasons[0], 'Pinned by you');
  const all = day.slots.flatMap((s) => [s.pick, ...s.backups]).filter(Boolean).map((r) => r.session.id);
  assert.ok(!all.includes('t:c'));
});

test('planDays: a pinned session not among the candidates still gets its slot', () => {
  const sessions = [session('a', '09:00', '10:00'), session('z', '13:00', '14:00')];
  const [day] = run(sessions, [rec(sessions[0], 0.9)], { pinned: ['t:z'] });
  assert.deepEqual(picks(day), ['t:a', 't:z']);
});

test('planDays: breakMinutes leaves time between picks', () => {
  const sessions = [session('a', '09:00', '10:00'), session('b', '10:00', '11:00'), session('c', '10:15', '11:15')];
  const candidates = [rec(sessions[0], 0.9), rec(sessions[1], 0.9), rec(sessions[2], 0.5)];
  assert.deepEqual(picks(run(sessions, candidates)[0]), ['t:a', 't:b']);
  assert.deepEqual(picks(run(sessions, candidates, { breakMinutes: 15 })[0]), ['t:a', 't:c']);
});

test('planDays: low scores stay free time, and free gaps become slots with booths', () => {
  const sessions = [session('a', '09:00', '10:00'), session('b', '11:00', '12:00'), session('k', '08:00', '08:30', { track: 'Keynote Sessions' })];
  const sponsors = [
    { sponsor: { id: 't:akuity', conferenceId: 't', name: 'Akuity', tier: 'Gold', url: 'https://a.test' }, score: 0.6, reasons: ['Works with Argo CD'] },
    { sponsor: { id: 't:dash0', conferenceId: 't', name: 'Dash0', tier: 'Silver', url: 'https://d.test' }, score: 0.5, reasons: ['Works with OpenTelemetry'] },
    { sponsor: { id: 't:elastic', conferenceId: 't', name: 'Elastic', tier: 'Gold', url: 'https://e.test' }, score: 0.4, reasons: ['Makes Elasticsearch'] },
  ];
  const [day] = run(sessions, [rec(sessions[0], 0.9), rec(sessions[1], 0.05)], {}, sponsors);
  assert.deepEqual(picks(day), ['t:k', 't:a']); // the keynote fills its slot before the day's 9:00 window
  const free = day.slots.filter((s) => !s.pick);
  assert.deepEqual(free.map((s) => [s.start, s.end]), [[at('10:00'), at('18:00')]]);
  assert.deepEqual(free[0].backups, []);
  const withGap = day.booths.filter((b) => b.gap);
  assert.equal(withGap.length, 2);
  assert.deepEqual(withGap[0].gap, { start: at('10:00'), end: at('18:00') });
  assert.equal(withGap[0].sponsor.name, 'Akuity');
  assert.ok(day.booths.some((b) => b.gap === null && b.sponsor.name === 'Elastic'));
});

test('freeGaps only counts gaps of 30 minutes or more between 9:00 and 18:00', () => {
  const gaps = plan.freeGaps(DAY, [session('a', '08:00', '09:20'), session('b', '09:40', '17:40'), session('c', '17:50', '19:00')], '-07:00');
  assert.deepEqual(gaps, []);
  const gaps2 = plan.freeGaps(DAY, [session('a', '10:00', '11:00')], '-07:00');
  assert.deepEqual(gaps2, [
    { start: at('09:00'), end: at('10:00') },
    { start: at('11:00'), end: at('18:00') },
  ]);
});

test('planDays: levels and includeSponsored filter candidates, Any Level and unset always allowed', () => {
  const sessions = [
    session('adv', '09:00', '10:00', { level: 'Advanced' }),
    session('any', '10:00', '11:00', { level: 'Any Level' }),
    session('none', '11:00', '12:00'),
    session('spon', '12:00', '13:00', { sponsored: true }),
  ];
  const candidates = sessions.map((s) => rec(s, 0.8));
  assert.deepEqual(picks(run(sessions, candidates, { levels: ['Beginner'], includeSponsored: false })[0]), ['t:any', 't:none']);
});

test('planDays: firstTimer lifts beginner sessions over advanced ones', () => {
  const sessions = [
    session('adv', '09:00', '10:00', { level: 'Advanced', title: 'Deep internals' }),
    session('intro', '09:00', '10:00', { title: 'Introduction to GitOps' }),
  ];
  const candidates = [rec(sessions[0], 0.6), rec(sessions[1], 0.5)];
  assert.deepEqual(picks(run(sessions, candidates)[0]), ['t:adv']);
  const [day] = run(sessions, candidates, { firstTimer: true });
  assert.deepEqual(picks(day), ['t:intro']);
  assert.ok(day.slots.find((s) => s.pick).pick.reasons.includes('Beginner friendly'));
});

test('normalizeOptions validates and fills defaults', () => {
  const snapshot = snapshotOf([session('a', '09:00', '10:00')]);
  const opts = plan.normalizeOptions(undefined, snapshot);
  assert.deepEqual(opts.days, [DAY]);
  assert.equal(opts.includeSponsored, true);
  assert.equal(opts.breakMinutes, 0);
  for (const bad of [
    { days: ['2030-01-01'] },
    { days: 'x' },
    { levels: ['Wizard'] },
    { breakMinutes: -5 },
    { breakMinutes: '10' },
    { firstTimer: 'yes' },
    { pinned: [1] },
    [],
  ]) {
    assert.throws(() => plan.normalizeOptions(bad, snapshot), (err) => err.code === 'invalid_input', JSON.stringify(bad));
  }
});

const profile = {
  source: 'interests',
  tools: [
    { name: 'argo-cd', label: 'Argo CD', weight: 0.9, evidence: [] },
    { name: 'opentelemetry', weight: 0.7, evidence: [] },
  ],
  topics: ['gitops'],
  keywords: ['progressive delivery'],
  languages: [{ name: 'Go', weight: 0.6 }],
};

test('buildPlan without Elasticsearch credentials plans from the snapshot', async () => {
  const result = await buildPlan({ conferenceId: 'kubecon-na-2026', profile, options: { days: ['2026-11-10'] } }, { env: {} });
  assert.equal(result.searchBackend, 'snapshot');
  assert.equal(result.conference.utcOffset, '-07:00');
  assert.equal(result.days.length, 1);
  const [day] = result.days;
  assert.equal(day.date, '2026-11-10');
  const chosen = day.slots.filter((s) => s.pick);
  assert.ok(chosen.length > 0);
  for (let i = 1; i < chosen.length; i += 1) {
    assert.ok(Date.parse(chosen[i].start) >= Date.parse(chosen[i - 1].end), 'picks do not overlap');
  }
  for (const slot of day.slots) assert.match(slot.start, /^2026-11-10T\d\d:\d\d:00-07:00$/);
  assert.ok(day.booths.some((b) => b.sponsor.name === 'Akuity'));
});

test('buildPlan errors: unknown conference is not_found, bad options are invalid_input', async () => {
  await assert.rejects(buildPlan({ conferenceId: 'nope', profile }, { env: {} }), (err) => err.code === 'not_found');
  await assert.rejects(buildPlan({ conferenceId: '../etc', profile }, { env: {} }), (err) => err.code === 'not_found');
  await assert.rejects(
    buildPlan({ conferenceId: 'kubecon-na-2026', profile, options: { breakMinutes: 'x' } }, { env: {} }),
    (err) => err.code === 'invalid_input',
  );
});

test('buildPlan uses Elasticsearch when a client is available, and falls back to the snapshot when it fails', async () => {
  const snapshotSession = require('../data/conferences/kubecon-na-2026.json').sessions.find(
    (s) => s.kind === 'session' && /Argo CD/.test(s.title),
  );
  const ok = {
    async search(req) {
      if (req.index === 'conference-sponsors') return { hits: { hits: [] } };
      return { hits: { hits: [{ _id: snapshotSession.id, _score: 2 / 61, _source: { ...snapshotSession } }] } };
    },
  };
  const day = snapshotSession.start.slice(0, 10);
  const live = await buildPlan({ conferenceId: 'kubecon-na-2026', profile, options: { days: [day] } }, { client: ok });
  assert.equal(live.searchBackend, 'elasticsearch');
  const slot = live.days[0].slots.find((s) => s.pick && s.pick.session.id === snapshotSession.id);
  assert.ok(slot, 'the Elasticsearch hit is picked');
  const { pick } = slot;
  assert.ok(pick.reasons.includes('Matches Argo CD'));

  const broken = {
    async search() {
      const err = new Error('connect ECONNREFUSED');
      err.name = 'ConnectionError';
      throw err;
    },
  };
  const fallback = await buildPlan({ conferenceId: 'kubecon-na-2026', profile, options: { days: ['2026-11-10'] } }, { client: broken });
  assert.equal(fallback.searchBackend, 'snapshot');
  assert.ok(fallback.days[0].slots.some((s) => s.pick));
});

test('planDays: keynotes fill otherwise free time with reason "Keynote", but never displace a real match', () => {
  const sessions = [
    session('k1', '09:00', '09:30', { track: 'Keynote Sessions' }),
    session('k2', '09:30', '09:40', { track: 'Keynote Sessions' }),
    session('k3', '09:40', '09:50', { tags: ['Keynote Sessions'] }),
    session('m', '09:35', '10:30'),
    session('x', '11:00', '12:00'),
  ];
  // k1 isn't a search result at all; k2 scored 0; m is a real match overlapping k2 and k3.
  const candidates = [rec(sessions[1], 0), rec(sessions[3], 0.21), rec(sessions[4], 0.05)];
  const [day] = run(sessions, candidates);
  assert.deepEqual(picks(day), ['t:k1', 't:m']);
  const k1 = day.slots.find((s) => s.pick && s.pick.session.id === 't:k1').pick;
  assert.equal(k1.score, plan.KEYNOTE_SCORE);
  assert.ok(plan.KEYNOTE_SCORE > plan.MIN_SCORE && plan.KEYNOTE_SCORE < plan.MIN_SCORE + 0.05);
  assert.deepEqual(k1.reasons, ['Keynote']);
  // Skipped keynotes and sponsored keynotes (when excluded) stay out.
  assert.deepEqual(picks(run(sessions, candidates, { skipped: ['t:k1'] })[0]), ['t:m']);
  const sponsored = [session('ks', '09:00', '09:30', { track: 'Keynote Sessions', sponsored: true })];
  assert.deepEqual(picks(run(sponsored, [], { includeSponsored: false })[0]), []);
  assert.deepEqual(picks(run(sponsored, [])[0]), ['t:ks']);
  // A keynote that is itself a real match keeps its own score and reasons.
  const [own] = run(sessions.slice(0, 1), [rec(sessions[0], 0.7, ['Matches Argo CD'])]);
  assert.equal(own.slots[0].pick.score, 0.7);
  assert.deepEqual(own.slots[0].pick.reasons, ['Matches Argo CD']);
});
