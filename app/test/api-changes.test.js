const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { getChanges } = require('../schedule');

async function start(deps = {}) {
  const server = http.createServer(createHandler({ buildProfile: async () => ({}), buildPlan: async () => ({}), ...deps }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('GET /api/changes validates its query', async (t) => {
  const calls = [];
  const app = await start({ getChanges: async (q) => { calls.push(q); return { changes: [], checkedAt: null }; } });
  t.after(app.close);
  const cases = [
    ['', 400],
    ['conferenceId=BAD!', 400],
    ['conferenceId=no-such-conf', 404],
    ['conferenceId=kubecon-na-2026&since=yesterday', 400],
    ['conferenceId=kubecon-na-2026&since=2026-11-10T10:00:00', 400], // no zone
    ['conferenceId=kubecon-na-2026&sessionIds=other-conf:1', 400],
    ['conferenceId=kubecon-na-2026&sessionIds=kubecon-na-2026:1%20OR%201', 400],
    [`conferenceId=kubecon-na-2026&sessionIds=${Array.from({ length: 201 }, (_, i) => `kubecon-na-2026:${i}`).join(',')}`, 400],
  ];
  for (const [query, status] of cases) {
    const res = await fetch(`${app.base}/api/changes?${query}`);
    assert.equal(res.status, status, query.slice(0, 80));
    const body = await res.json();
    assert.ok(body.error.code && body.error.message);
  }
  assert.equal(calls.length, 0);

  const ok = await fetch(`${app.base}/api/changes?conferenceId=kubecon-na-2026&since=2026-11-09T14:00:00-07:00&sessionIds=kubecon-na-2026:1,kubecon-na-2026:2,kubecon-na-2026:1`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { changes: [], checkedAt: null });
  assert.deepEqual(calls[0], {
    conferenceId: 'kubecon-na-2026',
    since: '2026-11-09T21:00:00.000Z',
    sessionIds: ['kubecon-na-2026:1', 'kubecon-na-2026:2'],
  });

  const post = await fetch(`${app.base}/api/changes?conferenceId=kubecon-na-2026`, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('GET /api/changes answers 502 without upstream details when Elasticsearch fails', async (t) => {
  const app = await start({ getChanges: async () => { throw new Error('secret-ish upstream detail'); } });
  t.after(app.close);
  const res = await fetch(`${app.base}/api/changes?conferenceId=kubecon-na-2026`);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes('secret-ish'));
});

test('getChanges without Elasticsearch returns no changes', async () => {
  assert.deepEqual(await getChanges({ conferenceId: 'kubecon-na-2026' }, { env: {} }), { changes: [], checkedAt: null });
});

test('getChanges reads the changes index and the last check time', async () => {
  const requests = [];
  const client = {
    async search(req) {
      requests.push(req);
      return { hits: { hits: [{ _source: { id: 'x', sessionId: 'kubecon-na-2026:1', type: 'cancelled' } }] } };
    },
    async get() {
      return { _source: { lastCheckedAt: '2026-11-09T21:00:00.000Z' } };
    },
  };
  const out = await getChanges({ conferenceId: 'kubecon-na-2026', since: null, sessionIds: ['kubecon-na-2026:1'] }, { client });
  assert.equal(out.changes.length, 1);
  assert.equal(out.checkedAt, '2026-11-09T21:00:00.000Z');
  assert.equal(requests[0].index, 'conference-changes');
});

test('getChanges treats a missing changes index (no watcher run yet) as no changes', async () => {
  const client = {
    async search() {
      const err = new Error('index_not_found_exception');
      err.meta = { statusCode: 404, body: { error: { type: 'index_not_found_exception' } } };
      throw err;
    },
    async get() {
      const err = new Error('not found');
      err.meta = { statusCode: 404 };
      throw err;
    },
  };
  assert.deepEqual(await getChanges({ conferenceId: 'kubecon-na-2026' }, { client }), { changes: [], checkedAt: null });
});
