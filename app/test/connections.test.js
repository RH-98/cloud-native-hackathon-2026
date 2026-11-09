const test = require('node:test');
const assert = require('node:assert/strict');
const { handleConnections } = require('../api/connections');

const profile = {
  source: 'interests',
  username: null,
  tools: [{ name: 'opentelemetry', weight: 1, evidence: ['private/repo-name'] }],
  topics: ['observability'],
  languages: [],
  keywords: [],
};
const quietLogger = { warn: () => {} };

test('rejects bad input with invalid_input', async () => {
  const cases = [
    null,
    { profile },
    { conferenceId: '../etc', profile },
    { conferenceId: 'kubecon-na-2026' },
    { conferenceId: 'kubecon-na-2026', profile, pickedSessionIds: 'x' },
    { conferenceId: 'kubecon-na-2026', profile, limit: 99 },
    { conferenceId: 'kubecon-na-2026', profile: { tools: [], topics: [], languages: [], keywords: [] } },
  ];
  for (const body of cases) {
    const res = await handleConnections(body, { env: {} });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.error.code, 'invalid_input');
  }
});

test('404 for a conference with no attendees', async () => {
  const res = await handleConnections({ conferenceId: 'no-such-conf', profile }, { env: {} });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'not_found');
});

test('without Elasticsearch, matches the committed demo attendees in memory', async () => {
  const res = await handleConnections({ conferenceId: 'kubecon-na-2026', profile, limit: 3 }, { env: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.searchBackend, 'snapshot');
  assert.equal(res.json.demoData, true);
  assert.equal(res.json.connections.length, 3);
  const attendees = require('../data/attendees/kubecon-na-2026.json').attendees;
  const optedOut = new Set(attendees.filter((a) => !a.optIn).map((a) => a.handle));
  for (const c of res.json.connections) {
    assert.ok(!optedOut.has(c.attendee.handle));
    assert.ok(c.shared.includes('OpenTelemetry'));
    assert.equal(typeof c.why, 'string');
    assert.ok(Array.isArray(c.commonSessions));
  }
  // Evidence (repo names) from the profile never comes back.
  assert.ok(!JSON.stringify(res.json).includes('private/repo-name'));
});

test('names the sessions in common with the plan', async () => {
  const attendees = require('../data/attendees/kubecon-na-2026.json').attendees;
  const target = attendees.find((a) => a.optIn && a.interests.tools.some((t) => t.name === 'opentelemetry'));
  const res = await handleConnections(
    { conferenceId: 'kubecon-na-2026', profile, pickedSessionIds: target.goingTo.slice(0, 1), limit: 20 },
    { env: {} },
  );
  const match = res.json.connections.find((c) => c.attendee.handle === target.handle);
  assert.equal(match.commonSessions.length, 1);
  assert.equal(match.commonSessions[0].id, target.goingTo[0]);
  assert.equal(typeof match.commonSessions[0].title, 'string');
});

test('uses Elasticsearch candidates when configured, and drops any opted-out hit', async () => {
  const candidate = (handle, optIn) => ({
    displayName: handle,
    handle,
    role: 'SRE',
    bio: 'Bio',
    optIn,
    experience: 'practitioner',
    maintains: [],
    goingTo: [],
    interests: { tools: [{ name: 'opentelemetry', label: 'OpenTelemetry', weight: 1 }], topics: [], languages: [], keywords: [] },
  });
  let called;
  const res = await handleConnections(
    { conferenceId: 'kubecon-na-2026', profile },
    {
      client: {},
      search: async (client, args) => {
        called = args;
        return [candidate('demo-es-one', true), candidate('demo-es-out', false)];
      },
    },
  );
  assert.equal(called.conferenceId, 'kubecon-na-2026');
  assert.equal(res.json.searchBackend, 'elasticsearch');
  assert.deepEqual(res.json.connections.map((c) => c.attendee.handle), ['demo-es-one']);
});

test('falls back to the in-memory matcher when Elasticsearch fails', async () => {
  const res = await handleConnections(
    { conferenceId: 'kubecon-na-2026', profile },
    {
      client: {},
      logger: quietLogger,
      search: async () => {
        throw new Error('index_not_found_exception');
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.json.searchBackend, 'snapshot');
  assert.ok(res.json.connections.length > 0);
});
