// Builds a Profile (docs/CONTRACTS.md) from a GitHub user's public repos, or
// from typed interests. Only derived signals are kept: languages, topics,
// tool names, short keywords. Never code, file contents or the token.
const { createClient, ProfileError, BudgetExhausted, withSpan } = require('./github');
const { detectTools, matchInterests, label, damping } = require('./tools');
const { pickFiles, findReadme, parseFile, extractKeywords } = require('./signals');

const MAX_REPOS = 8;
const MAX_CALLS = 40;
const CONCURRENCY = 4;
const MAX_TOOLS = 15;
const MAX_EVIDENCE = 5;
const MAX_INTERESTS = 500;
const TTL_MS = 15 * 60 * 1000;
const PARTIAL_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 200;
const NOISE_DIR = /(^|\/)(node_modules|vendor|third_party)\//;

// --------------------------------------------------------------- cache

class TtlCache {
  constructor({ max = CACHE_MAX } = {}) {
    this.max = max;
    this.map = new Map();
  }

  get(key, now) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, now, ttl) {
    this.map.delete(key);
    this.map.set(key, { value, expires: now + ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  clear() {
    this.map.clear();
  }
}

const defaultCache = new TtlCache();

// --------------------------------------------------------------- helpers

const round2 = (n) => Math.round(n * 100) / 100;

function normalizeUsername(input) {
  if (typeof input !== 'string') throw new ProfileError('invalid_input', 'The GitHub username must be text');
  let u = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(u);
  if (url) u = url[1];
  u = u.replace(/^@/, '');
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(u)) {
    throw new ProfileError('invalid_input', 'That does not look like a GitHub username');
  }
  return u;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const LANGUAGES = {
  go: 'Go', golang: 'Go', rust: 'Rust', python: 'Python', py: 'Python', java: 'Java', typescript: 'TypeScript',
  ts: 'TypeScript', javascript: 'JavaScript', js: 'JavaScript', node: 'JavaScript', nodejs: 'JavaScript', c: 'C',
  'c++': 'C++', cpp: 'C++', 'c#': 'C#', csharp: 'C#', dotnet: 'C#', ruby: 'Ruby', kotlin: 'Kotlin', swift: 'Swift',
  scala: 'Scala', elixir: 'Elixir', haskell: 'Haskell', php: 'PHP', shell: 'Shell', bash: 'Shell', zig: 'Zig',
  lua: 'Lua', dart: 'Dart', clojure: 'Clojure', ocaml: 'OCaml', erlang: 'Erlang', julia: 'Julia',
};

// ------------------------------------------------------------ interests

function fromInterests(interests, now) {
  if (typeof interests !== 'string') throw new ProfileError('invalid_input', 'Interests must be text');
  if (interests.length > MAX_INTERESTS) {
    throw new ProfileError('invalid_input', `Keep interests under ${MAX_INTERESTS} characters`);
  }
  const { tools, rest } = matchInterests(interests);
  if (!tools.length && !rest.length) throw new ProfileError('invalid_input', 'Give a GitHub username or some interests');
  const languages = [];
  for (const phrase of rest) {
    const lang = Object.hasOwn(LANGUAGES, phrase) ? LANGUAGES[phrase] : undefined;
    if (lang && !languages.some((l) => l.name === lang)) languages.push({ name: lang, weight: 1 });
  }
  return {
    source: 'interests',
    username: null,
    displayName: 'You',
    avatarUrl: null,
    repoCount: 0,
    languages,
    tools: tools.map((name) => ({ name, label: label(name), weight: 1, evidence: [] })),
    topics: [],
    keywords: [...new Set(rest)].slice(0, 15),
    generatedAt: new Date(now).toISOString(),
  };
}

// ------------------------------------------------------- github + interests

// What the user typed is a strong, deliberate signal: matched tools and
// languages get at least this weight next to what their repos show.
const TYPED_WEIGHT = 0.9;
const MAX_KEYWORDS = 15;
const MAX_LANGUAGES = 6;

const byWeight = (a, b) => b.weight - a.weight || a.name.localeCompare(b.name);

function boost(list, typed, makeEntry) {
  const out = (list || []).map((x) => ({ ...x }));
  for (const t of typed || []) {
    const hit = out.find((x) => x.name === t.name);
    if (hit) hit.weight = Math.max(hit.weight || 0, TYPED_WEIGHT);
    else out.push(makeEntry(t));
  }
  return out.sort(byWeight);
}

// Blends an interests profile into a GitHub profile (pure: neither input is
// changed). Typed tools and languages are added, or boosted to TYPED_WEIGHT;
// typed tools carry no repo evidence. Unmatched phrases go first in keywords
// so they survive the cap.
function mergeInterests(profile, interestsProfile) {
  if (!interestsProfile) return { ...profile };
  return {
    ...profile,
    source: 'github+interests',
    languages: boost(profile.languages, interestsProfile.languages, (l) => ({ name: l.name, weight: TYPED_WEIGHT }))
      .slice(0, MAX_LANGUAGES),
    tools: boost(profile.tools, interestsProfile.tools, (t) => ({
      name: t.name,
      label: t.label || label(t.name),
      weight: TYPED_WEIGHT,
      evidence: [],
    })).slice(0, MAX_TOOLS),
    topics: [...(profile.topics || [])],
    keywords: [...new Set([...(interestsProfile.keywords || []), ...(profile.keywords || [])])].slice(0, MAX_KEYWORDS),
  };
}

// --------------------------------------------------------------- github

async function scanRepo(client, repo, state, filesPerRepo) {
  const [owner, name] = repo.full_name.split('/');
  const branch = repo.default_branch || 'main';
  const result = { paths: [], deps: [], manifests: [], images: [], readme: '' };
  const guard = async (fn) => {
    if (state.stop) return null;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProfileError && err.code === 'rate_limited') state.stop = true;
      else if (err instanceof BudgetExhausted) state.stop = true;
      return null; // one repo's missing file never fails the profile
    }
  };

  const tree = await guard(() => client.fetchTree(owner, name, branch));
  if (!tree) return result;
  result.paths = tree.filter((e) => e.type === 'blob' && !NOISE_DIR.test(e.path)).map((e) => e.path);
  const readmePath = findReadme(tree);
  const files = pickFiles(tree, Math.max(0, filesPerRepo - (readmePath ? 1 : 0)));
  const fetches = files.map(async (path) => {
    const text = await guard(() => client.fetchFile(owner, name, branch, path));
    if (text == null) return;
    const parsed = parseFile(path, text);
    result.deps.push(...parsed.deps);
    result.manifests.push(...parsed.manifests);
    result.images.push(...parsed.images);
  });
  if (readmePath) {
    fetches.push(
      guard(() => client.fetchFile(owner, name, branch, readmePath)).then((text) => {
        result.readme = text ? text.slice(0, 20000) : '';
      }),
    );
  }
  await Promise.all(fetches);
  return result;
}

