const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { validatePlanRequest } = require('../api/plan');
const { resolveStatic, PUBLIC_DIR } = require('../api/static');
const { buildProfile, ProfileError } = require('../profile');
const { buildPlan } = require('../planner');

// Starts the app on an ephemeral port with the given profile/planner functions.
async function start(deps = {}) {
  const server = http.createServer(createHandler({ buildProfile, buildPlan, ...deps }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function postPlan(base, body, headers = { 'content-type': 'application/json' }) {
  return fetch(`${base}/api/plan`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

// Raw request, so paths like /../ are not normalized by the client.
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('healthz and readyz answer ok', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const path of ['/healthz', '/readyz']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok\n');
  }
});

test('GET / serves the UI with security headers', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('referrer-policy'));
  assert.match(await res.text(), /Switchback/);
  const js = await fetch(`${app.base}/app.js`);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.match(js.headers.get('cache-control'), /max-age=300/);
});

test('static files block traversal, hidden files and unknown types', async (t) => {
  const app = await start();
  t.after(app.close);
  for (const path of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2fpackage.json', '/package.json', '/.env', '/nope.html', '/%E0%A4%A']) {
    const status = await rawGet(app.base, path);
    assert.ok(status === 404 || status === 400, `${path} gave ${status}`);
  }
  assert.equal(resolveStatic('/../server.js'), null);
  assert.equal(resolveStatic('/a\0.html'), null);
  assert.equal(resolveStatic('/'), `${PUBLIC_DIR}/index.html`);
  assert.equal(resolveStatic('/account'), `${PUBLIC_DIR}/account.html`);
  assert.equal(resolveStatic('/account/'), null); // exact match only
  assert.equal(resolveStatic('/account/../server.js'), null);
});

test('GET /account serves the account page with the CSP and no inline scripts', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/account`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await res.text();
  assert.match(html, /<script type="module" src="\/account-page.js"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/); // every script is external
  assert.doesNotMatch(html, /\son[a-z]+=|style="/); // no inline handlers or styles
  assert.equal((await fetch(`${app.base}/account-page.js`)).status, 200);
});

test('GET /api/conferences lists the snapshot', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/conferences`);
  assert.equal(res.status, 200);
  const { conferences } = await res.json();
  const kc = conferences.find((c) => c.id === 'kubecon-na-2026');
  assert.ok(kc);
  assert.equal(kc.timezone, 'America/Denver');
  assert.ok(kc.sessionCount > 0);
});

test('POST /api/plan returns a profile and a plan (stubs, offline)', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', interests: 'argo cd, opentelemetry', options: { days: ['2026-11-10'] } });
  assert.equal(res.status, 200);
  const { profile, plan } = await res.json();
  assert.equal(profile.source, 'interests');
  assert.equal(plan.conferenceId, 'kubecon-na-2026');
  assert.deepEqual(plan.days.map((d) => d.date), ['2026-11-10']);
});

