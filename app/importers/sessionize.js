// Importer for any conference published on Sessionize. An organizer turns on
// the public API for their event and gets an endpoint id; its "All" view
// (https://sessionize.com/api/v2/<id>/view/All) returns sessions, speakers,
// rooms and categories as JSON. This converts that JSON into the planner's
// common conference format (see data/conference-format.md).
// Pure functions: no network access here, so they're easy to test.
const { withOffset } = require('./lf-events');

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Sessionize categories are free-form, so map common level names onto ours.
function normalizeLevel(name) {
  const n = clean(name).toLowerCase();
  if (!n) return null;
  if (/any|all levels|everyone|general/.test(n)) return 'Any Level';
  if (/beginner|introduct|novice|basic|\b100\b/.test(n)) return 'Beginner';
  if (/intermediate|\b200\b|\b300\b/.test(n)) return 'Intermediate';
  if (/advanced|expert|deep dive|\b400\b|\b500\b/.test(n)) return 'Advanced';
  return null;
}

// The categories whose item becomes the session's track, in order of
// preference: the ones the caller names, else one titled "Track", else the
// first session category that isn't a level.
function pickTrackCategories(categories, trackCategory) {
  const sessionCats = categories.filter((c) => !c.type || c.type === 'session');
  if (trackCategory) {
    const wanted = [].concat(trackCategory);
    return wanted.map((title) => sessionCats.find((c) => c.title === title)).filter(Boolean);
  }
  const fallback = sessionCats.find((c) => /^tracks?$/i.test(clean(c.title))) || sessionCats.find((c) => !/level/i.test(c.title));
  return fallback ? [fallback] : [];
}

/**
 * Convert a Sessionize "All" view into sessions in the common format.
 * Sessions without a time slot are left out: they can't be planned.
 * @param {{sessions: object[], speakers?: object[], rooms?: object[], categories?: object[]}} data
 * @param {object} opts
 * @param {string} opts.conferenceId
 * @param {string} opts.utcOffset - the event's UTC offset, e.g. "-05:00" (Sessionize times are local)
 * @param {string|function} [opts.sessionUrl] - URL for a session: a template with "{id}", or (session) => url
 * @param {string|string[]} [opts.trackCategory] - title(s) of the categories to take the track from, first match wins
 * @param {RegExp} [opts.keynotePattern] - service sessions whose title matches stay sessions (default /keynote/i)
 * @returns {object[]} sessions in the common format, sorted by start time
 */
function parseSessionize(data, { conferenceId, utcOffset, sessionUrl = null, trackCategory, keynotePattern = /keynote/i }) {
  if (!data || !Array.isArray(data.sessions)) throw new Error('Not a Sessionize "All" view: no sessions array');
  const speakers = new Map((data.speakers || []).map((s) => [s.id, clean(s.fullName) || clean(`${s.firstName} ${s.lastName}`)]));
  const rooms = new Map((data.rooms || []).map((r) => [r.id, clean(r.name)]));
  const categories = data.categories || [];
  const itemCategory = new Map();
  for (const c of categories) for (const item of c.items || []) itemCategory.set(item.id, { category: c, name: clean(item.name) });
  const trackCats = pickTrackCategories(categories, trackCategory);
  const urlFor = (s) => {
    if (typeof sessionUrl === 'function') return sessionUrl(s);
    if (typeof sessionUrl === 'string') return sessionUrl.replace('{id}', encodeURIComponent(s.id));
    return null;
  };

  const sessions = [];
  for (const s of data.sessions) {
    if (!s.startsAt || !s.endsAt) continue;
    const sourceId = String(s.id);
    const title = clean(s.title);
    const items = (s.categoryItems || []).map((id) => itemCategory.get(id)).filter(Boolean);
    const tags = [...new Set(items.map((i) => i.name).filter(Boolean))];
    let track = null;
    for (const cat of trackCats) {
      track = items.find((i) => i.category === cat)?.name || null;
      if (track) break;
    }
    const levelItem = items.find((i) => /level/i.test(i.category.title));
    const isKeynote = keynotePattern.test(title) || /keynote/i.test(track || '');
    // Breaks, meals, expo hours: Sessionize "service sessions". Keynotes are
    // often entered as service sessions too, but they belong in a plan.
    const kind = s.isServiceSession && !isKeynote ? 'logistics' : 'session';
    if (isKeynote) {
      track = track || 'Keynote';
      if (!tags.includes('Keynote')) tags.push('Keynote');
    }
    sessions.push({
      id: `${conferenceId}:${sourceId}`,
      conferenceId,
      sourceId,
      title,
      description: clean(s.description),
      start: withOffset(s.startsAt, utcOffset),
      end: withOffset(s.endsAt, utcOffset),
      room: rooms.get(s.roomId) || null,
      speakers: (s.speakers || []).map((id) => speakers.get(typeof id === 'object' ? id.id : id)).filter(Boolean),
      track,
      level: levelItem ? normalizeLevel(levelItem.name) : null,
      tags,
      sponsored: tags.some((t) => /sponsor/i.test(t)),
      kind,
      slidesAvailable: false,
      url: urlFor(s),
    });
  }
  return sessions.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

module.exports = { parseSessionize, normalizeLevel };
