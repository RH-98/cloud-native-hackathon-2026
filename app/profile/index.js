// Builds a Profile (docs/CONTRACTS.md) from a GitHub user's public repos, or
// from typed interests. Only derived signals are kept: languages, topics,
// tool names, short keywords. Never code, file contents or the token.
const { createClient, ProfileError, BudgetExhausted, withSpan } = require('./github');
const { detectEvidence, detectInterest, matchInterests, label } = require('./tools');
const { pickFiles, findReadme, parseFile, extractKeywords, readmeHeadings, stripMarkdown } = require('./signals');
const { ToolScores, blendLanguages, recencyDecay, dedupeKeywords } = require('./score');
const { languageOf } = require('./languages');
const { parseLinkedIn, looksLikeLinkedIn, MAX_PASTE } = require('./linkedin');

const MAX_REPOS = 8;
const MAX_CALLS = 60; // every request, raw files included
// API calls per profile: user, repos, starred, events, a tree and the
// languages of each scanned repo, and up to 5 contributed-to repos.
const MAX_API_CALLS = 25;
const MAX_API_CALLS_ANON = 15;
const MAX_FORKS = 10;
const FORK_DAYS = 2 * 365;
const MAX_STARRED = 50;
const CONTRIBUTION_DAYS = 90;
const MAX_CONTRIBUTIONS = 5;
const MAX_CONTRIBUTIONS_ANON = 2;
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

// ------------------------------------------------------------ interests

// Long text, or text with LinkedIn's section headers and counters, is a
// pasted profile; a short list is typed interests.
function isPastedProfile(interests) {
  return typeof interests === 'string' && (interests.length > MAX_INTERESTS || looksLikeLinkedIn(interests));
}

// A pasted LinkedIn profile: only the derived signals are kept, never the text.
function fromPastedProfile(text, now) {
  if (text.length > MAX_PASTE) {
    throw new ProfileError('invalid_input', `Keep pasted profiles under ${MAX_PASTE.toLocaleString('en-US')} characters`);
  }
  const { tools, languages, topics, keywords } = parseLinkedIn(text);
  if (!tools.length && !languages.length && !topics.length && !keywords.length) {
    throw new ProfileError('invalid_input', 'We could not find any skills or topics in that text. Try the headline, About and Skills sections.');
  }
  return {
    source: 'interests',
    pastedFrom: 'linkedin',
    username: null,
    displayName: 'You',
    avatarUrl: null,
    repoCount: 0,
    languages,
    tools: tools.map((t) => ({ name: t.name, label: label(t.name), weight: t.weight, evidence: [] })),
    topics,
    keywords,
    generatedAt: new Date(now).toISOString(),
  };
}

