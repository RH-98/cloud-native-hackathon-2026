// Every Elasticsearch call the app makes lives in this module: index
// definitions, loading and (later) search queries. Credentials come only from
// the environment (ELASTICSEARCH_URL, and ELASTICSEARCH_API_KEY from the
// app-credentials Secret).
const { Client } = require('@elastic/elasticsearch');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const terms = require('../planner/terms');

const tracer = trace.getTracer('conference-search');

const INDEX = {
  sessions: 'conference-sessions',
  sponsors: 'conference-sponsors',
  conferences: 'conference-meta',
};

// Jina embeddings come with Elastic Cloud: no extra API key needed.
const EMBEDDING_INFERENCE_ID = '.jina-embeddings-v5-text-small';

const MAPPINGS = {
  [INDEX.sessions]: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      conferenceId: { type: 'keyword' },
      sourceId: { type: 'keyword' },
      title: { type: 'text', copy_to: 'semantic', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
      description: { type: 'text', copy_to: 'semantic' },
      // Meaning-based matching over title + description.
      semantic: { type: 'semantic_text', inference_id: EMBEDDING_INFERENCE_ID },
      start: { type: 'date' },
      end: { type: 'date' },
      room: { type: 'keyword' },
      speakers: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      track: { type: 'keyword' },
      level: { type: 'keyword' },
      tags: { type: 'keyword' },
      sponsored: { type: 'boolean' },
      kind: { type: 'keyword' },
      slidesAvailable: { type: 'boolean' },
      url: { type: 'keyword', index: false },
    },
  },
  [INDEX.sponsors]: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      conferenceId: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      tier: { type: 'keyword' },
      url: { type: 'keyword', index: false },
    },
  },
  [INDEX.conferences]: {
    dynamic: 'strict',
    properties: {
      id: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      location: { type: 'text' },
      timezone: { type: 'keyword' },
      utcOffset: { type: 'keyword' },
      startDate: { type: 'date' },
      endDate: { type: 'date' },
      retrievedAt: { type: 'date' },
      sessionCount: { type: 'integer' },
      sponsorCount: { type: 'integer' },
    },
  },
};

function createClient(env = process.env) {
  const node = env.ELASTICSEARCH_URL;
  const apiKey = env.ELASTICSEARCH_API_KEY;
  if (!node || !apiKey) {
    throw new Error('ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY must be set');
  }
  return new Client({ node, auth: { apiKey }, requestTimeout: 120_000, maxRetries: 3 });
}

// Run fn inside a named span, recording errors on it.
function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function ensureIndices(client) {
  return withSpan('es.ensure_indices', {}, async (span) => {
    const created = [];
    for (const [index, mappings] of Object.entries(MAPPINGS)) {
      if (!(await client.indices.exists({ index }))) {
        await client.indices.create({ index, mappings });
        created.push(index);
      }
    }
    span.setAttribute('es.indices.created', created.join(','));
    return created;
  });
}

// Snapshot (common conference format) -> bulk operations. Pure, for tests.
function toBulkOperations(snapshot) {
  const { conference, sessions, sponsors } = snapshot;
  const ops = [];
  for (const s of sessions) {
    ops.push({ index: { _index: INDEX.sessions, _id: s.id } }, s);
  }
  for (const s of sponsors) {
    ops.push({ index: { _index: INDEX.sponsors, _id: s.id } }, s);
  }
  ops.push(
    { index: { _index: INDEX.conferences, _id: conference.id } },
    {
      id: conference.id,
      name: conference.name,
      location: conference.location,
      timezone: conference.timezone,
      utcOffset: conference.utcOffset,
      startDate: conference.startDate,
      endDate: conference.endDate,
      retrievedAt: conference.source?.retrievedAt,
      sessionCount: sessions.length,
      sponsorCount: sponsors.length,
    },
  );
  return ops;
}

// When was this conference last loaded? Lets the loader skip unchanged snapshots.
async function getLoadedConference(client, conferenceId) {
  try {
    const res = await client.get({ index: INDEX.conferences, id: conferenceId });
    return res._source;
  } catch (err) {
    if (err.meta?.statusCode === 404) return null;
    throw err;
  }
}

