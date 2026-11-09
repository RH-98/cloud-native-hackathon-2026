const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { trace } = require('@opentelemetry/api');

// Record every span (name + attributes) so we can check the paste never lands on one.
const spans = [];
function fakeSpan(name, attributes) {
  const span = {
    name,
    attributes: { ...(attributes || {}) },
    setAttribute(k, v) { this.attributes[k] = v; return this; },
    setAttributes(o) { Object.assign(this.attributes, o); return this; },
    addEvent() { return this; },
    recordException(e) { this.exception = String(e && e.message); },
    setStatus() { return this; },
    updateName() { return this; },
    end() {},
    isRecording: () => true,
    spanContext: () => ({ traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceFlags: 1 }),
  };
  spans.push(span);
  return span;
}
trace.setGlobalTracerProvider({
  getTracer: () => ({
    startSpan: (name, opts) => fakeSpan(name, opts && opts.attributes),
    startActiveSpan: (name, ...args) => {
      const fn = args[args.length - 1];
      const opts = typeof args[0] === 'object' ? args[0] : {};
      return fn(fakeSpan(name, opts.attributes));
    },
  }),
});

const { parseLinkedIn, looksLikeLinkedIn } = require('../profile/linkedin');
const { buildProfile, mergeInterests, ProfileError } = require('../profile');
const { validatePlanRequest } = require('../api/plan');

const FIX = path.join(__dirname, 'fixtures', 'linkedin');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const names = (list) => list.map((x) => x.name);
const NOW = () => Date.parse('2026-11-09T21:00:00Z');

test('short interests lists are not LinkedIn pastes', () => {
  for (const s of ['argo cd, otel, rust', 'kubernetes · rust', 'platform engineering\nrust\nchess', 'Experience with Helm']) {
    assert.equal(looksLikeLinkedIn(s), false, s);
  }
  for (const f of ['platform-engineer.txt', 'full-page-sre.txt', 'engineering-manager.txt']) {
    assert.equal(looksLikeLinkedIn(read(f)), true, f);
  }
});

test('platform engineer: skills, headline and Experience skills become tools and languages', () => {
  const p = parseLinkedIn(read('platform-engineer.txt'));
  for (const t of ['kubernetes', 'argo-cd', 'terraform', 'helm', 'prometheus', 'kyverno', 'crossplane', 'opentelemetry']) {
    assert.ok(names(p.tools).includes(t), `missing ${t}: ${names(p.tools)}`);
  }
  // Listed skills outrank prose mentions.
  const w = Object.fromEntries(p.tools.map((t) => [t.name, t.weight]));
  assert.equal(w.kubernetes, 1);
  assert.ok(w.crossplane < w.terraform);
  assert.deepEqual(p.languages, [{ name: 'Go', weight: 1 }]); // "Go (Programming Language)"
  assert.ok(p.topics.includes('platform engineering'));
  assert.ok(p.topics.includes('devops')); // "DevOps Engineer"
  assert.ok(p.keywords.includes('aws')); // "Amazon Web Services (AWS)"
  // Generic skills, spoken languages, schools, employers and the name stay out.
  const all = JSON.stringify(p).toLowerCase();
  for (const noise of ['agile', 'team leadership', 'english', 'spanish', 'colorado', 'northwind', 'contoso', 'avery', 'quill', 'jordan', 'endorse', 'computer science']) {
    assert.ok(!all.includes(noise), `leaked ${noise}`);
  }
});

test('full-page copy: Activity, Interests and People also viewed are ignored', () => {
  const p = parseLinkedIn(read('full-page-sre.txt'));
  assert.ok(p.topics.includes('reliability'));
  assert.ok(p.topics.includes('observability'));
  for (const t of ['prometheus', 'grafana', 'jaeger', 'thanos']) assert.ok(names(p.tools).includes(t), t);
  assert.deepEqual(names(p.languages), ['Rust']);
  // Kafka is only in an Activity post; Ray/KServe/vLLM/Falco/OPA/Vault only in other people's headlines.
  for (const t of ['kafka', 'ray', 'kserve', 'vllm', 'falco', 'opa', 'vault', 'llm']) {
    assert.ok(!names(p.tools).includes(t), `picked up ${t} from noise`);
  }
  assert.ok(!p.topics.includes('security') && !p.topics.includes('data engineering') && !p.topics.includes('ai'));
  const all = JSON.stringify(p).toLowerCase();
  for (const noise of ['rowan', 'snowflake', 'seattle', 'followers', 'microsoft office', 'example.com', 'brightpath']) {
    assert.ok(!all.includes(noise), `leaked ${noise}`);
  }
});

test('engineering manager with mostly prose: titles become topics, prose gives tools at lower weight', () => {
  const p = parseLinkedIn(read('engineering-manager.txt'));
  for (const t of ['leadership', 'platform strategy', 'platform engineering', 'startups']) assert.ok(p.topics.includes(t), t);
  for (const t of ['kubernetes', 'istio', 'opentelemetry', 'backstage', 'sigstore']) assert.ok(names(p.tools).includes(t), t);
  assert.ok(p.tools.every((t) => t.weight < 1));
  assert.ok(p.keywords.includes('finops'));
  assert.ok(p.keywords.includes('supply chain security'));
  // Terraform and Kafka are only in someone else's recommendation.
  assert.ok(!names(p.tools).includes('terraform') && !names(p.tools).includes('kafka'));
  assert.ok(!JSON.stringify(p).toLowerCase().includes('taylor'));
});

