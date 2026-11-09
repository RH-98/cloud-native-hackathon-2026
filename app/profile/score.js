// Turns per-repo evidence into ranked profile fields. Pure: no network.
//
// A tool's score is the sum over its evidence of
//   kindWeight × recency(repo) × (1 + ln(1 + occurrences)) × damping(tool)
// where recency halves every 12 months since the repo was last pushed (or
// the star / contribution happened). Weak kinds are capped per tool, so a
// pile of starred repos never outweighs one real dependency. Scores are
// normalized to 0..1 and then capped by strength, so a tool seen only in
// READMEs or starred repos never ranks like one the user actually runs.
const { STRONG_KINDS, label, damping, compact } = require('./tools');

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 365;

const KIND_WEIGHT = {
  dependency: 1,
  manifest: 1,
  image: 0.9,
  workflow: 0.8,
  topic: 0.6,
  contribution: 0.5,
  implied: 0.45,
  fork: 0.25,
  readme: 0.2,
  starred: 0.15,
};
// Per tool, summed over every repo of that kind.
const KIND_CAP = { fork: 0.5, starred: 0.3, contribution: 1.2 };
const STRENGTH_CAP = { strong: 1, medium: 0.7, light: 0.35 };
const MEDIUM_KINDS = new Set(['topic', 'implied', 'contribution']);
const WEAK_KINDS = new Set(['readme', 'fork', 'starred']);
const NOT_LANGUAGES = new Set(['Dockerfile', 'Makefile', 'Procfile']);

const round2 = (n) => Math.round(n * 100) / 100;

function recencyDecay(date, now, halfLifeDays = HALF_LIFE_DAYS) {
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

function strengthOf(kinds) {
  if (kinds.some((k) => STRONG_KINDS.has(k))) return 'strong';
  if (kinds.some((k) => MEDIUM_KINDS.has(k))) return 'medium';
  if (kinds.filter((k) => WEAK_KINDS.has(k)).length >= 2) return 'medium';
  return 'light';
}

const byKindWeight = (a, b) => (KIND_WEIGHT[b] || 0) - (KIND_WEIGHT[a] || 0) || a.localeCompare(b);

// Collects evidence repo by repo, then ranks tools.
class ToolScores {
  constructor() {
    this.tools = new Map();
  }

  // evidence: Map(tool -> Map(kind -> occurrences)) for one repo.
  add(repo, evidence, recency) {
    for (const [name, kinds] of evidence) {
      const t = this.tools.get(name) || { byKind: new Map(), repos: new Map() };
      for (const [kind, count] of kinds) {
        const s = (KIND_WEIGHT[kind] || 0) * recency * (1 + Math.log(1 + count)) * damping(name);
        if (s <= 0) continue;
        const k = t.byKind.get(kind) || { score: 0, repos: new Set() };
        k.score += s;
        k.repos.add(repo);
        t.byKind.set(kind, k);
        const r = t.repos.get(repo) || { score: 0, kinds: new Set() };
        r.score += s;
        r.kinds.add(kind);
        t.repos.set(repo, r);
      }
      if (t.byKind.size) this.tools.set(name, t);
    }
  }

  // -> [{ name, label, weight, strength, kinds, evidence, sources }]
  rank({ max = 15, maxEvidence = 5 } = {}) {
    const scored = [];
    for (const [name, t] of this.tools) {
      const kinds = [...t.byKind.keys()].sort(byKindWeight);
      // A README mention alone needs two repos before it counts at all.
      if (kinds.length === 1 && kinds[0] === 'readme' && t.byKind.get('readme').repos.size < 2) continue;
      let score = 0;
      for (const [kind, k] of t.byKind) score += Math.min(k.score, KIND_CAP[kind] ?? Infinity);
      scored.push({ name, t, kinds, score, strength: strengthOf(kinds) });
    }
    const maxScore = Math.max(0, ...scored.map((s) => s.score));
    return scored
      .map(({ name, t, kinds, score, strength }) => {
        const sources = [...t.repos.entries()]
          .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
          .slice(0, maxEvidence)
          .map(([repo, r]) => ({ repo, kinds: [...r.kinds].sort(byKindWeight) }));
        return {
          name,
          label: label(name),
          weight: Math.max(0.01, round2(Math.min(STRENGTH_CAP[strength], score / maxScore))),
          strength,
          kinds,
          evidence: sources.map((s) => s.repo),
          sources,
          score,
        };
      })
      .sort((a, b) => b.weight - a.weight || b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, max)
      .map(({ score, ...tool }) => tool);
  }
}

// entries: [{ bytes: { Go: 1234 } | null, primary: 'Go' | null, recency, weight? }]
// A repo's languages count by their share of its bytes, scaled by recency and
// (gently) by the repo's size; a repo with no byte counts falls back to its
// primary language. Languages under 3% are dropped.
function blendLanguages(entries, { max = 6, minShare = 0.03 } = {}) {
  const scores = new Map();
  const add = (name, s) => {
    if (name && !NOT_LANGUAGES.has(name) && s > 0) scores.set(name, (scores.get(name) || 0) + s);
  };
  for (const { bytes, primary, recency, weight = 1 } of entries) {
    const pairs = Object.entries(bytes || {}).filter(([n, b]) => !NOT_LANGUAGES.has(n) && Number(b) > 0);
    const total = pairs.reduce((a, [, b]) => a + Number(b), 0);
    if (total > 0) {
      const size = 1 + Math.log10(1 + total / 10000);
      for (const [name, b] of pairs) add(name, (Number(b) / total) * recency * weight * size);
    } else {
      add(primary, recency * weight);
    }
  }
  const sum = [...scores.values()].reduce((a, b) => a + b, 0);
  if (!sum) return [];
  const kept = [...scores.entries()].filter(([, s]) => s / sum >= minShare);
  const keptSum = kept.reduce((a, [, s]) => a + s, 0);
  return kept
    .map(([name, s]) => ({ name, weight: round2(s / keptSum) }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, max);
}

// Drops keywords that only repeat the name of a tool or language already in
// the profile ("kubernetes", "go"). Related phrases stay ("progressive
// delivery" next to Argo Rollouts): the planner matches them in session text.
function dedupeKeywords(keywords, tools, languages) {
  const names = new Set([
    ...tools.flatMap((t) => [compact(t.name), compact(t.label)]),
    ...languages.map((l) => compact(l.name)),
  ]);
  return keywords.filter((k) => !names.has(compact(k)));
}

module.exports = { ToolScores, blendLanguages, recencyDecay, dedupeKeywords, strengthOf, KIND_WEIGHT, KIND_CAP, STRENGTH_CAP };
