// buildPlan: profile -> searched, scored sessions -> a day plan with backups
// and booth suggestions (shape in docs/CONTRACTS.md).
//
// Searches Elasticsearch when ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY are
// set; otherwise, or when Elasticsearch fails, scores the bundled snapshot in
// memory. The plan says which one served it (`searchBackend`).
const fs = require('node:fs');
const path = require('node:path');
const es = require('../search/elasticsearch');
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
  if (client || es.searchAvailable(env)) {
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
    }
  }
  return {
    backend: 'snapshot',
    candidates: snapshotSearch.searchSessions(snapshot, query),
    sponsors: snapshotSearch.searchSponsors(snapshot, query),
  };
}

// deps (tests): { env, client } — a fake Elasticsearch client, or env without credentials.
async function buildPlan({ conferenceId, profile, options } = {}, deps = {}) {
  const env = deps.env || process.env;
  return es.withSpan('plan.build', { 'conference.id': String(conferenceId || '').slice(0, 64) }, async (span) => {
    const snapshot = loadSnapshot(conferenceId);
    if (!snapshot) {
      const err = new Error(`No conference named ${String(conferenceId).slice(0, 64)}`);
      err.code = 'not_found';
      throw err;
    }
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

    const days = planDays({ snapshot, candidates: recs, sponsors, options: opts, tierRank });
    span.setAttribute('search.backend', backend);
    span.setAttribute('plan.days', opts.days.join(','));
    span.setAttribute('plan.candidates', candidates.length);
    span.setAttribute('plan.picks', days.reduce((n, d) => n + d.slots.filter((s) => s.pick).length, 0));

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
