// Private repos through the read-only GitHub App: state, the callback, the
// token never persisted, user mismatch, anonymized evidence, the plan merge
// only for the owner, and the feature off without its env. No network, no
// database: fakes for GitHub and Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { createAccounts, accountsFromEnv } = require('../auth');
const gh = require('../auth/github');
const ghApp = require('../auth/github-app');
const { hashToken } = require('../db');
const { mergePrivate, pickPrivateRepos, buildPrivateProfile, PRIVATE_EVIDENCE } = require('../profile/private');

const SECRET = 'a'.repeat(64);
const PUBLIC_URL = 'https://planner.example';
const APP = { clientId: 'Iv23li-app-client', clientSecret: 'app-client-secret', slug: 'switchback-test' };
const USER_TOKEN = 'ghu_SECRET_user_token_123';
const PRIVATE_NAME = 'octocat/top-secret-launch';

function fakeDb() {
  const users = new Map();
  const sessions = new Map();
  const privateProfiles = new Map();
  const writes = []; // every write, to check the token never reaches the database
  let nextId = 1;
  return {
    users, sessions, privateProfiles, writes,
    enabled: true,
    async ready() {},
    async upsertUser(g) {
      writes.push(JSON.stringify(g));
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
    async deleteSession() {},
    async getPrivateProfile(userId) { return privateProfiles.get(userId) || null; },
    async setPrivateProfile(userId, profile) {
      writes.push(JSON.stringify(profile));
      const scannedAt = new Date().toISOString();
      privateProfiles.set(userId, { profile: JSON.parse(JSON.stringify(profile)), scannedAt });
      return scannedAt;
    },
    async deletePrivateProfile(userId) { privateProfiles.delete(userId); },
    async listOptedInProfiles() { return []; },
  };
}

// GitHub: sign-in OAuth, the App's OAuth, /user, installations, tree, contents.
function fakeGithub({ appUserId = 42 } = {}) {
  const calls = [];
  const signInUser = { id: 42, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/42' };
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const auth = init.headers?.authorization || init.headers?.Authorization;
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(init.body);
      if (body.client_id === 'client-id' && body.code === 'good-code') return Response.json({ access_token: 'gho_signin' });
      if (body.client_id === APP.clientId && body.client_secret === APP.clientSecret && body.code === 'app-code') {
        return Response.json({ access_token: USER_TOKEN, token_type: 'bearer' });
      }
      return Response.json({ error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user') {
      if (auth === 'Bearer gho_signin') return Response.json(signInUser);
      if (auth === `Bearer ${USER_TOKEN}`) return Response.json({ ...signInUser, id: appUserId });
      return new Response('{}', { status: 401 });
    }
    if (auth !== `Bearer ${USER_TOKEN}`) return new Response('{}', { status: 401 });
    if (url.startsWith('https://api.github.com/user/installations?')) return Response.json({ installations: [{ id: 7 }] });
    if (url.startsWith('https://api.github.com/user/installations/7/repositories')) {
      return Response.json({
        repositories: [
          { full_name: PRIVATE_NAME, name: 'top-secret-launch', private: true, default_branch: 'main', size: 10, language: 'Go', pushed_at: '2026-11-01T00:00:00Z', topics: ['secret-codename'] },
          { full_name: 'octocat/public-thing', name: 'public-thing', private: false, default_branch: 'main', size: 10, language: 'Rust', pushed_at: '2026-11-02T00:00:00Z' },
          { full_name: 'octocat/old-fork', private: true, fork: true, size: 10, pushed_at: '2026-11-03T00:00:00Z' },
        ],
      });
    }
    if (url.startsWith(`https://api.github.com/repos/${PRIVATE_NAME}/git/trees/main`)) {
      return Response.json({ tree: [{ path: 'go.mod', type: 'blob' }, { path: 'README.md', type: 'blob' }] });
    }
    if (url.startsWith(`https://api.github.com/repos/${PRIVATE_NAME}/contents/go.mod?ref=main`)) {
      assert.equal(init.headers.Accept, 'application/vnd.github.raw');
      return new Response('module x\nrequire (\n github.com/argoproj/argo-cd/v2 v2.9.0\n)\n');
    }
    if (url.startsWith(`https://api.github.com/repos/${PRIVATE_NAME}/contents/README.md`)) {
      return new Response('# Top secret launch\nProject Nightjar uses OpenTelemetry.');
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, calls };
}

async function start({ db = fakeDb(), github = fakeGithub(), githubApp = APP } = {}) {
  const accounts = createAccounts({
    db, clientId: 'client-id', clientSecret: 'client-secret', sessionSecret: SECRET, publicUrl: PUBLIC_URL, fetch: github.fetch, githubApp,
  });
  const buildProfile = async ({ github: login }) => ({
    source: 'github', username: login, displayName: login, avatarUrl: null, repoCount: 1,
    languages: [{ name: 'Rust', weight: 1 }], tools: [{ name: 'helm', label: 'Helm', weight: 0.5, evidence: [`${login}/public-thing`] }],
    topics: [], keywords: [], generatedAt: '2026-11-09T21:00:00Z',
  });
  const buildPlan = async ({ conferenceId }) => ({ conferenceId, days: [] });
  const server = http.createServer(createHandler({ buildProfile, buildPlan, accounts }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, github, accounts, close: () => new Promise((resolve) => server.close(resolve)) };
}

const getCookie = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (setCookie) => setCookie.split(';')[0].split('=').slice(1).join('=');

async function signIn(app) {
  const login = await fetch(`${app.base}/auth/github/login?returnTo=/`, { redirect: 'manual' });
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cb = await fetch(`${app.base}/auth/github/callback?code=good-code&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: `${gh.STATE_COOKIE}=${cookieValue(getCookie(login, gh.STATE_COOKIE))}` },
  });
  return `${gh.SESSION_COOKIE}=${cookieValue(getCookie(cb, gh.SESSION_COOKIE))}`;
}

// Starts the App flow and returns { state, cookie } for the callback.
async function beginApp(app, session, query = '') {
  const res = await fetch(`${app.base}/auth/github-app/install?returnTo=/${query}`, { redirect: 'manual', headers: { cookie: session } });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  return { location, state: location.searchParams.get('state'), cookie: `${ghApp.STATE_COOKIE}=${cookieValue(getCookie(res, ghApp.STATE_COOKIE))}` };
}

function callback(app, session, { state, cookie }, code = 'app-code') {
  return fetch(`${app.base}/auth/github-app/callback?code=${code}&installation_id=7&setup_action=install&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: `${session}; ${cookie}` },
  });
}

// Captures console output during fn.
async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

// ---------- Feature switch ----------

test('feature is off without all three GitHub App values', async (t) => {
  const base = { DATABASE_URL: '', GITHUB_OAUTH_CLIENT_ID: 'x', GITHUB_OAUTH_CLIENT_SECRET: 'y', SESSION_SECRET: SECRET, PUBLIC_URL };
  assert.equal(accountsFromEnv(base).privateRepos, false);
  const db = fakeDb();
  const ok = (githubApp) => createAccounts({ db, clientId: 'c', clientSecret: 's', sessionSecret: SECRET, publicUrl: PUBLIC_URL, githubApp }).privateRepos;
  assert.equal(ok(APP), true);
  assert.equal(ok({ ...APP, slug: '' }), false);
  assert.equal(ok({ ...APP, clientSecret: '' }), false);
  assert.equal(ok({ ...APP, slug: 'Bad/Slug' }), false);
  assert.equal(ok(undefined), false);

  const app = await start({ githubApp: null });
  t.after(app.close);
  const session = await signIn(app);
  const me = await (await fetch(`${app.base}/api/me`, { headers: { cookie: session } })).json();
  assert.deepEqual(me.privateRepos, { enabled: false });
  const res = await fetch(`${app.base}/auth/github-app/install?returnTo=/`, { redirect: 'manual', headers: { cookie: session } });
  assert.equal(res.headers.get('location'), '/?private=unavailable');
});

// ---------- State ----------

test('app state: matching, mismatched, expired, tampered', () => {
  const now = Date.now();
  const { setCookie, location } = ghApp.beginAppFlow({ ...APP, publicUrl: PUBLIC_URL, secret: SECRET, returnTo: '/x', userId: '1', now });
  assert.match(location, /^https:\/\/github\.com\/apps\/switchback-test\/installations\/new\?state=/);
  assert.match(setCookie, /Path=\/auth\/github-app; HttpOnly; Secure; SameSite=Lax/);
  const state = new URL(location).searchParams.get('state');
  const value = cookieValue(setCookie);
  assert.deepEqual(ghApp.checkAppState({ cookieValue: value, state, secret: SECRET, now }), { returnTo: '/x', userId: '1', mode: 'install' });
  assert.equal(ghApp.checkAppState({ cookieValue: value, state: `${state}x`, secret: SECRET, now }), null);
  assert.equal(ghApp.checkAppState({ cookieValue: value, state, secret: SECRET, now: now + 11 * 60 * 1000 }), null);
  assert.equal(ghApp.checkAppState({ cookieValue: value, state, secret: 'b'.repeat(64), now }), null);
  assert.equal(ghApp.checkAppState({ cookieValue: undefined, state, secret: SECRET, now }), null);

  const auth = ghApp.beginAppFlow({ ...APP, publicUrl: PUBLIC_URL, secret: SECRET, returnTo: '/', userId: '1', mode: 'auth', now });
  const u = new URL(auth.location);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), APP.clientId);
  assert.equal(u.searchParams.get('redirect_uri'), `${PUBLIC_URL}/auth/github-app/callback`);
  assert.equal(u.searchParams.get('scope'), null); // GitHub App permissions, not OAuth scopes
});

