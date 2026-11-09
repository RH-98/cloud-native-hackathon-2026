// /auth/github/login, /auth/github/callback and /auth/logout.
// See app/auth/github.js for the flow and README "Accounts (optional)".
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { send, sendError } = require('./http');
const gh = require('../auth/github');
const { sessionToken, sameOrigin } = require('../auth');
const { createGithubAppHandler } = require('./github-app');

function redirect(res, location, cookies = []) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookies.length) headers['set-cookie'] = cookies;
  send(res, 302, headers, '');
}

// Records a failure on the request's span without request headers, codes or tokens.
function recordFailure(err, what) {
  const span = trace.getActiveSpan();
  span?.recordException({ name: err?.name || 'Error', message: err?.message || what });
  span?.setStatus({ code: SpanStatusCode.ERROR, message: what });
}

// appDeps: fakes for the GitHub App routes in tests.
function createAuthHandler(accounts, appDeps) {
  const handleGithubApp = createGithubAppHandler(accounts, appDeps);
  async function callback(req, res, url) {
    const failed = (cookies = []) => redirect(res, '/?login=failed', [gh.clearStateCookie(), ...cookies]);
    const cookies = gh.parseCookies(req.headers.cookie);
    const returnTo = gh.checkState({
      cookieValue: cookies[gh.STATE_COOKIE],
      state: url.searchParams.get('state'),
      secret: accounts.sessionSecret,
    });
    const code = url.searchParams.get('code');
    if (!returnTo || !code || code.length > 200) {
      trace.getActiveSpan()?.setAttribute('auth.outcome', 'bad_state');
      return failed();
    }
    try {
      const accessToken = await gh.exchangeCode({
        fetch: accounts.fetch,
        clientId: accounts.clientId,
        clientSecret: accounts.clientSecret,
        code,
        redirectUri: `${accounts.publicUrl}/auth/github/callback`,
      });
      // The token is used for this one call and then goes out of scope.
      const ghUser = await gh.fetchUser({ fetch: accounts.fetch, accessToken });
      const user = await accounts.db.upsertUser(ghUser);
      const token = await accounts.db.createSession(user.id);
      trace.getActiveSpan()?.setAttribute('auth.outcome', 'ok');
      return redirect(res, returnTo, [gh.clearStateCookie(), gh.sessionCookie(token)]);
    } catch (err) {
      recordFailure(err, 'GitHub sign-in failed');
      console.error(`GitHub sign-in failed: ${err && err.name}: ${err && err.message}`);
      return failed();
    }
  }

  async function logout(req, res) {
    if (!sameOrigin(req, accounts.publicUrl)) return sendError(res, 'forbidden', 'Cross-site request refused');
    try {
      if (accounts.enabled) await accounts.db.deleteSession(sessionToken(req));
    } catch (err) {
      // The cookie is cleared anyway; the row expires on its own.
      recordFailure(err, 'could not delete the session');
    }
    send(res, 204, { 'set-cookie': [gh.clearSessionCookie()], 'cache-control': 'no-store' }, '');
  }

  return function handleAuth(req, res, url) {
    const p = url.pathname;
    if (p.startsWith('/auth/github-app/')) return handleGithubApp(req, res, url);
    if (p === '/auth/github/login') {
      if (req.method !== 'GET') return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET' });
      if (!accounts.enabled) return redirect(res, '/?login=unavailable');
      const { location, setCookie } = gh.beginLogin({
        clientId: accounts.clientId,
        publicUrl: accounts.publicUrl,
        secret: accounts.sessionSecret,
        returnTo: url.searchParams.get('returnTo'),
      });
      return redirect(res, location, [setCookie]);
    }
    if (p === '/auth/github/callback') {
      if (req.method !== 'GET') return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET' });
      if (!accounts.enabled) return redirect(res, '/?login=unavailable');
      return callback(req, res, url);
    }
    if (p === '/auth/logout') {
      if (req.method !== 'POST') return sendError(res, 'method_not_allowed', 'Use POST', { allow: 'POST' });
      return logout(req, res);
    }
    return sendError(res, 'not_found', 'No such route');
  };
}

module.exports = { createAuthHandler };
