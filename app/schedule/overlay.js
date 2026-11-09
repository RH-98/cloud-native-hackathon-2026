// Applies recorded schedule changes (index conference-changes) to the bundled
// snapshot, so plans use a session's new time and room and drop cancelled
// sessions. The planner returns the snapshot's own session objects, so
// without this a re-plan would still use the old times.
const es = require('../search/elasticsearch');

const CACHE_MS = 30_000;
const cache = new Map(); // conferenceId -> { at, changes, checkedAt }

// The most recent change per session (changes in any order).
function latestBySession(changes) {
  const latest = new Map();
  for (const c of changes || []) {
    if (!c || typeof c.sessionId !== 'string' || typeof c.type !== 'string') continue;
    const prev = latest.get(c.sessionId);
    if (!prev || String(c.detectedAt || '') > String(prev.detectedAt || '')) latest.set(c.sessionId, c);
  }
  return latest;
}

/** Pure: returns a new snapshot with the changes applied (or the same one if none apply). */
function overlaySnapshot(snapshot, changes) {
  const latest = latestBySession(changes);
  if (!latest.size) return snapshot;
  const sessions = [];
  let touched = false;
  for (const s of snapshot.sessions || []) {
    const c = latest.get(s.id);
    if (!c) {
      sessions.push(s);
      continue;
    }
    touched = true;
    if (c.type === 'cancelled') continue;
    const a = c.after || {};
    sessions.push({ ...s, start: a.start || s.start, end: a.end || s.end, room: a.room === undefined ? s.room : a.room });
  }
  return touched ? { ...snapshot, sessions } : snapshot;
}

// The snapshot with live changes applied. Never fails: on any Elasticsearch
// error it returns the snapshot unchanged (the es.search_changes span records it).
async function liveSnapshot(snapshot, client, { now = Date.now(), checkedAt } = {}) {
  const conferenceId = snapshot && snapshot.conference && snapshot.conference.id;
  if (!client || !conferenceId) return snapshot;
  let entry = cache.get(conferenceId);
  if (!entry || now - entry.at > CACHE_MS || (checkedAt && entry.checkedAt && checkedAt > entry.checkedAt)) {
    try {
      const { changes, checkedAt: latestCheckedAt } = await es.searchChanges(client, { conferenceId, size: 1000 });
      entry = { at: now, changes, checkedAt: latestCheckedAt };
    } catch {
      entry = { at: now, changes: entry ? entry.changes : [], checkedAt: entry && entry.checkedAt };
    }
    cache.set(conferenceId, entry);
  }
  return overlaySnapshot(snapshot, entry.changes);
}

module.exports = { latestBySession, overlaySnapshot, liveSnapshot, _cache: cache };