test('install needs a Switchback session first', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/auth/github-app/install?returnTo=/`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/auth/github/login?returnTo=%2F');
  const session = await signIn(app);
  const { location } = await beginApp(app, session);
  assert.equal(location.origin + location.pathname, 'https://github.com/apps/switchback-test/installations/new');
  const rescan = await beginApp(app, session, '&mode=rescan');
  assert.equal(rescan.location.pathname, '/login/oauth/authorize');
});

test('callback rejects a bad state, another session, and no session', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  const flow = await beginApp(app, session);
  const bad = await callback(app, session, { ...flow, state: `${flow.state}x` });
  assert.equal(bad.headers.get('location'), '/?private=failed');
  const noSession = await fetch(`${app.base}/auth/github-app/callback?code=app-code&state=${flow.state}`, { redirect: 'manual', headers: { cookie: flow.cookie } });
  assert.match(noSession.headers.get('location'), /^\/auth\/github\/login/);
  assert.equal(app.db.privateProfiles.size, 0);
  assert.ok(!app.github.calls.some((c) => c.url.includes('oauth/access_token') && JSON.parse(c.init.body).client_id === APP.clientId));
});

test('installed without a code: falls back to the OAuth authorize URL', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  const flow = await beginApp(app, session);
  const res = await fetch(`${app.base}/auth/github-app/callback?installation_id=7&setup_action=update&state=${flow.state}`, {
    redirect: 'manual', headers: { cookie: `${session}; ${flow.cookie}` },
  });
  assert.match(res.headers.get('location'), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
});

// ---------- The scan ----------

test('scan stores derived signals only; the token and private names go nowhere', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  const flow = await beginApp(app, session);
  const { result: res, lines } = await captureLogs(() => callback(app, session, flow));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?private=ready');
  assert.match(getCookie(res, ghApp.STATE_COOKIE), /Max-Age=0/);

  // The App's client id and secret were used, and the span name is the App's.
  const exchange = app.github.calls.find((c) => c.url.includes('oauth/access_token') && JSON.parse(c.init.body).client_id === APP.clientId);
  assert.ok(exchange.init.signal);
  // Private files came through the contents API, never raw.githubusercontent.com.
  assert.ok(app.github.calls.some((c) => c.url.includes(`/repos/${PRIVATE_NAME}/contents/go.mod`)));
  assert.ok(!app.github.calls.some((c) => c.url.includes('raw.githubusercontent.com')));
  // The public repo and the fork were not scanned with the user token.
  assert.ok(!app.github.calls.some((c) => c.url.includes('public-thing') || c.url.includes('old-fork')));

  const stored = app.db.privateProfiles.get('1');
  assert.ok(stored);
  assert.equal(stored.profile.repoCount, 1);
  assert.ok(stored.profile.tools.some((x) => x.name === 'argo-cd'));
  assert.deepEqual(Object.keys(stored.profile).sort(), ['languages', 'repoCount', 'tools']);
  const everything = [...app.db.writes, ...lines, res.headers.get('location'), ...res.headers.getSetCookie()].join('\n');
  assert.ok(!everything.includes(USER_TOKEN), 'token persisted or logged');
  assert.ok(!everything.includes('top-secret'), 'private repo name persisted or logged');
  assert.ok(!everything.includes('Nightjar'), 'README text persisted');
  assert.ok(!everything.includes('secret-codename'), 'private topic persisted');

  // /api/me reports a count and a time, never names.
  const me = await (await fetch(`${app.base}/api/me`, { headers: { cookie: session } })).json();
  assert.equal(me.privateRepos.enabled, true);
  assert.equal(me.privateRepos.repoCount, 1);
  assert.ok(me.privateRepos.scannedAt);
});

test('a token for another GitHub user is rejected', async (t) => {
  const app = await start({ github: fakeGithub({ appUserId: 999 }) });
  t.after(app.close);
  const session = await signIn(app);
  const flow = await beginApp(app, session);
  const res = await callback(app, session, flow);
  assert.equal(res.headers.get('location'), '/?private=mismatch');
  assert.equal(app.db.privateProfiles.size, 0);
  assert.ok(!app.github.calls.some((c) => c.url.includes('/user/installations')));
});

test('a failed exchange stores nothing', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  const flow = await beginApp(app, session);
  const res = await callback(app, session, flow, 'bad-code');
  assert.equal(res.headers.get('location'), '/?private=failed');
  assert.equal(app.db.privateProfiles.size, 0);
});

// ---------- Using it ----------

test('POST /api/plan merges private signals only for the signed-in owner', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  await callback(app, session, await beginApp(app, session));
  const plan = (github, cookie) => fetch(`${app.base}/api/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ conferenceId: 'kubecon-na-2026', github }),
  }).then((r) => r.json());

  const mine = (await plan('octocat', session)).profile;
  assert.equal(mine.privateRepos, 1);
  const argo = mine.tools.find((x) => x.name === 'argo-cd');
  assert.deepEqual(argo.evidence, [PRIVATE_EVIDENCE]);
  assert.ok(!JSON.stringify(mine).includes('top-secret'));

  const someoneElse = (await plan('torvalds', session)).profile;
  assert.equal(someoneElse.privateRepos, undefined);
  assert.ok(!someoneElse.tools.some((x) => x.name === 'argo-cd'));
  const signedOut = (await plan('octocat')).profile;
  assert.equal(signedOut.privateRepos, undefined);
});

