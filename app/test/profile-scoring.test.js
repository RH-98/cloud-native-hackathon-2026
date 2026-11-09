// Evidence kinds, recency x frequency scoring, weak-signal caps, keywords and
// byte-weighted languages. Pure: no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectEvidence, detectInterest, countMentions } = require('../profile/tools');
const { ToolScores, blendLanguages, recencyDecay, dedupeKeywords } = require('../profile/score');
const { extractKeywords, readmeHeadings } = require('../profile/signals');

const NOW = Date.parse('2026-11-09T20:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
const byName = (tools, name) => tools.find((t) => t.name === name);

test('evidence kinds: dependency, workflow, manifest, image, topic, readme, implied', () => {
  const ev = detectEvidence({
    deps: ['npm:@opentelemetry/api', 'npm:@opentelemetry/sdk-node', 'action:docker/build-push-action'],
    paths: ['.github/workflows/ci.yml', 'deploy/kustomization.yaml'],
    manifests: [{ group: 'argoproj.io', kind: 'Application' }],
    images: ['otel/opentelemetry-collector-contrib'],
    topics: ['gitops'],
    text: 'We deploy with Flux CD.',
  });
  assert.equal(ev.get('opentelemetry').get('dependency'), 2);
  assert.equal(ev.get('opentelemetry').get('image'), 1);
  assert.equal(ev.get('docker').get('workflow'), 1);
  assert.equal(ev.get('github-actions').get('workflow'), 1);
  assert.equal(ev.get('kustomize').get('manifest'), 1);
  assert.equal(ev.get('argo-cd').get('manifest'), 1);
  assert.equal(ev.get('gitops').get('topic'), 1);
  assert.ok(ev.get('gitops').has('implied'), 'Argo CD implies GitOps');
  assert.equal(ev.get('flux').get('readme'), 1);
  assert.ok(!ev.get('flux').has('implied'));
});

test('README lists of tools are not usage: 4+ tools on a line, table rows, short bullet runs', () => {
  const text = [
    'It detects about 75 tools (Argo CD, Flux, OpenTelemetry, Cilium, Kyverno…).',
    '| Cilium | Kyverno | Crossplane | Falco |',
    '- Cilium',
    '- Kyverno',
    '- Crossplane',
    '- Falco',
    '',
    'We deploy it with Argo CD and trace it with OpenTelemetry.',
  ].join('\n');
  const m = countMentions(text);
  assert.deepEqual([...m.keys()].sort(), ['argo-cd', 'opentelemetry']);
  assert.equal(m.get('argo-cd'), 1);
  // A list whose items are real sentences still counts.
  const sentences = countMentions(
    '- We deploy every service with Argo CD from this repo\n- Traces go through an OpenTelemetry collector we run\n' +
      '- Policies are enforced by Kyverno in every cluster here\n- Network policy comes from Cilium on our nodes',
  );
  assert.ok(sentences.has('kyverno') && sentences.has('cilium'));

  const nestedList = countMentions(
    '- We use Kubernetes across the production clusters and services that our team maintains\n' +
      '- We compare Cilium, Kyverno, Crossplane, and Falco while evaluating options for deployment',
  );
  assert.deepEqual([...nestedList.keys()], ['kubernetes']);
});

test('mention-only tools rank far below dependency tools; one README alone does not count', () => {
  const s = new ToolScores();
  s.add('me/app', detectEvidence({ deps: ['npm:@opentelemetry/api'], text: 'Built on Crossplane ideas. Mentions Kyverno.' }), 1);
  s.add('me/notes', detectEvidence({ text: 'More about Crossplane.' }), 1);
  const tools = s.rank();
  const otel = byName(tools, 'opentelemetry');
  const xp = byName(tools, 'crossplane');
  assert.equal(otel.weight, 1);
  assert.equal(otel.strength, 'strong');
  assert.ok(xp, 'README mentions in 2 repos count');
  assert.equal(xp.strength, 'light');
  assert.deepEqual(xp.kinds, ['readme']);
  assert.ok(xp.weight <= 0.35, `crossplane ${xp.weight}`);
  assert.ok(!byName(tools, 'kyverno'), 'a single README mention is dropped');
});

test('recency x frequency: the same evidence counts less the older the repo, more the more often it appears', () => {
  assert.equal(recencyDecay(daysAgo(0), NOW), 1);
  assert.ok(Math.abs(recencyDecay(daysAgo(365), NOW) - 0.5) < 0.01, 'half-life of 12 months');
  assert.ok(recencyDecay(daysAgo(30), NOW) > recencyDecay(daysAgo(400), NOW));

  const s = new ToolScores();
  s.add('me/new', detectEvidence({ deps: ['go:github.com/nats-io/nats.go'] }), recencyDecay(daysAgo(10), NOW));
  s.add('me/old', detectEvidence({ deps: ['npm:kafkajs'] }), recencyDecay(daysAgo(900), NOW));
  s.add('me/many', detectEvidence({ manifests: Array(6).fill({ group: 'cert-manager.io', kind: 'Certificate' }) }), recencyDecay(daysAgo(10), NOW));
  const tools = s.rank();
  const names = tools.map((t) => t.name);
  assert.ok(names.indexOf('nats') < names.indexOf('kafka'), names.join(','));
  assert.ok(names.indexOf('cert-manager') < names.indexOf('nats'), 'six manifests beat one dependency');
  assert.deepEqual(byName(tools, 'cert-manager').evidence, ['me/many']);
});

test('forks, starred repos and contributions are weak and capped', () => {
  const few = new ToolScores();
  const many = new ToolScores();
  for (const s of [few, many]) s.add('me/app', detectEvidence({ deps: ['npm:pg'] }), 1);
  const star = (i) => ({ name: `k${i}`, full_name: `o/k${i}`, topics: ['kubernetes'] });
  for (let i = 0; i < 3; i++) few.add(`o/k${i}`, detectInterest(star(i), 'starred'), 1);
  for (let i = 0; i < 50; i++) many.add(`o/k${i}`, detectInterest(star(i), 'starred'), 1);
  const a = byName(few.rank(), 'kubernetes');
  const b = byName(many.rank(), 'kubernetes');
  assert.equal(a.strength, 'light');
  assert.ok(b.weight <= 0.35 && b.weight === a.weight, `${a.weight} vs ${b.weight}: capped`);
  assert.equal(byName(many.rank(), 'postgres').weight, 1);

  const fork = detectInterest({ name: 'argo-cd', description: 'fork of Argo CD', topics: [] }, 'fork');
  assert.deepEqual([...fork.get('argo-cd').keys()], ['fork']);
  const s = new ToolScores();
  s.add('me/app', detectEvidence({ deps: ['npm:pg'] }), 1);
  s.add('me/argo-cd', fork, 1);
  const contrib = detectInterest({ name: 'mesh', topics: ['linkerd'] }, 'contribution');
  s.add('o/mesh', contrib, 1);
  const ranked = s.rank();
  assert.equal(byName(ranked, 'argo-cd').strength, 'light');
  assert.equal(byName(ranked, 'linkerd').strength, 'medium');
  assert.ok(byName(ranked, 'linkerd').weight <= 0.7);
  assert.ok(byName(ranked, 'postgres').weight > byName(ranked, 'linkerd').weight);
});

test('keywords: topics and descriptions first; README prose needs 2 repos; stoplist and meta words', () => {
  const readme = 'This app makes API calls, 5000 requests per hour, hits the api limit. A live agent demo for the hackathon attendees.';
  const kw = extractKeywords([
    { text: 'Event streaming pipelines', weight: 2, kind: 'description' },
    { text: 'hackathon', weight: 3, kind: 'topic' },
    { text: `${readme}\nWe care about chaos experiments.`, weight: 1, kind: 'readme', repo: 'me/a' },
    { text: 'More chaos experiments.', weight: 1, kind: 'readme', repo: 'me/b' },
    { text: 'Only here: quantum widgets.', weight: 1, kind: 'readme', repo: 'me/b' },
  ]);
  assert.ok(kw.includes('event streaming pipelines') || kw.includes('streaming pipelines') || kw.includes('event streaming'), kw.join(', '));
  assert.ok(kw.includes('hackathon'), 'meta words are fine as a topic');
  assert.ok(kw.includes('chaos experiments'), kw.join(', '));
  for (const junk of ['api calls', 'requests hour', 'api limit', 'live', 'agent', 'attendees', 'quantum widgets', 'quantum']) {
    assert.ok(!kw.includes(junk), `${junk} in ${kw.join(', ')}`);
  }
  // From prose, meta words never count, even in 2 repos.
  const meta = extractKeywords([
    { text: 'hackathon demo', weight: 1, kind: 'readme', repo: 'me/a' },
    { text: 'hackathon demo', weight: 1, kind: 'readme', repo: 'me/b' },
  ]);
  assert.deepEqual(meta, []);
  assert.equal(readmeHeadings('# Switchback\n\n## Limits\n```\n# not a heading\n```\nText'), 'Switchback');
  assert.deepEqual(
    dedupeKeywords(['kubernetes', 'progressive delivery', 'go'], [{ name: 'kubernetes', label: 'Kubernetes' }], [{ name: 'Go' }]),
    ['progressive delivery'],
  );
});

test('languages: byte-weighted per repo, blended with recency, under 3% dropped', () => {
  const langs = blendLanguages([
    { bytes: { Go: 90000, Shell: 1000, Makefile: 5000 }, primary: 'Go', recency: 1 },
    { bytes: { TypeScript: 40000, CSS: 10000 }, primary: 'TypeScript', recency: 0.5 },
    { bytes: null, primary: 'Python', recency: 0.25 },
  ]);
  const names = langs.map((l) => l.name);
  assert.deepEqual(names.slice(0, 2), ['Go', 'TypeScript']);
  assert.ok(names.includes('CSS') && names.includes('Python'));
  assert.ok(!names.includes('Shell'), 'under 3%');
  assert.ok(!names.includes('Makefile'), 'not a language');
  assert.ok(Math.abs(langs.reduce((a, l) => a + l.weight, 0) - 1) < 0.02);
  assert.deepEqual(blendLanguages([]), []);
});
