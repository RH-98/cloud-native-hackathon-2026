// One schedule check for one conference: fetch the source, apply the demo
// overrides, diff against Elasticsearch, record and apply the changes.
// scripts/watch-schedule.js runs it for every conference snapshot; tests run
// it with a fake Elasticsearch client and a fixture page.
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const es = require('../search/elasticsearch');
const { parseSchedule } = require('../importers/lf-events');
const { parseSessionize } = require('../importers/sessionize');
const { fetchText } = require('../importers/fetch');
const { diffSessions } = require('./diff');
const { applyOverrides } = require('./overrides');

const tracer = trace.getTracer('schedule-watch');
let changeCounter;
function counter() {
  if (!changeCounter) {
    changeCounter = metrics.getMeter('conference-planner').createCounter('schedule.changes', {
      description: 'Schedule changes detected by the schedule-watch CronJob',
    });
  }
  return changeCounter;
}

function span(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (s) => {
    try {
      return await fn(s);
    } catch (err) {
      s.recordException(err);
      s.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      s.end();
    }
  });
}

// A parse that finds far fewer sessions than we hold means the page changed
// shape (or came back partial), not that half the conference was cancelled.
const MIN_SOURCE_RATIO = 0.8;

/**
 * Fetches and parses the conference's schedule page. Returns null when the
 * source can't be trusted this run (fetch failed, or too few sessions).
 */
// Which importer reads this conference's source: Sessionize's JSON API when
// the snapshot names one, otherwise the Linux Foundation schedule page.
function sourceFor(conference) {
  const src = conference.source || {};
  const opts = { conferenceId: conference.id, utcOffset: conference.utcOffset };
  if (src.sessionizeApiUrl) {
    return {
      url: src.sessionizeApiUrl,
      // Only time, room and title are compared; the track of an added session may differ from the importer's.
      parse: (text) => parseSessionize(JSON.parse(text), { ...opts, sessionUrl: src.scheduleUrl || null }),
    };
  }
  if (src.scheduleUrl) {
    return { url: src.scheduleUrl, parse: (text) => parseSchedule(text, { ...opts, pageUrl: src.scheduleUrl }) };
  }
  return null;
}

async function fetchSource(conference, liveCount, { fetchImpl, log }) {
  const source = sourceFor(conference);
  if (!source) return null;
  const { url } = source;
  return span('schedule.fetch', { 'conference.id': conference.id, 'url.full': url }, async (s) => {
    try {
      const text = await fetchText(url, 'schedule.fetch_page', { fetchImpl });
      const sessions = source.parse(text);
      s.setAttribute('schedule.sessions', sessions.length);
      if (sessions.length < Math.ceil(liveCount * MIN_SOURCE_RATIO)) {
        s.addEvent('source_rejected', { 'schedule.sessions': sessions.length, 'schedule.sessions_stored': liveCount });
        log(`${conference.id}: source lists ${sessions.length} sessions, we hold ${liveCount}; not trusting it this run`);
        return null;
      }
      return sessions;
    } catch (err) {
      // Keep going with overrides only; the error is on the fetch span.
      s.recordException(err);
      s.addEvent('source_unavailable');
      log(`${conference.id}: could not fetch the schedule (${err.message}); applying overrides only`);
      return null;
    }
  });
}

/**
 * @param {object} conference - the snapshot's conference record (id, utcOffset, source.scheduleUrl)
 * @param {{ client, overrides?: object[], fetchImpl?, now?: Date, log? }} deps
 * @returns {Promise<{ conferenceId, checkedAt, sourceUsed, changes: object[], warnings: string[] }>}
 */
async function watchConference(conference, { client, overrides = [], fetchImpl = fetch, now = new Date(), log = console.log } = {}) {
  const conferenceId = conference.id;
  const checkedAt = now.toISOString();
  const current = await es.getSessions(client, conferenceId);
  if (!current.length) {
    log(`${conferenceId}: no sessions in Elasticsearch yet; run the loader first`);
    return { conferenceId, checkedAt, sourceUsed: false, changes: [], warnings: [] };
  }
  const live = current.filter((s) => s.kind !== 'cancelled');

  const fetched = await fetchSource(conference, live.length, { fetchImpl, log });
  const base = fetched || live;
  const { sessions: next, simulatedIds, warnings } = applyOverrides(base, overrides);

  const diffs = await span('schedule.diff', { 'conference.id': conferenceId }, async (s) => {
    const d = diffSessions(current, next);
    s.setAttribute('schedule.changes', d.length);
    s.setAttribute('schedule.source_used', Boolean(fetched));
    return d;
  });

  // A change that undoes a simulated one (its override was removed) is simulated too.
  const lastSimulated = new Set();
  if (diffs.length) {
    const { changes: previous } = await es.searchChanges(client, {
      conferenceId,
      sessionIds: diffs.map((d) => d.sessionId),
      size: 1000,
    });
    const seen = new Set();
    for (const c of previous) {
      if (seen.has(c.sessionId)) continue; // newest first
      seen.add(c.sessionId);
      if (c.source === 'simulated') lastSimulated.add(c.sessionId);
    }
  }

  const records = diffs.map((d) => ({
    id: `${d.sessionId}@${checkedAt}`,
    conferenceId,
    sessionId: d.sessionId,
    sessionTitle: d.sessionTitle,
    type: d.type,
    before: d.before,
    after: d.after,
    detectedAt: checkedAt,
    source: simulatedIds.has(d.sessionId) || lastSimulated.has(d.sessionId) ? 'simulated' : 'live',
  }));

  const { failures } = await es.applySessionChanges(client, {
    conferenceId,
    diffs,
    records,
    checkedAt,
    liveRetrievedAt: fetched ? checkedAt : null,
  });
  if (failures.length) {
    throw new Error(`${conferenceId}: ${failures.length} writes failed (first: ${failures[0].id}: ${failures[0].reason})`);
  }
  for (const r of records) counter().add(1, { 'conference.id': conferenceId, type: r.type, source: r.source });
  return { conferenceId, checkedAt, sourceUsed: Boolean(fetched), changes: records, warnings };
}

module.exports = { watchConference, sourceFor, MIN_SOURCE_RATIO };
