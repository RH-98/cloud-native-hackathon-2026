const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildProfile, mergeInterests, ProfileError, TtlCache } = require('../profile');
const { detectTools, matchInterests, CATALOG } = require('../profile/tools');
const signals = require('../profile/signals');

const FIX = path.join(__dirname, 'fixtures', 'github');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const NOW = Date.parse('2026-11-09T20:00:00Z');
const BRANCH = { 'deploy-stack': 'main', 'web-ui': 'main', 'ml-notes': 'trunk' };

// A fake fetch serving fixture files. `rateLimitApiAfter`: API calls after
// that many succeed return 403 with x-ratelimit-remaining: 0.
function fakeGithub({ rateLimitApiAfter = Infinity, user = 'octo-dev' } = {}) {
  const calls = [];
  let apiCalls = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, hasSignal: Boolean(init.signal) });
    const u = new URL(url);
    const json = (body) =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '42' } });
    if (u.host === 'api.github.com') {
      apiCalls += 1;
      if (apiCalls > rateLimitApiAfter) {
        return new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        });
      }
      const p = u.pathname.toLowerCase();
      if (p === `/users/${user}`) return json(read('user.json'));
      if (p === `/users/${user}/repos`) return json(read('repos.json'));
      if (p === `/users/${user}/starred`) return json(read('starred.json'));
      if (p === `/users/${user}/events/public`) return json(read('events.json'));
      const tree = /^\/repos\/octo-dev\/([^/]+)\/git\/trees\/([^/]+)$/.exec(u.pathname);
      if (tree && BRANCH[tree[1]] === tree[2]) return json(read(`tree-${tree[1]}.json`));
      const langs = /^\/repos\/octo-dev\/([^/]+)\/languages$/.exec(u.pathname);
      if (langs && fs.existsSync(path.join(FIX, `languages-${langs[1]}.json`))) return json(read(`languages-${langs[1]}.json`));
      const other = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (other && fs.existsSync(path.join(FIX, `repo-${other[1]}__${other[2]}.json`))) {
        return json(read(`repo-${other[1]}__${other[2]}.json`));
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    if (u.host === 'raw.githubusercontent.com') {
      const m = /^\/octo-dev\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
      const file = m && path.join('raw', `${m[1]}__${decodeURIComponent(m[3]).replace(/\//g, '__')}.txt`);
      if (m && BRANCH[m[1]] === m[2] && fs.existsSync(path.join(FIX, file))) {
        return new Response(read(file), { status: 200 });
      }
      return new Response('404: Not Found', { status: 404 });
    }
    throw new Error(`unexpected host ${u.host}`);
  };
  return { fetch, calls };
}

const deps = (fake, extra = {}) => ({ fetch: fake.fetch, cache: new TtlCache(), token: '', ...extra });
const tool = (profile, name) => profile.tools.find((t) => t.name === name);

// ---------------------------------------------------------------- detection

test('detects tools from go.mod, package.json, requirements.txt and Chart.yaml dependencies', () => {
  const goDeps = signals.parseFile('go.mod', read('raw/deploy-stack__go.mod.txt')).deps;
  const found = detectTools({ deps: goDeps });
  for (const name of ['prometheus', 'opentelemetry', 'client-go', 'operators', 'kubernetes']) {
    assert.ok(found.has(name), `go.mod -> ${name}`);
  }
  assert.ok(!found.has('argo-cd'));

  const npm = detectTools({ deps: signals.parseFile('package.json', read('raw/web-ui__package.json.txt')).deps });
  assert.ok(npm.has('opentelemetry') && npm.has('grpc'));
  assert.equal(npm.get('opentelemetry'), 3);

  const py = detectTools({ deps: signals.parseFile('requirements.txt', read('raw/ml-notes__requirements.txt.txt')).deps });
  assert.ok(py.has('vllm') && py.has('ray') && py.has('postgres') && py.has('llm'));

  const chart = detectTools({ deps: signals.parseFile('charts/app/Chart.yaml', read('raw/deploy-stack__charts__app__Chart.yaml.txt')).deps });
  assert.ok(chart.has('prometheus-operator') && chart.has('prometheus'));
});

