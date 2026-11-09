// Sign in with GitHub (OAuth web flow) and the cookies around it.
// The GitHub access token is used once, to read the user's id, login, name
// and avatar, and then dropped: it is never stored, logged or returned.
const crypto = require('node:crypto');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('conference-accounts');

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const TIMEOUT_MS = 5000;

const STATE_COOKIE = 'sb_oauth';
const SESSION_COOKIE = 'sb_session';
const STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------- Signed values (HMAC-SHA256) ----------

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// payload (JSON) -> "<base64url json>.<base64url mac>"
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

// Returns the payload, or null when the value is malformed or tampered with.
function verify(value, secret) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!safeEqual(mac, hmac(secret, body))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- Cookies ----------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

const sessionCookie = (token) => cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS });
const clearSessionCookie = () => cookie(SESSION_COOKIE, '', { maxAge: 0 });
const clearStateCookie = () => cookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth/github' });

// ---------- returnTo ----------

// Only same-site relative paths ("/", "/?x=1"), never "//evil" or "/\evil".
function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512) return '/';
  if (value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/';
  try {
    const u = new URL(value, 'http://switchback.invalid');
    if (u.origin !== 'http://switchback.invalid') return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

// ---------- Login: the redirect and the state cookie ----------

// Returns { location, setCookie } for GET /auth/github/login.
function beginLogin({ clientId, publicUrl, secret, returnTo, now = Date.now() }) {
  const state = crypto.randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${publicUrl}/auth/github/callback`,
    scope: 'read:user',
    state,
    allow_signup: 'true',
  });
  const value = sign({ s: state, r: safeReturnTo(returnTo), e: now + STATE_TTL_SECONDS * 1000 }, secret);
  return {
    location: `${AUTHORIZE_URL}?${params}`,
    setCookie: cookie(STATE_COOKIE, value, { maxAge: STATE_TTL_SECONDS, path: '/auth/github' }),
  };
}

// Checks the callback's state against the signed cookie. Returns returnTo, or null.
function checkState({ cookieValue, state, secret, now = Date.now() }) {
  const payload = verify(cookieValue, secret);
  if (!payload || typeof payload.s !== 'string' || typeof payload.e !== 'number') return null;
  if (payload.e < now) return null;
  if (typeof state !== 'string' || !safeEqual(state, payload.s)) return null;
  return safeReturnTo(payload.r);
}

// ---------- GitHub calls ----------

function withSpan(name, fn) {
  return tracer.startActiveSpan(name, { attributes: { 'peer.service': 'github' } }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException({ name: err.name, message: err.message });
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

class OAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthError';
  }
}

// Exchanges the one-time code for an access token. Error messages never
// include the code, the secret or the response body.
function exchangeCode({ fetch = globalThis.fetch, clientId, clientSecret, code, redirectUri }) {
  return withSpan('github.oauth_exchange', async (span) => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'switchback-planner' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    span.setAttribute('http.response.status_code', res.status);
    if (!res.ok) throw new OAuthError(`token exchange failed with status ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      // GitHub answers 200 with { error: "bad_verification_code" } and the like.
      const reason = body && typeof body.error === 'string' ? body.error.slice(0, 40) : 'no_token';
      span.setAttribute('github.oauth_error', reason);
      throw new OAuthError(`token exchange failed: ${reason}`);
    }
    return body.access_token;
  });
}

function fetchUser({ fetch = globalThis.fetch, accessToken }) {
  return withSpan('github.fetch_user', async (span) => {
    const res = await fetch(USER_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'switchback-planner',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    span.setAttribute('http.response.status_code', res.status);
    if (!res.ok) throw new OAuthError(`GitHub /user failed with status ${res.status}`);
    const u = await res.json();
    if (!u || !Number.isSafeInteger(u.id) || typeof u.login !== 'string') throw new OAuthError('GitHub /user returned an unexpected shape');
    return {
      id: u.id,
      login: u.login.slice(0, 39),
      name: typeof u.name === 'string' ? u.name.slice(0, 200) : null,
      avatar_url: typeof u.avatar_url === 'string' && u.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? u.avatar_url.slice(0, 500) : null,
    };
  });
}

module.exports = {
  STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sign,
  verify,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  clearStateCookie,
  safeReturnTo,
  beginLogin,
  checkState,
  exchangeCode,
  fetchUser,
  OAuthError,
};
