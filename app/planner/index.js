// STUB, to be replaced by the search and planner work (see docs/CONTRACTS.md).
// Builds a naive plan from the snapshot (keyword overlap with the profile), so
// the API and UI can be built against the contract with realistic data.
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'conferences');

function loadSnapshot(conferenceId) {
  if (!/^[a-z0-9-]+$/.test(conferenceId || '')) return null;
  const file = path.join(DATA_DIR, `${conferenceId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function terms(profile) {
  return [
    ...profile.tools.map((t) => t.name),
    ...profile.topics,
    ...profile.keywords,
  ].map((t) => t.toLowerCase().replace(/-/g, ' '));
}

function recommend(session, words) {
  const text = `${session.title} ${session.description || ''}`.toLowerCase();
  const hits = words.filter((w) => w && text.includes(w));
  return { session, score: Math.min(1, hits.length / 3), reasons: hits.map((h) => `Matches ${h}`) };
}

async function buildPlan({ conferenceId, profile, options = {} }) {
  const snapshot = loadSnapshot(conferenceId);
  if (!snapshot) {
    const err = new Error(`No conference named ${conferenceId}`);
    err.code = 'not_found';
    throw err;
  }
  const words = terms(profile);
  const skipped = new Set(options.skipped || []);
  const pinned = new Set(options.pinned || []);
  const byDay = new Map();
  for (const s of snapshot.sessions) {
    if (s.kind !== 'session' || skipped.has(s.id) || !s.start) continue;
    const date = s.start.slice(0, 10);
    if (options.days && !options.days.includes(date)) continue;
    if (!byDay.has(date)) byDay.set(date, new Map());
    const slots = byDay.get(date);
    if (!slots.has(s.start)) slots.set(s.start, []);
    slots.get(s.start).push(recommend(s, words));
  }
  const days = [...byDay.keys()].sort().map((date) => {
    const slots = [...byDay.get(date).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([start, recs]) => {
        recs.sort((a, b) => Number(pinned.has(b.session.id)) - Number(pinned.has(a.session.id)) || b.score - a.score);
        const [pick, ...rest] = recs;
        return { start, end: pick.session.end, pick, backups: rest.slice(0, 2), pinned: pinned.has(pick.session.id) };
      });
    const booths = snapshot.sponsors.slice(0, 3).map((sponsor) => ({
      sponsor,
      score: 0.1,
      reasons: [`${sponsor.tier || 'Sponsor'} sponsor`],
      gap: null,
    }));
    return { date, slots, booths };
  });
  const { conference } = snapshot;
  return {
    conferenceId,
    conference: {
      name: conference.name,
      timezone: conference.timezone,
      utcOffset: conference.utcOffset,
      location: conference.location,
    },
    generatedAt: new Date().toISOString(),
    searchBackend: 'snapshot',
    days,
  };
}

module.exports = { buildPlan };
