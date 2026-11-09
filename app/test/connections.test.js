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

// --- POST /api/connections through the router ------------------------------
const http = require('node:http');
const { createHandler } = require('../api/router');

async function startApp(connections = { env: {}, logger: quietLogger }) {
  const handler = createHandler({ buildProfile: async () => ({}), buildPlan: async () => ({}), connections });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function post(base, body, headers = { 'content-type': 'application/json' }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${base}/api/connections`, { method: 'POST', headers, body: payload });
}

test('POST /api/connections returns opted-in demo matches as JSON', async (t) => {
  const app = await startApp();
  t.after(app.close);
  // The body the UI sends.
  const res = await post(app.base, {
    conferenceId: 'kubecon-na-2026',
    profile,
    pickedSessionIds: [],
    limit: 5,
    firstTimer: false,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.demoData, true);
  assert.equal(body.connections.length, 5);
  assert.deepEqual(Object.keys(body.connections[0].attendee).sort(), ['bio', 'displayName', 'handle', 'role']);
});

test('POST /api/connections answers errors in the contract format', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const tooBig = JSON.stringify({ conferenceId: 'kubecon-na-2026', profile, pad: 'x'.repeat(70 * 1024) });
  const cases = [
    [await post(app.base, { conferenceId: 'kubecon-na-2026' }), 400, 'invalid_input'],
    [await post(app.base, '{not json'), 400, 'invalid_input'],
    [await post(app.base, { conferenceId: 'no-such-conf', profile }), 404, 'not_found'],
    [await post(app.base, '{}', { 'content-type': 'text/plain' }), 415, 'unsupported_media_type'],
    [await post(app.base, tooBig), 413, 'payload_too_large'],
    [await fetch(`${app.base}/api/connections`), 405, 'method_not_allowed'],
  ];
  for (const [res, status, code] of cases) {
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error.code, code);
  }
});

test('POST /api/connections hides unexpected errors behind a generic 500', async (t) => {
  // Malformed attendee data makes the matcher throw.
  const app = await startApp({ env: {}, logger: quietLogger, attendees: 42 });
  t.after(app.close);
  const original = console.error;
  const logged = [];
  console.error = (line) => logged.push(line);
  t.after(() => {
    console.error = original;
  });
  const res = await post(app.base, { conferenceId: 'kubecon-na-2026', profile });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'internal');
  // The log line never includes the request body (the profile).
  assert.ok(logged.every((line) => !String(line).includes('private/repo-name')));
});
