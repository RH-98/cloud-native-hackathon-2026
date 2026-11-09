// Pure planning: scored candidates in, the Plan's `days` out (docs/CONTRACTS.md).
// Times stay the ISO strings from the data, with the conference's offset; they
// are parsed only to compare them, never converted or re-formatted.

const MIN_SCORE = 0.2; // below this a session isn't worth suggesting: the time stays free
// A pick must score at least this share of the day's best match.
const RELATIVE_FLOOR = 0.5;
// Keynotes often have no description, so they rarely match a profile. They get
// a floor just above MIN_SCORE, and clear the relative floor only when no
// pickable real match overlaps them, so a keynote never displaces a match.
const KEYNOTE_TRACK = 'Keynote Sessions';
const KEYNOTE_SCORE = Math.round((MIN_SCORE + 0.01) * 1000) / 1000;
const MIN_GAP_MINUTES = 30; // free time this long gets booth suggestions
const FREE_SLOT_MINUTES = 10; // free time this long becomes a slot with options
const SHORT_GAP_MINUTES = 15; // below this, free time is just a walk to the next room
const FREE_BACKUPS = 3;
const SHORT_GAP_BOOTHS = 1; // booths offered in a gap of 15 to 30 minutes on an expo day
const LONG_LOGISTICS_MINUTES = 4 * 60; // coat check and badge pick-up run all day: not an option
const DAY_START = '09:00:00';
const DAY_END = '18:00:00';
const BOOTHS_PER_GAP = 2;
const BOOTHS_PER_DAY = 3; // listed without a gap
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Any Level'];
const MINUTE = 60_000;

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_input';
  return err;
}

function ms(iso) {
  return Date.parse(iso);
}

function minutes(session) {
  return (ms(session.end) - ms(session.start)) / MINUTE;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Every date the conference covers: its start..end range plus any date with sessions.
function conferenceDays(snapshot) {
  const days = new Set();
  const { startDate, endDate } = snapshot.conference || {};
  if (DATE_RE.test(startDate || '') && DATE_RE.test(endDate || '')) {
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) days.add(d);
  }
  for (const s of snapshot.sessions || []) if (s.start) days.add(s.start.slice(0, 10));
  return [...days].sort();
}

function stringList(value, name, { allowed, max = 500 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== 'string')) {
    throw invalid(`options.${name} must be a list of strings`);
  }
  if (allowed) {
    const bad = value.find((v) => !allowed.includes(v));
    if (bad !== undefined) throw invalid(`options.${name}: unknown value ${JSON.stringify(bad).slice(0, 60)}`);
  }
  return [...new Set(value)];
}

function bool(value, name, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw invalid(`options.${name} must be true or false`);
  return value;
}

// Validates options and fills in defaults. Throws err.code = 'invalid_input'.
function normalizeOptions(options, snapshot) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw invalid('options must be an object');
  const known = conferenceDays(snapshot);
  const days = stringList(options.days, 'days', { allowed: known, max: 31 }).sort();
  const breakMinutes = options.breakMinutes == null ? 0 : options.breakMinutes;
  if (typeof breakMinutes !== 'number' || !Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > 240) {
    throw invalid('options.breakMinutes must be a number from 0 to 240');
  }
  return {
    days: days.length ? days : known,
    levels: stringList(options.levels, 'levels', { allowed: LEVELS }),
    includeSponsored: bool(options.includeSponsored, 'includeSponsored', true),
    pinned: stringList(options.pinned, 'pinned'),
    skipped: stringList(options.skipped, 'skipped'),
    firstTimer: bool(options.firstTimer, 'firstTimer', false),
    breakMinutes,
  };
}

const BEGINNER_TITLE = /\b(101|introduction|intro to|getting started|beginners?|novice|first[- ]timers?|new to)\b/i;

function isBeginnerFriendly(session) {
  return session.level === 'Beginner' || session.track === 'Cloud Native Novice' || BEGINNER_TITLE.test(session.title || '');
}

