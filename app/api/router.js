// Routes a request to its handler. createHandler() takes the profile and
// planner functions so tests can pass fakes; server.js passes the real ones.
const { send, sendError } = require('./http');
const { handleConferences, hasConference } = require('./conferences');
const { createPlanHandler } = require('./plan');
const { createStaticHandler } = require('./static');

function createHandler({ buildProfile, buildPlan, publicDir } = {}) {
  const handlePlan = createPlanHandler({ buildProfile, buildPlan, hasConference });
  const handleStatic = createStaticHandler(publicDir);

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
    if (p.startsWith('/api/')) return sendError(res, 'not_found', 'No such API route');
    return handleStatic(req, res, p);
  };
}

module.exports = { createHandler };