test('detects tools from manifest apiVersion/kind, images, paths and workflow actions', () => {
  const y = signals.parseYaml(read('raw/deploy-stack__deploy__rollout.yaml.txt'));
  assert.deepEqual(y.manifests.map((m) => `${m.group}/${m.kind}`), [
    'argoproj.io/Rollout',
    'cert-manager.io/Certificate',
    'argoproj.io/Application',
  ]);
  assert.ok(y.images.includes('otel/opentelemetry-collector-contrib'));
  const found = detectTools(y);
  for (const name of ['argo-rollouts', 'argo-cd', 'cert-manager', 'opentelemetry', 'kubernetes', 'gitops']) {
    assert.ok(found.has(name), `manifest -> ${name}`);
  }
  assert.ok(!found.has('argo-workflows'), 'argoproj.io kinds are told apart');

  const paths = detectTools({
    paths: ['Dockerfile', 'infra/main.tf', '.github/workflows/ci.yml', 'charts/x/Chart.yaml', 'policy/deny.rego', 'api/v1/svc.proto'],
  });
  for (const name of ['docker', 'terraform', 'github-actions', 'ci-cd', 'helm', 'opa', 'grpc']) {
    assert.ok(paths.has(name), `path -> ${name}`);
  }

  const wf = signals.parseYaml('jobs:\n  b:\n    steps:\n      - uses: sigstore/cosign-installer@v3\n      - uses: azure/setup-helm@v4\n');
  const fromWf = detectTools(wf);
  assert.ok(fromWf.has('sigstore') && fromWf.has('helm'));
});

test('evidence strength: dependency/manifest > topic > README mention', () => {
  const found = detectTools({
    deps: ['npm:@opentelemetry/api'],
    topics: ['argocd'],
    text: 'we deploy with flux cd and keda',
  });
  assert.equal(found.get('opentelemetry'), 3);
  assert.equal(found.get('argo-cd'), 2);
  assert.equal(found.get('flux'), 1);
  assert.equal(found.get('keda'), 1);
  // Ambiguous words are not README mentions: "ray" in prose, "argo" alone.
  const prose = detectTools({ text: 'a ray of light; argo the ship; an array of things' });
  assert.ok(!prose.has('ray') && !prose.has('argo-cd'));
});

test('catalog: ~60 tools, unique slugs, every entry has a label', () => {
  assert.ok(CATALOG.length >= 60, `catalog has ${CATALOG.length}`);
  assert.equal(new Set(CATALOG.map((t) => t.name)).size, CATALOG.length);
  for (const t of CATALOG) assert.ok(t.label, t.name);
});

test('pickFiles balances dependency files and manifests and skips vendored paths', () => {
  const tree = JSON.parse(read('tree-deploy-stack.json')).tree;
  const picked = signals.pickFiles(tree, 3);
  assert.deepEqual(picked, ['go.mod', 'deploy/rollout.yaml', 'charts/app/Chart.yaml']);
  assert.equal(signals.findReadme(tree), 'README.md');
});

test('keywords come from descriptions and READMEs, without code blocks or URLs', () => {
  const kw = signals.extractKeywords(
    [
      { text: 'GitOps platform manifests for progressive delivery', weight: 3 },
      { text: read('raw/deploy-stack__README.md.txt'), weight: 1 },
    ],
    { exclude: ['deploy-stack'] },
  );
  assert.ok(kw.includes('progressive delivery'), kw.join(', '));
  assert.ok(!kw.some((k) => /secret|github\.com|badge/.test(k)), kw.join(', '));
  assert.ok(kw.length <= 10);
});

// ------------------------------------------------------------- interests