// First-timer mode: lift beginner material, soften advanced material.
function adjustForOptions(rec, options) {
  if (!options.firstTimer) return rec;
  const { session } = rec;
  if (isBeginnerFriendly(session)) {
    const reasons = rec.reasons.includes('Beginner friendly') ? rec.reasons : [...rec.reasons, 'Beginner friendly'];
    return { ...rec, score: round(Math.min(1, rec.score + 0.15)), reasons };
  }
  if (session.level === 'Advanced') return { ...rec, score: round(rec.score * 0.8) };
  return rec;
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

// Two sessions conflict when they overlap or leave less than `gapMs` between them.
function conflicts(a, b, gapMs = 0) {
  return ms(a.start) < ms(b.end) + gapMs && ms(b.start) < ms(a.end) + gapMs;
}

// What a pick is worth to the schedule. Squaring the score makes one strong
// match worth more than several weak ones (0.8 beats 0.4 + 0.4), short talks
// count a little less than full ones, and every pick pays a small cost for
// walking between rooms, so a day isn't traded for a string of lightning talks.
// Keynotes run back to back in one hall: no walking, no cost.
const PICK_COST = 0.03;
function weight(rec) {
  const cost = isKeynote(rec.session) ? 0 : PICK_COST;
  return rec.score * rec.score * Math.min(1, 0.5 + minutes(rec.session) / 60) - cost;
}

// Weighted interval scheduling: the non-conflicting subset with the most weight.
function bestSchedule(recs, gapMs = 0) {
  const items = [...recs].sort(
    (a, b) =>
      ms(a.session.end) - ms(b.session.end) ||
      ms(a.session.start) - ms(b.session.start) ||
      a.session.id.localeCompare(b.session.id),
  );
  const ends = items.map((r) => ms(r.session.end));
  // prev[j]: number of items (a prefix) that end early enough to precede item j.
  const prev = items.map((r, j) => {
    const limit = ms(r.session.start) - gapMs;
    let lo = 0;
    let hi = j;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= limit) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
  const best = new Array(items.length + 1).fill(0);
  for (let j = 0; j < items.length; j += 1) {
    best[j + 1] = Math.max(best[j], weight(items[j]) + best[prev[j]]);
  }
  const chosen = [];
  for (let j = items.length; j > 0; ) {
    const take = weight(items[j - 1]) + best[prev[j - 1]];
    if (take > best[j - 1]) {
      chosen.push(items[j - 1]);
      j = prev[j - 1];
    } else {
      j -= 1;
    }
  }
  return chosen.reverse();
}

// Free windows of at least minMinutes between DAY_START and DAY_END.
function freeGaps(date, picks, utcOffset, minMinutes = MIN_GAP_MINUTES) {
  const dayStart = `${date}T${DAY_START}${utcOffset}`;
  const dayEnd = `${date}T${DAY_END}${utcOffset}`;
  const gaps = [];
  let cursor = dayStart;
  const sorted = [...picks].sort((a, b) => ms(a.start) - ms(b.start));
  const push = (start, end) => {
    if ((ms(end) - ms(start)) / MINUTE >= minMinutes) gaps.push({ start, end });
  };
  for (const s of sorted) {
    if (ms(cursor) >= ms(dayEnd)) break;
    if (ms(s.start) > ms(cursor)) push(cursor, ms(s.start) > ms(dayEnd) ? dayEnd : s.start);
    if (ms(s.end) > ms(cursor)) cursor = s.end;
  }
  if (ms(cursor) < ms(dayEnd)) push(cursor, dayEnd);
  return gaps;
}

// Booths are open on days with keynotes or expo-hall programming.
function boothDays(snapshot) {
  const days = new Set();
  for (const s of snapshot.sessions || []) {
    if (s.start && /Keynote|Solutions Showcase|Sponsor Demo Theater/.test(s.track || '')) days.add(s.start.slice(0, 10));
  }
  return days.size ? days : null; // null: no signal, so every day
}

// When nothing matches the profile, still point at the biggest booths.
function fallbackSponsors(snapshot, tierRank) {
  return [...(snapshot.sponsors || [])]
    .filter((s) => tierRank(s.tier) >= 5)
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || a.name.localeCompare(b.name))
    .map((sponsor) => ({ sponsor, score: 0.05, reasons: [`${sponsor.tier} sponsor`] }));
}

function pickSponsor(ranked, usedToday, usedEver) {
  return (
    ranked.find((r) => !usedToday.has(r.sponsor.id) && !usedEver.has(r.sponsor.id)) ||
    ranked.find((r) => !usedToday.has(r.sponsor.id))
  );
}

function planDay({ date, recs, pinnedRecs, pool = [], logistics = [], options, utcOffset, sponsors, boothsOpen, usedSponsors }) {
  const gapMs = options.breakMinutes * MINUTE;
  const pinnedIds = new Set(pinnedRecs.map((r) => r.session.id));
  const good = recs.filter((r) => r.score >= MIN_SCORE && !pinnedIds.has(r.session.id));
  // Picks must also be within reach of the day's best match; weaker sessions
  // can still be backups. Keynotes clear the floor only if no pickable real match overlaps.
  const floor = Math.max(MIN_SCORE, RELATIVE_FLOOR * Math.max(0, ...good.map((r) => r.score)));
  const open = good.filter((r) => {
    if (pinnedRecs.some((p) => conflicts(r.session, p.session, gapMs))) return false;
    if (r.score >= floor) return true;
    // Keynote floor recs: only where no pickable real match overlaps.
    return (
      isKeynote(r.session) &&
      !good.some(
        (o) => o !== r && !isKeynote(o.session) && o.score >= floor && conflicts(o.session, r.session),
      )
    );
  });
  const chosen = bestSchedule(open, gapMs);
  const picks = [
    ...pinnedRecs.map((rec) => ({ rec, pinned: true })),
    ...chosen.map((rec) => ({ rec, pinned: false })),
  ].sort((a, b) => ms(a.rec.session.start) - ms(b.rec.session.start) || a.rec.session.id.localeCompare(b.rec.session.id));

  const pickedIds = new Set(picks.map((p) => p.rec.session.id));
  const usedBackups = new Set();
  const slots = picks.map(({ rec, pinned }) => {
    const backups = good
      .filter((r) => !pickedIds.has(r.session.id) && !usedBackups.has(r.session.id) && conflicts(r.session, rec.session))
      .sort((a, b) => b.score - a.score || a.session.id.localeCompare(b.session.id))
      .slice(0, 2);
    backups.forEach((b) => usedBackups.add(b.session.id));
    return { start: rec.session.start, end: rec.session.end, pick: rec, backups, pinned };
  });

  const pickedSessions = picks.map((p) => p.rec.session);
  const gaps = freeGaps(date, pickedSessions, utcOffset);
  const freeSlots = freeGaps(date, pickedSessions, utcOffset, FREE_SLOT_MINUTES).map((gap) => ({
    start: gap.start, end: gap.end, pick: null, backups: [], pinned: false, booths: [], logistics: [], suggestion: '',
  }));
  slots.push(...freeSlots);
  slots.sort((a, b) => ms(a.start) - ms(b.start));

  const booths = [];
  const usedToday = new Set();
  if (boothsOpen && sponsors.length) {
    const take = (gap) => {
      const next = pickSponsor(sponsors, usedToday, usedSponsors);
      if (!next) return false;
      usedToday.add(next.sponsor.id);
      usedSponsors.add(next.sponsor.id);
      booths.push({ sponsor: next.sponsor, score: next.score, reasons: next.reasons, gap });
      return true;
    };
    for (const gap of gaps) for (let i = 0; i < BOOTHS_PER_GAP && take({ start: gap.start, end: gap.end }); i += 1);
    for (let i = 0; i < BOOTHS_PER_DAY && take(null); i += 1);
  }

  // Options for each free slot: sessions on anyway, meals and breaks, booths.
  for (const slot of freeSlots) {
    const mins = (ms(slot.end) - ms(slot.start)) / MINUTE;
    slot.logistics = logisticsIn(slot, logistics);
    if (mins >= SHORT_GAP_MINUTES) slot.backups = freeBackups(slot, pool, pickedIds);
    slot.booths = booths
      .filter((b) => b.gap && b.gap.start === slot.start && b.gap.end === slot.end)
      .map(({ sponsor, score, reasons }) => ({ sponsor, score, reasons }));
    if (boothsOpen && !slot.booths.length && mins >= SHORT_GAP_MINUTES) {
      for (let i = 0; i < SHORT_GAP_BOOTHS; i += 1) {
        const next = sponsors.find((r) => !usedToday.has(r.sponsor.id));
        if (!next) break;
        usedToday.add(next.sponsor.id);
        slot.booths.push({ sponsor: next.sponsor, score: next.score, reasons: next.reasons });
      }
    }
    slot.suggestion = suggestionFor(mins, slot);
  }
  return { date, slots, booths };
}

// ---------- Options for free time ----------

const DEMO_TRACK = /Demo Theater|Solutions Showcase/i;
const isDemo = (session) => Boolean(session.sponsored) || DEMO_TRACK.test(session.track || '');

// How a session sits in a free window, or null when it is no real option:
// it starts in the window (at least 5 minutes before it ends), or it is
// already running and at least 20 minutes of it fall in the window.
function windowFit(session, gap) {
  const s = ms(session.start);
  const e = ms(session.end);
  const gs = ms(gap.start);
  const ge = ms(gap.end);
  if (s >= gs && s <= ge - 5 * MINUTE) return e <= ge ? 'Fits this window' : 'Starts in this window';
  if (s < gs && e > gs && (Math.min(e, ge) - gs) / MINUTE >= 20) return 'Already running';
  return null;
}

// Up to FREE_BACKUPS sessions on during a free window, best match first even
// when below the pick floor. Sponsored demos only when nothing else is on.
function freeBackups(gap, pool, pickedIds) {
  const fits = [];
  for (const rec of pool) {
    if (pickedIds.has(rec.session.id)) continue;
    const fit = windowFit(rec.session, gap);
    if (fit) fits.push({ rec, fit });
  }
  const real = fits.filter((f) => !isDemo(f.rec.session));
  return (real.length ? real : fits)
    .sort(
      (a, b) =>
        b.rec.score - a.rec.score ||
        Number(a.fit === 'Already running') - Number(b.fit === 'Already running') ||
        ms(a.rec.session.start) - ms(b.rec.session.start) ||
        a.rec.session.id.localeCompare(b.rec.session.id),
    )
    .slice(0, FREE_BACKUPS)
    .map(({ rec, fit }) => ({ session: rec.session, score: rec.score, reasons: [fit, ...rec.reasons.filter((r) => r !== fit)] }));
}

const MEAL = /breakfast|brunch|lunch|dinner/i;
const PLAIN_MEAL = /^(breakfast|brunch|lunch|dinner)( break)?$/i;
const SOCIAL = /happy hour|reception|party|social|mixer/i;
const BREAK = /coffee|break|snack/i;
const EXPO = /expo|exhibit|sponsor hall|showcase/i;

function logisticsType(title) {
  if (MEAL.test(title)) return 'meal';
  if (SOCIAL.test(title)) return 'social';
  if (BREAK.test(title)) return 'break';
  if (EXPO.test(title)) return 'expo';
  return 'other';
}

// "🍲 Lunch" -> "Lunch", "LUNCH BREAK" -> "Lunch break".
function cleanTitle(title) {
  const t = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return /\p{Ll}/u.test(t) ? t : t.charAt(0) + t.slice(1).toLowerCase();
}

// Meals, breaks, receptions and expo hours overlapping a free window. All-day
// services (coat check, badge pick-up) are left out.
function logisticsIn(gap, items) {
  return items
    .filter((l) => ms(l.start) < ms(gap.end) && ms(l.end) > ms(gap.start) && minutes(l) <= LONG_LOGISTICS_MINUTES)
    .sort((a, b) => ms(a.start) - ms(b.start))
    .map((l) => {
      const title = cleanTitle(l.title) || 'Break';
      return { title, type: logisticsType(title), start: l.start, end: l.end, room: l.room || null };
    });
}

// Wall-clock times straight from the ISO strings, which carry the conference's offset.
function clock(iso) {
  const h = Number(iso.slice(11, 13));
  return { text: `${h % 12 || 12}:${iso.slice(14, 16)}`, half: h >= 12 ? 'PM' : 'AM' };
}

function clockRange(start, end) {
  const a = clock(start);
  const b = clock(end);
  return a.half === b.half ? `${a.text}–${b.text} ${b.half}` : `${a.text} ${a.half}–${b.text} ${b.half}`;
}

// "Salt Palace | Level 1 | Halls A-C" -> "Halls A-C".
function shortRoom(room) {
  return room ? String(room).split('|').pop().trim() : '';
}

// One friendly line for a free window, in place of a bare "free".
function suggestionFor(mins, slot) {
  const { logistics, booths, backups } = slot;
  const food =
    logistics.find((l) => PLAIN_MEAL.test(l.title)) ||
    ['meal', 'break', 'social', 'expo'].map((t) => logistics.find((l) => l.type === t)).find(Boolean);
  const where = food && shortRoom(food.room) ? ` in ${shortRoom(food.room)}` : '';
  if (mins < SHORT_GAP_MINUTES) {
    return food && food.type !== 'expo'
      ? `Short break: ${food.title.toLowerCase()}${where} on the way to your next room.`
      : 'Short break: walk to your next room.';
  }
  const parts = [];
  if (food) {
    const when = clockRange(food.start, food.end);
    if (PLAIN_MEAL.test(food.title)) parts.push(`${food.title.replace(/ break$/i, '')} is served ${when}${where}.`);
    else parts.push(`${food.title}: ${when}${where}.`);
  }
  if (booths.length) parts.push(`Time for ${booths.length === 1 ? 'a booth visit' : `${booths.length} booth visits`}.`);
  if (!parts.length) {
    if (backups.length) parts.push('Nothing matched you strongly, but a few sessions are on if you want one.');
    else if (mins >= 60) parts.push('Rest, refill your water, or wander the hallway track.');
    else parts.push('Take a breather before your next session.');
  }
  return parts.join(' ');
}

// LF events call the track "Keynote Sessions"; the Sessionize importer uses "Keynote".
function isKeynote(session) {
  const names = [session.track, ...(Array.isArray(session.tags) ? session.tags : [])];
  return names.some((n) => n === KEYNOTE_TRACK || n === 'Keynote');
}

// Keynotes that scored below MIN_SCORE (or weren't returned by search at all)
// are lifted to KEYNOTE_SCORE; planDay checks whether that clears the pick floor.
function keynoteRecs(snapshot, matched, byId, isEligible) {
  const real = matched.filter((r) => r.score >= MIN_SCORE);
  const realIds = new Set(real.map((r) => r.session.id));
  return (snapshot.sessions || [])
    .filter((s) => isKeynote(s) && !realIds.has(s.id) && isEligible(s))
    .map((session) => {
      const found = byId.get(session.id);
      const reasons = found ? found.reasons.filter((r) => r !== 'Keynote') : [];
      return { session, score: KEYNOTE_SCORE, reasons: ['Keynote', ...reasons] };
    });
}

// candidates: [{ session, score, reasons }] from search. sponsors: ranked
// [{ sponsor, score, reasons }]. options: normalized (normalizeOptions).
function planDays({ snapshot, candidates, sponsors = [], options, tierRank = () => 0 }) {
  const utcOffset = (snapshot.conference && snapshot.conference.utcOffset) || 'Z';
  const skipped = new Set(options.skipped);
  const pinned = new Set(options.pinned);
  const levels = options.levels;
  const byId = new Map(candidates.map((c) => [c.session.id, c]));

  const isEligible = (session) => {
    if (session.kind !== 'session' || !session.start || !session.end) return false;
    if (skipped.has(session.id) || pinned.has(session.id)) return false;
    if (!options.includeSponsored && session.sponsored) return false;
    if (levels.length && !(session.level == null || session.level === 'Any Level' || levels.includes(session.level))) {
      return false;
    }
    return true;
  };
  const matched = candidates.filter(({ session }) => isEligible(session)).map((rec) => adjustForOptions(rec, options));
  const keynotes = keynoteRecs(snapshot, matched, byId, isEligible);
  const keynoteIds = new Set(keynotes.map((r) => r.session.id));
  const eligible = [...matched.filter((r) => !keynoteIds.has(r.session.id)), ...keynotes];

  const pinnedRecs = (snapshot.sessions || [])
    .filter((s) => pinned.has(s.id) && s.start && s.end)
    .map((session) => {
      const found = byId.get(session.id);
      const reasons = found ? found.reasons.filter((r) => r !== 'Pinned by you') : [];
      return { session, score: found ? found.score : 0, reasons: ['Pinned by you', ...reasons] };
    });

  // Free-time options: every eligible session that day, matched or not, and the day's logistics.
  const eligibleIds = new Set(eligible.map((r) => r.session.id));
  const pool = [
    ...eligible,
    ...(snapshot.sessions || []).filter((s) => !eligibleIds.has(s.id) && isEligible(s)).map((session) => ({ session, score: 0, reasons: [] })),
  ];
  const logistics = (snapshot.sessions || []).filter((s) => s.kind === 'logistics' && s.start && s.end);

  const openDays = boothDays(snapshot);
  const ranked = sponsors.length ? sponsors : fallbackSponsors(snapshot, tierRank);
  const usedSponsors = new Set();
  return options.days.map((date) =>
    planDay({
      date,
      recs: eligible.filter((r) => r.session.start.slice(0, 10) === date),
      pinnedRecs: pinnedRecs.filter((r) => r.session.start.slice(0, 10) === date),
      pool: pool.filter((r) => r.session.start.slice(0, 10) === date),
      logistics: logistics.filter((l) => l.start.slice(0, 10) === date),
      options,
      utcOffset,
      sponsors: ranked,
      boothsOpen: !openDays || openDays.has(date),
      usedSponsors,
    }),
  );
}

module.exports = {
  MIN_SCORE,
  KEYNOTE_SCORE,
  isKeynote,
  normalizeOptions,
  conferenceDays,
  isBeginnerFriendly,
  adjustForOptions,
  conflicts,
  bestSchedule,
  freeGaps,
  windowFit,
  suggestionFor,
  planDays,
};
