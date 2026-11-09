// Schedule changes vs. the user's plan: which picks are affected, and what to
// recommend. No DOM here, so node:test can import it. changes.js renders it.

const ALERT_TYPES = new Set(['time_changed', 'room_changed', 'cancelled', 'details_changed']);

// The newest change per session (the API returns newest first, but don't rely on it).
export function latestChanges(changes) {
  const latest = new Map();
  for (const c of changes || []) {
    if (!c || typeof c.sessionId !== 'string' || !ALERT_TYPES.has(c.type)) continue;
    const prev = latest.get(c.sessionId);
    if (!prev || String(c.detectedAt || '') > String(prev.detectedAt || '')) latest.set(c.sessionId, c);
  }
  return latest;
}

// Session ids to ask the API about: every pick and backup, picks first, max 200.
export function watchedSessionIds(plan, max = 200) {
  const picks = [];
  const backups = [];
  for (const day of plan?.days || []) {
    for (const slot of day.slots || []) {
      if (slot.pick?.session?.id) picks.push(slot.pick.session.id);
      for (const b of slot.backups || []) if (b?.session?.id) backups.push(b.session.id);
    }
  }
  return [...new Set([...picks, ...backups])].slice(0, max);
}

const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

// A backup still works if it wasn't moved or cancelled itself.
function usableBackup(slot, latest) {
  const backups = slot.backups || [];
  for (let i = 0; i < backups.length; i += 1) {
    const b = backups[i];
    if (!b?.session?.id) continue;
    const c = latest.get(b.session.id);
    if (c && (c.type === 'cancelled' || c.type === 'time_changed')) continue;
    return { index: i, rec: b };
  }
  return null;
}

/**
 * For each pick with an unhandled change, what to tell the user and offer.
 * @param {object} plan - the plan on screen
 * @param {object[]} changes - from GET /api/changes
 * @param {{ pinned?: Set<string>, dismissed?: Set<string> }} opts - pinned session ids; change ids already dismissed
 * @returns {{ change, date, index, slot, swap: {index, rec}|null, replan: {pin: boolean}|null }[]}
 *   swap: promote that backup (the slot's existing swap);
 *   replan: re-request the plan, pinning the session at its new time (pin)
 *   or skipping it (!pin). Room and title changes need no action.
 */
export function affectedPicks(plan, changes, { pinned = new Set(), dismissed = new Set() } = {}) {
  const latest = latestChanges(changes);
  const out = [];
  for (const day of plan?.days || []) {
    (day.slots || []).forEach((slot, index) => {
      const id = slot.pick?.session?.id;
      const change = id && latest.get(id);
      if (!change || dismissed.has(change.id)) return;
      const entry = { change, date: day.date, index, slot, swap: null, replan: null };
      if (change.type === 'time_changed' || change.type === 'cancelled') {
        entry.swap = usableBackup(slot, latest);
        let pin = false;
        if (change.type === 'time_changed' && change.after?.start && change.after?.end) {
          // Pin it at the new time unless that collides with another pinned session.
          pin = !plan.days.some((d) => (d.slots || []).some((s) =>
            s.pick?.session?.id && s.pick.session.id !== id && pinned.has(s.pick.session.id) && overlaps(s.pick.session, change.after)));
        }
        entry.replan = { pin };
      }
      out.push(entry);
    });
  }
  return out;
}

// Pins and skips for "Re-plan around it". Returns new Sets; inputs untouched.
export function replanChoices(entry, pinned, skipped) {
  const nextPinned = new Set(pinned);
  const nextSkipped = new Set(skipped);
  const id = entry.change.sessionId;
  if (entry.replan?.pin) {
    nextPinned.add(id);
    nextSkipped.delete(id);
  } else {
    nextPinned.delete(id);
    nextSkipped.add(id);
  }
  return { pinned: nextPinned, skipped: nextSkipped };
}