function fromInterests(interests, now) {
  if (typeof interests !== 'string') throw new ProfileError('invalid_input', 'Interests must be text');
  if (isPastedProfile(interests)) return fromPastedProfile(interests, now);
  const { tools, rest } = matchInterests(interests);
  if (!tools.length && !rest.length) throw new ProfileError('invalid_input', 'Give a GitHub username or some interests');
  const languages = [];
  for (const phrase of rest) {
    const lang = languageOf(phrase);
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

// Typed entries have weight 1; pasted-profile entries carry their own (prose
// mentions count less than listed skills), scaled the same way.
const typedWeight = (t) => Math.round(TYPED_WEIGHT * (Number.isFinite(t.weight) ? t.weight : 1) * 100) / 100;

function boost(list, typed, makeEntry) {
  const out = (list || []).map((x) => ({ ...x }));
  for (const t of typed || []) {
    const hit = out.find((x) => x.name === t.name);
    if (hit) {
      hit.weight = Math.max(hit.weight || 0, typedWeight(t));
      // The user said so (typed, or a listed LinkedIn skill; not a prose mention).
      if (hit.strength && !(t.weight < 1)) hit.strength = 'strong';
    } else {
      out.push(makeEntry(t));
    }
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
    // The paste's own topics (job titles), so the browser can save them without GitHub's.
    ...(interestsProfile.pastedFrom
      ? { pastedFrom: interestsProfile.pastedFrom, pastedTopics: [...(interestsProfile.topics || [])] }
      : {}),
    languages: boost(profile.languages, interestsProfile.languages, (l) => ({ name: l.name, weight: typedWeight(l) }))
      .slice(0, MAX_LANGUAGES),
    tools: boost(profile.tools, interestsProfile.tools, (t) => ({
      name: t.name,
      label: t.label || label(t.name),
      weight: typedWeight(t),
      evidence: [],
    })).slice(0, MAX_TOOLS),
    topics: [...new Set([...(interestsProfile.topics || []), ...(profile.topics || [])])].slice(0, 20),
    keywords: [...new Set([...(interestsProfile.keywords || []), ...(profile.keywords || [])])].slice(0, MAX_KEYWORDS),
  };
}

// --------------------------------------------------------------- github

// Runs one optional fetch: any failure gives null (one repo's missing file
// never fails the profile), and a rate limit or an empty budget stops every
// later fetch, leaving a partial profile from what was already read.
function guarded(state) {
  return async (fn) => {
    if (state.stop) return null;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProfileError && err.code === 'rate_limited') state.stop = true;
      else if (err instanceof BudgetExhausted) state.stop = true;
      return null;
    }
  };
}

