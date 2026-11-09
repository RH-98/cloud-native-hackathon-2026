// Connection requests ("People to meet": Connect): lifecycle, sign-in and
// CSRF, opt-in rules, demo auto-accept, request states on suggestions, and
// account deletion. In-memory fake for Postgres, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { createAccounts } = require('../auth');
const gh = require('../auth/github');
const { hashToken } = require('../db');
const { requestStates } = require('../api/requests');

const PUBLIC_URL = 'https://planner.example';
const CONF = 'kubecon-na-2026';
const DEMO = 'demo-uma-pebblecrest'; // opted in
const DEMO_NOT_OPTED = 'demo-juno-oakhollow';
const ARGO = { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 1 }], topics: [], languages: [], keywords: [] };

function fakeDb() {
  const users = new Map();
  const sessions = new Map();
  const social = new Map();
  const requests = new Map();
  let nextUser = 1;
  let nextReq = 1;
  const withUsers = (r) => ({
    ...r,
    from: { login: users.get(r.fromUserId)?.login, name: users.get(r.fromUserId)?.name || null },
    to: r.toUserId ? { login: users.get(r.toUserId)?.login, name: users.get(r.toUserId)?.name || null } : null,
  });
  return {
    users, sessions, social, requests,
    enabled: true,
    async ready() {},
    async upsertUser(g) {
      const user = { id: String(nextUser++), githubId: String(g.id), login: g.login, name: g.name || null, avatarUrl: null };
      users.set(user.id, user);
      return user;
    },
    async createSession(userId) {
      const token = require('node:crypto').randomBytes(32).toString('base64url');
      sessions.set(hashToken(token), userId);
      return token;
    },
    async getSessionUser(token) {
      const id = token && sessions.get(hashToken(token));
      return id ? users.get(id) : null;
    },
    async getPrivateProfile() { return null; },
    async getSocialProfile(userId, conf) { return social.get(`${userId}|${conf}`) || null; },
    async listOptedInProfiles(conf) {
      return [...social.entries()].filter(([k]) => k.endsWith(`|${conf}`)).map(([k, v]) => {
        const u = users.get(k.split('|')[0]);
        return { userId: u.id, login: u.login, displayName: u.name || u.login, profile: v.profile, demo: false };
      });
    },
    async listConnectionRequests(userId, conf) {
      return [...requests.values()]
        .filter((r) => (r.fromUserId === String(userId) || r.toUserId === String(userId)) && (!conf || r.conferenceId === conf))
        .map(withUsers);
    },
    async getConnectionRequest(id) { return requests.has(String(id)) ? withUsers(requests.get(String(id))) : null; },
    async createConnectionRequest({ conferenceId, fromUserId, to, status = 'pending' }) {
      const existing = [...requests.values()].find((r) => r.conferenceId === conferenceId && r.fromUserId === String(fromUserId)
        && r.toUserId === (to.userId || null) && r.toDemoHandle === (to.demoHandle || null));
      if (existing) return { request: withUsers(existing), created: false };
      const now = new Date().toISOString();
      const r = { id: String(nextReq++), conferenceId, fromUserId: String(fromUserId), toUserId: to.userId || null, toDemoHandle: to.demoHandle || null, status, createdAt: now, updatedAt: now };
      requests.set(r.id, r);
      return { request: withUsers(r), created: true };
    },
    async answerConnectionRequest(id, toUserId, status) {
      const r = requests.get(String(id));
      if (!r || r.toUserId !== String(toUserId) || r.status === 'accepted') return null;
      r.status = status;
      return withUsers(r);
    },
    async withdrawConnectionRequest(id, fromUserId) {
      const r = requests.get(String(id));
      if (!r || r.fromUserId !== String(fromUserId) || r.status === 'accepted') return false;
      return requests.delete(String(id));
    },
    async countIncomingConnectionRequests(userId) {
      return [...requests.values()].filter((r) => r.toUserId === String(userId) && r.status === 'pending').length;
    },
    async deleteUser(userId) {
      for (const [k, r] of [...requests]) if (r.fromUserId === userId || r.toUserId === userId) requests.delete(k);
      for (const k of [...social.keys()]) if (k.startsWith(`${userId}|`)) social.delete(k);
      for (const [k, v] of [...sessions]) if (v === userId) sessions.delete(k);
      users.delete(userId);
    },
  };
}

