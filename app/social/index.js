// Suggested connections: Elasticsearch when configured (opt-in filter, RRF of
// tag overlap and semantic similarity), else the in-memory matcher over the
// committed demo attendees. Either way match.js explains each match.
const fs = require('node:fs');
const path = require('node:path');
const { matchAttendees } = require('./match');

const ATTENDEES_DIR = path.join(__dirname, '..', 'data', 'attendees');
const CONFERENCES_DIR = path.join(__dirname, '..', 'data', 'conferences');
const ID_PATTERN = /^[a-z0-9-]+$/;

const cache = new Map();
function readJson(dir, id) {
  if (!ID_PATTERN.test(id || '')) return null;
  const file = path.join(dir, `${id}.json`);
  const key = file;
  if (!cache.has(key)) cache.set(key, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  return cache.get(key);
}

function loadAttendees(conferenceId) {
  return readJson(ATTENDEES_DIR, conferenceId)?.attendees || null;
}

// id -> { id, title, start } for naming common sessions.
const sessionIndexes = new Map();
function sessionIndex(conferenceId) {
  if (!sessionIndexes.has(conferenceId)) {
    const snapshot = readJson(CONFERENCES_DIR, conferenceId);
    sessionIndexes.set(
      conferenceId,
      new Map((snapshot?.sessions || []).map((s) => [s.id, { id: s.id, title: s.title, start: s.start }])),
    );
  }
  return sessionIndexes.get(conferenceId);
}

function esConfigured(env) {
  return Boolean(env.ELASTICSEARCH_URL && env.ELASTICSEARCH_API_KEY);
}

let sharedClient;
function defaultClient(env) {
  if (!sharedClient) sharedClient = require('../search/elasticsearch').createClient(env);
  return sharedClient;
}

// { conferenceId, profile, pickedSessionIds, limit, firstTimer }
// deps (for tests): { env, client, search, attendees, logger }
async function suggestConnections(input, deps = {}) {
  const { conferenceId, profile, pickedSessionIds = [], limit = 5, firstTimer = false } = input;
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  const options = { limit, pickedSessionIds, firstTimer };

  let backend = 'snapshot';
  let results = null;
  if (deps.client || esConfigured(env)) {
    try {
      const search = deps.search || require('../search/elasticsearch').searchAttendees;
      const client = deps.client || defaultClient(env);
      const candidates = await search(client, { conferenceId, profile, size: Math.max(limit * 3, 15) });
      results = matchAttendees(profile, candidates, options);
      backend = 'elasticsearch';
    } catch (err) {
      // Degrade to the in-memory matcher rather than failing the request.
      logger.warn(`connections: Elasticsearch search failed, using the snapshot (${err.message})`);
    }
  }
  if (!results) {
    const attendees = deps.attendees || loadAttendees(conferenceId);
    if (!attendees) return null;
    results = matchAttendees(profile, attendees, options);
  }

  const sessions = sessionIndex(conferenceId);
  return {
    searchBackend: backend,
    connections: results.map((r) => ({
      ...r,
      commonSessions: r.commonSessions.map((id) => sessions.get(id) || { id, title: null, start: null }),
    })),
  };
}

module.exports = { suggestConnections, loadAttendees };
