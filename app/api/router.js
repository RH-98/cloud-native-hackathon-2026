// Routes a request to its handler. createHandler() takes the profile and
// planner functions so tests can pass fakes; server.js passes the real ones.
const { send, sendError } = require('./http');
const { handleConferences, hasConference } = require('./conferences');
const { createPlanHandler } = require('./plan');
const { createConnectionsHandler } = require('./connections');
const { createStaticHandler } = require('./static');
const { createAuthHandler } = require('./auth');
const { privateSignalsFor } = require('./github-app');
const { createChangesHandler } = require('./changes');
const schedule = require('../schedule');
const { createMeHandler } = require('./me');
const { createAccounts, sessionToken } = require('../auth');

// connections: optional deps for handleConnections (tests pass a fake search or env).
// accounts: from app/auth accountsFromEnv(); omitted (tests, local dev) means accounts are off.
function createHandler({ buildProfile, buildPlan, publicDir, connections, accounts = createAccounts(), getChanges = schedule.getChanges } = {}) {
  const handlePlan = createPlanHandler({ buildProfile, buildPlan, hasConference, withPrivateSignals: privateSignalsFor(accounts) });
  const handleConnections = createConnectionsHandler(connections);
  const handleAuth = createAuthHandler(accounts);
  const handleMe = createMeHandler(accounts);
  const handleStatic = createStaticHandler(publicDir);
  const handleChanges = createChangesHandler({ getChanges, hasConference });

  return function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, 'invalid_input', 'Bad request');
    }
    const p = url.pathname;
    if (p === '/healthz' || p === '/readyz') {
      return send(res, 200, { 'content-type': 'text/plain' }, 'ok\n');
    }
    if (p === '/api/conferences') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET, HEAD' });
      }
      return handleConferences(req, res);
    }
    if (p === '/api/plan') {
      if (req.method !== 'POST') return sendError(res, 'method_not_allowed', 'Use POST', { allow: 'POST' });
      return handlePlan(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 'internal', 'Something went wrong on our side');
      });
    }
    if (p.startsWith('/auth/')) {
      return Promise.resolve(handleAuth(req, res, url)).catch(() => {
        if (!res.headersSent) sendError(res, 'internal', 'Something went wrong on our side');
      });
    }
    if (p === '/api/changes') {
      if (req.method !== 'GET') return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET' });
      return handleChanges(req, res, url);
    }
    if (p === '/api/me' || p.startsWith('/api/me/')) return handleMe(req, res, url);
    if (p === '/api/connections') {
      if (req.method !== 'POST') return sendError(res, 'method_not_allowed', 'Use POST', { allow: 'POST' });
      const token = accounts.enabled ? sessionToken(req) : null;
      // Database down: log the lookup failure, then carry on as signed out (demo attendees only).
      return Promise.resolve(token ? accounts.db.getSessionUser(token).catch((err) => {
        console.error(`POST /api/connections session lookup failed: ${err && (err.code || err.name)}`);
        return null;
      }) : null)
        .then((viewer) => handleConnections(req, res, { viewer }))
        .catch(() => {
          if (!res.headersSent) sendError(res, 'internal', 'Something went wrong on our side');
        });
    }
    if (p.startsWith('/api/')) return sendError(res, 'not_found', 'No such API route');
    return handleStatic(req, res, p);
  };
}

module.exports = { createHandler };