test('buildProfile: a pasted profile is an interests profile marked pastedFrom linkedin, with no name', async () => {
  const profile = await buildProfile({ interests: read('platform-engineer.txt') }, { now: NOW });
  assert.equal(profile.source, 'interests');
  assert.equal(profile.pastedFrom, 'linkedin');
  assert.equal(profile.username, null);
  assert.equal(profile.displayName, 'You');
  assert.ok(profile.tools.every((t) => Array.isArray(t.evidence) && t.evidence.length === 0 && t.label));
  assert.ok(!JSON.stringify(profile).includes('Avery'));
});

test('buildProfile: short interests behave as before', async () => {
  const profile = await buildProfile({ interests: 'argo cd, otel, rust, chess' }, { now: NOW });
  assert.equal(profile.source, 'interests');
  assert.equal(profile.pastedFrom, undefined);
  assert.deepEqual(names(profile.tools), ['argo-cd', 'opentelemetry']);
  assert.ok(profile.tools.every((t) => t.weight === 1));
  assert.deepEqual(profile.languages, [{ name: 'Rust', weight: 1 }]);
  assert.deepEqual(profile.keywords, ['rust', 'chess']);
  assert.deepEqual(profile.topics, []);
});

test('long text that names nothing is rejected; over 10,000 characters is rejected', async () => {
  await assert.rejects(buildProfile({ interests: 'lorem ipsum dolor '.repeat(40) }, { now: NOW }), ProfileError);
  await assert.rejects(buildProfile({ interests: `Skills\nKubernetes\n${'x'.repeat(10001)}` }, { now: NOW }),
    (err) => err.code === 'invalid_input' && /10,000/.test(err.message));
});

test('blending with a GitHub profile keeps repo evidence and adds LinkedIn signals', async () => {
  const github = {
    source: 'github', username: 'octo-dev', displayName: 'Octo Dev', avatarUrl: null, repoCount: 3,
    languages: [{ name: 'TypeScript', weight: 0.7 }, { name: 'Go', weight: 0.3 }],
    tools: [{ name: 'kubernetes', label: 'Kubernetes', weight: 1, evidence: ['octo-dev/infra'] },
      { name: 'crossplane', label: 'Crossplane', weight: 0.2, evidence: ['octo-dev/infra'] }],
    topics: ['gitops'], keywords: ['monorepo'], generatedAt: '2026-11-09T21:00:00Z',
  };
  const pasted = await buildProfile({ interests: read('platform-engineer.txt') }, { now: NOW });
  const merged = mergeInterests(github, pasted);
  assert.equal(merged.source, 'github+interests');
  assert.equal(merged.pastedFrom, 'linkedin');
  assert.equal(merged.username, 'octo-dev');
  const byName = Object.fromEntries(merged.tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.kubernetes.evidence, ['octo-dev/infra']);
  assert.equal(byName.terraform.weight, 0.9); // listed skill
  assert.equal(byName.crossplane.weight, 0.54); // prose mention: 0.9 * 0.6, above the repo's 0.2
  assert.equal(byName.go === undefined, true);
  assert.equal(merged.languages.find((l) => l.name === 'Go').weight, 0.9);
  assert.ok(merged.topics.includes('platform engineering') && merged.topics.includes('gitops'));
  assert.deepEqual(merged.pastedTopics, pasted.topics);
  assert.ok(merged.keywords.includes('monorepo') && merged.keywords.includes('aws'));
  // Typed interests still blend exactly as before.
  const typed = mergeInterests(github, await buildProfile({ interests: 'crossplane' }, { now: NOW }));
  assert.equal(typed.tools.find((t) => t.name === 'crossplane').weight, 0.9);
  assert.equal(typed.pastedFrom, undefined);
  assert.deepEqual(typed.pastedTopics, []);
});

test('the pasted text never reaches logs or span attributes', async () => {
  const text = read('full-page-sre.txt');
  const logged = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...args) => logged.push(args.map(String).join(' '));
  }
  spans.length = 0;
  try {
    await buildProfile({ interests: text }, { now: NOW });
    await buildProfile({ interests: 'Skills\nRowan Ellery Secret Project\nlorem\n500+ connections' }, { now: NOW }).catch(() => {});
  } finally {
    Object.assign(console, orig);
  }
  const seen = JSON.stringify({ logged, spans: spans.map((s) => ({ n: s.name, a: s.attributes, e: s.exception })) });
  assert.ok(spans.some((s) => s.attributes['profile.pasted_from'] === 'linkedin'));
  for (const secret of ['Rowan', 'Ellery', 'Brightpath', 'Seattle', 'SLOs', 'Snowflake']) {
    assert.ok(!seen.includes(secret), `${secret} leaked into logs or spans`);
  }
});

test('API: pasted profiles may be up to 10,000 characters; interests stay text', () => {
  const paste = read('platform-engineer.txt');
  assert.ok(paste.length > 500);
  assert.equal(validatePlanRequest({ conferenceId: 'kubecon-na-2026', interests: paste }).interests, paste.trim());
  assert.throws(() => validatePlanRequest({ conferenceId: 'kubecon-na-2026', interests: 'a'.repeat(10001) }), /10,000/);
  assert.equal(validatePlanRequest({ conferenceId: 'kubecon-na-2026', interests: ' rust ' }).interests, 'rust');
});
