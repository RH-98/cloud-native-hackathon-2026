// Suggested connections, in memory: score opted-in attendees against a
// profile. Pure functions, no I/O. Used directly when Elasticsearch isn't
// configured, and to explain (shared / why / commonSessions) the candidates
// Elasticsearch returns.
//
// Privacy: attendees with optIn !== true are never returned, and `shared`
// only ever holds labels of public tools and topics both sides list.
const { termKey, labelFor } = require('./catalog');

// How much each kind of signal counts: tools > topics > languages > keywords.
const DIMENSION_WEIGHTS = { tools: 1, topics: 0.6, languages: 0.35, keywords: 0.2 };
const MAINTAINER_BOOST = 0.1;
const COMMON_SESSION_BOOST = 0.04;
const MAX_COMMON_SESSION_BOOST = 0.12;

function weightOf(value) {
  const w = Number(value);
  return Number.isFinite(w) && w > 0 ? Math.min(w, 1) : 1;
}

function entries(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) =>
      typeof item === 'string'
        ? { name: item, label: null, weight: 1 }
        : item && typeof item.name === 'string'
          ? { name: item.name, label: typeof item.label === 'string' ? item.label : null, weight: weightOf(item.weight) }
          : null,
    )
    .filter((e) => e && termKey(e.name));
}

// Profile-shaped interests -> Map(key -> { weight, dims:Set, label }).
// A term that appears in several dimensions (a tool also typed as a keyword)
// counts once, at its strongest weight.
function interestVector(source) {
  const vector = new Map();
  for (const dim of Object.keys(DIMENSION_WEIGHTS)) {
    for (const { name, label, weight } of entries(source?.[dim])) {
      const key = termKey(name);
      const w = DIMENSION_WEIGHTS[dim] * weight;
      const prev = vector.get(key);
      if (!prev) {
        vector.set(key, { weight: w, dims: new Set([dim]), label: label || null, name });
      } else {
        prev.weight = Math.max(prev.weight, w);
        prev.dims.add(dim);
        prev.label = prev.label || label || null;
      }
    }
  }
  return vector;
}

function norm(vector) {
  let sum = 0;
  for (const { weight } of vector.values()) sum += weight * weight;
  return Math.sqrt(sum);
}

// Cosine similarity of two interest vectors, plus the overlapping keys,
// strongest first.
function similarity(a, b) {
  const overlap = [];
  let dot = 0;
  for (const [key, va] of a) {
    const vb = b.get(key);
    if (!vb) continue;
    dot += va.weight * vb.weight;
    overlap.push({ key, product: va.weight * vb.weight, a: va, b: vb });
  }
  const denom = norm(a) * norm(b);
  overlap.sort((x, y) => y.product - x.product || x.key.localeCompare(y.key));
  return { cosine: denom ? dot / denom : 0, overlap };
}

const PUBLIC_DIMS = ['tools', 'topics'];

function isPublicShared(o) {
  // Shared only if it is a tool or topic on both sides (not a free-text keyword).
  return PUBLIC_DIMS.some((d) => o.a.dims.has(d)) && PUBLIC_DIMS.some((d) => o.b.dims.has(d));
}

