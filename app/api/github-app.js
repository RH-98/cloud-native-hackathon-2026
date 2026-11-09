// GET /auth/github-app/install and GET /auth/github-app/callback: connect the
// read-only GitHub App, scan the user's private repos once, store only the
// derived signals (app/profile/private.js), and drop the token.
// Repo names never appear in redirects, logs, errors or span attributes.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { send, sendError } = require('./http');
const gh = require('../auth/github');
const ghApp = require('../auth/github-app');
const { sessionToken } = require('../auth');
const privateProfile = require('../profile/private');

function redirect(res, location, cookies = []) {
  const headers = { location, 'cache-control': 'no-store' };
  if (cookies.length) headers['set-cookie'] = cookies;
  send(res, 302, headers, '');
}

// returnTo plus ?private=<outcome> (returnTo is already a safe relative path).
function withOutcome(returnTo, outcome) {
  const u = new URL(gh.safeReturnTo(returnTo), 'http://switchback.invalid');
  u.searchParams.set('private', outcome);
  return `${u.pathname}${u.search}${u.hash}`;
}

// deps (tests): { listGrantedRepos, buildPrivateProfile, exchangeCode, fetchUser }
function createGithubAppHandler(accounts, deps = {}) {
  const exchangeCode = deps.exchangeCode || gh.exchangeCode;
  const fetchUser = deps.fetchUser || gh.fetchUser;
  const listGrantedRepos = deps.listGrantedRepos || ghApp.listGrantedRepos;
  const buildPrivateProfile = deps.buildPrivateProfile || privateProfile.buildPrivateProfile;
  const app = accounts.githubApp || {};

  async function currentUser(req) {
    const token = sessionToken(req);
    return token ? accounts.db.getSessionUser(token) : null;
  }

  const signInFirst = (res, returnTo) =>
    redirect(res, `/auth/github/login?returnTo=${encodeURIComponent(gh.safeReturnTo(returnTo))}`);

  async function install(req, res, url) {
    const returnTo = url.searchParams.get('returnTo');
    const user = await currentUser(req);
    if (!user) return signInFirst(res, returnTo);
    const { location, setCookie } = ghApp.beginAppFlow({
      slug: app.slug,
      clientId: app.clientId,
      publicUrl: accounts.publicUrl,
      secret: accounts.sessionSecret,
      returnTo,
      userId: user.id,
      mode: url.searchParams.get('mode') === 'rescan' ? 'auth' : 'install',
    });
    return redirect(res, location, [setCookie]);
  }

  async function callback(req, res, url) {
    const span = trace.getActiveSpan();
    const outcome = (returnTo, what, cookies = []) => {
      span?.setAttribute('private_repos.outcome', what);
      return redirect(res, withOutcome(returnTo, what), [ghApp.clearAppStateCookie(), ...cookies]);
    };
    const state = ghApp.checkAppState({
      cookieValue: gh.parseCookies(req.headers.cookie)[ghApp.STATE_COOKIE],
      state: url.searchParams.get('state'),
      secret: accounts.sessionSecret,
    });
    if (!state) return outcome('/', 'failed');
    const user = await currentUser(req);
    if (!user) return signInFirst(res, state.returnTo);
    if (user.id !== state.userId) return outcome(state.returnTo, 'failed');

    const code = url.searchParams.get('code');
    if (!code || code.length > 200) {
      // Installed or reconfigured without a code (the App was already
      // installed): ask GitHub for the user's authorization once.
      if (state.mode === 'install') {
        const { location, setCookie } = ghApp.beginAppFlow({
          slug: app.slug, clientId: app.clientId, publicUrl: accounts.publicUrl, secret: accounts.sessionSecret,
          returnTo: state.returnTo, userId: user.id, mode: 'auth',
        });
        return redirect(res, location, [setCookie]);
      }
      return outcome(state.returnTo, 'failed');
    }

    try {
      // The user token lives only in this block and is never stored or logged.
      const token = await exchangeCode({
        fetch: accounts.fetch,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        code,
        redirectUri: `${accounts.publicUrl}${ghApp.callbackPath}`,
        spanName: 'github.app_oauth_exchange',
      });
      const ghUser = await fetchUser({ fetch: accounts.fetch, accessToken: token });
      if (String(ghUser.id) !== String(user.githubId)) return outcome(state.returnTo, 'mismatch');
      const repos = await listGrantedRepos({ fetch: accounts.fetch, token });
      const derived = await buildPrivateProfile({ login: user.login, repos, token }, { fetch: accounts.fetch });
      span?.setAttribute('private_repos.count', derived.repoCount);
      if (!derived.repoCount) {
        await accounts.db.deletePrivateProfile(user.id);
        return outcome(state.returnTo, 'none');
      }
      await accounts.db.setPrivateProfile(user.id, derived);
      return outcome(state.returnTo, 'ready');
    } catch (err) {
      // Name only: messages from upstream calls stay off the logs.
      span?.recordException({ name: err?.name || 'Error', message: 'private repo scan failed' });
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'private repo scan failed' });
      console.error(`GitHub App private repo scan failed: ${err && err.name}`);
      return outcome(state.returnTo, 'failed');
    }
  }

  return function handleGithubApp(req, res, url) {
    const p = url.pathname;
    if (p !== '/auth/github-app/install' && p !== ghApp.callbackPath) return sendError(res, 'not_found', 'No such route');
    if (req.method !== 'GET') return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET' });
    if (!accounts.privateRepos) return redirect(res, '/?private=unavailable');
    const run = p === ghApp.callbackPath ? callback : install;
    return run(req, res, url).catch((err) => {
      trace.getActiveSpan()?.recordException({ name: err?.name || 'Error', message: 'github app route failed' });
      console.error(`${p} failed: ${err && err.name}`);
      if (!res.headersSent) redirect(res, '/?private=failed', [ghApp.clearAppStateCookie()]);
    });
  };
}

// For POST /api/plan: (req, profile) -> profile with the signed-in user's
// stored private signals merged in, only when the profile was built from
// their own GitHub login. Any lookup failure leaves the profile as it was.
function privateSignalsFor(accounts) {
  if (!accounts || !accounts.privateRepos) return null;
  return async function withPrivateSignals(req, profile) {
    if (!profile || (profile.source !== 'github' && profile.source !== 'github+interests') || typeof profile.username !== 'string') return profile;
    const token = sessionToken(req);
    if (!token) return profile;
    try {
      const user = await accounts.db.getSessionUser(token);
      if (!user || user.login.toLowerCase() !== profile.username.toLowerCase()) return profile;
      const row = await accounts.db.getPrivateProfile(user.id);
      return row ? privateProfile.mergePrivate(profile, row.profile) : profile;
    } catch (err) {
      trace.getActiveSpan()?.recordException({ name: err?.name || 'Error', message: 'private profile lookup failed' });
      console.error(`private profile lookup failed: ${err && (err.code || err.name)}`);
      return profile;
    }
  };
}

module.exports = { createGithubAppHandler, privateSignalsFor, withOutcome };
