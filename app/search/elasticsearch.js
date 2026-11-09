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

module.exports = {
  INDEX,
  MAPPINGS,
  EMBEDDING_INFERENCE_ID,
  createClient,
  ensureIndices,
  toBulkOperations,
  getLoadedConference,
  loadSnapshot,
};
