// POST /api/plan: validate the request, build the profile, then the plan.
// See docs/CONTRACTS.md for the shapes.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { HttpError, sendJson, sendError, readJsonBody } = require('./http');

const CONFERENCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// GitHub usernames: 1-39 alphanumerics or single hyphens, not at either end.
const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,63}:[A-Za-z0-9_.-]{1,64}$/;
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Any Level'];
const MAX_INTERESTS = 500;
const MAX_IDS = 100;

// Error codes the profile and planner throw on purpose, and the status each maps to.
const KNOWN_CODES = new Set(['invalid_input', 'not_found', 'rate_limited', 'upstream']);

const bad = (message) => new HttpError('invalid_input', message);

function stringArray(value, name, { pattern, allowed, max }) {
  if (!Array.isArray(value)) throw bad(`options.${name} must be an array`);
  if (value.length > max) throw bad(`options.${name} has more than ${max} entries`);
  for (const v of value) {
    if (typeof v !== 'string') throw bad(`options.${name} must contain strings`);
    if (pattern && !pattern.test(v)) throw bad(`options.${name} has an invalid entry`);
    if (allowed && !allowed.includes(v)) throw bad(`options.${name} must be one of ${allowed.join(', ')}`);
  }
  return [...new Set(value)];
}

function validateOptions(options) {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) throw bad('options must be an object');
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    switch (key) {
      case 'days':
        out.days = stringArray(value, key, { pattern: DATE, max: 14 });
        break;
      case 'levels':
        out.levels = stringArray(value, key, { allowed: LEVELS, max: LEVELS.length });
        break;
      case 'pinned':
      case 'skipped':
        out[key] = stringArray(value, key, { pattern: SESSION_ID, max: MAX_IDS });
        break;
      case 'includeSponsored':
      case 'firstTimer':
        if (typeof value !== 'boolean') throw bad(`options.${key} must be true or false`);
        out[key] = value;
        break;
      case 'breakMinutes':
        if (!Number.isInteger(value) || value < 0 || value > 120) {
          throw bad('options.breakMinutes must be a whole number from 0 to 120');
        }
        out.breakMinutes = value;
        break;
      default:
        throw bad(`Unknown option ${JSON.stringify(key).slice(0, 40)}`);
    }
  }
  return out;
}

// Returns { conferenceId, github?, interests?, options } or throws HttpError.
function validatePlanRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object');
  const { conferenceId, github, interests, options } = body;
  if (typeof conferenceId !== 'string' || !CONFERENCE_ID.test(conferenceId)) {
    throw bad('conferenceId must be a conference id such as kubecon-na-2026');
  }
  const hasGithub = github !== undefined && github !== null && github !== '';
  const hasInterests = interests !== undefined && interests !== null && interests !== '';
  if (!hasGithub && !hasInterests) throw bad('Give a GitHub username, your interests, or both');
  const out = { conferenceId, options: validateOptions(options) };
  if (hasGithub) {
    if (typeof github !== 'string' || !GITHUB_USER.test(github)) throw bad('That is not a valid GitHub username');
    out.github = github;
  }
  if (hasInterests) {
    if (typeof interests !== 'string') throw bad('interests must be text');
    const text = interests.trim();
    if (!text) throw bad('Tell us at least one interest');
    if (text.length > MAX_INTERESTS) throw bad(`Keep your interests under ${MAX_INTERESTS} characters`);
    out.interests = text;
  }
  return out;
}

// Messages for errors the user can act on; upstream details stay server-side.
function publicMessage(err) {
  if (err.code === 'upstream') return 'A service the planner depends on failed. Try again in a moment.';
  if (err.code === 'rate_limited') {
    return err.message || 'GitHub is rate limiting us right now. Try typing your interests instead.';
  }
  return err.message || 'Something was wrong with the request';
}

// With both inputs, these GitHub failures fall back to the typed interests;
// the response then carries the warning so the UI can say why.
const GITHUB_FALLBACK = { rate_limited: 'github_rate_limited', not_found: 'github_not_found', upstream: 'github_unavailable' };

function planSource(input) {
  if (input.github && input.interests) return 'github+interests';
  return input.github ? 'github' : 'interests';
}

// Builds the profile, falling back to the interests alone when GitHub fails
// and the user typed some. Returns { profile, warnings }.
async function profileFor(input, buildProfile, span) {
  if (!input.github) return { profile: await buildProfile({ interests: input.interests }), warnings: [] };
  if (!input.interests) return { profile: await buildProfile({ github: input.github }), warnings: [] };
  try {
    return { profile: await buildProfile({ github: input.github, interests: input.interests }), warnings: [] };
  } catch (err) {
    const warning = err && Object.hasOwn(GITHUB_FALLBACK, err.code) ? GITHUB_FALLBACK[err.code] : null;
    if (!warning) throw err;
    span?.setAttribute('plan.fallback', warning);
    return { profile: await buildProfile({ interests: input.interests }), warnings: [warning] };
  }
}

// deps: { buildProfile, buildPlan, hasConference } so tests can inject fakes.
function createPlanHandler(deps) {
  return async function handlePlan(req, res) {
    const span = trace.getActiveSpan();
    try {
      const body = await readJsonBody(req);
      const input = validatePlanRequest(body);
      span?.setAttributes({
        'plan.source': planSource(input),
        'conference.id': input.conferenceId,
      });
      if (deps.hasConference && !deps.hasConference(input.conferenceId)) {
        throw new HttpError('not_found', `No conference named ${input.conferenceId}`);
      }
      const { profile, warnings } = await profileFor(input, deps.buildProfile, span);
      const plan = await deps.buildPlan({ conferenceId: input.conferenceId, profile, options: input.options });
      sendJson(res, 200, warnings.length ? { profile, plan, warnings } : { profile, plan });
    } catch (err) {
      if (err instanceof HttpError) {
        span?.setAttribute('plan.error_code', err.code);
        return sendError(res, err.code, err.message);
      }
      if (err && KNOWN_CODES.has(err.code)) {
        span?.setAttribute('plan.error_code', err.code);
        if (err.code === 'upstream') {
          span?.recordException(err);
          span?.setStatus({ code: SpanStatusCode.ERROR, message: 'upstream' });
        }
        const headers = err.code === 'rate_limited' && err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {};
        return sendError(res, err.code, publicMessage(err), headers);
      }
      span?.recordException(err);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: 'unexpected error in /api/plan' });
      // Name and message only: never request headers or upstream bodies.
      console.error(`POST /api/plan failed: ${err && err.name}: ${err && err.message}`);
      return sendError(res, 'internal', 'Something went wrong on our side. Try again in a moment.');
    }
  };
}

module.exports = { createPlanHandler, validatePlanRequest, validateOptions, GITHUB_USER };
