// Accounts: OAuth state cookie, the GitHub callback, sessions, CSRF, saved
// plans and the "only your own profile" rule. No network, no database: a fake
// fetch stands in for GitHub and an in-memory fake for Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { createAccounts } = require('../auth');
const gh = require('../auth/github');
const { createDb, MIGRATION_SQL, hashToken } = require('../db');
const { validateSavedState, deriveSocialProfile } = require('../api/me');

const SECRET = 'a'.repeat(64);
const PUBLIC_URL = 'https://planner.example';

function fakeDb() {
  const users = new Map(); // id -> user
  const sessions = new Map(); // hash -> userId
  const plans = new Map();
  const social = new Map();
  let nextId = 1;
  return {
    users, sessions, plans, social,
    enabled: true,
    async ready() {},
    async upsertUser(g) {
      let user = [...users.values()].find((u) => u.githubId === String(g.id));
      if (!user) user = { id: String(nextId++), githubId: String(g.id) };
      Object.assign(user, { login: g.login, name: g.name, avatarUrl: g.avatar_url });
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
    async deleteSession(token) { sessions.delete(hashToken(token)); },
    async getPlan(userId, conf) { return plans.get(`${userId}|${conf}`) || null; },
    async savePlan(userId, conf, state) {
      const savedAt = new Date().toISOString();
      plans.set(`${userId}|${conf}`, { state, savedAt });
      return savedAt;
    },
    async getSocialProfile(userId, conf) { return social.get(`${userId}|${conf}`) || null; },
    async setSocialProfile(userId, conf, profile) { social.set(`${userId}|${conf}`, { profile, optedInAt: new Date().toISOString() }); },
    async deleteSocialProfile(userId, conf) { social.delete(`${userId}|${conf}`); },
    async listOptedInProfiles() { return []; },
  };
}

// GitHub's token and user endpoints.
function fakeGithub({ token = 'gho_fake_token', user = { id: 42, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/42' } } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      if (body.code !== 'good-code') return Response.json({ error: 'bad_verification_code' });
      return Response.json({ access_token: token, token_type: 'bearer', scope: 'read:user' });
    }
    if (String(url) === 'https://api.github.com/user') {
      if (init.headers.authorization !== `Bearer ${token}`) return new Response('{}', { status: 401 });
      return Response.json(user);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

async function start({ db = fakeDb(), github = fakeGithub(), enabled = true, connections } = {}) {
  const accounts = enabled
    ? createAccounts({ db, clientId: 'client-id', clientSecret: 'client-secret', sessionSecret: SECRET, publicUrl: PUBLIC_URL, fetch: github.fetch })
    : createAccounts();
  const server = http.createServer(createHandler({ buildProfile: async () => ({}), buildPlan: async () => ({}), connections, accounts }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, github, close: () => new Promise((resolve) => server.close(resolve)) };
}

const getCookie = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (setCookie) => setCookie.split(';')[0].split('=').slice(1).join('=');

// Runs login + callback; returns the session token.
async function signIn(app, { code = 'good-code' } = {}) {
  const login = await fetch(`${app.base}/auth/github/login?returnTo=/plan?day=2`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const stateCookie = cookieValue(getCookie(login, gh.STATE_COOKIE));
  const cb = await fetch(`${app.base}/auth/github/callback?code=${code}&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: `${gh.STATE_COOKIE}=${stateCookie}` },
  });
  return { cb, token: getCookie(cb, gh.SESSION_COOKIE) && cookieValue(getCookie(cb, gh.SESSION_COOKIE)) };
}

// ---------- Signed state cookie ----------

test('signed values verify, and tampering is rejected', () => {
  const v = gh.sign({ s: 'abc', r: '/', e: Date.now() + 1000 }, SECRET);
  assert.deepEqual(gh.verify(v, SECRET).s, 'abc');
  const [body, mac] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ s: 'evil', r: '/', e: Date.now() + 1000 })).toString('base64url');
  assert.equal(gh.verify(`${forged}.${mac}`, SECRET), null);
  assert.equal(gh.verify(`${body}.${mac.slice(0, -2)}xx`, SECRET), null);
  assert.equal(gh.verify(v, 'b'.repeat(64)), null);
  assert.equal(gh.verify('garbage', SECRET), null);
  assert.equal(gh.verify(undefined, SECRET), null);
});

test('state check: matching, mismatched, expired', () => {
  const now = Date.now();
  const { setCookie, location } = gh.beginLogin({ clientId: 'id', publicUrl: PUBLIC_URL, secret: SECRET, returnTo: '/x', now });
  const state = new URL(location).searchParams.get('state');
  const value = cookieValue(setCookie);
  assert.equal(gh.checkState({ cookieValue: value, state, secret: SECRET, now }), '/x');
  assert.equal(gh.checkState({ cookieValue: value, state: `${state}x`, secret: SECRET, now }), null);
  assert.equal(gh.checkState({ cookieValue: value, state, secret: SECRET, now: now + 11 * 60 * 1000 }), null);
  assert.equal(gh.checkState({ cookieValue: undefined, state, secret: SECRET, now }), null);
});

test('returnTo only allows relative paths on this site', () => {
  assert.equal(gh.safeReturnTo('/'), '/');
  assert.equal(gh.safeReturnTo('/plan?day=2#x'), '/plan?day=2#x');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, '/\nx']) {
    assert.equal(gh.safeReturnTo(bad), '/', String(bad));
  }
});

// ---------- Login and callback ----------

test('login redirects to GitHub with read:user, the callback URL and a signed state cookie', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/auth/github/login?returnTo=//evil.example`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'client-id');
  assert.equal(loc.searchParams.get('scope'), 'read:user');
  assert.equal(loc.searchParams.get('redirect_uri'), `${PUBLIC_URL}/auth/github/callback`);
  const c = getCookie(res, gh.STATE_COOKIE);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=600/);
  const payload = gh.verify(cookieValue(c), SECRET);
  assert.equal(payload.s, loc.searchParams.get('state'));
  assert.equal(payload.r, '/');
});

test('callback happy path: user upserted, session cookie set, token discarded', async (t) => {
  const app = await start();
  t.after(app.close);
  const { cb, token } = await signIn(app);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/plan?day=2');
  const c = getCookie(cb, gh.SESSION_COOKIE);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${7 * 24 * 3600}`]) assert.ok(c.includes(flag), flag);
  assert.ok(token && token.length >= 40);
  // The GitHub access token appears nowhere: not in cookies, headers or the database.
  assert.ok(!JSON.stringify(cb.headers.getSetCookie()).includes('gho_fake_token'));
  assert.ok(!JSON.stringify([...app.db.users.values()]).includes('gho_fake_token'));
  // Only the hash of the session token is stored.
  assert.ok(app.db.sessions.has(hashToken(token)));
  assert.ok(!app.db.sessions.has(token));
  // Exchange used JSON, the client secret, and the exact callback URL.
  const exchange = app.github.calls[0];
  assert.equal(exchange.init.method, 'POST');
  assert.equal(exchange.init.headers.accept, 'application/json');
  assert.equal(JSON.parse(exchange.init.body).redirect_uri, `${PUBLIC_URL}/auth/github/callback`);
  assert.ok(exchange.init.signal);

  const me = await (await fetch(`${app.base}/api/me`, { headers: { cookie: `${gh.SESSION_COOKIE}=${token}` } })).json();
  assert.deepEqual(me, { enabled: true, user: { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/42' } });
});

test('callback failures redirect to /?login=failed without a session', async (t) => {
  const app = await start();
  t.after(app.close);
  // Wrong code (GitHub answers 200 with an error).
  const { cb } = await signIn(app, { code: 'bad-code' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?login=failed');
  assert.equal(getCookie(cb, gh.SESSION_COOKIE), undefined);
  // State without its cookie.
  const res = await fetch(`${app.base}/auth/github/callback?code=good-code&state=abc`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/?login=failed');
  assert.equal(app.db.users.size, 0);
});

test('logout deletes the session and clears the cookie; cross-site logout is refused', async (t) => {
  const app = await start();
  t.after(app.close);
  const { token } = await signIn(app);
  const cookie = `${gh.SESSION_COOKIE}=${token}`;
  const evil = await fetch(`${app.base}/auth/logout`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(app.db.sessions.size, 1);
  const res = await fetch(`${app.base}/auth/logout`, { method: 'POST', headers: { cookie, origin: PUBLIC_URL } });
  assert.equal(res.status, 204);
  assert.match(getCookie(res, gh.SESSION_COOKIE), /Max-Age=0/);
  assert.equal(app.db.sessions.size, 0);
});

// ---------- /api/me ----------

test('with accounts off, /api/me says so and the other routes 404', async (t) => {
  const app = await start({ enabled: false });
  t.after(app.close);
  const res = await fetch(`${app.base}/api/me`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false, user: null });
  assert.equal((await fetch(`${app.base}/api/me/plan?conferenceId=kubecon-na-2026`)).status, 404);
  const login = await fetch(`${app.base}/auth/github/login`, { redirect: 'manual' });
  assert.equal(login.headers.get('location'), '/?login=unavailable');
});

test('signed out: /api/me has no user, saved plans need sign-in', async (t) => {
  const app = await start();
  t.after(app.close);
  assert.deepEqual(await (await fetch(`${app.base}/api/me`)).json(), { enabled: true, user: null });
  const res = await fetch(`${app.base}/api/me/plan?conferenceId=kubecon-na-2026`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'unauthorized');
});

const savedState = {
  request: { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { includeSponsored: true } },
  pinned: ['kubecon-na-2026:1'],
  skipped: [],
  swaps: [['2026-11-10|2026-11-10T11:30:00-07:00', 'kubecon-na-2026:2']],
  activeDay: '2026-11-10',
  plan: { conferenceId: 'kubecon-na-2026', days: [] },
  profile: { source: 'github', username: 'octocat' },
  extra: 'dropped',
};

test('save and restore a plan; writes need a same-origin request', async (t) => {
  const app = await start();
  t.after(app.close);
  const { token } = await signIn(app);
  const cookie = `${gh.SESSION_COOKIE}=${token}`;
  const put = (headers) => fetch(`${app.base}/api/me/plan`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ conferenceId: 'kubecon-na-2026', state: savedState }),
  });
  assert.equal((await put({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await put({})).status, 403); // no Origin, no Sec-Fetch-Site
  const ok = await put({ origin: PUBLIC_URL });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).savedAt);
  assert.equal((await put({ 'sec-fetch-site': 'same-origin' })).status, 200);

  const got = await (await fetch(`${app.base}/api/me/plan?conferenceId=kubecon-na-2026`, { headers: { cookie } })).json();
  assert.deepEqual(got.state.pinned, ['kubecon-na-2026:1']);
  assert.deepEqual(got.state.swaps, savedState.swaps);
  assert.equal(got.state.extra, undefined);
  assert.ok(got.savedAt);
});

test('saved state validation caps sizes and checks the conference', () => {
  assert.throws(() => validateSavedState({ ...savedState, pinned: Array.from({ length: 101 }, (_, i) => `x:${i}`) }, 'kubecon-na-2026'));
  assert.throws(() => validateSavedState(savedState, 'other-conf'));
  assert.throws(() => validateSavedState({ ...savedState, swaps: [['only-one']] }, 'kubecon-na-2026'));
  assert.throws(() => validateSavedState({ ...savedState, plan: { conferenceId: 'kubecon-na-2026', days: [], big: 'x'.repeat(600 * 1024) } }, 'kubecon-na-2026'), { code: 'payload_too_large' });
  assert.throws(() => validateSavedState([], 'kubecon-na-2026'));
});

// ---------- Social opt-in ----------

test('you can only opt in your own GitHub profile, and only derived signals are stored', async (t) => {
  const app = await start();
  t.after(app.close);
  const { token } = await signIn(app);
  const put = (body) => fetch(`${app.base}/api/me/social`, {
    method: 'PUT',
    headers: { cookie: `${gh.SESSION_COOKIE}=${token}`, 'content-type': 'application/json', origin: PUBLIC_URL },
    body: JSON.stringify({ conferenceId: 'kubecon-na-2026', ...body }),
  });
  const someoneElse = await put({ optIn: true, profile: { source: 'github', username: 'torvalds', tools: [] } });
  assert.equal(someoneElse.status, 403);
  // A profile with nothing in it has nothing to match on.
  const empty = await put({ optIn: true, profile: { source: 'interests', username: null } });
  assert.equal(empty.status, 400);
  assert.equal(app.db.social.size, 0);

  const mine = await put({
    optIn: true,
    profile: {
      source: 'github', username: 'OctoCat', repoCount: 8,
      tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 0.9, evidence: ['octocat/private-thing'] }],
      languages: [{ name: 'Go', weight: 0.6 }], topics: ['gitops'], keywords: ['helm'], code: 'func main() {}',
    },
  });
  assert.equal(mine.status, 200);
  const stored = [...app.db.social.values()][0].profile;
  assert.deepEqual(stored, { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 0.9 }], languages: [{ name: 'Go', weight: 0.6 }], topics: ['gitops'], keywords: ['helm'] });
  assert.ok(!JSON.stringify(stored).includes('private-thing'));

  // GitHub plus typed interests is still your own profile; someone else's is not.
  assert.equal((await put({ optIn: true, profile: { source: 'github+interests', username: 'octocat', tools: [] } })).status, 200);
  assert.equal((await put({ optIn: true, profile: { source: 'github+interests', username: 'torvalds', tools: [] } })).status, 403);

  const out = await put({ optIn: false });
  assert.equal(out.status, 200);
  assert.equal(app.db.social.size, 0);
});

test('LinkedIn-pasted signals can be opted in: derived labels and weights only, never the text', async (t) => {
  const app = await start();
  t.after(app.close);
  const { token } = await signIn(app);
  const put = (body) => fetch(`${app.base}/api/me/social`, {
    method: 'PUT',
    headers: { cookie: `${gh.SESSION_COOKIE}=${token}`, 'content-type': 'application/json', origin: PUBLIC_URL },
    body: JSON.stringify({ conferenceId: 'kubecon-na-2026', ...body }),
  });
  const raw = 'Avery Quill\nSenior Platform Engineer at Northwind\n500+ connections\nSkills\nKubernetes';
  const linkedin = {
    source: 'interests', pastedFrom: 'linkedin', username: null, displayName: 'You',
    tools: [{ name: 'kubernetes', label: 'Kubernetes', weight: 1, evidence: [] }, { name: 'crossplane', label: 'Crossplane', weight: 0.6, evidence: [] }],
    languages: [{ name: 'Go', weight: 1 }], topics: ['platform engineering'], keywords: ['aws'],
    interests: raw, text: raw, // a client must never send these, but if one does they are not stored
  };

  // No checkbox beyond the opt-in itself: a pasted profile with no username is taken as yours.
  assert.equal((await put({ optIn: true, profile: linkedin })).status, 200);
  let stored = [...app.db.social.values()][0].profile;
  assert.deepEqual(stored, {
    tools: [{ name: 'kubernetes', label: 'Kubernetes', weight: 1 }, { name: 'crossplane', label: 'Crossplane', weight: 0.6 }],
    languages: [{ name: 'Go', weight: 1 }], topics: ['platform engineering'], keywords: [],
  });
  for (const s of ['Avery', 'Northwind', 'connections', 'pastedFrom']) assert.ok(!JSON.stringify(stored).includes(s), s);

  // Blended with your own GitHub: stored together; the username must still be yours.
  const blended = { ...linkedin, source: 'github+interests', username: 'octocat', tools: [...linkedin.tools, { name: 'argo-cd', label: 'Argo CD', weight: 0.8, evidence: ['octocat/deploy'] }] };
  assert.equal((await put({ optIn: true, profile: blended })).status, 200);
  stored = [...app.db.social.values()][0].profile;
  assert.deepEqual(stored.tools.map((x) => x.name), ['kubernetes', 'crossplane', 'argo-cd']);
  assert.deepEqual(stored.keywords, []);
  assert.ok(!JSON.stringify(stored).includes('octocat/deploy'));
  assert.equal((await put({ optIn: true, profile: { ...blended, username: 'torvalds' } })).status, 403);
  assert.equal((await put({ optIn: true, profile: { ...linkedin, username: 'torvalds' } })).status, 403);
  assert.equal(app.db.social.size, 1);
});

test('deriveSocialProfile caps list sizes and clamps weights', () => {
  const p = deriveSocialProfile({ tools: Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, weight: 5 })), topics: Array(50).fill('k8s') });
  assert.equal(p.tools.length, 15);
  assert.equal(p.tools[0].weight, 1);
  assert.equal(p.topics.length, 30);
});

// ---------- Database outage and migrations ----------

test('a database outage answers 503 on account routes and never touches /readyz', async (t) => {
  const db = fakeDb();
  db.getSessionUser = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  const app = await start({ db });
  t.after(app.close);
  const res = await fetch(`${app.base}/api/me`, { headers: { cookie: `${gh.SESSION_COOKIE}=${'x'.repeat(43)}` } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'unavailable');
  assert.equal((await fetch(`${app.base}/readyz`)).status, 200);
});

test('connections logs session lookup failures and continues as signed out', async (t) => {
  const db = fakeDb();
  const app = await start({ db, connections: { env: {} } });
  t.after(app.close);
  const { token } = await signIn(app);
  db.getSessionUser = async () => { throw Object.assign(new Error('sensitive database detail'), { code: 'ECONNREFUSED' }); };

  const original = console.error;
  const logged = [];
  console.error = (message) => logged.push(message);
  t.after(() => { console.error = original; });

  const res = await fetch(`${app.base}/api/connections`, {
    method: 'POST',
    headers: { cookie: `${gh.SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      conferenceId: 'kubecon-na-2026',
      profile: { username: null, tools: [{ name: 'argo-cd', weight: 1 }], languages: [], topics: [], keywords: [] },
      limit: 20,
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).demoData, true);
  assert.deepEqual(logged, ['POST /api/connections session lookup failed: ECONNREFUSED']);
});

test('migrations are idempotent and run under an advisory lock', async () => {
  for (const stmt of MIGRATION_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    assert.match(stmt, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, stmt.slice(0, 60));
  }
  for (const table of ['users', 'sessions', 'saved_plans', 'social_profiles']) assert.match(MIGRATION_SQL, new RegExp(`TABLE IF NOT EXISTS ${table} `));
  assert.doesNotMatch(MIGRATION_SQL, /access_token|token\s+text/i);

  const log = [];
  let fail = true;
  const client = { query: async (sql, params) => { log.push([sql.trim().slice(0, 40), params]); if (fail && sql === MIGRATION_SQL) { fail = false; throw new Error('db starting'); } }, release: () => log.push(['release']) };
  const db = createDb({ connect: async () => client, query: async () => ({ rows: [] }) });
  await assert.rejects(db.ready());
  assert.deepEqual(log.map((l) => l[0]).filter((x) => /advisory|release/.test(x)), ['SELECT pg_advisory_lock($1)', 'SELECT pg_advisory_unlock($1)', 'release']);
  await db.ready(); // retried after the failure
  await db.ready(); // memoized: no third run
  assert.equal(log.filter((l) => l[0].startsWith('SELECT pg_advisory_lock')).length, 2);
});

// ---------- Real opted-in attendees in "People to meet" ----------

test('real opted-in users join the candidates, marked demo: false, without the requester', async () => {
  const { suggestConnections } = require('../social');
  const profile = { username: 'octocat', tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 0.9 }], languages: [], topics: [], keywords: [] };
  const realAttendees = async () => [
    { userId: '1', login: 'octocat', displayName: 'Me', profile: { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 1 }] } },
    { userId: '2', login: 'hubot', displayName: 'Hubot', profile: { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 0.8 }] } },
  ];
  const result = await suggestConnections(
    { conferenceId: 'kubecon-na-2026', profile, limit: 20 },
    { attendees: [], realAttendees, env: {}, viewer: { id: '1' } },
  );
  assert.deepEqual(result.connections.map((c) => c.attendee.handle), ['hubot']);
  assert.equal(result.connections[0].attendee.demo, false);
});