async function loadSnapshot(client, snapshot, { batchSize = 50 } = {}) {
  const conferenceId = snapshot.conference.id;
  return withSpan('es.load_snapshot', { 'conference.id': conferenceId }, async (span) => {
    const ops = toBulkOperations(snapshot);
    const metaOps = ops.splice(ops.length - 2, 2);
    let indexed = 0;
    const failures = [];
    // Small batches: each session runs through the embedding model on ingest.
    for (let i = 0; i < ops.length; i += batchSize * 2) {
      const batch = ops.slice(i, i + batchSize * 2);
      const res = await withSpan('es.bulk', { 'es.bulk.operations': batch.length / 2 }, () =>
        client.bulk({ operations: batch }),
      );
      for (const item of res.items) {
        const result = item.index;
        if (result.error) failures.push({ id: result._id, reason: result.error.reason });
        else indexed += 1;
      }
    }
    if (failures.length === 0) {
      const res = await withSpan('es.bulk', { 'es.bulk.operations': 1 }, () =>
        client.bulk({ operations: metaOps, refresh: true }),
      );
      for (const item of res.items) {
        const result = item.index;
        if (result.error) failures.push({ id: result._id, reason: result.error.reason });
        else indexed += 1;
      }
    }
    await client.indices.refresh({ index: Object.values(INDEX) });
    span.setAttribute('es.documents.indexed', indexed);
    span.setAttribute('es.documents.failed', failures.length);
    return { indexed, failures };
  });
}

// --- Search -------------------------------------------------------------------
// Request bodies are plain query objects built from the profile: user input
// only ever lands in query values, never in a query string.

const SEARCH_TRANSPORT = { requestTimeout: 10_000, maxRetries: 1 };
const RRF_RANK_CONSTANT = 60;
const LEXICAL_FIELDS = ['title^3', 'description', 'tags^2', 'track'];
// How much the profile-term match and the fused rank each count in a hit's score.
const BLEND = { lexical: 0.5, rank: 0.5 };

function searchAvailable(env = process.env) {
  return Boolean(env.ELASTICSEARCH_URL && env.ELASTICSEARCH_API_KEY);
}

// Filters shared by both retrievers: this conference, real sessions, the
// requested days (in the conference's offset) and levels (plus Any Level/none).
function sessionFilters({ conferenceId, days, levels, utcOffset = '-07:00' }) {
  const filter = [{ term: { conferenceId } }, { term: { kind: 'session' } }];
  if (days && days.length) {
    filter.push({
      bool: {
        should: days.map((day) => ({
          range: { start: { gte: `${day}T00:00:00${utcOffset}`, lte: `${day}T23:59:59${utcOffset}` } },
        })),
        minimum_should_match: 1,
      },
    });
  }
  if (levels && levels.length) {
    filter.push({
      bool: {
        should: [
          { terms: { level: [...new Set([...levels, 'Any Level'])] } },
          { bool: { must_not: { exists: { field: 'level' } } } },
        ],
        minimum_should_match: 1,
      },
    });
  }
  return filter;
}

function buildSessionSearch({ conferenceId, profile, days, levels, size = 250, utcOffset }) {
  const profileTerms = terms.profileTerms(profile);
  const filter = sessionFilters({ conferenceId, days, levels, utcOffset });
  const should = profileTerms.flatMap((t) =>
    t.variants.map((variant) => ({
      multi_match: {
        query: variant,
        fields: LEXICAL_FIELDS,
        operator: 'and',
        lenient: true,
        boost: Math.max(0.01, Math.round(t.weight * 1000) / 1000),
      },
    })),
  );
  const lexical = should.length
    ? { bool: { should, minimum_should_match: 1, filter } }
    : { bool: { filter } };
  const semanticText = terms.semanticQueryText(profile, profileTerms);
  const semantic = { bool: { must: [{ semantic: { field: 'semantic', query: semanticText } }], filter } };
  const common = { index: INDEX.sessions, size, _source: { excludes: ['semantic'] } };
  return {
    terms: profileTerms,
    semanticText,
    common,
    lexical,
    semantic,
    request: {
      ...common,
      retriever: {
        rrf: {
          retrievers: [{ standard: { query: lexical } }, { standard: { query: semantic } }],
          rank_window_size: size,
          rank_constant: RRF_RANK_CONSTANT,
        },
      },
    },
  };
}