async function scanRepo(client, repo, guard, filesPerRepo) {
  const [owner, name] = repo.full_name.split('/');
  const branch = repo.default_branch || 'main';
  const result = { paths: [], deps: [], manifests: [], images: [], readme: '' };

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

// A repo many people starred is what the person is known for, however long
// ago they last pushed to it (kelseyhightower/kubernetes-the-hard-way):
// recency never takes its weight below this. 0 under 10 stars, 0.8 at 10k+.
function popularityFloor(repo) {
  const stars = Number(repo && repo.stargazers_count) || 0;
  if (stars < 10) return 0;
  return Math.min(0.8, 0.2 * (Math.log10(stars) - 1) + 0.2);
}

// Own repos to scan: half the budget for the most recently pushed (what they
// work on now), the rest for the most starred (what they are known for).
function pickRepos(candidates, max) {
  const byPushed = [...candidates].sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
  const recent = byPushed.slice(0, Math.ceil(max / 2));
  const taken = new Set(recent.map((r) => r.full_name));
  const popular = [...candidates]
    .filter((r) => !taken.has(r.full_name) && (Number(r.stargazers_count) || 0) >= 10)
    .sort((a, b) => (Number(b.stargazers_count) || 0) - (Number(a.stargazers_count) || 0))
    .slice(0, max - recent.length);
  const picked = [...recent, ...popular];
  // Fill any space left (few starred repos) with the next most recent.
  for (const r of byPushed) {
    if (picked.length >= max) break;
    if (!picked.includes(r)) picked.push(r);
  }
  return picked;
}

const lowerTopics = (repo) => (repo.topics || []).map((t) => String(t).toLowerCase());
const asWords = (topics) => topics.map((t) => t.replace(/-/g, ' ')).join('\n');

// Everything fetched -> { tools, languages, topics, keywords }. Pure.
// input: { user, repos, scans, languageBytes, forks, starred, contributions, now }
//   contributions: [{ repo, count, last }] (repo may be a stub with just a name)
function aggregate({ user, repos, scans, languageBytes = [], forks = [], starred = [], contributions = [], now, maxTools }) {
  const scores = new ToolScores();
  const langEntries = [];
  const topicCounts = new Map();
  const docs = [];

  repos.forEach((repo, i) => {
    const recency = Math.max(recencyDecay(repo.pushed_at, now), popularityFloor(repo));
    const scan = scans[i];
    const topics = lowerTopics(repo);
    topics.forEach((t) => topicCounts.set(t, (topicCounts.get(t) || 0) + 1));
    langEntries.push({ bytes: languageBytes[i], primary: repo.language, recency });

    const text = `${repo.description || ''}\n${stripMarkdown(scan.readme)}`;
    scores.add(repo.full_name, detectEvidence({ ...scan, topics, text }), recency);
    if (topics.length) docs.push({ text: asWords(topics), weight: 3, kind: 'topic' });
    if (repo.description) docs.push({ text: repo.description, weight: 2, kind: 'description' });
    if (scan.readme) {
      docs.push({ text: readmeHeadings(scan.readme), weight: 1.5, kind: 'heading' });
      docs.push({ text: scan.readme, weight: 1, kind: 'readme', repo: repo.full_name });
    }
    scan.readme = ''; // README text is only used for derived signals; drop it.
  });

  for (const fork of forks) {
    scores.add(fork.full_name, detectInterest(fork, 'fork'), recencyDecay(fork.pushed_at, now));
    docs.push({ text: [fork.description || '', asWords(lowerTopics(fork))].join('\n'), weight: 0.5, kind: 'weak' });
  }
  // Starred repos come most recently starred first.
  starred.forEach((repo, i) => {
    if (repo && repo.full_name && !repo.private) scores.add(repo.full_name, detectInterest(repo, 'starred'), 0.5 ** (i / 25));
  });
  for (const { repo, count, last } of contributions) {
    const found = detectInterest(repo, 'contribution');
    for (const kinds of found.values()) kinds.set('contribution', count);
    const recency = recencyDecay(last, now);
    scores.add(repo.full_name, found, recency);
    if (repo.language) langEntries.push({ bytes: null, primary: repo.language, recency, weight: 0.3 });
    for (const t of lowerTopics(repo)) if (!topicCounts.has(t)) topicCounts.set(t, 0.5);
    docs.push({ text: [repo.description || '', asWords(lowerTopics(repo))].join('\n'), weight: 1, kind: 'weak' });
  }

  const tools = scores.rank({ max: maxTools || MAX_TOOLS, maxEvidence: MAX_EVIDENCE });
  const languages = blendLanguages(langEntries);
  const topics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([t]) => t);

  const exclude = [user.login, ...repos.map((r) => r.name), ...forks.map((r) => r.name)].map((s) =>
    String(s).toLowerCase(),
  );
  const keywords = dedupeKeywords(extractKeywords(docs, { max: 14, exclude }), tools, languages).slice(0, 10);

  return { tools, languages, topics, keywords };
}

const CONTRIBUTION_EVENTS = {
  PushEvent: () => true,
  PullRequestEvent: (p) => p && p.action === 'opened',
  IssuesEvent: (p) => p && p.action === 'opened',
};

// Public events -> other people's repos the user pushed to or opened a PR or
// issue in, in the last 90 days, most active first.
function contributedRepos(events, login, now, max) {
  const since = now - CONTRIBUTION_DAYS * 24 * 60 * 60 * 1000;
  const me = String(login).toLowerCase();
  const byRepo = new Map();
  for (const ev of events || []) {
    const name = ev && ev.repo && ev.repo.name;
    const ok = ev && Object.hasOwn(CONTRIBUTION_EVENTS, ev.type) && CONTRIBUTION_EVENTS[ev.type](ev.payload);
    if (!ok || typeof name !== 'string' || !name.includes('/') || ev.public === false) continue;
    if (name.split('/')[0].toLowerCase() === me) continue;
    const at = Date.parse(ev.created_at);
    if (!Number.isFinite(at) || at < since) continue;
    const c = byRepo.get(name) || { name, count: 0, last: ev.created_at };
    c.count += 1;
    if (at > Date.parse(c.last)) c.last = ev.created_at;
    byRepo.set(name, c);
  }
  return [...byRepo.values()]
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last) || a.name.localeCompare(b.name))
    .slice(0, max);
}

