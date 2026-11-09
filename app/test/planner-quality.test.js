// Regression: the live plan for a Flux maintainer (github stefanprodan) on
// 2026-11-10 was all AI-agent talks and sponsored Demo Theater slots, and
// missed both Flux talks. Built from the real snapshot sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan } = require('../planner');
const terms = require('../planner/terms');
const snapshot = require('../data/conferences/kubecon-na-2026.json');

const DAY = '2026-11-10';
const byTitle = (prefix) => {
  const s = snapshot.sessions.find((x) => x.title.startsWith(prefix));
  assert.ok(s, `snapshot has "${prefix}"`);
  return s;
};
const ARGO_FLUX = byTitle('You Don’t Have to Choose: Argo and Flux Are Friends!');
const FLUX_AGENTS = byTitle('GitOps Without You Writing YAML: How Flux Grounds AI Agents');

// Close to the live profile: tools, then the keywords the profile extracted.
const fluxMaintainer = {
  source: 'github',
  tools: [
    { name: 'kubernetes', label: 'Kubernetes', weight: 1, evidence: [] },
    { name: 'flux', label: 'Flux', weight: 0.99, evidence: [] },
    { name: 'github-actions', label: 'GitHub Actions', weight: 0.91, evidence: [] },
    { name: 'helm', label: 'Helm', weight: 0.9, evidence: [] },
    { name: 'llm', label: 'AI', weight: 0.84, evidence: [] },
    { name: 'gitops', label: 'GitOps', weight: 0.71, evidence: [] },
  ],
  topics: ['kubernetes', 'gitops', 'flux', 'helm'],
  keywords: ['kubernetes', 'agents', 'server', 'flux', 'helm', 'market data'],
  languages: [{ name: 'Go', weight: 0.8 }],
};

// A fake Elasticsearch that ranks like the live semantic retriever did:
// AI-agent talks and sponsored sessions first, everything else after.
function aiFirstClient() {
  const day = snapshot.sessions.filter((s) => s.kind === 'session' && s.start.startsWith(DAY));
  const aiFirst = day.filter((s) => /agent|\bAI\b/i.test(s.title) || s.sponsored);
  const ranked = [...aiFirst, ...day.filter((s) => !aiFirst.includes(s))];
  return {
    async search(req) {
      if (req.index === 'conference-sponsors') return { hits: { hits: [] } };
      return { hits: { hits: ranked.map((s, i) => ({ _id: s.id, _score: 1 / (61 + i), _source: s })) } };
    },
  };
}

function check(result) {
  const chosen = result.days[0].slots.filter((s) => s.pick).map((s) => s.pick);
  const ids = chosen.map((p) => p.session.id);
  assert.ok(ids.includes(ARGO_FLUX.id), 'picks "Argo and Flux Are Friends"');
  assert.ok(ids.includes(FLUX_AGENTS.id), 'picks "How Flux Grounds AI Agents"');
  const demoTheater = chosen.filter((p) => p.session.track === 'Sponsor Demo Theater');
  assert.deepEqual(demoTheater.map((p) => p.session.title), [], 'no Demo Theater picks');
  const flux = chosen.find((p) => p.session.id === FLUX_AGENTS.id);
  assert.equal(flux.reasons[0], 'Matches Flux');
}

test('a Flux maintainer gets the Flux and GitOps talks, not Demo Theater (snapshot backend)', async () => {
  const result = await buildPlan({ conferenceId: 'kubecon-na-2026', profile: fluxMaintainer, options: { days: [DAY] } }, { env: {} });
  assert.equal(result.searchBackend, 'snapshot');
  check(result);
});

test('the same holds when Elasticsearch ranks AI-agent and sponsored sessions first', async () => {
  const result = await buildPlan(
    { conferenceId: 'kubecon-na-2026', profile: fluxMaintainer, options: { days: [DAY] } },
    { client: aiFirstClient() },
  );
  assert.equal(result.searchBackend, 'elasticsearch');
  check(result);
});

test('AI is generic, vague keywords are dropped, and the semantic query leaves generic tools out', () => {
  const t = terms.profileTerms(fluxMaintainer);
  const byKey = Object.fromEntries(t.map((x) => [x.key, x]));
  assert.ok(byKey.ai.generic && byKey.ai.weight < 0.2);
  assert.ok(!byKey.server && !byKey.agents, 'server and agents are dropped');
  assert.ok(byKey['market data'], 'specific keywords stay');
  assert.deepEqual(t.filter((x) => x.topTool).map((x) => x.key), ['flux', 'github actions', 'helm']);
  const text = terms.semanticQueryText(fluxMaintainer, t);
  assert.match(text, /Flux/);
  assert.doesNotMatch(text, /\bAI\b|Kubernetes/);
});

test('sessionScore: title beats description, sponsored counts half unless a top tool is in the title', () => {
  const t = terms.profileTerms(fluxMaintainer);
  const base = { title: 'A talk', description: '', tags: [], track: null, sponsored: false };
  const score = (s, rank) => terms.sessionScore(s, terms.sessionMatches(s, t), rank);
  const inTitle = score({ ...base, title: 'Flux in production' });
  const inDesc = score({ ...base, description: 'We use Flux in production' });
  assert.ok(inTitle > 2 * inDesc, `${inTitle} vs ${inDesc}`);

  const demo = { ...base, title: 'Demo Theater: agents everywhere', description: 'Runs on Flux', sponsored: true };
  assert.ok(Math.abs(score(demo) - score({ ...demo, sponsored: false }) / 2) <= 0.001);
  const fluxDemo = { ...base, title: 'Demo Theater: Flux at scale', sponsored: true };
  assert.equal(score(fluxDemo), score({ ...fluxDemo, sponsored: false }));

  // With Elasticsearch: the fused rank counts, but less than the term match.
  const semanticOnly = score(base, 1);
  assert.ok(semanticOnly <= 0.3 && semanticOnly < inTitle);
});
