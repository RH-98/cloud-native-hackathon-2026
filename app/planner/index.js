// buildPlan: profile -> searched, scored sessions -> a day plan with backups
// and booth suggestions (shape in docs/CONTRACTS.md).
//
// Searches Elasticsearch when ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY are
// set; otherwise, or when Elasticsearch fails, scores the bundled snapshot in
// memory. The plan says which one served it (`searchBackend`).
const fs = require('node:fs');
const path = require('node:path');
const es = require('../search/elasticsearch');
const metrics = require('../metrics');
const snapshotSearch = require('./snapshot-search');
const { planDays, normalizeOptions } = require('./plan');
const { tierRank } = require('./terms');

const DATA_DIR = path.join(__dirname, '..', 'data', 'conferences');
const CANDIDATES = 250;

const snapshots = new Map();

function loadSnapshot(conferenceId) {
  if (typeof conferenceId !== 'string' || !/^[a-z0-9-]+$/.test(conferenceId)) return null;
  if (!snapshots.has(conferenceId)) {
    const file = path.join(DATA_DIR, `${conferenceId}.json`);
    snapshots.set(conferenceId, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  }
  return snapshots.get(conferenceId);
}

let sharedClient = null;
function defaultClient(env) {
  if (!sharedClient) sharedClient = es.createClient(env);
  return sharedClient;
}

// Runs the Elasticsearch search, falling back to the snapshot on any error
// (recorded on the plan.build span; the es.* span records the error itself).
async function search(span, { snapshot, query, env, client }) {
  const available = Boolean(client) || es.searchAvailable(env);
  if (available) {
    try {
      const c = client || defaultClient(env);
      const [candidates, sponsors] = await Promise.all([
        es.searchSessions(c, query),
        es.searchSponsors(c, { conferenceId: query.conferenceId, profile: query.profile }),
      ]);
      return { backend: 'elasticsearch', candidates, sponsors };
    } catch (err) {
      span.recordException(err);
      span.addEvent('search_fallback', { 'search.backend': 'snapshot', 'error.type': err.name || 'Error' });
      metrics.recordSearchFallback('es_error');
    }
  } else {
    metrics.recordSearchFallback('no_credentials');
  }
  let startedAt = metrics.now();
  const candidates = snapshotSearch.searchSessions(snapshot, query);
  metrics.recordSearchDuration({ index: 'sessions', fusion: 'snapshot', startedAt });
  startedAt = metrics.now();
  const sponsors = snapshotSearch.searchSponsors(snapshot, query);
  metrics.recordSearchDuration({ index: 'sponsors', fusion: 'snapshot', startedAt });
  return { backend: 'snapshot', candidates, sponsors };
}

const CLIENT_ERRORS = new Set(['invalid_input', 'not_found']);

// deps (tests): { env, client } — a fake Elasticsearch client, or env without credentials.
async function buildPlan({ conferenceId, profile, options } = {}, deps = {}) {
  const startedAt = metrics.now();
  // Filled in as the plan is built; only fixed values and a known conference id.
  const m = { conference: undefined, source: profile && profile.source, backend: 'none', picks: undefined };
  try {
    const plan = await tracedBuildPlan({ conferenceId, profile, options }, deps, m);
    metrics.recordPlan({ ...m, outcome: 'ok', startedAt });
    return plan;
  } catch (err) {
    metrics.recordPlan({ ...m, outcome: CLIENT_ERRORS.has(err.code) ? 'rejected' : 'error', startedAt });
    throw err;
  }
}

async function tracedBuildPlan({ conferenceId, profile, options }, deps, m) {
  const env = deps.env || process.env;
  return es.withSpan('plan.build', { 'conference.id': String(conferenceId || '').slice(0, 64) }, async (span) => {
    const snapshot = loadSnapshot(conferenceId);
    if (!snapshot) {
      const err = new Error(`No conference named ${String(conferenceId).slice(0, 64)}`);
      err.code = 'not_found';
      throw err;
    }
    m.conference = conferenceId;
    if (!profile || typeof profile !== 'object') {
      const err = new Error('A profile is required');
      err.code = 'invalid_input';
      throw err;
    }
    const opts = normalizeOptions(options, snapshot);
    const query = {
      conferenceId,
      profile,
      days: opts.days,
      levels: opts.levels,
      size: CANDIDATES,
      utcOffset: snapshot.conference.utcOffset,
    };
    const { backend, candidates, sponsors } = await search(span, { snapshot, query, env, client: deps.client });

    // Return the snapshot's own session objects, so the shape is exactly the data format.
    const sessionsById = new Map(snapshot.sessions.map((s) => [s.id, s]));
    const recs = candidates.map((c) => ({ ...c, session: sessionsById.get(c.session.id) || c.session }));

    m.backend = backend;
    const days = planDays({ snapshot, candidates: recs, sponsors, options: opts, tierRank });
    m.picks = days.reduce((n, d) => n + d.slots.filter((s) => s.pick).length, 0);
    span.setAttribute('search.backend', backend);
    span.setAttribute('plan.days', opts.days.join(','));
    span.setAttribute('plan.candidates', candidates.length);
    span.setAttribute('plan.picks', m.picks);

    const { conference } = snapshot;
    return {
      conferenceId,
      conference: {
        name: conference.name,
        timezone: conference.timezone,
        utcOffset: conference.utcOffset,
        location: conference.location,
      },
      generatedAt: new Date().toISOString(),
      searchBackend: backend,
      days,
    };
  });
}

module.exports = { buildPlan, loadSnapshot };