test('interests: aliases map to catalog tools, the rest become keywords', async () => {
  const p = await buildProfile({ interests: 'argo, otel, k8s, rust, platform engineering, wasm\nchess' });
  assert.equal(p.source, 'interests');
  assert.equal(p.username, null);
  assert.deepEqual(
    p.tools.map((t) => t.name),
    ['argo-cd', 'opentelemetry', 'kubernetes', 'platform-engineering', 'wasm'],
  );
  assert.equal(tool(p, 'argo-cd').label, 'Argo CD');
  assert.equal(tool(p, 'opentelemetry').label, 'OpenTelemetry');
  assert.deepEqual(p.keywords, ['rust', 'chess']);
  assert.deepEqual(p.languages, [{ name: 'Rust', weight: 1 }]);
  assert.deepEqual(p.topics, []);

  const inheritedProperty = await buildProfile({ interests: 'constructor' });
  assert.deepEqual(inheritedProperty.languages, []);
  assert.deepEqual(inheritedProperty.keywords, ['constructor']);
});

test('interests: tools inside longer phrases, longest alias first', () => {
  const r = matchInterests('I like argo rollouts and observability with OTel; Argo-CD');
  assert.deepEqual(r.tools, ['argo-rollouts', 'observability', 'opentelemetry', 'argo-cd']);
  assert.deepEqual(r.rest, []);
  assert.deepEqual(matchInterests('rust, sailing').rest, ['rust', 'sailing']);
});

test('interests: over 500 characters with no skills in them, or empty, is invalid_input', async () => {
  await assert.rejects(buildProfile({ interests: 'x'.repeat(501) }), { name: 'ProfileError', code: 'invalid_input' });
  await assert.rejects(buildProfile({}), { code: 'invalid_input' });
  await assert.rejects(buildProfile({ github: 'not a user!' }, { fetch: () => assert.fail('no call') }), {
    code: 'invalid_input',
  });
});

// ---------------------------------------------------------------- github