async function fromGithub(username, deps, span) {
  const now = deps.now ? deps.now() : Date.now();
  const cache = deps.cache || defaultCache;
  const key = username.toLowerCase();
  const cached = cache.get(key, now);
  span.setAttribute('profile.cache_hit', Boolean(cached));
  if (cached) return structuredClone(cached);

  const maxCalls = deps.maxCalls || MAX_CALLS;
  const token = deps.token !== undefined ? deps.token : process.env.GITHUB_TOKEN;
  // Without a token GitHub allows 60 API calls an hour, so spend fewer.
  const maxApiCalls = deps.maxApiCalls || (token ? MAX_API_CALLS : MAX_API_CALLS_ANON);
  const client = createClient({
    fetch: deps.fetch || globalThis.fetch,
    token,
    timeoutMs: deps.timeoutMs || 5000,
    maxCalls,
    maxApiCalls,
  });

  const state = { stop: false };
  const guard = guarded(state);

  // The user, repos, starred and events calls only need the username, so
  // they run at once (found by Dash0 Agent0: run one after another they made
  // a first plan take 2-6 s). User and repos are required: their errors are
  // thrown, the user's first. Starred and events are optional (guarded): a
  // rate limit there gives a partial profile.
  const settled = await Promise.allSettled([
    client.fetchUser(username),
    client.fetchRepos(username),
    guard(() => client.fetchStarred(username, MAX_STARRED)),
    guard(() => client.fetchEvents(username)),
  ]);
  const [user, all, starredRaw, events] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    if (i === 0 && r.reason instanceof ProfileError && r.reason.code === 'not_found') {
      throw new ProfileError('not_found', `No GitHub user named ${username}`);
    }
    throw r.reason;
  });
  const login = user.login || username;
  const byPushed = (a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || ''));
  const mine = all.filter((r) => r && !r.private && typeof r.full_name === 'string');
  const repos = pickRepos(
    mine.filter((r) => !r.fork && !r.archived && r.size !== 0),
    deps.maxRepos || MAX_REPOS,
  );
  const forkSince = now - FORK_DAYS * 24 * 60 * 60 * 1000;
  const forks = mine
    .filter((r) => r.fork && Date.parse(r.pushed_at) >= forkSince)
    .sort(byPushed)
    .slice(0, MAX_FORKS);

  const starred = (starredRaw || []).filter((r) => r && typeof r.full_name === 'string' && !r.private);

  // Raw files don't count against the API rate limit; share that budget.
  const n = repos.length || 1;
  const filesPerRepo = Math.max(1, Math.min(5, Math.floor((maxCalls - maxApiCalls) / n)));

  const contributed = contributedRepos(events, login, now, token ? MAX_CONTRIBUTIONS : MAX_CONTRIBUTIONS_ANON);
  const extra = [
    ...contributed.map((c) => ({ type: 'repo', c })),
    ...repos.map((repo, i) => ({ type: 'languages', repo, i })),
  ];
  const languageBytes = new Array(repos.length).fill(null);
  const contributions = contributed.map((c) => ({
    repo: { full_name: c.name, name: c.name.split('/')[1], topics: [] },
    count: c.count,
    last: c.last,
  }));
  // One tree per repo comes first in the budget; plan the optional calls
  // against what is left after those, so a planned limit never trips
  // BudgetExhausted and marks the profile partial. The trees and the
  // optional calls then run side by side.
  const planned = extra.slice(0, Math.max(0, client.apiCallsLeft - repos.length));
  const scansDone = mapLimit(repos, deps.concurrency || CONCURRENCY, (repo) =>
    scanRepo(client, repo, guard, filesPerRepo),
  );
  const extrasDone = mapLimit(planned, deps.concurrency || CONCURRENCY, async (job) => {
    if (job.type === 'languages') {
      const [owner, name] = job.repo.full_name.split('/');
      languageBytes[job.i] = await guard(() => client.fetchLanguages(owner, name));
    } else {
      const [owner, name] = job.c.name.split('/');
      const repo = await guard(() => client.fetchRepo(owner, name));
      const slot = contributions.find((x) => x.repo.full_name === job.c.name);
      if (repo && !repo.private && typeof repo.full_name === 'string') slot.repo = repo;
    }
  });
  const [scans] = await Promise.all([scansDone, extrasDone]);

  const { tools, languages, topics, keywords } = aggregate({
    user, repos, scans, languageBytes, forks, starred, contributions, now, maxTools: deps.maxTools,
  });
  const scan = {
    publicRepos: Number.isFinite(user.public_repos) ? user.public_repos : mine.length,
    scanned: repos.length,
    forks: mine.filter((r) => r.fork).length,
    empty: mine.filter((r) => !r.fork && r.size === 0).length,
    archived: mine.filter((r) => !r.fork && r.archived && r.size !== 0).length,
    starred: starred.length,
    contributions: contributions.length,
    partial: state.stop,
  };
  const profile = {
    source: 'github',
    username: login,
    displayName: user.name || login,
    avatarUrl: user.avatar_url || null,
    repoCount: repos.length,
    languages,
    tools,
    topics,
    keywords,
    scan,
    generatedAt: new Date(now).toISOString(),
  };
  span.setAttribute('github.repo_count', repos.length);
  span.setAttribute('github.calls', client.calls);
  span.setAttribute('github.api_calls', client.apiCalls);
  span.setAttribute('github.starred_count', starred.length);
  span.setAttribute('github.contribution_count', contributions.length);
  span.setAttribute('profile.partial', state.stop);
  cache.set(key, profile, now, state.stop ? PARTIAL_TTL_MS : TTL_MS);
  return structuredClone(profile);
}