async function start(t) {
  const db = fakeDb();
  const accounts = createAccounts({ db, clientId: 'id', clientSecret: 'secret', sessionSecret: 'a'.repeat(64), publicUrl: PUBLIC_URL, fetch: async () => new Response('{}', { status: 404 }) });
  const server = http.createServer(createHandler({ buildProfile: async () => ({}), buildPlan: async () => ({}), connections: { env: {}, realAttendees: (conf) => db.listOptedInProfiles(conf) }, accounts }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function user(login, { optIn = true, email } = {}) {
    const u = await db.upsertUser({ id: login.length * 1000 + db.users.size, login, name: login.toUpperCase(), email });
    if (email) u.email = email;
    if (optIn) db.social.set(`${u.id}|${CONF}`, { profile: ARGO, optedInAt: new Date().toISOString() });
    const token = await db.createSession(u.id);
    const cookie = `${gh.SESSION_COOKIE}=${token}`;
    const call = (path, { method = 'GET', body, origin = PUBLIC_URL } = {}) => fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ...u, cookie, call };
  }
  return { db, base, user };
}

const connect = (u, to, opts = {}) => u.call('/api/me/connections', { method: 'POST', body: { conferenceId: CONF, to }, ...opts });
const listFor = async (u) => (await u.call(`/api/me/connections?conferenceId=${CONF}`)).json();

test('request lifecycle: create, duplicate, accept; badge counts incoming', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');

  const res = await connect(ada, { userId: bob.id });
  assert.equal(res.status, 201);
  const { request } = await res.json();
  assert.equal(request.direction, 'outgoing');
  assert.equal(request.status, 'pending');
  assert.equal(request.person.handle, 'bob');
  assert.equal(request.person.profileUrl, null); // not until both agree
  assert.deepEqual(request.shared, ['Argo CD']);

  const dup = await connect(ada, { userId: bob.id });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).request.id, request.id);
  assert.equal(app.db.requests.size, 1);

  assert.equal((await (await bob.call('/api/me')).json()).connectionRequests.incoming, 1);
  const bobList = await listFor(bob);
  assert.equal(bobList.incoming.length, 1);
  assert.equal(bobList.incoming[0].person.handle, 'ada');

  // Only the recipient can accept.
  assert.equal((await ada.call(`/api/me/connections/${request.id}/accept`, { method: 'POST' })).status, 404);
  const accepted = await bob.call(`/api/me/connections/${request.id}/accept`, { method: 'POST' });
  assert.equal(accepted.status, 200);
  const acc = (await accepted.json()).request;
  assert.equal(acc.status, 'accepted');
  assert.equal(acc.person.profileUrl, 'https://github.com/ada');

  const adaList = await listFor(ada);
  assert.equal(adaList.accepted.length, 1);
  assert.equal(adaList.accepted[0].person.profileUrl, 'https://github.com/bob');
  assert.equal(adaList.outgoing.length, 0);
  assert.equal((await (await bob.call('/api/me')).json()).connectionRequests.incoming, 0);
  // An accepted connection can't be withdrawn or declined.
  assert.equal((await ada.call(`/api/me/connections/${request.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await bob.call(`/api/me/connections/${request.id}/decline`, { method: 'POST' })).status, 404);
});

test('decline is not revealed to the sender; withdraw removes the request', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');
  const { request } = await (await connect(ada, { userId: bob.id })).json();
  assert.equal((await bob.call(`/api/me/connections/${request.id}/decline`, { method: 'POST' })).status, 200);
  assert.equal((await listFor(bob)).incoming.length, 0);
  const adaList = await listFor(ada);
  assert.equal(adaList.outgoing.length, 1);
  assert.equal(adaList.outgoing[0].status, 'pending');

  assert.equal((await bob.call(`/api/me/connections/${request.id}`, { method: 'DELETE' })).status, 404); // not the sender
  assert.equal((await ada.call(`/api/me/connections/${request.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(app.db.requests.size, 0);
});

test('asking someone who already asked you accepts their request', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');
  await connect(ada, { userId: bob.id });
  const res = await connect(bob, { userId: ada.id });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).request.status, 'accepted');
  assert.equal(app.db.requests.size, 1);
});

test('sign-in and same-origin are required; writes from another site are refused', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');
  assert.equal((await fetch(`${app.base}/api/me/connections?conferenceId=${CONF}`)).status, 401);
  assert.equal((await fetch(`${app.base}/api/me/connections`, {
    method: 'POST', headers: { origin: PUBLIC_URL, 'content-type': 'application/json' }, body: JSON.stringify({ conferenceId: CONF, to: { userId: bob.id } }),
  })).status, 401);
  assert.equal((await connect(ada, { userId: bob.id }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await connect(ada, { userId: bob.id }, { origin: null })).status, 403);
  assert.equal(app.db.requests.size, 0);
  assert.equal((await ada.call('/api/me/connections/1/accept', { method: 'POST', origin: 'https://evil.example' })).status, 403);
  assert.equal((await ada.call('/api/me/connections/1', { method: 'DELETE', origin: 'https://evil.example' })).status, 403);
});

