const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHandler } = require('../api/router');
const { dash0WebConfig } = require('../api/rum');

const TOKEN = 'auth_test-web-token-123';

async function start(rumEnv) {
  const server = http.createServer(createHandler({ rumEnv }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Evaluates the /config.js module body and returns its default export.
function evalConfig(source) {
  assert.match(source, /^export default /);
  return JSON.parse(source.replace(/^export default /, '').replace(/;\s*$/, ''));
}

test('GET /config.js without the token answers dash0: null and no token', async (t) => {
  const app = await start({});
  t.after(app.close);
  const res = await fetch(`${app.base}/config.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.deepEqual(evalConfig(body), { dash0: null });
  assert.doesNotMatch(body, /auth_/);
});

test('GET /config.js with the token answers the Dash0 Web SDK settings', async (t) => {
  const app = await start({
    DASH0_WEB_AUTH_TOKEN: TOKEN,
    DASH0_WEB_ENDPOINT: 'https://ingress.us-west-2.aws.dash0.com',
    APP_VERSION: 'abc1234',
    NODE_ENV: 'production',
  });
  t.after(app.close);
  const res = await fetch(`${app.base}/config.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(evalConfig(await res.text()), {
    dash0: {
      url: 'https://ingress.us-west-2.aws.dash0.com',
      authToken: TOKEN,
      serviceName: 'switchback-web',
      version: 'abc1234',
      environment: 'production',
    },
  });
});

test('dash0WebConfig only accepts the HTTPS origin allowed by the CSP', () => {
  assert.equal(dash0WebConfig({}), null);
  assert.equal(dash0WebConfig({ DASH0_WEB_AUTH_TOKEN: '  ' }), null);
  assert.equal(dash0WebConfig({ DASH0_WEB_AUTH_TOKEN: TOKEN }).url, 'https://ingress.us-west-2.aws.dash0.com');
  assert.equal(dash0WebConfig({ DASH0_WEB_AUTH_TOKEN: TOKEN, DASH0_WEB_ENDPOINT: 'http://evil.example' }).url, 'https://ingress.us-west-2.aws.dash0.com');
  assert.equal(dash0WebConfig({ DASH0_WEB_AUTH_TOKEN: TOKEN, DASH0_WEB_ENDPOINT: 'https://evil.example' }).url, 'https://ingress.us-west-2.aws.dash0.com');
});

test('GET /vendor/dash0-sdk-web.js serves the SDK as JavaScript; other vendor paths 404', async (t) => {
  const app = await start({});
  t.after(app.close);
  const res = await fetch(`${app.base}/vendor/dash0-sdk-web.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  const body = await res.text();
  assert.match(body, /export\s*\{[^}]*\binit\b/);
  assert.match(body, /\bidentify\b/);
  for (const p of ['/vendor/dash0.js', '/vendor/dash0-sdk-web.js.map', '/vendor/../package.json', '/vendor/%2e%2e/package.json']) {
    assert.equal((await fetch(app.base + p)).status, 404, p);
  }
  assert.equal((await fetch(`${app.base}/vendor/dash0-sdk-web.js`, { method: 'POST' })).status, 405);
});

test('the CSP allows the Dash0 ingest origin for fetches only, and pages load rum.js first', async (t) => {
  const app = await start({});
  t.after(app.close);
  for (const page of ['/', '/account']) {
    const res = await fetch(app.base + page);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self' https:\/\/ingress\.us-west-2\.aws\.dash0\.com(;|$)/);
    assert.match(csp, /script-src 'self'(;|$)/);
    const html = await res.text();
    const rum = html.indexOf('<script type="module" src="/rum.js"></script>');
    assert.ok(rum > 0, `${page} loads rum.js`);
    assert.ok(rum < html.indexOf('<script type="module" src="/app.js"></script>') || page === '/account');
  }
  assert.equal((await fetch(`${app.base}/rum.js`)).status, 200);
});