// Reciprocal rank fusion in JS, for clusters that refuse the rrf retriever.
// lists: arrays of hits, each in rank order. Returns hits with an RRF _score.
function fuseRrf(lists, { rankConstant = RRF_RANK_CONSTANT, size = Infinity } = {}) {
  const byId = new Map();
  for (const hits of lists) {
    hits.forEach((hit, i) => {
      const entry = byId.get(hit._id) || { hit, score: 0 };
      entry.score += 1 / (rankConstant + i + 1);
      byId.set(hit._id, entry);
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || String(a.hit._id).localeCompare(String(b.hit._id)))
    .slice(0, size)
    .map((e) => ({ ...e.hit, _score: e.score }));
}

// Hits -> [{ session, score, reasons }]. The score (0..1) blends how well the
// profile terms match (computed here, so it means the same thing for every
// backend) with the fused rank, normalized so that first place in either
// retriever counts fully (rank 10 ~0.87, rank 100 ~0.38).
function toRecommendations(hits, profileTerms, { rankConstant = RRF_RANK_CONSTANT } = {}) {
  const best = 1 / (rankConstant + 1);
  return hits
    .map((hit) => {
      const { semantic, ...session } = hit._source || {};
      const matches = terms.sessionMatches(session, profileTerms);
      const rank = Math.min(1, (hit._score || 0) / best);
      const score = BLEND.lexical * terms.lexicalScore(matches) + BLEND.rank * rank;
      return {
        session,
        score: Math.round(score * 1000) / 1000,
        reasons: terms.sessionReasons(session, matches, { semantic: true }),
      };
    })
    .sort((a, b) => b.score - a.score || a.session.id.localeCompare(b.session.id));
}

function rrfUnsupported(err) {
  const status = err && err.meta && err.meta.statusCode;
  return status === 400 || status === 403 || /rrf|retriever|licen[cs]e/i.test((err && err.message) || '');
}

async function searchSessions(client, { conferenceId, profile, days, levels, size = 250, utcOffset } = {}) {
  const attributes = {
    'conference.id': conferenceId,
    'es.index': INDEX.sessions,
    'es.size': size,
    'search.days': (days || []).join(','),
  };
  return withSpan('es.search_sessions', attributes, async (span) => {
    const built = buildSessionSearch({ conferenceId, profile, days, levels, size, utcOffset });
    span.setAttribute('search.terms', built.terms.length);
    let hits;
    try {
      const res = await client.search(built.request, SEARCH_TRANSPORT);
      hits = res.hits.hits;
      span.setAttribute('es.fusion', 'rrf');
    } catch (err) {
      if (!rrfUnsupported(err)) throw err;
      span.addEvent('rrf_unsupported', { 'http.status_code': (err.meta && err.meta.statusCode) || 0 });
      const [lexical, semantic] = await Promise.all([
        client.search({ ...built.common, query: built.lexical }, SEARCH_TRANSPORT),
        client.search({ ...built.common, query: built.semantic }, SEARCH_TRANSPORT),
      ]);
      hits = fuseRrf([lexical.hits.hits, semantic.hits.hits], { size });
      span.setAttribute('es.fusion', 'js');
    }
    span.setAttribute('es.hits', hits.length);
    return toRecommendations(hits, built.terms);
  });
}

function buildSponsorSearch({ conferenceId, profile }) {
  const profileTerms = terms.profileTerms(profile);
  const vendorNames = terms.vendorNamesFor(profileTerms);
  const should = profileTerms
    .filter((t) => t.kind === 'tool' && t.key.length >= 4)
    .map((t) => ({ match: { name: { query: t.key, operator: 'and' } } }));
  if (vendorNames.length) should.push({ terms: { 'name.keyword': vendorNames } });
  return {
    terms: profileTerms,
    request: should.length
      ? {
          index: INDEX.sponsors,
          size: 50,
          query: { bool: { filter: [{ term: { conferenceId } }], should, minimum_should_match: 1 } },
        }
      : null,
  };
}

// Sponsors whose name or known products match the profile's tools.
async function searchSponsors(client, { conferenceId, profile } = {}) {
  return withSpan('es.search_sponsors', { 'conference.id': conferenceId, 'es.index': INDEX.sponsors }, async (span) => {
    const built = buildSponsorSearch({ conferenceId, profile });
    if (!built.request) {
      span.setAttribute('es.hits', 0);
      return [];
    }
    const res = await client.search(built.request, SEARCH_TRANSPORT);
    const sponsors = res.hits.hits.map((h) => h._source);
    span.setAttribute('es.hits', sponsors.length);
    return terms.rankSponsors(sponsors, built.terms);
  });
}

// ---------------------------------------------------------------------------
// Suggested connections: attendees (opt-in only). Owned by the social feature.
// ---------------------------------------------------------------------------
const { termKey } = require('../social/catalog');
const { interestSummary } = require('../social/match');

const ATTENDEES_INDEX = 'conference-attendees';

const ATTENDEES_MAPPING = {
  dynamic: 'strict',
  properties: {
    id: { type: 'keyword' },
    conferenceId: { type: 'keyword' },
    displayName: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    handle: { type: 'keyword' },
    role: { type: 'text' },
    bio: { type: 'text' },
    experience: { type: 'keyword' },
    maintains: { type: 'keyword' },
    optIn: { type: 'boolean' },
    // Canonical keys (catalog termKey), so "Argo CD" and "argo-cd" match.
    tools: { type: 'keyword' },
    topics: { type: 'keyword' },
    languages: { type: 'keyword' },
    keywords: { type: 'text' },
    goingTo: { type: 'keyword' },
    summary: { type: 'text', copy_to: 'semantic' },
    semantic: { type: 'semantic_text', inference_id: EMBEDDING_INFERENCE_ID },
    // The weighted interest set, stored (not indexed) to explain matches.
    interests: { type: 'object', enabled: false },
  },
};

const keysOf = (list) => [
  ...new Set((list || []).map((x) => termKey(typeof x === 'string' ? x : x?.name)).filter(Boolean)),
];

// Attendee (data/attendees format) -> index document. Pure, for tests.
function toAttendeeDocument(attendee) {
  const interests = attendee.interests || {};
  return {
    id: attendee.id,
    conferenceId: attendee.conferenceId,
    displayName: attendee.displayName,
    handle: attendee.handle,
    role: attendee.role,
    bio: attendee.bio,
    experience: attendee.experience || null,
    maintains: attendee.maintains || [],
    optIn: attendee.optIn === true,
    tools: keysOf(interests.tools),
    topics: keysOf(interests.topics),
    languages: keysOf(interests.languages),
    keywords: (interests.keywords || []).join(', '),
    goingTo: attendee.goingTo || [],
    summary: interestSummary({ ...interests, role: attendee.role }),
    interests,
  };
}

// Back from a hit to the attendee shape match.js scores.
function fromAttendeeDocument(doc) {
  return {
    id: doc.id,
    conferenceId: doc.conferenceId,
    displayName: doc.displayName,
    handle: doc.handle,
    role: doc.role,
    bio: doc.bio,
    experience: doc.experience,
    maintains: doc.maintains || [],
    optIn: doc.optIn === true,
    interests: doc.interests || {},
    goingTo: doc.goingTo || [],
  };
}

async function ensureAttendeesIndex(client) {
  return withSpan('es.ensure_attendees_index', { 'es.index': ATTENDEES_INDEX }, async (span) => {
    const exists = await client.indices.exists({ index: ATTENDEES_INDEX });
    if (!exists) await client.indices.create({ index: ATTENDEES_INDEX, mappings: ATTENDEES_MAPPING });
    span.setAttribute('es.index.created', !exists);
    return !exists;
  });
}

async function loadAttendees(client, conferenceId, attendees, { batchSize = 25 } = {}) {
  return withSpan('es.load_attendees', { 'conference.id': conferenceId }, async (span) => {
    const docs = attendees.filter((a) => a.conferenceId === conferenceId).map(toAttendeeDocument);
    let indexed = 0;
    const failures = [];
    for (let i = 0; i < docs.length; i += batchSize) {
      const operations = docs
        .slice(i, i + batchSize)
        .flatMap((doc) => [{ index: { _index: ATTENDEES_INDEX, _id: doc.id } }, doc]);
      const res = await withSpan('es.bulk', { 'es.bulk.operations': operations.length / 2 }, () =>
        client.bulk({ operations }),
      );
      for (const item of res.items) {
        if (item.index.error) failures.push({ id: item.index._id, reason: item.index.error.reason });
        else indexed += 1;
      }
    }
    await client.indices.refresh({ index: ATTENDEES_INDEX });
    span.setAttribute('es.documents.indexed', indexed);
    span.setAttribute('es.documents.failed', failures.length);
    return { indexed, failures };
  });
}

// The two retrievers' queries for a profile. Pure, for tests. Each carries
// the opt-in + conference filter, so nobody who opted out can come back.
function attendeeQueries({ conferenceId, profile }) {
  const filter = [{ term: { conferenceId } }, { term: { optIn: true } }];
  const should = [];
  const tools = keysOf(profile?.tools);
  const topics = keysOf([...(profile?.topics || []), ...(profile?.tools || [])]);
  const languages = keysOf(profile?.languages);
  if (tools.length) should.push({ terms: { tools, boost: 3 } });
  if (topics.length) should.push({ terms: { topics, boost: 2 } });
  if (languages.length) should.push({ terms: { languages, boost: 1 } });
  const keywordText = (profile?.keywords || []).filter((k) => typeof k === 'string').join(' ');
  if (keywordText) should.push({ match: { keywords: { query: keywordText, boost: 0.5 } } });
  const summary = interestSummary(profile || {});
  return {
    lexical: should.length ? { bool: { filter, should, minimum_should_match: 1 } } : null,
    semantic: summary ? { bool: { filter, must: [{ semantic: { field: 'semantic', query: summary } }] } } : null,
  };
}

// Opted-in attendees for a profile: RRF of tag overlap and semantic similarity.
// Returns attendee objects (match.js shape), best first.
async function searchAttendees(client, { conferenceId, profile, size = 15 }) {
  return withSpan('es.search_attendees', { 'conference.id': conferenceId, 'es.size': size }, async (span) => {
    const { lexical, semantic } = attendeeQueries({ conferenceId, profile });
    const queries = [lexical, semantic].filter(Boolean);
    if (!queries.length) return [];
    const windowSize = Math.max(size * 3, 30);
    let hits;
    if (queries.length === 1) {
      span.setAttribute('es.fusion', 'none');
      const res = await client.search({ index: ATTENDEES_INDEX, query: queries[0], size }, SEARCH_TRANSPORT);
      hits = res.hits.hits;
    } else {
      try {
        const res = await client.search({
          index: ATTENDEES_INDEX,
          size,
          retriever: {
            rrf: {
              retrievers: queries.map((query) => ({ standard: { query } })),
              rank_window_size: windowSize,
              rank_constant: RRF_RANK_CONSTANT,
            },
          },
        }, SEARCH_TRANSPORT);
        span.setAttribute('es.fusion', 'rrf');
        hits = res.hits.hits;
      } catch (err) {
        if (!rrfUnsupported(err)) throw err;
        span.setAttribute('es.fusion', 'js');
        const lists = [];
        for (const query of queries) {
          const res = await client.search({ index: ATTENDEES_INDEX, query, size: windowSize }, SEARCH_TRANSPORT);
          lists.push(res.hits.hits);
        }
        hits = fuseRrf(lists, { size });
      }
    }
    span.setAttribute('es.hits', hits.length);
    // Belt and braces: the filter already excludes opted-out attendees.
    return hits.map((h) => fromAttendeeDocument(h._source)).filter((a) => a.optIn === true);
  });
}

module.exports = {
  INDEX,
  MAPPINGS,
  EMBEDDING_INFERENCE_ID,
  createClient,
  ensureIndices,
  toBulkOperations,
  getLoadedConference,
  loadSnapshot,
  withSpan,
  searchAvailable,
  sessionFilters,
  buildSessionSearch,
  fuseRrf,
  toRecommendations,
  searchSessions,
  buildSponsorSearch,
  searchSponsors,
  // Suggested connections
  ATTENDEES_INDEX,
  ATTENDEES_MAPPING,
  toAttendeeDocument,
  fromAttendeeDocument,
  ensureAttendeesIndex,
  loadAttendees,
  attendeeQueries,
  searchAttendees,
};
