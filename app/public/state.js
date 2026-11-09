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

// The interests box also takes a pasted LinkedIn profile (up to 10,000 characters).
export const MAX_INTERESTS = 10000;

// Text over 500 characters, or with LinkedIn's headers and counters, is a
// pasted profile (roughly the server's rule in app/profile/linkedin.js): it is
// sent once to build the plan and never kept (not in localStorage, not in a
// saved account plan). Short typed lists, even on several lines, are kept.
const LINKEDIN_HINTS = /^(about|experience|skills|education|activity|licenses & certifications)$|\b\d[\d,]*\+?\s*(connections|followers)\b|\bendorsed by\b|\bendorsements\b/im;
export function isPastedText(text) {
  return typeof text === 'string' && (text.length > 500 || (text.includes('\n') && LINKEDIN_HINTS.test(text)));
}

// The pasted signals as a short interests line, to keep in place of a paste.
// In a blended profile only tools without repo evidence came from the paste:
// GitHub's tools, languages and words are left out so a replan doesn't treat
// them as typed (and raise them to 0.9).
export function derivedInterests(profile) {
  if (!profile) return '';
  const blended = profile.source === 'github+interests';
  const tools = (profile.tools || []).filter((t) => !blended || !(t.evidence || []).length);
  const words = [
    ...tools.map((t) => t.label || t.name),
    ...(blended ? [] : (profile.languages || []).map((l) => l.name)),
    ...(blended ? [] : [...(profile.topics || []), ...(profile.keywords || [])]),
  ].filter((w) => typeof w === 'string' && w);
  let out = '';
  for (const w of [...new Set(words)]) {
    const next = out ? `${out}, ${w}` : w;
    if (next.length > 500) break;
    out = next;
  }
  return out;
}

// A request safe to persist: a pasted profile is replaced by what we derived
// from it. The server's profile.pastedFrom is the authoritative signal.
export function persistableRequest(request, profile) {
  if (!request || typeof request.interests !== 'string') return request;
  if (profile?.pastedFrom !== 'linkedin' && !isPastedText(request.interests)) return request;
  const interests = derivedInterests(profile);
  const { interests: _dropped, ...rest } = request;
  return interests ? { ...rest, interests } : rest;
}

export function saveInputs(inputs, storage = globalThis.localStorage) {
  try {
    const kept = isPastedText(inputs?.interests) ? { ...inputs, interests: '' } : inputs;
    storage?.setItem(STORAGE_KEY, JSON.stringify(kept));
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