function aggregate(user, repos, scans) {
  const toolScores = new Map();
  const langScores = new Map();
  const topicCounts = new Map();
  const docs = [];

  repos.forEach((repo, i) => {
    const recency = 1 - i * 0.05;
    const scan = scans[i];
    const topics = (repo.topics || []).map((t) => String(t).toLowerCase());
    topics.forEach((t) => topicCounts.set(t, (topicCounts.get(t) || 0) + 1));
    if (repo.language) langScores.set(repo.language, (langScores.get(repo.language) || 0) + recency);

    const text = `${repo.description || ''}\n${scan.readme}`.toLowerCase();
    const found = detectTools({ ...scan, topics, text });
    for (const [tool, strength] of found) {
      const entry = toolScores.get(tool) || { score: 0, evidence: [] };
      entry.score += strength * recency * damping(tool);
      entry.evidence.push({ repo: repo.full_name, strength });
      toolScores.set(tool, entry);
    }
    docs.push({ text: [repo.description || '', ...topics.map((t) => t.replace(/-/g, ' '))].join('\n'), weight: 3 });
    if (scan.readme) docs.push({ text: scan.readme, weight: 1 });
    scan.readme = ''; // README text is only used for derived signals; drop it.
  });

  const maxScore = Math.max(0, ...[...toolScores.values()].map((e) => e.score));
  const tools = [...toolScores.entries()]
    .map(([name, e]) => ({
      name,
      label: label(name),
      weight: round2(e.score / maxScore),
      evidence: e.evidence
        .sort((a, b) => b.strength - a.strength)
        .slice(0, MAX_EVIDENCE)
        .map((x) => x.repo),
    }))
    .filter((t) => t.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, MAX_TOOLS);

  const langTotal = [...langScores.values()].reduce((a, b) => a + b, 0);
  const languages = [...langScores.entries()]
    .map(([name, s]) => ({ name, weight: round2(s / langTotal) }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, 6);

  const topics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([t]) => t);

  const exclude = [user.login, ...repos.map((r) => r.name)].map((s) => String(s).toLowerCase());
  const keywords = extractKeywords(docs, { max: 10, exclude });

  return { tools, languages, topics, keywords };
}

