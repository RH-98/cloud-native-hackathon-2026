// The signed-in user's account: GET /api/me, GET|PUT /api/me/plan,
// GET|PUT /api/me/social. Cookie-authenticated (sb_session); writes need a
// same-origin request (CSRF). With accounts off, GET /api/me answers
// { enabled: false, user: null } and the other routes 404.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { HttpError, sendJson, sendError, readJsonBody } = require('./http');
const { validatePlanRequest } = require('./plan');
const { sessionToken, sameOrigin } = require('../auth');

const CONFERENCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 512 * 1024;
const MAX_STATE_JSON = 500 * 1024;
const MAX_IDS = 100;
const MAX_SWAPS = 200;

const bad = (message) => new HttpError('invalid_input', message);

function shortStrings(value, name, { max, maxLength }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw bad(`state.${name} must be an array of at most ${max} entries`);
  for (const v of value) {
    if (typeof v !== 'string' || !v || v.length > maxLength) throw bad(`state.${name} has an invalid entry`);
  }
  return [...new Set(value)];
}

function plainObject(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw bad(`state.${name} must be an object`);
  return value;
}

// What the UI needs to restore a plan: the request, pins, skips, swaps, the
// active day, and the plan and profile as last shown. Unknown keys are dropped.
function validateSavedState(state, conferenceId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw bad('state must be an object');
  let request = null;
  if (state.request !== undefined && state.request !== null) {
    request = validatePlanRequest(state.request);
    if (request.conferenceId !== conferenceId) throw bad('state.request is for another conference');
  }
  const swaps = state.swaps === undefined || state.swaps === null ? [] : state.swaps;
  if (!Array.isArray(swaps) || swaps.length > MAX_SWAPS) throw bad(`state.swaps must be an array of at most ${MAX_SWAPS} pairs`);
  for (const pair of swaps) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== 'string' || !x || x.length > 160)) {
      throw bad('state.swaps must contain [slotKey, sessionId] pairs');
    }
  }
  const activeDay = state.activeDay ?? null;
  if (activeDay !== null && (typeof activeDay !== 'string' || !DATE.test(activeDay))) throw bad('state.activeDay must be a date');
  const out = {
    request,
    pinned: shortStrings(state.pinned, 'pinned', { max: MAX_IDS, maxLength: 160 }),
    skipped: shortStrings(state.skipped, 'skipped', { max: MAX_IDS, maxLength: 160 }),
    swaps,
    activeDay,
    plan: plainObject(state.plan, 'plan'),
    profile: plainObject(state.profile, 'profile'),
  };
  if (out.plan && out.plan.conferenceId !== undefined && out.plan.conferenceId !== conferenceId) {
    throw bad('state.plan is for another conference');
  }
  if (JSON.stringify(out).length > MAX_STATE_JSON) throw new HttpError('payload_too_large', 'The saved plan is too large');
  return out;
}

// ---------- Social profile: derived signals only ----------

const clip = (s, n) => String(s).slice(0, n);
const weight = (w) => (typeof w === 'number' && Number.isFinite(w) ? Math.max(0, Math.min(1, Math.round(w * 1000) / 1000)) : 0);

function labels(list, max) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => typeof x === 'string' && x.trim()).slice(0, max).map((x) => clip(x.trim(), 60));
}

// Keeps tool, topic, language and keyword labels with weights. Drops
// evidence (repo names), counts, timestamps and anything else.
function deriveSocialProfile(profile) {
  const tools = (Array.isArray(profile.tools) ? profile.tools : [])
    .filter((t) => t && typeof t.name === 'string')
    .slice(0, 15)
    .map((t) => ({ name: clip(t.name, 60), label: clip(typeof t.label === 'string' ? t.label : t.name, 60), weight: weight(t.weight) }));
  const languages = (Array.isArray(profile.languages) ? profile.languages : [])
    .filter((l) => l && typeof l.name === 'string')
    .slice(0, 15)
    .map((l) => ({ name: clip(l.name, 40), weight: weight(l.weight) }));
  return { tools, languages, topics: labels(profile.topics, 30), keywords: labels(profile.keywords, 30) };
}

// You can only opt yourself in. A profile built from GitHub must be your own
// login; a profile from typed interests or a pasted LinkedIn profile (no
// username) is taken as yours. Either way only derived signals are stored.
function isOwnProfile(profile, user) {
  if (!profile || typeof profile !== 'object' || !user) return false;
  if (profile.source === 'github' || profile.source === 'github+interests') {
    return typeof profile.username === 'string' && profile.username.toLowerCase() === user.login.toLowerCase();
  }
  return profile.source === 'interests' && (profile.username === null || profile.username === undefined);
}

function conferenceParam(url) {
  const id = url.searchParams.get('conferenceId');
  if (!id || !CONFERENCE_ID.test(id)) throw bad('conferenceId must be a conference id such as kubecon-na-2026');
  return id;
}

function publicUser(user) {
  return user ? { login: user.login, name: user.name, avatarUrl: user.avatarUrl } : null;
}

