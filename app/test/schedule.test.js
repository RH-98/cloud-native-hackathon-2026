const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diffSessions, sameInstant } = require('../schedule/diff');
const { normalizeOverrides, readOverrides, applyOverrides } = require('../schedule/overrides');
const { overlaySnapshot, latestBySession, liveSnapshot } = require('../schedule/overlay');
const { watchConference } = require('../schedule/watch');
const es = require('../search/elasticsearch');

const session = (id, extra = {}) => ({
  id: `kubecon-na-2026:${id}`,
  conferenceId: 'kubecon-na-2026',
  sourceId: String(id),
  title: `Talk ${id}`,
  description: 'About things.',
  start: '2026-11-10T11:30:00-07:00',
  end: '2026-11-10T12:00:00-07:00',
  room: 'Salt Palace | Level 2 | 250 A-C',
  kind: 'session',
  ...extra,
});

// --- diff -----------------------------------------------------------------------

test('diff: no changes when only whitespace, description or time formatting differ', () => {
  const before = [session(1)];
  const after = [
    session(1, {
      title: '  Talk   1 ',
      room: 'Salt Palace |  Level 2 | 250 A-C ',
      description: 'A completely rewritten abstract.',
      start: '2026-11-10T18:30:00.000Z',
    }),
  ];
  assert.deepEqual(diffSessions(before, after), []);
  assert.ok(sameInstant('2026-11-10T11:30:00-07:00', '2026-11-10T18:30:00Z'));
});

