// POST /api/connections: suggested people to meet (opt-in demo attendees).
// Request:  { conferenceId, profile: Profile, pickedSessionIds?: [id], limit?: 1-20, firstTimer?: bool }
// Response: { connections: [{ attendee: { displayName, handle, role, bio }, score, shared, why,
//             commonSessions: [{ id, title, start }] }], searchBackend, demoData: true }
// The profile is used for this request only; it is never stored or logged.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { suggestConnections } = require('../social');
const { HttpError, sendJson, sendError, readJsonBody } = require('./http');
const { withRequestStates } = require('./requests');

// A GitHub profile with tool evidence plus a day's picks fits well within this.
const BODY_LIMIT = 64 * 1024;

const MAX_TERMS = 100;
const MAX_TERM_LENGTH = 100;
const MAX_PICKED = 300;

function invalid(message) {
  return { status: 400, json: { error: { code: 'invalid_input', message } } };
}

const isText = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_TERM_LENGTH;

// Keep only the derived signals the matcher uses, in the Profile shape.
function cleanProfile(profile) {
  const named = (list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, MAX_TERMS)
      .filter((t) => t && isText(t.name))
      .map((t) => ({
        name: t.name,
        ...(isText(t.label) ? { label: t.label } : {}),
        weight: Number.isFinite(Number(t.weight)) ? Number(t.weight) : 1,
      }));
  const strings = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_TERMS).filter(isText);
  return {
    username: isText(profile.username) ? profile.username : null,
    tools: named(profile.tools),
    languages: named(profile.languages),
    topics: strings(profile.topics),
    keywords: strings(profile.keywords),
  };
}

async function handleConnections(body, deps = {}) {
  if (!body || typeof body !== 'object') return invalid('Send a JSON object');
  const { conferenceId, profile, pickedSessionIds = [], limit = 5, firstTimer = false } = body;
  if (typeof conferenceId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(conferenceId)) {
    return invalid('conferenceId must be a conference id like "kubecon-na-2026"');
  }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return invalid('profile must be the profile object returned by POST /api/plan');
  }
  if (!Array.isArray(pickedSessionIds) || pickedSessionIds.length > MAX_PICKED || !pickedSessionIds.every(isText)) {
    return invalid('pickedSessionIds must be a list of session ids');
  }
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 20) return invalid('limit must be a whole number from 1 to 20');

  const clean = cleanProfile(profile);
  if (!clean.tools.length && !clean.topics.length && !clean.languages.length && !clean.keywords.length) {
    return invalid('profile has no tools, topics, languages or keywords to match on');
  }

  const result = await suggestConnections(
    { conferenceId, profile: clean, pickedSessionIds, limit: n, firstTimer: firstTimer === true },
    deps,
  );
  if (!result) {
    return { status: 404, json: { error: { code: 'not_found', message: `No attendees for ${conferenceId}` } } };
  }
  // Signed in: each suggestion carries the viewer's request state with that
  // person (none | requested | incoming | connected) for the Connect buttons.
  let connections = result.connections;
  if (deps.viewer && deps.connectionStates) {
    // Best effort: without states the cards still render, just without Connect state.
    const states = await Promise.resolve().then(() => deps.connectionStates(conferenceId)).catch((err) => {
      const span = trace.getActiveSpan();
      span?.recordException(err);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'connection states unavailable' });
      return null;
    });
    if (states) connections = withRequestStates(connections, states);
  }
  return {
    status: 200,
    json: {
      conferenceId,
      connections,
      // Whether the UI can offer Connect (accounts on) and whether the viewer is signed in.
      connect: { enabled: Boolean(deps.accountsEnabled), signedIn: Boolean(deps.viewer) },
      searchBackend: result.searchBackend,
      // The attendees are fictional demo data: the UI must say so.
      demoData: true,
    },
  };
}

// HTTP adapter for the router. deps go to handleConnections (tests pass fakes).
function createConnectionsHandler(deps = {}) {
  return async function serveConnections(req, res, requestDeps = {}) {
    const span = trace.getActiveSpan();
    try {
      const body = await readJsonBody(req, BODY_LIMIT);
      const { status, json } = await handleConnections(body, { ...deps, ...requestDeps });
      span?.setAttributes({
        'connections.count': json.connections ? json.connections.length : 0,
        'connections.backend': json.searchBackend || 'none',
      });
      if (json.error) return sendError(res, json.error.code, json.error.message);
      return sendJson(res, status, json);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.code, err.message);
      span?.recordException(err);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'unexpected error in /api/connections' });
      // Name and message only: never the request body (it holds the profile).
      console.error(`POST /api/connections failed: ${err && err.name}: ${err && err.message}`);
      return sendError(res, 'internal', 'Something went wrong on our side. Try again in a moment.');
    }
  };
}

module.exports = { handleConnections, cleanProfile, createConnectionsHandler, BODY_LIMIT };
