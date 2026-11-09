// Compares two versions of a conference's sessions (what Elasticsearch holds
// now, and what the source says now) and lists what changed for attendees.
// Pure: no network, no clock. The watcher (scripts/watch-schedule.js) turns
// the result into change records and Elasticsearch writes.
//
// What counts as a change:
//   time_changed     start or end moved (the room may have changed too)
//   room_changed     same time, different room
//   cancelled        the session is gone from the source
//   added            a new session, or a cancelled one that came back
//   details_changed  the title changed (description-only edits are noise)
// Whitespace differences never count.

const CHANGE_TYPES = ['time_changed', 'room_changed', 'cancelled', 'added', 'details_changed'];

const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

// Same instant, whatever the formatting ("…T11:30:00-07:00" vs "…T18:30:00.000Z").
function sameInstant(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return clean(a) === clean(b);
  return ta === tb;
}

function where(session) {
  if (!session) return null;
  return { start: session.start || null, end: session.end || null, room: clean(session.room) || null };
}

const isLive = (s) => s && s.kind !== 'cancelled';

/**
 * @param {object[]} current - sessions as stored now (Elasticsearch), any kind
 * @param {object[]} next - sessions as the source lists them now
 * @returns {{ type: string, sessionId: string, sessionTitle: string,
 *   before: object|null, after: object|null, patch: object|null, doc: object|null }[]}
 *   one entry per changed session. Write `doc` as the whole document when set,
 *   otherwise merge `patch` into the stored one.
 */
function diffSessions(current, next) {
  const before = new Map((current || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const after = new Map((next || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  const changes = [];

  for (const [id, now] of after) {
    const was = before.get(id);
    if (!isLive(was)) {
      // New, or reinstated after a cancellation: write the whole document.
      changes.push({ type: 'added', sessionId: id, sessionTitle: clean(now.title), before: null, after: where(now), patch: null, doc: now });
      continue;
    }
    const timeMoved = !sameInstant(was.start, now.start) || !sameInstant(was.end, now.end);
    const roomMoved = clean(was.room) !== clean(now.room);
    const retitled = clean(was.title) !== clean(now.title);
    if (!timeMoved && !roomMoved && !retitled) continue;

    const patch = {};
    if (timeMoved) Object.assign(patch, { start: now.start, end: now.end });
    if (roomMoved) patch.room = now.room == null ? null : now.room;
    if (retitled) Object.assign(patch, { title: now.title, description: now.description });
    const type = timeMoved ? 'time_changed' : roomMoved ? 'room_changed' : 'details_changed';
    changes.push({ type, sessionId: id, sessionTitle: clean(now.title), before: where(was), after: where(now), patch, doc: null });
  }

  for (const [id, was] of before) {
    if (!isLive(was) || after.has(id)) continue;
    changes.push({
      type: 'cancelled',
      sessionId: id,
      sessionTitle: clean(was.title),
      before: where(was),
      after: null,
      patch: { kind: 'cancelled' },
      doc: null,
    });
  }

  return changes.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

module.exports = { CHANGE_TYPES, diffSessions, sameInstant, clean };
