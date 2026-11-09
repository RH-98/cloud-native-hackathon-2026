// Accounts: configuration and the request helpers the /auth and /api/me
// routes share (who is signed in, CSRF check).
const { getDb } = require('../db');
const { parseCookies, SESSION_COOKIE } = require('./github');

// The accounts feature is on only with a database, the GitHub OAuth App's
// id and secret, a session secret and the public URL. Otherwise every
// account route reports { enabled: false } and the planner works as before.
function accountsFromEnv(env = process.env) {
  const config = {
    db: getDb(),
    clientId: env.GITHUB_OAUTH_CLIENT_ID || '',
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET || '',
    sessionSecret: env.SESSION_SECRET || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    fetch: globalThis.fetch,
    // Private repos (optional): the read-only GitHub App's OAuth credentials and slug.
    githubApp: {
      clientId: env.GITHUB_APP_CLIENT_ID || '',
      clientSecret: env.GITHUB_APP_CLIENT_SECRET || '',
      slug: env.GITHUB_APP_SLUG || '',
    },
  };
  return createAccounts(config);
}

function createAccounts(config = {}) {
  const enabled = Boolean(
    config.db && config.clientId && config.clientSecret
    && typeof config.sessionSecret === 'string' && config.sessionSecret.length >= 32
    && /^https?:\/\/[^/]+$/.test(config.publicUrl || ''),
  );
  const app = config.githubApp || {};
  // Needs accounts on, plus all three GitHub App values.
  const privateRepos = Boolean(enabled && app.clientId && app.clientSecret && /^[a-z0-9][a-z0-9-]{0,99}$/.test(app.slug || ''));
  return { ...config, fetch: config.fetch || globalThis.fetch, enabled, privateRepos };
}

function sessionToken(req) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return value && /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null;
}

// Cookie-authenticated requests that change state must come from our own
// page: the Origin matches PUBLIC_URL or this Host, or (without Origin) the
// browser says Sec-Fetch-Site: same-origin.
function sameOrigin(req, publicUrl) {
  const origin = req.headers.origin;
  if (origin) {
    if (publicUrl && origin === publicUrl) return true;
    const host = req.headers.host;
    return Boolean(host) && (origin === `https://${host}` || origin === `http://${host}`);
  }
  return req.headers['sec-fetch-site'] === 'same-origin';
}

module.exports = { accountsFromEnv, createAccounts, sessionToken, sameOrigin };
