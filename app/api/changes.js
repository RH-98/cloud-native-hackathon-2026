// GET /api/changes?conferenceId=…&since=<ISO>&sessionIds=a,b: schedule
// changes (moved, re-roomed, cancelled sessions) found by the schedule-watch
// CronJob. See docs/CONTRACTS.md.
const { HttpError, sendJson, sendError } = require('./http');

const CONFERENCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,63}:[A-Za-z0-9_.-]{1,64}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_IDS = 200;

const bad = (message) => new HttpError('invalid_input', message);

// URLSearchParams -> { conferenceId, since, sessionIds }. Throws HttpError.
function validateChangesQuery(params, hasConference) {
  const conferenceId = params.get('conferenceId');
  if (!conferenceId || !CONFERENCE_ID.test(conferenceId)) throw bad('conferenceId is required, for example kubecon-na-2026');
  if (hasConference && !hasConference(conferenceId)) throw new HttpError('not_found', 'No conference with that id');

  let since = null;
  const rawSince = params.get('since');
  if (rawSince) {
    if (rawSince.length > 40 || !ISO_DATE_TIME.test(rawSince) || Number.isNaN(Date.parse(rawSince))) {
      throw bad('since must be an ISO 8601 date-time with a time zone, for example 2026-11-10T18:00:00Z');
    }
    since = new Date(rawSince).toISOString();
  }

  let sessionIds = null;
  const rawIds = params.get('sessionIds');
  if (rawIds) {
    const ids = [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_IDS) throw bad(`sessionIds has more than ${MAX_IDS} entries`);
    for (const id of ids) {
      if (!SESSION_ID.test(id) || !id.startsWith(`${conferenceId}:`)) throw bad('sessionIds has an invalid entry');
    }
    sessionIds = ids;
  }
  return { conferenceId, since, sessionIds };
}

function createChangesHandler({ getChanges, hasConference }) {
  return async function handleChanges(req, res, url) {
    let query;
    try {
      query = validateChangesQuery(url.searchParams, hasConference);
    } catch (err) {
      return sendError(res, err.code || 'invalid_input', err.message);
    }
    try {
      const { changes, checkedAt } = await getChanges(query);
      return sendJson(res, 200, { changes, checkedAt });
    } catch {
      // The es.search_changes span has the error; don't leak upstream details.
      return sendError(res, 'upstream', 'Schedule updates are unavailable right now');
    }
  };
}

module.exports = { createChangesHandler, validateChangesQuery, MAX_IDS };
