// App state, the saved form inputs (localStorage), and the plan edits that
// happen in the browser: swaps. Pins and skips are sent to the API.
// No DOM here, so node:test can import it.

const STORAGE_KEY = 'switchback:v1';

export const state = {
  conferences: [],
  request: null,      // the last POST /api/plan body (without pins and skips)
  profile: null,
  plan: null,         // the API's plan with local swaps applied
  pinned: new Set(),  // session ids
  skipped: new Set(), // session ids
  swaps: new Map(),   // slot key -> session id the user swapped in
  activeDay: null,    // "YYYY-MM-DD"
  loading: false,
};

// Storage can be missing or throw (private mode, blocked cookies): never fatal.
export function loadInputs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveInputs(inputs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(inputs));
  } catch {
    // ignore: remembering inputs is a convenience
  }
}

// Warnings from POST /api/plan (docs/CONTRACTS.md): the plan was still built,
// from less input. Unknown codes are dropped.
const WARNINGS = {
  github_rate_limited: 'GitHub is rate limiting us right now, so this route comes only from the interests you typed.',
  github_not_found: 'We could not find that GitHub user, so this route comes only from the interests you typed.',
  github_unavailable: 'GitHub did not answer in time, so this route comes only from the interests you typed.',
};

export function warningMessages(warnings) {
  return (Array.isArray(warnings) ? warnings : [])
    .filter((w) => typeof w === 'string' && Object.hasOwn(WARNINGS, w))
    .map((w) => WARNINGS[w]);
}

// A slot is identified by its day and start time.
export function slotKey(date, slot) {
  return `${date}|${slot.start}`;
}

// Promotes backups[index] to the pick; the old pick becomes that backup.
// Returns the swapped-in recommendation, or null.
export function swapSlot(slot, index = 0) {
  const backup = slot.backups?.[index];
  if (!backup) return null;
  const old = slot.pick;
  slot.pick = backup;
  if (old) slot.backups[index] = old;
  else slot.backups.splice(index, 1);
  slot.pinned = false;
  slot.swapped = true;
  return backup;
}

// Re-applies remembered swaps to a fresh plan from the API, where the
// swapped-in session is still one of that slot's backups.
export function applySwaps(plan, swaps) {
  for (const day of plan.days || []) {
    for (const slot of day.slots || []) {
      const want = swaps.get(slotKey(day.date, slot));
      if (!want || slot.pick?.session?.id === want) continue;
      const i = (slot.backups || []).findIndex((b) => b?.session?.id === want);
      if (i >= 0) swapSlot(slot, i);
      else swaps.delete(slotKey(day.date, slot));
    }
  }
  return plan;
}

// Builds the POST /api/plan body from the last request plus pins and skips.
export function planRequest(base, pinned, skipped) {
  const options = { ...(base.options || {}) };
  if (pinned.size) options.pinned = [...pinned];
  else delete options.pinned;
  if (skipped.size) options.skipped = [...skipped];
  else delete options.skipped;
  return { ...base, options };
}

export function countPicks(plan) {
  let n = 0;
  for (const day of plan?.days || []) for (const slot of day.slots || []) if (slot.pick) n += 1;
  return n;
}