test('github: builds the contract shape from public, non-fork, non-archived repos', async () => {
  const fake = fakeGithub();
  const p = await buildProfile({ github: 'https://github.com/Octo-Dev' }, deps(fake, { token: 'test-token', now: () => NOW, maxTools: 40 }));
  assert.deepEqual(Object.keys(p), [
    'source', 'username', 'displayName', 'avatarUrl', 'repoCount', 'languages', 'tools', 'topics', 'keywords', 'scan',
    'generatedAt',
  ]);
  assert.equal(p.source, 'github');
  assert.equal(p.username, 'octo-dev');
  assert.equal(p.displayName, 'Octo Dev');
  assert.equal(p.repoCount, 3);
  assert.equal(p.languages[0].name, 'Go');
  assert.ok(Math.abs(p.languages.reduce((a, l) => a + l.weight, 0) - 1) < 0.02);
  assert.ok(!p.languages.some((l) => l.name === 'C' || l.name === 'Ruby'), 'forks and archived repos skipped');
  assert.ok(!p.languages.some((l) => l.name === 'Makefile' || l.name === 'Smarty'), 'not languages, or under 3%');
  // The user's own topics first, then topics of repos they contributed to.
  assert.deepEqual(p.topics.slice(0, 4).sort(), ['dashboard', 'gitops', 'kubernetes', 'opentelemetry']);
  assert.deepEqual(p.topics.slice(4).sort(), ['linkerd', 'service-mesh']);

  for (const name of ['argo-rollouts', 'argo-cd', 'kubernetes', 'opentelemetry', 'prometheus', 'helm', 'kustomize', 'postgres']) {
    assert.ok(tool(p, name), `found ${name}: ${p.tools.map((t) => `${t.name} ${t.weight} ${t.strength} ${t.kinds}`).join(" | ")}`);
  }
  assert.ok(p.tools.length > 15, "maxTools: 40 shows the long tail");
  for (const t of p.tools) {
    assert.ok(t.weight > 0 && t.weight <= 1, `${t.name} weight ${t.weight}`);
    assert.equal(typeof t.label, 'string');
  }
  assert.deepEqual(p.tools.map((t) => t.weight), p.tools.map((t) => t.weight).slice().sort((a, b) => b - a));
  assert.equal(p.tools[0].weight, 1);
  assert.deepEqual(tool(p, 'opentelemetry').evidence.slice().sort(), ['octo-dev/deploy-stack', 'octo-dev/web-ui']);
  assert.deepEqual(tool(p, 'postgres').evidence, ['octo-dev/ml-notes']);
  assert.ok(!tool(p, 'grpc') || !tool(p, 'grpc').evidence.includes('octo-dev/deploy-stack'), 'vendored .proto ignored');
  assert.ok(p.keywords.includes('progressive delivery'), p.keywords.join(', '));

  const out = JSON.stringify(p);
  assert.ok(!out.includes('SECRET_SHOULD_NEVER_APPEAR') && !out.includes('test-token'), 'no file contents or token');

  // Token goes to the API only, every call has a timeout, and the call budget holds.
  for (const c of fake.calls) {
    assert.ok(c.hasSignal, 'timeout signal');
    assert.equal(c.headers['User-Agent'], 'conference-planner');
    if (c.url.startsWith('https://api.github.com/')) assert.equal(c.headers.Authorization, 'Bearer test-token');
    else assert.equal(c.headers.Authorization, undefined);
  }
  const apiCalls = fake.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.ok(apiCalls.length <= 25, `${apiCalls.length} API calls`);
  assert.ok(fake.calls.length <= 60, `${fake.calls.length} calls`);
  assert.ok(!fake.calls.some((c) => c.url.includes('forked-thing') || c.url.includes('old-archive')));

  // Strength and kinds on every tool; evidence and sources line up.
  for (const t of p.tools) {
    assert.ok(['strong', 'medium', 'light'].includes(t.strength), `${t.name} strength ${t.strength}`);
    assert.ok(Array.isArray(t.kinds) && t.kinds.length > 0, `${t.name} kinds`);
    assert.deepEqual(t.sources.map((s) => s.repo), t.evidence);
  }
  assert.equal(tool(p, 'argo-rollouts').strength, 'strong');
  assert.ok(tool(p, 'argo-rollouts').kinds.includes('manifest'));
  assert.ok(tool(p, 'postgres').kinds.includes('dependency'));

  // Contributions: other people's repos only, last 90 days, opened PRs/issues and pushes.
  const linkerd = tool(p, 'linkerd');
  assert.ok(linkerd && linkerd.kinds.includes('contribution') && linkerd.strength === 'medium');
  assert.deepEqual(linkerd.evidence, ['other-org/mesh-lab']);
  assert.ok(!out.includes('old-org/ancient') && !out.includes('closed-only') && !out.includes('other-org/watched'));
  // Starred: weak, light, and below every tool the user actually runs.
  const cilium = tool(p, 'cilium');
  assert.ok(cilium && cilium.strength === 'light' && cilium.weight <= 0.35, JSON.stringify(cilium));
  assert.deepEqual(cilium.kinds, ['starred']);
  for (const t of p.tools.filter((x) => x.strength === 'strong')) assert.ok(t.weight > cilium.weight, t.name);

  assert.deepEqual(p.scan, {
    publicRepos: 5, scanned: 3, forks: 1, empty: 0, archived: 1, starred: 3, contributions: 2, partial: false,
  });
});

test('github: no token means no Authorization header', async () => {
  const fake = fakeGithub();
  const p = await buildProfile({ github: 'octo-dev' }, deps(fake, { token: undefined }));
  assert.ok(p.tools.length <= 15);
  assert.ok(fake.calls.every((c) => c.headers.Authorization === undefined));
});

test('github: skips optional API jobs beyond the anonymous budget without marking partial', async () => {
  const fake = fakeGithub();
  const p = await buildProfile({ github: 'octo-dev' }, deps(fake, { maxApiCalls: 8 }));
  const apiCalls = fake.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.equal(apiCalls.length, 8);
  assert.equal(p.scan.partial, false);
});