test("can't request yourself, a non-opted-in user, or without opting in", async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const shy = await app.user('shy', { optIn: false });
  const bob = await app.user('bob');
  assert.equal((await connect(ada, { userId: ada.id })).status, 400);
  assert.equal((await connect(ada, { userId: shy.id })).status, 404);
  assert.equal((await connect(ada, { userId: '999' })).status, 404);
  assert.equal((await connect(shy, { userId: bob.id })).status, 403);
  assert.equal((await connect(ada, { demoHandle: DEMO_NOT_OPTED })).status, 404);
  assert.equal((await connect(ada, { userId: bob.id, demoHandle: DEMO })).status, 400);
  assert.equal((await connect(ada, {})).status, 400);
  assert.equal(app.db.requests.size, 0);
});

test('demo attendees auto-accept and are marked simulated', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada', { optIn: false }); // demo requests don't need an opt-in
  const res = await connect(ada, { demoHandle: DEMO });
  assert.equal(res.status, 201);
  const { request } = await res.json();
  assert.equal(request.status, 'accepted');
  assert.equal(request.simulated, true);
  assert.match(request.note, /Demo attendee: auto-accepted/);
  assert.equal(request.person.demo, true);
  assert.equal(request.person.handle, DEMO);
  assert.equal((await listFor(ada)).accepted.length, 1);
});

test('no private fields leak: only names, logins and shared public labels', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada', { email: 'ada@example.com' });
  const bob = await app.user('bob', { email: 'bob@example.com' });
  app.db.social.set(`${bob.id}|${CONF}`, { profile: { ...ARGO, keywords: ['secret-employer'], languages: [{ name: 'go', weight: 1 }] } });
  await connect(ada, { userId: bob.id });
  const text = JSON.stringify(await listFor(bob)) + JSON.stringify(await listFor(ada));
  for (const leak of ['@example.com', 'secret-employer', 'githubId', 'avatarUrl', 'fromUserId', 'toUserId']) assert.ok(!text.includes(leak), leak);
});

test('People to meet carries the request state for signed-in viewers only', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');
  await connect(bob, { userId: ada.id });
  await connect(ada, { demoHandle: DEMO });
  const body = { conferenceId: CONF, profile: { username: null, tools: [{ name: 'crossplane', weight: 1 }, { name: 'argo-cd', weight: 1 }] }, limit: 20 };
  const signedIn = await (await ada.call('/api/connections', { method: 'POST', body })).json();
  assert.deepEqual(signedIn.connect, { enabled: true, signedIn: true });
  const bobCard = signedIn.connections.find((c) => c.attendee.handle === 'bob');
  assert.equal(bobCard.requestState, 'incoming');
  assert.equal(bobCard.attendee.userId, bob.id);
  assert.equal(signedIn.connections.find((c) => c.attendee.handle === DEMO).requestState, 'connected');
  assert.ok(signedIn.connections.some((c) => c.requestState === 'none'));

  const anon = await (await fetch(`${app.base}/api/connections`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  assert.deepEqual(anon.connect, { enabled: true, signedIn: false });
  assert.ok(anon.connections.every((c) => c.requestState === undefined));
});

test('requestStates ranks connected over incoming over requested', () => {
  const states = requestStates([
    { id: '1', fromUserId: '1', toUserId: '2', status: 'pending' },
    { id: '2', fromUserId: '3', toUserId: '1', status: 'pending' },
    { id: '3', fromUserId: '4', toUserId: '1', status: 'declined' },
    { id: '4', fromUserId: '1', toUserId: null, toDemoHandle: 'demo-x', status: 'accepted' },
  ], '1');
  assert.deepEqual(states.get('user:2'), { state: 'requested', requestId: '1' });
  assert.deepEqual(states.get('user:3'), { state: 'incoming', requestId: '2' });
  assert.equal(states.get('user:4'), undefined);
  assert.deepEqual(states.get('demo:demo-x'), { state: 'connected', requestId: '4' });
});

test('deleting your account removes requests in both directions', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  const bob = await app.user('bob');
  const cy = await app.user('cy');
  await connect(ada, { userId: bob.id });
  await connect(cy, { userId: ada.id });
  await connect(bob, { userId: cy.id });
  assert.equal((await ada.call('/api/me', { method: 'DELETE' })).status, 204);
  assert.equal(app.db.requests.size, 1);
  assert.equal((await listFor(bob)).outgoing[0].person.handle, 'cy');
});

test('connection routes answer 503 when the database is down', async (t) => {
  const app = await start(t);
  const ada = await app.user('ada');
  app.db.listConnectionRequests = async () => { throw new Error('ECONNREFUSED'); };
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  assert.equal((await ada.call(`/api/me/connections?conferenceId=${CONF}`)).status, 503);
});