test('forget my private-repo signals: same-origin DELETE', async (t) => {
  const app = await start();
  t.after(app.close);
  const session = await signIn(app);
  await callback(app, session, await beginApp(app, session));
  assert.equal(app.db.privateProfiles.size, 1);
  const evil = await fetch(`${app.base}/api/me/private-profile`, { method: 'DELETE', headers: { cookie: session, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(app.db.privateProfiles.size, 1);
  const res = await fetch(`${app.base}/api/me/private-profile`, { method: 'DELETE', headers: { cookie: session, origin: PUBLIC_URL } });
  assert.equal(res.status, 200);
  assert.equal(app.db.privateProfiles.size, 0);
  const signedOut = await fetch(`${app.base}/api/me/private-profile`, { method: 'DELETE', headers: { origin: PUBLIC_URL } });
  assert.equal(signedOut.status, 401);
});

// ---------- Pure helpers ----------

test('mergePrivate anonymizes evidence and keeps labels only', () => {
  const profile = {
    source: 'github', username: 'octocat',
    tools: [{ name: 'helm', label: 'Helm', weight: 0.4, evidence: ['octocat/charts'] }],
    languages: [{ name: 'Rust', weight: 1 }],
  };
  const stored = {
    tools: [{ name: 'helm', label: 'Helm', weight: 0.9, evidence: ['octocat/secret'] }, { name: 'argo-cd', label: 'Argo CD', weight: 1 }],
    languages: [{ name: 'Go', weight: 1 }],
    repoCount: 3,
    names: ['octocat/secret'],
  };
  const out = mergePrivate(profile, stored);
  assert.equal(out.privateRepos, 3);
  assert.deepEqual(out.tools.find((x) => x.name === 'helm'), { name: 'helm', label: 'Helm', weight: 0.9, evidence: ['octocat/charts', PRIVATE_EVIDENCE] });
  assert.deepEqual(out.tools.find((x) => x.name === 'argo-cd').evidence, [PRIVATE_EVIDENCE]);
  assert.ok(out.languages.some((l) => l.name === 'Go'));
  assert.ok(!JSON.stringify(out).includes('octocat/secret'));
  assert.equal(profile.privateRepos, undefined); // input unchanged
  assert.equal(mergePrivate(profile, null), profile);
  assert.equal(mergePrivate(profile, { repoCount: 0 }), profile);
});

test('only private, non-fork, non-archived, non-empty repos are picked, newest first', () => {
  const picked = pickPrivateRepos([
    { full_name: 'a/old', private: true, size: 1, pushed_at: '2026-01-01' },
    { full_name: 'a/new', private: true, size: 1, pushed_at: '2026-06-01' },
    { full_name: 'a/internal', visibility: 'internal', size: 1, pushed_at: '2026-03-01' },
    { full_name: 'a/pub', private: false, visibility: 'public', size: 1 },
    { full_name: 'a/fork', private: true, fork: true, size: 1 },
    { full_name: 'a/arch', private: true, archived: true, size: 1 },
    { full_name: 'a/empty', private: true, size: 0 },
  ]);
  assert.deepEqual(picked.map((r) => r.full_name), ['a/new', 'a/internal', 'a/old']);
});

test('buildPrivateProfile with no private repos makes no GitHub calls', async () => {
  let calls = 0;
  const out = await buildPrivateProfile({ login: 'x', repos: [{ full_name: 'x/pub', private: false, size: 1 }], token: USER_TOKEN }, { fetch: async () => { calls += 1; } });
  assert.deepEqual(out, { tools: [], languages: [], repoCount: 0 });
  assert.equal(calls, 0);
});

test('private-scan requests are marked so the automatic HTTP spans skip their URLs', async () => {
  const { isPrivateRequest } = require('../telemetry');
  assert.equal(isPrivateRequest({ headers: 'accept: x\r\nx-switchback-private: 1\r\n' }), true);
  assert.equal(isPrivateRequest({ headers: ['accept', 'x', 'X-Switchback-Private', '1'] }), true);
  assert.equal(isPrivateRequest({ headers: 'accept: x\r\n' }), false);
  assert.equal(isPrivateRequest({}), false);

  const app = await start();
  try {
    const session = await signIn(app);
    await callback(app, session, await beginApp(app, session));
    const scanCalls = app.github.calls.filter((c) => c.url.includes('/user/installations') || c.url.includes('/repos/'));
    assert.ok(scanCalls.length >= 3);
    for (const c of scanCalls) {
      const h = c.init.headers || {};
      assert.equal(h['x-switchback-private'] || h['X-Switchback-Private'], '1', c.url.replace(/repos\/[^?]*/, 'repos/…'));
    }
  } finally {
    await app.close();
  }
});