class DbError extends Error {}

function createMeHandler(accounts) {
  // Database calls: any failure becomes a 503 (recorded on the span).
  async function db(fn) {
    try {
      return await fn(accounts.db);
    } catch (err) {
      const wrapped = new DbError('database unavailable');
      wrapped.cause = err;
      throw wrapped;
    }
  }

  async function requireUser(req) {
    const user = await db((d) => d.getSessionUser(sessionToken(req)));
    if (!user) throw new HttpError('unauthorized', 'Sign in with GitHub first');
    return user;
  }

  function requireSameOrigin(req) {
    if (!sameOrigin(req, accounts.publicUrl)) throw new HttpError('forbidden', 'Cross-site request refused');
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/me') {
      if (m !== 'GET') return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET' });
      if (!accounts.enabled) return sendJson(res, 200, { enabled: false, user: null });
      const token = sessionToken(req);
      const user = token ? await db((d) => d.getSessionUser(token)) : null;
      return sendJson(res, 200, { enabled: true, user: publicUser(user) });
    }
    if (!accounts.enabled) return sendError(res, 'not_found', 'Accounts are not enabled on this server');

    if (p === '/api/me/plan') {
      if (m === 'GET') {
        const conferenceId = conferenceParam(url);
        const user = await requireUser(req);
        const saved = await db((d) => d.getPlan(user.id, conferenceId));
        return sendJson(res, 200, { state: saved ? saved.state : null, savedAt: saved ? saved.savedAt : null });
      }
      if (m === 'PUT') {
        requireSameOrigin(req);
        const user = await requireUser(req);
        const body = await readJsonBody(req, MAX_BODY);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object');
        if (typeof body.conferenceId !== 'string' || !CONFERENCE_ID.test(body.conferenceId)) throw bad('conferenceId must be a conference id');
        const state = validateSavedState(body.state, body.conferenceId);
        const savedAt = await db((d) => d.savePlan(user.id, body.conferenceId, state));
        return sendJson(res, 200, { savedAt });
      }
      return sendError(res, 'method_not_allowed', 'Use GET or PUT', { allow: 'GET, PUT' });
    }

    if (p === '/api/me/social') {
      if (m === 'GET') {
        const conferenceId = conferenceParam(url);
        const user = await requireUser(req);
        const row = await db((d) => d.getSocialProfile(user.id, conferenceId));
        return sendJson(res, 200, { optedIn: Boolean(row), optedInAt: row ? row.optedInAt : null });
      }
      if (m === 'PUT') {
        requireSameOrigin(req);
        const user = await requireUser(req);
        const body = await readJsonBody(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object');
        const { conferenceId, optIn, profile } = body;
        if (typeof conferenceId !== 'string' || !CONFERENCE_ID.test(conferenceId)) throw bad('conferenceId must be a conference id');
        if (typeof optIn !== 'boolean') throw bad('optIn must be true or false');
        if (!optIn) {
          await db((d) => d.deleteSocialProfile(user.id, conferenceId));
          return sendJson(res, 200, { optedIn: false });
        }
        if (!isOwnProfile(profile, user)) {
          throw new HttpError('forbidden', 'You can only opt in with a profile built from your own GitHub account');
        }
        const derived = deriveSocialProfile(profile);
        // Typed interests keep unmatched phrases verbatim as keywords (could be names or
        // employers): only GitHub's derived keywords and the LinkedIn parser's curated ones are kept.
        if (profile.source !== 'github' && profile.pastedFrom !== 'linkedin') derived.keywords = [];
        const signals = derived.tools.length + derived.languages.length + derived.topics.length + derived.keywords.length;
        if (!profile.username && !signals) {
          throw bad('Build a plan from your GitHub, interests or LinkedIn profile first');
        }
        await db((d) => d.setSocialProfile(user.id, conferenceId, derived));
        return sendJson(res, 200, { optedIn: true });
      }
      return sendError(res, 'method_not_allowed', 'Use GET or PUT', { allow: 'GET, PUT' });
    }

    return sendError(res, 'not_found', 'No such API route');
  }

  return async function handleMe(req, res, url) {
    try {
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendError(res, err.code, err.message);
      const span = trace.getActiveSpan();
      const cause = err instanceof DbError ? err.cause : err;
      span?.recordException({ name: cause?.name || 'Error', message: cause?.message || 'unknown' });
      span?.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof DbError ? 'database unavailable' : 'unexpected error' });
      if (err instanceof DbError) {
        console.error(`accounts database unavailable: ${cause && (cause.code || cause.name)}`);
        return sendError(res, 'unavailable', 'Saved plans are unavailable right now. Your plan still works; try again in a moment.');
      }
      console.error(`${req.method} ${url.pathname} failed: ${err && err.name}: ${err && err.message}`);
      return sendError(res, 'internal', 'Something went wrong on our side.');
    }
  };
}

module.exports = { createMeHandler, validateSavedState, deriveSocialProfile, isOwnProfile };
