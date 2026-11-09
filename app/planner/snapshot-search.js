// Offline search: the same signatures as searchSessions / searchSponsors in
// app/search/elasticsearch.js, scoring the bundled snapshot in memory with a
// weighted term overlap. Used locally, in tests, and when Elasticsearch fails.
const terms = require('./terms');

function inDays(session, days) {
  return !days || !days.length || days.includes(String(session.start || '').slice(0, 10));
}

function levelAllowed(level, levels) {
  return !levels || !levels.length || level == null || level === 'Any Level' || levels.includes(level);
}

// snapshot: the conference file. Returns [{ session, score, reasons }].
function searchSessions(snapshot, { conferenceId, profile, days, levels, size = 250 } = {}) {
  const profileTerms = terms.profileTerms(profile);
  const results = [];
  for (const session of snapshot.sessions) {
    if (session.kind !== 'session' || (conferenceId && session.conferenceId !== conferenceId)) continue;
    if (!inDays(session, days) || !levelAllowed(session.level, levels)) continue;
    const matches = terms.sessionMatches(session, profileTerms);
    if (!matches.length) continue;
    results.push({
      session,
      score: terms.sessionScore(session, matches),
      reasons: terms.sessionReasons(session, matches),
    });
  }
  return results
    .sort((a, b) => b.score - a.score || a.session.id.localeCompare(b.session.id))
    .slice(0, size);
}

function searchSponsors(snapshot, { profile } = {}) {
  return terms.rankSponsors(snapshot.sponsors || [], terms.profileTerms(profile));
}

module.exports = { searchSessions, searchSponsors, levelAllowed };
