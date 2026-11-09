// Every Elasticsearch call the app makes lives in this module: index
// definitions, loading and (later) search queries. Credentials come only from
// the environment (ELASTICSEARCH_URL, and ELASTICSEARCH_API_KEY from the
// app-credentials Secret).
const { Client } = require('@elastic/elasticsearch');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

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

// Reciprocal rank fusion of ranked hit lists, in JS: the fallback when the
// cluster rejects the rrf retriever (license or version).
function fuseRankings(lists, { rankConstant = 60, size = 10 } = {}) {
  const fused = new Map();
  for (const hits of lists) {
    hits.forEach((hit, rank) => {
      const entry = fused.get(hit._id) || { hit, score: 0 };
      entry.score += 1 / (rankConstant + rank + 1);
      fused.set(hit._id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || String(a.hit._id).localeCompare(String(b.hit._id)))
    .slice(0, size)
    .map(({ hit, score }) => ({ ...hit, _score: score }));
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

const isRrfRejected = (err) => {
  const status = err?.meta?.statusCode;
  const text = JSON.stringify(err?.meta?.body?.error || err?.message || '');
  return (status === 400 || status === 403) && /rrf|retriever|licen[sc]e|rank/i.test(text);
};

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
      const res = await client.search({ index: ATTENDEES_INDEX, query: queries[0], size });
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
              rank_constant: 60,
            },
          },
        });
        span.setAttribute('es.fusion', 'rrf');
        hits = res.hits.hits;
      } catch (err) {
        if (!isRrfRejected(err)) throw err;
        span.setAttribute('es.fusion', 'js');
        const lists = [];
        for (const query of queries) {
          const res = await client.search({ index: ATTENDEES_INDEX, query, size: windowSize });
          lists.push(res.hits.hits);
        }
        hits = fuseRankings(lists, { size });
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
  // Suggested connections
  ATTENDEES_INDEX,
  ATTENDEES_MAPPING,
  toAttendeeDocument,
  fromAttendeeDocument,
  ensureAttendeesIndex,
  loadAttendees,
  fuseRankings,
  attendeeQueries,
  searchAttendees,
};
