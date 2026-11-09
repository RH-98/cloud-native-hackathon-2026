// The read-only GitHub App for private repos (Repository permissions:
// Contents read, Metadata read). Its user-to-server token is used for one
// scan and then dropped: never stored, logged, cached or put on a span.
const crypto = require('node:crypto');
const gh = require('./github');

const STATE_COOKIE = 'sb_ghapp';
const COOKIE_PATH = '/auth/github-app';
const STATE_TTL_SECONDS = 10 * 60;
const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const API = 'https://api.github.com';
const TIMEOUT_MS = 5000;
const MAX_PAGES = 5;

const callbackPath = `${COOKIE_PATH}/callback`;

// mode: "install" (the App's install page) or "auth" (OAuth only, when the
// App is already installed). The state is bound to the Switchback user.
function beginAppFlow({ slug, clientId, publicUrl, secret, returnTo, userId, mode = 'install', now = Date.now() }) {
  const state = crypto.randomBytes(24).toString('base64url');
  const value = gh.sign({ s: state, r: gh.safeReturnTo(returnTo), u: String(userId), m: mode, e: now + STATE_TTL_SECONDS * 1000 }, secret);
  let location;
  if (mode === 'auth') {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: `${publicUrl}${callbackPath}`, state });
    location = `${AUTHORIZE_URL}?${params}`;
  } else {
    location = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${new URLSearchParams({ state })}`;
  }
  return {
    location,
    setCookie: gh.cookie(STATE_COOKIE, value, { maxAge: STATE_TTL_SECONDS, path: COOKIE_PATH }),
  };
}

const clearAppStateCookie = () => gh.cookie(STATE_COOKIE, '', { maxAge: 0, path: COOKIE_PATH });

// Returns { returnTo, userId, mode } when the state matches the signed,
// unexpired cookie (constant-time compare), else null.
function checkAppState({ cookieValue, state, secret, now = Date.now() }) {
  const p = gh.verify(cookieValue, secret);
  if (!p || typeof p.s !== 'string' || typeof p.e !== 'number' || typeof p.u !== 'string') return null;
  if (p.e < now) return null;
  if (typeof state !== 'string' || !gh.safeEqual(state, p.s)) return null;
  return { returnTo: gh.safeReturnTo(p.r), userId: p.u, mode: p.m === 'auth' ? 'auth' : 'install' };
}

class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

async function getJson(fetch, token, path, span) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'switchback-planner',
      'x-github-api-version': '2022-11-28',
      'x-switchback-private': '1', // no automatic HTTP span with the URL (app/telemetry.js)
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  span.setAttribute('http.response.status_code', res.status);
  if (!res.ok) {
    res.body?.cancel?.().catch(() => {});
    throw new AppError(`GitHub answered ${res.status}`);
  }
  return res.json();
}

// The repos the user granted the App, across their installations. The page
// limit bounds collection; pickPrivateRepos sorts and caps repos for scanning.
function listGrantedRepos({ fetch = globalThis.fetch, token }) {
  return gh.withSpan('github.app_list_repos', async (span) => {
    const inst = await getJson(fetch, token, '/user/installations?per_page=100', span);
    const installations = Array.isArray(inst?.installations) ? inst.installations : [];
    const repos = [];
    for (const i of installations) {
      if (!Number.isSafeInteger(i?.id)) continue;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const body = await getJson(fetch, token, `/user/installations/${i.id}/repositories?per_page=100&page=${page}`, span);
        const list = Array.isArray(body?.repositories) ? body.repositories : [];
        repos.push(...list);
        if (list.length < 100) break;
      }
    }
    span.setAttribute('github.installation_count', installations.length);
    span.setAttribute('github.granted_repo_count', repos.length);
    return repos;
  });
}

module.exports = { STATE_COOKIE, callbackPath, beginAppFlow, checkAppState, clearAppStateCookie, listGrantedRepos, AppError };