test('github: unknown user is not_found', async () => {
  const fake = fakeGithub({ user: 'someone-else' });
  await assert.rejects(buildProfile({ github: 'octo-dev' }, deps(fake)), (err) => {
    assert.ok(err instanceof ProfileError);
    assert.equal(err.code, 'not_found');
    assert.match(err.message, /octo-dev/);
    return true;
  });
});

test('github: rate limit on the first call is rate_limited', async () => {
  const fake = fakeGithub({ rateLimitApiAfter: 0 });
  await assert.rejects(buildProfile({ github: 'octo-dev' }, deps(fake)), (err) => {
    assert.equal(err.code, 'rate_limited');
    assert.doesNotMatch(err.message, /API rate limit exceeded/, 'no upstream body in the message');
    return true;
  });
});

test('github: rate limit mid-scan returns a partial profile from what was fetched', async () => {
  const fake = fakeGithub({ rateLimitApiAfter: 2 }); // user + repos succeed, every tree is refused
  const p = await buildProfile({ github: 'octo-dev' }, deps(fake));
  assert.equal(p.repoCount, 3);
  assert.equal(p.languages.length, 3);
  // Topics and descriptions still count.
  assert.ok(tool(p, 'kubernetes') && tool(p, 'gitops') && tool(p, 'opentelemetry'));
  assert.ok(!tool(p, 'cert-manager') && !tool(p, 'helm'), 'no files were read');
  // After the first refusal it stops calling the API.
  const trees = fake.calls.filter((c) => c.url.includes('/git/trees/'));
  assert.ok(trees.length <= 4, `${trees.length} tree calls`);
  assert.equal(p.scan.partial, true);
  assert.equal(p.scan.scanned, 3);
  assert.equal(p.scan.starred, 0);
});

test('github: upstream errors are upstream without leaking the body', async () => {
  const fetch = async () => new Response('{"message":"boom","token":"ghp_x"}', { status: 500 });
  await assert.rejects(buildProfile({ github: 'octo-dev' }, { fetch, cache: new TtlCache() }), (err) => {
    assert.equal(err.code, 'upstream');
    assert.doesNotMatch(err.message, /boom|ghp_/);
    return true;
  });
  const timeout = async () => {
    throw new DOMException('timed out', 'TimeoutError');
  };
  await assert.rejects(buildProfile({ github: 'octo-dev' }, { fetch: timeout, cache: new TtlCache() }), {
    code: 'upstream',
  });
});

test('github: profiles are cached by lowercase username for 15 minutes', async () => {
  const fake = fakeGithub();
  const cache = new TtlCache();
  let now = Date.parse('2026-11-09T20:00:00Z');
  const d = { fetch: fake.fetch, cache, token: '', now: () => now };
  const a = await buildProfile({ github: 'octo-dev' }, d);
  const n = fake.calls.length;
  const b = await buildProfile({ github: 'OCTO-DEV' }, d);
  assert.equal(fake.calls.length, n, 'second call served from cache');
  assert.deepEqual(b, a);
  b.tools.length = 0; // callers can't corrupt the cache
  assert.ok((await buildProfile({ github: 'octo-dev' }, d)).tools.length > 0);
  now += 16 * 60 * 1000;
  await buildProfile({ github: 'octo-dev' }, d);
  assert.ok(fake.calls.length > n, 'expired entry refetched');
});

test('TtlCache evicts the oldest entry beyond its max size', () => {
  const c = new TtlCache({ max: 2 });
  c.set('a', 1, 0, 1000);
  c.set('b', 2, 0, 1000);
  c.set('c', 3, 0, 1000);
  assert.equal(c.get('a', 1), undefined);
  assert.equal(c.get('c', 1), 3);
  assert.equal(c.get('c', 2000), undefined);
});

// ------------------------------------------------------- github + interests