test('POST /api/plan validates input', async (t) => {
  const app = await start();
  t.after(app.close);
  const cases = [
    { conferenceId: 'kubecon-na-2026' },
    { conferenceId: 'kubecon-na-2026', github: '', interests: '' },
    { conferenceId: 'kubecon-na-2026', github: 'not a user!', interests: 'rust' },
    { conferenceId: 'Bad Id!', github: 'octocat' },
    { conferenceId: 'kubecon-na-2026', github: '-octocat' },
    { conferenceId: 'kubecon-na-2026', github: 'a'.repeat(40) },
    { conferenceId: 'kubecon-na-2026', interests: 'x'.repeat(10001) }, // over the pasted-profile limit
    { conferenceId: 'kubecon-na-2026', interests: '   ' },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: [] },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { days: ['tomorrow'] } },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { levels: ['Expert'] } },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { breakMinutes: -5 } },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { firstTimer: 'yes' } },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { pinned: ['<script>'] } },
    { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { surprise: true } },
  ];
  for (const body of cases) {
    const res = await postPlan(app.base, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const { error } = await res.json();
    assert.equal(error.code, 'invalid_input');
    assert.equal(typeof error.message, 'string');
  }
  const notJson = await postPlan(app.base, '{nope');
  assert.equal(notJson.status, 400);
  const wrongType = await postPlan(app.base, '{}', { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  const tooBig = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', interests: 'x', pad: 'y'.repeat(33 * 1024) });
  assert.equal(tooBig.status, 413);
  const get = await fetch(`${app.base}/api/plan`);
  assert.equal(get.status, 405);
});

test('validatePlanRequest keeps only known, valid options', () => {
  const out = validatePlanRequest({
    conferenceId: 'kubecon-na-2026',
    github: 'octo-cat',
    options: { days: ['2026-11-10', '2026-11-10'], levels: ['Beginner'], pinned: ['kubecon-na-2026:1335605'], breakMinutes: 10, includeSponsored: false, firstTimer: true },
  });
  assert.equal(out.github, 'octo-cat');
  assert.deepEqual(out.options.days, ['2026-11-10']);
  assert.equal(out.options.breakMinutes, 10);
});

test('unknown conference is a 404 before any GitHub call', async (t) => {
  let called = false;
  const app = await start({ buildProfile: async () => { called = true; } });
  t.after(app.close);
  const res = await postPlan(app.base, { conferenceId: 'no-such-conf', github: 'octocat' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
  assert.equal(called, false);
});

test('profile and planner error codes map to HTTP statuses', async (t) => {
  const expected = { not_found: 404, rate_limited: 429, upstream: 502, invalid_input: 400 };
  for (const [code, status] of Object.entries(expected)) {
    const app = await start({ buildProfile: async () => { throw new ProfileError(code, `profile says ${code}`); } });
    const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', github: 'octocat' });
    assert.equal(res.status, status, code);
    const { error } = await res.json();
    assert.equal(error.code, code);
    if (code === 'upstream') assert.doesNotMatch(error.message, /profile says/);
    await app.close();
  }
  const app = await start({
    buildPlan: async () => {
      const err = new Error('planner failed');
      err.code = 'upstream';
      throw err;
    },
  });
  t.after(app.close);
  const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', interests: 'rust' });
  assert.equal(res.status, 502);
});

test('unexpected errors become a generic 500', async (t) => {
  const app = await start({ buildPlan: async () => { throw new Error('secret internal detail at /app/planner'); } });
  t.after(app.close);
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', interests: 'rust' });
  assert.equal(res.status, 500);
  const { error } = await res.json();
  assert.equal(error.code, 'internal');
  assert.doesNotMatch(error.message, /secret|planner/);
});

test('unknown API routes are JSON 404s', async (t) => {
  const app = await start();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

test('POST /api/plan accepts a GitHub username and interests together', async (t) => {
  const seen = [];
  const app = await start({
    buildProfile: async (input) => {
      seen.push(input);
      return { source: 'github+interests', username: 'octocat', tools: [], languages: [], topics: [], keywords: ['chess'] };
    },
  });
  t.after(app.close);
  const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', github: 'octocat', interests: 'rust, chess', options: { days: ['2026-11-10'] } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.profile.source, 'github+interests');
  assert.equal(body.warnings, undefined);
  assert.deepEqual(seen, [{ github: 'octocat', interests: 'rust, chess' }]);
  assert.deepEqual(validatePlanRequest({ conferenceId: 'kubecon-na-2026', github: 'octocat', interests: ' rust ' }), {
    conferenceId: 'kubecon-na-2026', github: 'octocat', interests: 'rust', options: {},
  });
});

test('with both inputs, a GitHub failure falls back to the interests with a warning', async (t) => {
  const expected = { rate_limited: 'github_rate_limited', not_found: 'github_not_found', upstream: 'github_unavailable' };
  for (const [code, warning] of Object.entries(expected)) {
    const seen = [];
    const app = await start({
      buildProfile: async (input) => {
        seen.push(input);
        if (input.github) throw new ProfileError(code, `github says ${code}`);
        return buildProfile(input);
      },
    });
    const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', github: 'octocat', interests: 'argo cd, rust', options: { days: ['2026-11-10'] } });
    assert.equal(res.status, 200, code);
    const body = await res.json();
    assert.deepEqual(body.warnings, [warning]);
    assert.equal(body.profile.source, 'interests');
    assert.ok(body.profile.tools.some((tool) => tool.name === 'argo-cd'));
    assert.deepEqual(seen, [{ github: 'octocat', interests: 'argo cd, rust' }, { interests: 'argo cd, rust' }]);
    await app.close();
  }
  // Interests with nothing usable: the GitHub error, not a confusing 400.
  const punct = await start({
    buildProfile: async (input) => {
      if (input.github) throw new ProfileError('rate_limited', 'GitHub rate limit reached');
      return buildProfile(input);
    },
  });
  const punctRes = await postPlan(punct.base, { conferenceId: 'kubecon-na-2026', github: 'octocat', interests: ',' });
  assert.equal(punctRes.status, 429);
  await punct.close();
  // Other errors are not swallowed, and GitHub alone still fails as before.
  const app = await start({ buildProfile: async () => { throw new ProfileError('invalid_input', 'nope'); } });
  t.after(app.close);
  const res = await postPlan(app.base, { conferenceId: 'kubecon-na-2026', github: 'octocat', interests: 'rust' });
  assert.equal(res.status, 400);
});