// --------------------------------------------------------------- public

// buildProfile({ github?, interests? }, deps?): at least one of the two.
// With both, the GitHub profile is built and the interests are blended in
// (mergeInterests). GitHub errors are thrown as usual; the caller decides
// whether to fall back to the interests alone.
// deps (for tests): { fetch, now, cache, token, maxRepos, maxTools, maxCalls, maxApiCalls, concurrency, timeoutMs }
async function buildProfile({ github, interests } = {}, deps = {}) {
  const hasGithub = typeof github === 'string' ? github.trim() !== '' : github != null;
  const hasInterests = interests != null && interests !== '';
  const source = hasGithub ? (hasInterests ? 'github+interests' : 'github') : 'interests';
  return withSpan('profile.build', { 'profile.source': source }, async (span) => {
    let profile;
    if (hasGithub) {
      const username = normalizeUsername(github);
      // Check the typed text before spending GitHub calls on it.
      const typedMatches = typeof interests === 'string' && !isPastedProfile(interests)
        ? matchInterests(interests)
        : null;
      const typed = hasInterests && (!typedMatches || typedMatches.tools.length + typedMatches.rest.length > 0)
        ? fromInterests(interests, deps.now ? deps.now() : Date.now())
        : null;
      profile = await fromGithub(username, deps, span);
      if (typed) profile = mergeInterests(profile, typed);
    } else if (hasInterests) {
      profile = fromInterests(interests, deps.now ? deps.now() : Date.now());
    } else {
      throw new ProfileError('invalid_input', 'Give a GitHub username or some interests');
    }
    span.setAttribute('profile.tools_found', profile.tools.length);
    // Which input kind only; the pasted text itself never goes on a span.
    if (profile.pastedFrom) span.setAttribute('profile.pasted_from', profile.pastedFrom);
    return profile;
  });
}

module.exports = { buildProfile, mergeInterests, isPastedProfile, ProfileError, TtlCache, clearCache: () => defaultCache.clear() };
// For app/profile/private.js: the same scan and aggregation over repos it picks.
module.exports.internal = { scanRepo, aggregate, mapLimit, guarded, pickRepos, popularityFloor };