test('mergeInterests adds or boosts typed tools and languages, keywords first, without changing inputs', () => {
  const github = {
    source: 'github', username: 'octo', displayName: 'Octo', avatarUrl: null, repoCount: 2,
    languages: [{ name: 'Go', weight: 0.7 }, { name: 'Rust', weight: 0.3 }],
    tools: [
      { name: 'kubernetes', label: 'Kubernetes', weight: 1, evidence: ['octo/a'] },
      { name: 'argo-cd', label: 'Argo CD', weight: 0.4, evidence: ['octo/b'] },
    ],
    topics: ['gitops'],
    keywords: ['progressive delivery', 'chess'],
    generatedAt: '2026-11-09T21:00:00.000Z',
  };
  const typed = {
    source: 'interests', languages: [{ name: 'Rust', weight: 1 }, { name: 'Zig', weight: 1 }],
    tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 1, evidence: [] }, { name: 'opentelemetry', label: 'OpenTelemetry', weight: 1, evidence: [] }],
    topics: [], keywords: ['chess', 'sailing'],
  };
  const before = structuredClone(github);
  const m = mergeInterests(github, typed);
  assert.deepEqual(github, before, 'github profile unchanged');
  assert.equal(m.source, 'github+interests');
  assert.equal(m.username, 'octo');
  assert.deepEqual(m.tools.map((t) => [t.name, t.weight]), [['kubernetes', 1], ['argo-cd', 0.9], ['opentelemetry', 0.9]]);
  assert.deepEqual(m.tools.find((t) => t.name === 'argo-cd').evidence, ['octo/b'], 'boosted tool keeps its repos');
  assert.deepEqual(m.tools.find((t) => t.name === 'opentelemetry').evidence, []);
  assert.deepEqual(m.languages.map((l) => [l.name, l.weight]), [['Rust', 0.9], ['Zig', 0.9], ['Go', 0.7]]);
  assert.deepEqual(m.keywords, ['chess', 'sailing', 'progressive delivery']);
  assert.deepEqual(m.topics, ['gitops']);

  const many = mergeInterests(
    { ...github, tools: [], keywords: Array.from({ length: 15 }, (_, i) => `kw${i}`) },
    { ...typed, keywords: ['typed one'] },
  );
  assert.equal(many.keywords.length, 15);
  assert.equal(many.keywords[0], 'typed one');
});

test('github + interests: builds the GitHub profile and blends the interests in', async () => {
  const fake = fakeGithub();
  const p = await buildProfile({ github: 'octo-dev', interests: 'wasm, sailing' }, deps(fake));
  assert.equal(p.source, 'github+interests');
  assert.equal(p.username, 'octo-dev');
  assert.equal(p.repoCount, 3);
  const wasm = tool(p, 'wasm');
  assert.ok(wasm && wasm.weight >= 0.9, JSON.stringify(wasm));
  assert.equal(p.keywords[0], 'sailing');
  assert.ok(p.tools.length <= 15);
});

test('github + interests: ignores interests that contain no phrases', async () => {
  const fake = fakeGithub();
  const p = await buildProfile({ github: 'octo-dev', interests: ',;|' }, deps(fake));
  assert.equal(p.source, 'github');
  assert.equal(p.username, 'octo-dev');
  assert.equal(p.repoCount, 3);

  await assert.rejects(buildProfile({ interests: ',;|' }), { code: 'invalid_input' });
});

test('github + interests: a GitHub error is thrown for the caller to fall back on', async () => {
  const fake = fakeGithub({ rateLimitApiAfter: 0 });
  await assert.rejects(buildProfile({ github: 'octo-dev', interests: 'rust' }, deps(fake)), { code: 'rate_limited' });
  await assert.rejects(
    buildProfile({ github: 'octo-dev', interests: 'x'.repeat(501) }, deps(fakeGithub(), { fetch: () => assert.fail('no call') })),
    { code: 'invalid_input' },
  );
});