async function fromGithub(username, deps, span) {
  const now = deps.now ? deps.now() : Date.now();
  const cache = deps.cache || defaultCache;
  const key = username.toLowerCase();
  const cached = cache.get(key, now);
  span.setAttribute('profile.cache_hit', Boolean(cached));
  if (cached) return structuredClone(cached);

  const maxCalls = deps.maxCalls || MAX_CALLS;
  const client = createClient({
    fetch: deps.fetch || globalThis.fetch,
    token: deps.token !== undefined ? deps.token : process.env.GITHUB_TOKEN,
    timeoutMs: deps.timeoutMs || 5000,
    maxCalls,
  });

  let user;
  try {
    user = await client.fetchUser(username);
  } catch (err) {
    if (err instanceof ProfileError && err.code === 'not_found') {
      throw new ProfileError('not_found', `No GitHub user named ${username}`);
    }
    throw err;
  }
  const all = await client.fetchRepos(username);
  const repos = all
    .filter((r) => r && !r.fork && !r.archived && !r.private && r.size !== 0 && r.full_name)
    .sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')))
    .slice(0, deps.maxRepos || MAX_REPOS);

  // Share what's left of the call budget fairly: one tree per repo, then
  // README + files from what remains (at most 5 per repo).
  const n = repos.length || 1;
  const filesPerRepo = Math.max(1, Math.min(5, Math.floor((maxCalls - client.calls - repos.length) / n)));
  const state = { stop: false };
  const scans = await mapLimit(repos, deps.concurrency || CONCURRENCY, (repo) =>
    scanRepo(client, repo, state, filesPerRepo),
  );

  const { tools, languages, topics, keywords } = aggregate(user, repos, scans);
  const profile = {
    source: 'github',
    username: user.login || username,
    displayName: user.name || user.login || username,
    avatarUrl: user.avatar_url || null,
    repoCount: repos.length,
    languages,
    tools,
    topics,
    keywords,
    generatedAt: new Date(now).toISOString(),
  };
  span.setAttribute('github.repo_count', repos.length);
  span.setAttribute('github.calls', client.calls);
  span.setAttribute('profile.partial', state.stop);
  cache.set(key, profile, now, state.stop ? PARTIAL_TTL_MS : TTL_MS);
  return structuredClone(profile);
}

// --------------------------------------------------------------- public

// buildProfile({ github?, interests? }, deps?): at least one of the two.
// With both, the GitHub profile is built and the interests are blended in
// (mergeInterests). GitHub errors are thrown as usual; the caller decides
// whether to fall back to the interests alone.
// deps (for tests): { fetch, now, cache, token, maxRepos, maxCalls, concurrency, timeoutMs }
async function buildProfile({ github, interests } = {}, deps = {}) {
  const hasGithub = typeof github === 'string' ? github.trim() !== '' : github != null;
  const hasInterests = interests != null && interests !== '';
  const source = hasGithub ? (hasInterests ? 'github+interests' : 'github') : 'interests';
  return withSpan('profile.build', { 'profile.source': source }, async (span) => {
    let profile;
    if (hasGithub) {
      const username = normalizeUsername(github);
      // Check the typed text before spending GitHub calls on it.
      const typed = hasInterests ? fromInterests(interests, deps.now ? deps.now() : Date.now()) : null;
      profile = await fromGithub(username, deps, span);
      if (typed) profile = mergeInterests(profile, typed);
    } else if (hasInterests) {
      profile = fromInterests(interests, deps.now ? deps.now() : Date.now());
    } else {
      throw new ProfileError('invalid_input', 'Give a GitHub username or some interests');
    }
    span.setAttribute('profile.tools_found', profile.tools.length);
    return profile;
  });
}

module.exports = { buildProfile, mergeInterests, ProfileError, TtlCache, clearCache: () => defaultCache.clear() };