test('diff: time, room, title, cancelled and added', () => {
  const before = [session(1), session(2), session(3), session(4), session(5, { kind: 'cancelled' })];
  const after = [
    session(1, { start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00' }),
    session(2, { room: 'Hyatt Regency | Level 4 | Regency Ballroom A' }),
    session(3, { title: 'Talk 3: the sequel', description: 'New.' }),
    session(5),
    session(6),
  ];
  const byId = Object.fromEntries(diffSessions(before, after).map((c) => [c.sessionId.split(':')[1], c]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '2', '3', '4', '5', '6']);

  assert.equal(byId[1].type, 'time_changed');
  assert.equal(byId[1].before.start, '2026-11-10T11:30:00-07:00');
  assert.equal(byId[1].after.start, '2026-11-10T14:00:00-07:00');
  assert.deepEqual(byId[1].patch, { start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00' });

  assert.equal(byId[2].type, 'room_changed');
  assert.deepEqual(byId[2].patch, { room: 'Hyatt Regency | Level 4 | Regency Ballroom A' });

  assert.equal(byId[3].type, 'details_changed');
  assert.equal(byId[3].sessionTitle, 'Talk 3: the sequel');
  assert.deepEqual(byId[3].patch, { title: 'Talk 3: the sequel', description: 'New.' });

  assert.equal(byId[4].type, 'cancelled');
  assert.equal(byId[4].after, null);
  assert.deepEqual(byId[4].patch, { kind: 'cancelled' });

  assert.equal(byId[5].type, 'added'); // reinstated
  assert.equal(byId[5].doc.kind, 'session');
  assert.equal(byId[6].type, 'added');
  assert.equal(byId[6].before, null);
});

test('diff: a time and room change together is one time_changed with both', () => {
  const [c] = diffSessions([session(1)], [session(1, { start: '2026-11-10T15:00:00-07:00', end: '2026-11-10T15:30:00-07:00', room: 'Hall 1' })]);
  assert.equal(c.type, 'time_changed');
  assert.equal(c.after.room, 'Hall 1');
  assert.equal(c.patch.room, 'Hall 1');
});

test('diff: an already-cancelled session is not cancelled again', () => {
  assert.deepEqual(diffSessions([session(1, { kind: 'cancelled' })], []), []);
});

// --- overrides --------------------------------------------------------------------

test('overrides: valid entries kept, bad ones dropped with a warning', () => {
  const { overrides, warnings } = normalizeOverrides([
    { sessionId: 'kubecon-na-2026:1', start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00', room: 'Hall 1' },
    { sessionId: 'kubecon-na-2026:2', cancelled: true },
    { sessionId: 'nope' },
    { sessionId: 'kubecon-na-2026:3', start: 'tomorrow' },
    { sessionId: 'kubecon-na-2026:4', start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T13:00:00-07:00' },
    { sessionId: 'kubecon-na-2026:5' },
  ]);
  assert.equal(overrides.length, 2);
  assert.equal(warnings.length, 4);
  assert.deepEqual(normalizeOverrides({ not: 'an array' }).overrides, []);
});

test('overrides: missing file means none; invalid JSON is a warning, not a crash', () => {
  assert.deepEqual(readOverrides(path.join(os.tmpdir(), 'no-such-overrides.json')), { overrides: [], warnings: [] });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'overrides.json');
  fs.writeFileSync(file, '[{');
  const bad = readOverrides(file);
  assert.deepEqual(bad.overrides, []);
  assert.equal(bad.warnings.length, 1);
  fs.writeFileSync(file, '[{"sessionId":"kubecon-na-2026:1","cancelled":true}]');
  assert.equal(readOverrides(file).overrides.length, 1);
});

test('overrides: apply moves and cancels sessions without mutating the input', () => {
  const sessions = [session(1), session(2)];
  const { sessions: out, simulatedIds, warnings } = applyOverrides(sessions, [
    { sessionId: 'kubecon-na-2026:1', start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00' },
    { sessionId: 'kubecon-na-2026:2', cancelled: true },
    { sessionId: 'kubecon-na-2026:99', cancelled: true },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, '2026-11-10T14:00:00-07:00');
  assert.equal(out[0].room, sessions[0].room);
  assert.equal(sessions[0].start, '2026-11-10T11:30:00-07:00');
  assert.deepEqual([...simulatedIds].sort(), ['kubecon-na-2026:1', 'kubecon-na-2026:2']);
  assert.equal(warnings.length, 1);
});

// --- overlay (planner uses live times) ---------------------------------------------

test('overlay: the latest change per session wins; cancelled sessions are dropped', () => {
  const snapshot = { conference: { id: 'kubecon-na-2026' }, sessions: [session(1), session(2), session(3)] };
  const changes = [
    { sessionId: 'kubecon-na-2026:1', type: 'time_changed', detectedAt: '2026-11-09T20:00:00Z', after: { start: '2026-11-10T13:00:00-07:00', end: '2026-11-10T13:30:00-07:00', room: 'A' } },
    { sessionId: 'kubecon-na-2026:1', type: 'time_changed', detectedAt: '2026-11-09T21:00:00Z', after: { start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00', room: 'B' } },
    { sessionId: 'kubecon-na-2026:2', type: 'cancelled', detectedAt: '2026-11-09T21:00:00Z', after: null },
    { title: 'not a change record' },
  ];
  assert.equal(latestBySession(changes).size, 2);
  const out = overlaySnapshot(snapshot, changes);
  assert.deepEqual(out.sessions.map((s) => s.id), ['kubecon-na-2026:1', 'kubecon-na-2026:3']);
  assert.equal(out.sessions[0].start, '2026-11-10T14:00:00-07:00');
  assert.equal(out.sessions[0].room, 'B');
  assert.equal(snapshot.sessions.length, 3);
  assert.equal(overlaySnapshot(snapshot, []), snapshot);
});

test('overlay: liveSnapshot reads the latest changes on every call, and falls back when Elasticsearch fails', async () => {
  const snapshot = { conference: { id: 'kubecon-na-2026' }, sessions: [session(1)] };
  const broken = { search: async () => { throw new Error('down'); }, get: async () => { throw new Error('down'); } };
  assert.equal(await liveSnapshot(snapshot, broken), snapshot);

  let changes = [];
  let searches = 0;
  const client = {
    search: async () => {
      searches += 1;
      return { hits: { hits: changes.map((c) => ({ _source: c })) } };
    },
    get: async () => ({ _source: {} }),
  };
  assert.equal(await liveSnapshot(snapshot, client), snapshot);
  // A change recorded right after the first plan shows up in the very next one.
  changes = [{ sessionId: 'kubecon-na-2026:1', type: 'cancelled', detectedAt: '2026-11-09T21:00:00Z', after: null }];
  assert.deepEqual((await liveSnapshot(snapshot, client)).sessions, []);
  assert.equal(searches, 2);
});

// --- Elasticsearch helpers ----------------------------------------------------------

test('es: the changes query filters by conference, time and session ids', () => {
  const q = es.buildChangesQuery({ conferenceId: 'kubecon-na-2026', since: '2026-11-09T20:00:00.000Z', sessionIds: ['kubecon-na-2026:1'], size: 5000 });
  assert.equal(q.index, 'conference-changes');
  assert.equal(q.size, 1000);
  assert.deepEqual(q.query.bool.filter, [
    { term: { conferenceId: 'kubecon-na-2026' } },
    { range: { detectedAt: { gt: '2026-11-09T20:00:00.000Z' } } },
    { terms: { sessionId: ['kubecon-na-2026:1'] } },
  ]);
  assert.equal(es.buildChangesQuery({ conferenceId: 'x' }).query.bool.filter.length, 1);
  assert.equal(es.MAPPINGS['conference-changes'].dynamic, 'strict');
  assert.ok(es.MAPPINGS['conference-meta'].properties.lastCheckedAt);
});

// --- the watcher, end to end with a fake Elasticsearch -----------------------------

function fakeElasticsearch(stored, previousChanges = []) {
  const bulks = [];
  return {
    bulks,
    async search(req) {
      if (req.index === 'conference-sessions') return { hits: { hits: stored.map((s) => ({ _id: s.id, _source: s })) } };
      if (req.index === 'conference-changes') return { hits: { hits: previousChanges.map((c) => ({ _source: c })) } };
      throw new Error(`unexpected index ${req.index}`);
    },
    async get() {
      return { _source: { lastCheckedAt: '2026-11-09T20:00:00.000Z' } };
    },
    async bulk(req) {
      bulks.push(req);
      return { items: req.operations.filter((_, i) => i % 2 === 0).map((op) => ({ [Object.keys(op)[0]]: { _id: Object.values(op)[0]._id } })) };
    },
  };
}

const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'lf-schedule.html'), 'utf8');
const conference = {
  id: 'kubecon-na-2026',
  utcOffset: '-07:00',
  source: { scheduleUrl: 'https://events.example/schedule/' },
};
const fetchFixture = async () => ({ ok: true, status: 200, text: async () => fixtureHtml });
const { parseSchedule } = require('../importers/lf-events');
const fixtureSessions = () =>
  parseSchedule(fixtureHtml, { conferenceId: 'kubecon-na-2026', utcOffset: '-07:00', pageUrl: conference.source.scheduleUrl });

test('watch: records a live room change and a simulated cancellation, and updates Elasticsearch', async () => {
  const stored = fixtureSessions().map((s) => (s.sourceId === '101' ? { ...s, room: 'Old Room' } : s));
  const client = fakeElasticsearch(stored);
  const result = await watchConference(conference, {
    client,
    fetchImpl: fetchFixture,
    overrides: [{ sessionId: 'kubecon-na-2026:102', cancelled: true }],
    now: new Date('2026-11-09T21:00:00Z'),
    log: () => {},
  });
  assert.equal(result.sourceUsed, true);
  const byId = Object.fromEntries(result.changes.map((c) => [c.sessionId, c]));
  assert.equal(byId['kubecon-na-2026:101'].type, 'room_changed');
  assert.equal(byId['kubecon-na-2026:101'].source, 'live');
  assert.equal(byId['kubecon-na-2026:102'].type, 'cancelled');
  assert.equal(byId['kubecon-na-2026:102'].source, 'simulated');
  assert.equal(byId['kubecon-na-2026:102'].id, 'kubecon-na-2026:102@2026-11-09T21:00:00.000Z');

  const ops = client.bulks[0].operations;
  assert.deepEqual(ops[0], { update: { _index: 'conference-sessions', _id: 'kubecon-na-2026:101' } });
  assert.deepEqual(ops[1], { doc: { room: 'Salt Palace | Level 2 | 250 A-C' } });
  assert.deepEqual(ops[3], { doc: { kind: 'cancelled' } });
  assert.deepEqual(ops.at(-1), { doc: { lastCheckedAt: '2026-11-09T21:00:00.000Z', liveRetrievedAt: '2026-11-09T21:00:00.000Z' } });
  assert.equal(client.bulks[0].refresh, true);
});

test('watch: no changes still records the check time', async () => {
  const client = fakeElasticsearch(fixtureSessions());
  const result = await watchConference(conference, { client, fetchImpl: fetchFixture, log: () => {} });
  assert.equal(result.changes.length, 0);
  assert.equal(client.bulks[0].operations.length, 2);
});

test('watch: an unreachable or shrunken source never cancels sessions; overrides still apply', async () => {
  const stored = [...fixtureSessions(), session(900), session(901), session(902)];
  for (const fetchImpl of [async () => { throw new Error('ENOTFOUND'); }, fetchFixture]) {
    const client = fakeElasticsearch(stored);
    const result = await watchConference(conference, {
      client,
      fetchImpl,
      overrides: [{ sessionId: 'kubecon-na-2026:900', start: '2026-11-10T16:00:00-07:00', end: '2026-11-10T16:30:00-07:00' }],
      log: () => {},
    });
    assert.equal(result.sourceUsed, false);
    assert.deepEqual(result.changes.map((c) => [c.sessionId, c.type, c.source]), [['kubecon-na-2026:900', 'time_changed', 'simulated']]);
  }
});

test('watch: undoing a simulated change (override removed) is recorded as simulated', async () => {
  const stored = fixtureSessions().map((s) => (s.sourceId === '101' ? { ...s, start: '2026-11-10T16:00:00-07:00', end: '2026-11-10T16:30:00-07:00' } : s));
  const previous = [{ sessionId: 'kubecon-na-2026:101', type: 'time_changed', source: 'simulated', detectedAt: '2026-11-09T20:00:00Z' }];
  const client = fakeElasticsearch(stored, previous);
  const result = await watchConference(conference, { client, fetchImpl: fetchFixture, log: () => {} });
  assert.deepEqual(result.changes.map((c) => [c.type, c.source]), [['time_changed', 'simulated']]);
});

test('watch: Sessionize conferences are read from the Sessionize API', async () => {
  const json = fs.readFileSync(path.join(__dirname, 'fixtures', 'sessionize-all.json'), 'utf8');
  const { parseSessionize } = require('../importers/sessionize');
  const conv = {
    id: 'convergence-2026',
    utcOffset: '-05:00',
    source: { scheduleUrl: 'https://conv.example/sessions/', sessionizeApiUrl: 'https://sessionize.example/api/v2/x/view/All' },
  };
  const stored = parseSessionize(JSON.parse(json), { conferenceId: conv.id, utcOffset: conv.utcOffset }).map((s) =>
    s.sourceId === '1293020' ? { ...s, room: 'Splash 1-2' } : s,
  );
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => json };
  };
  const client = fakeElasticsearch(stored);
  const result = await watchConference(conv, { client, fetchImpl, log: () => {} });
  assert.deepEqual(urls, [conv.source.sessionizeApiUrl]);
  assert.equal(result.sourceUsed, true);
  assert.deepEqual(result.changes.map((c) => [c.sessionId, c.type, c.after.room]), [['convergence-2026:1293020', 'room_changed', 'Splash 9']]);
});