test('only signed-in callers can see real opted-in attendees', async (t) => {
  let realAttendeeReads = 0;
  const app = await start({
    connections: {
      env: {},
      realAttendees: async () => {
        realAttendeeReads += 1;
        return [
          { userId: '1', login: 'octocat', displayName: 'Me', profile: { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 1 }] } },
          { userId: '2', login: 'opted-real-only', displayName: 'Opted Real Only', profile: { tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 0.8 }] } },
        ];
      },
    },
  });
  t.after(app.close);

  const profile = { username: null, tools: [{ name: 'argo-cd', weight: 1 }], languages: [], topics: [], keywords: [] };
  const request = (token) => fetch(`${app.base}/api/connections`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `${gh.SESSION_COOKIE}=${token}` } : {}),
    },
    body: JSON.stringify({ conferenceId: 'kubecon-na-2026', profile, limit: 20 }),
  });

  const anonymous = await request();
  assert.equal(anonymous.status, 200);
  const anonymousBody = await anonymous.json();
  assert.equal(realAttendeeReads, 0);
  assert.ok(!JSON.stringify(anonymousBody).includes('opted-real-only'));

  const { token } = await signIn(app);
  const signedIn = await request(token);
  assert.equal(signedIn.status, 200);
  const signedInBody = await signedIn.json();
  assert.equal(realAttendeeReads, 1);
  const realMatches = signedInBody.connections.filter((c) => c.attendee.demo === false);
  assert.deepEqual(realMatches.map((c) => c.attendee.handle), ['opted-real-only']);
});
