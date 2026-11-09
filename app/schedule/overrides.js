// Simulated schedule changes for demos. The real schedule rarely changes while
// we watch, so the CronJob mounts ConfigMap schedule-overrides at
// /etc/schedule-overrides/overrides.json and the watcher applies it on top of
// what the source says:
//   [{ "sessionId": "kubecon-na-2026:1223002", "start": "…", "end": "…", "room": "…" },
//    { "sessionId": "kubecon-na-2026:1247277", "cancelled": true }]
// Changes caused by an override are recorded with source "simulated".
const fs = require('node:fs');

const DEFAULT_PATH = '/etc/schedule-overrides/overrides.json';
const MAX_OVERRIDES = 100;
const ID = /^[a-z0-9-]+:[A-Za-z0-9_-]+$/;

const validTime = (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)) && /T\d\d:\d\d/.test(t);

/**
 * Validates parsed overrides. Bad entries are dropped with a warning rather
 * than failing the run, so a typo in the ConfigMap can't stop live updates.
 * @returns {{ overrides: object[], warnings: string[] }}
 */
function normalizeOverrides(raw) {
  const warnings = [];
  if (raw == null) return { overrides: [], warnings };
  if (!Array.isArray(raw)) return { overrides: [], warnings: ['overrides must be a JSON array; ignoring it'] };
  const overrides = [];
  raw.slice(0, MAX_OVERRIDES).forEach((o, i) => {
    if (!o || typeof o !== 'object' || typeof o.sessionId !== 'string' || !ID.test(o.sessionId)) {
      warnings.push(`override ${i}: needs a sessionId like "kubecon-na-2026:1223002"`);
      return;
    }
    if (o.cancelled === true) {
      overrides.push({ sessionId: o.sessionId, cancelled: true });
      return;
    }
    const out = { sessionId: o.sessionId };
    for (const key of ['start', 'end']) {
      if (o[key] === undefined) continue;
      if (!validTime(o[key])) {
        warnings.push(`override ${i}: ${key} must be an ISO 8601 date-time with an offset`);
        return;
      }
      out[key] = o[key];
    }
    if (o.room !== undefined) {
      if (typeof o.room !== 'string' || !o.room.trim() || o.room.length > 200) {
        warnings.push(`override ${i}: room must be a non-empty string`);
        return;
      }
      out.room = o.room;
    }
    if (out.start && out.end && Date.parse(out.end) <= Date.parse(out.start)) {
      warnings.push(`override ${i}: end must be after start`);
      return;
    }
    if (Object.keys(out).length === 1) {
      warnings.push(`override ${i}: nothing to change (give start/end/room, or "cancelled": true)`);
      return;
    }
    overrides.push(out);
  });
  if (raw.length > MAX_OVERRIDES) warnings.push(`only the first ${MAX_OVERRIDES} overrides are used`);
  return { overrides, warnings };
}

// Reads the mounted file. Missing file = no overrides (local runs, or no ConfigMap).
function readOverrides(file = process.env.SCHEDULE_OVERRIDES_FILE || DEFAULT_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { overrides: [], warnings: [] };
    return { overrides: [], warnings: [`could not read ${file}: ${err.code || err.message}`] };
  }
  if (!text.trim()) return { overrides: [], warnings: [] };
  try {
    return normalizeOverrides(JSON.parse(text));
  } catch {
    return { overrides: [], warnings: [`${file} is not valid JSON; ignoring it`] };
  }
}

/**
 * Applies overrides to a list of sessions (not mutated).
 * @returns {{ sessions: object[], simulatedIds: Set<string>, warnings: string[] }}
 */
function applyOverrides(sessions, overrides) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const simulatedIds = new Set();
  const warnings = [];
  for (const o of overrides || []) {
    const session = byId.get(o.sessionId);
    if (!session) {
      warnings.push(`override for ${o.sessionId}: no such session in the source`);
      continue;
    }
    simulatedIds.add(o.sessionId);
    if (o.cancelled) byId.delete(o.sessionId);
    else {
      const next = { ...session };
      for (const key of ['start', 'end', 'room']) if (o[key] !== undefined) next[key] = o[key];
      byId.set(o.sessionId, next);
    }
  }
  return { sessions: [...byId.values()], simulatedIds, warnings };
}

module.exports = { DEFAULT_PATH, normalizeOverrides, readOverrides, applyOverrides };