function joinLabels(labels) {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function whyLine({ sharedTools, sharedTopics, sharedLanguages, maintains, commonSessionCount }) {
  let line;
  if (sharedTools.length) line = `You both work with ${joinLabels(sharedTools.slice(0, 3))}`;
  else if (sharedTopics.length) line = `You're both into ${joinLabels(sharedTopics.slice(0, 3))}`;
  else if (sharedLanguages.length) line = `You both write ${joinLabels(sharedLanguages.slice(0, 2))}`;
  else line = 'Similar interests';
  if (maintains.length) line += `; they help maintain ${joinLabels(maintains.slice(0, 2))}`;
  if (commonSessionCount) {
    line += `; going to ${commonSessionCount} of the same session${commonSessionCount === 1 ? '' : 's'}`;
  }
  return line;
}

// A user who is new (first-timer option, or a light profile) gets a boost
// toward maintainers of something they share: the person who can answer
// their questions.
function looksNew(profile, { firstTimer } = {}) {
  if (firstTimer) return true;
  const tools = entries(profile?.tools);
  return tools.length > 0 && tools.length <= 2 && tools.every((t) => t.weight <= 0.5);
}

// One attendee against a profile vector. Returns null when there is nothing in common.
function scoreAttendee(profileVector, attendee, { pickedSessionIds, newcomer } = {}) {
  const attendeeVector = interestVector(attendee.interests || attendee);
  const { cosine, overlap } = similarity(profileVector, attendeeVector);
  const picked = pickedSessionIds instanceof Set ? pickedSessionIds : new Set(pickedSessionIds || []);
  const commonSessions = (attendee.goingTo || []).filter((id) => picked.has(id));
  if (!overlap.length && !commonSessions.length) return null;

  const publicShared = overlap.filter(isPublicShared);
  const label = (o) => labelFor(o.b.name, o.b.label || o.a.label);
  const sharedTools = publicShared.filter((o) => o.a.dims.has('tools') && o.b.dims.has('tools')).map(label);
  const sharedTopics = publicShared.filter((o) => !(o.a.dims.has('tools') && o.b.dims.has('tools'))).map(label);
  const sharedLanguages = overlap
    .filter((o) => o.a.dims.has('languages') && o.b.dims.has('languages'))
    .map(label);

  const sharedKeys = new Set(publicShared.map((o) => o.key));
  const maintains =
    newcomer && attendee.experience === 'maintainer'
      ? (attendee.maintains || []).filter((m) => sharedKeys.has(termKey(m))).map((m) => labelFor(m))
      : [];

  let score = cosine;
  if (maintains.length) score += MAINTAINER_BOOST;
  score += Math.min(MAX_COMMON_SESSION_BOOST, commonSessions.length * COMMON_SESSION_BOOST);
  score = Math.round(Math.min(1, score) * 1000) / 1000;

  return {
    score,
    shared: [...sharedTools, ...sharedTopics],
    why: whyLine({ sharedTools, sharedTopics, sharedLanguages, maintains, commonSessionCount: commonSessions.length }),
    commonSessions,
  };
}

// What an attendee shows publicly. Nothing else leaves this module.
function publicAttendee(a) {
  return {
    displayName: a.displayName,
    handle: a.handle,
    role: a.role,
    bio: a.bio,
  };
}

// Top `limit` opted-in matches for a profile.
// options: { limit = 5, pickedSessionIds = [], firstTimer = false, excludeHandles = [] }
function matchAttendees(profile, attendees, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 50));
  const profileVector = interestVector(profile);
  const picked = new Set(options.pickedSessionIds || []);
  const newcomer = looksNew(profile, options);
  const exclude = new Set((options.excludeHandles || []).map((h) => String(h).toLowerCase()));
  if (profile?.username) exclude.add(String(profile.username).toLowerCase());

  const results = [];
  for (const attendee of attendees || []) {
    if (!attendee || attendee.optIn !== true) continue;
    if (exclude.has(String(attendee.handle || '').toLowerCase())) continue;
    const scored = scoreAttendee(profileVector, attendee, { pickedSessionIds: picked, newcomer });
    if (!scored || scored.score <= 0) continue;
    results.push({ attendee: publicAttendee(attendee), ...scored });
  }
  results.sort(
    (a, b) => b.score - a.score || a.attendee.handle.localeCompare(b.attendee.handle),
  );
  return results.slice(0, limit);
}

// Natural-language summary of a profile or attendee, for semantic search.
function interestSummary(source) {
  const names = (dim, n) =>
    entries(source?.[dim])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map((e) => labelFor(e.name, e.label));
  const parts = [];
  if (source?.role) parts.push(`${source.role}.`);
  const tools = names('tools', 8);
  const topics = names('topics', 6);
  const languages = names('languages', 3);
  const keywords = names('keywords', 6);
  if (tools.length) parts.push(`Works with ${joinLabels(tools)}.`);
  if (topics.length) parts.push(`Interested in ${joinLabels(topics)}.`);
  if (languages.length) parts.push(`Writes ${joinLabels(languages)}.`);
  if (keywords.length) parts.push(`Keywords: ${keywords.join(', ')}.`);
  return parts.join(' ');
}

module.exports = {
  DIMENSION_WEIGHTS,
  interestVector,
  similarity,
  scoreAttendee,
  matchAttendees,
  publicAttendee,
  interestSummary,
  looksNew,
};
