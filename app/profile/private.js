// Signals from a signed-in user's PRIVATE repos, read through the read-only
// GitHub App with a short-lived user token (app/api/github-app.js).
//
// Privacy: what leaves this module is catalog tool labels and language
// names with weights, and a repo count. No repo names, paths, topics,
// README keywords, code or token. Evidence for these signals is shown as
// the literal "a private repo".
const { createClient, withSpan } = require('./github');
const { label } = require('./tools');
const { internal } = require('./index');

const MAX_REPOS = 8;
const MAX_CALLS = 40;
const CONCURRENCY = 4;
const MAX_TOOLS = 15;
const MAX_LANGUAGES = 6;
const PRIVATE_EVIDENCE = 'a private repo';

const isPrivate = (r) => Boolean(r && (r.private || (r.visibility && r.visibility !== 'public')));
const clip = (s, n) => String(s).slice(0, n);
const weight = (w) => (typeof w === 'number' && Number.isFinite(w) ? Math.max(0, Math.min(1, Math.round(w * 100) / 100)) : 0);

// The most recently pushed private repos with something in them. Public repos
// are already in the public profile.
function pickPrivateRepos(repos, max = MAX_REPOS) {
  return (Array.isArray(repos) ? repos : [])
    .filter((r) => isPrivate(r) && !r.fork && !r.archived && r.size !== 0 && typeof r.full_name === 'string' && r.full_name.includes('/'))
    .sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')))
    .slice(0, max);
}

// Keeps only labels and weights (also used on rows read back from the database).
function sanitizePrivateProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const tools = (Array.isArray(p.tools) ? p.tools : [])
    .filter((t) => t && typeof t.name === 'string')
    .slice(0, MAX_TOOLS)
    .map((t) => ({ name: clip(t.name, 60), label: clip(typeof t.label === 'string' ? t.label : label(t.name), 60), weight: weight(t.weight) }));
  const languages = (Array.isArray(p.languages) ? p.languages : [])
    .filter((l) => l && typeof l.name === 'string')
    .slice(0, MAX_LANGUAGES)
    .map((l) => ({ name: clip(l.name, 40), weight: weight(l.weight) }));
  const repoCount = Number.isSafeInteger(p.repoCount) && p.repoCount > 0 ? Math.min(p.repoCount, 100) : 0;
  return { tools, languages, repoCount };
}

// repos: from the user's GitHub App installations. token: the user's
// short-lived token; it lives only in this call's client and is never
// returned, logged or put on a span.
// deps (for tests): { fetch, maxCalls, concurrency, timeoutMs }
async function buildPrivateProfile({ login, repos, token }, deps = {}) {
  return withSpan('profile.build_private', {}, async (span) => {
    const picked = pickPrivateRepos(repos, deps.maxRepos || MAX_REPOS);
    span.setAttribute('github.private_repo_count', picked.length);
    if (!picked.length) return sanitizePrivateProfile({ repoCount: 0 });
    const maxCalls = deps.maxCalls || MAX_CALLS;
    const client = createClient({
      fetch: deps.fetch || globalThis.fetch,
      token,
      timeoutMs: deps.timeoutMs || 5000,
      maxCalls,
      contentsApi: true,
    });
    const filesPerRepo = Math.max(1, Math.min(5, Math.floor((maxCalls - picked.length) / picked.length)));
    const state = { stop: false };
    const scans = await internal.mapLimit(picked, deps.concurrency || CONCURRENCY, (repo) =>
      internal.scanRepo(client, repo, state, filesPerRepo),
    );
    // aggregate() also makes topics, keywords and evidence (repo names): drop them.
    const { tools, languages } = internal.aggregate({ login: login || '' }, picked, scans);
    span.setAttribute('github.calls', client.calls);
    span.setAttribute('profile.partial', state.stop);
    return sanitizePrivateProfile({ tools, languages, repoCount: picked.length });
  });
}

const byWeight = (a, b) => b.weight - a.weight || a.name.localeCompare(b.name);

// Blends stored private signals into a public profile (pure). Tools and
// languages are added or raised to the private weight; private evidence is
// "a private repo". profile.privateRepos is the number of private repos.
function mergePrivate(profile, stored) {
  const priv = sanitizePrivateProfile(stored);
  if (!profile || !priv || !priv.repoCount) return profile;
  const tools = (profile.tools || []).map((t) => ({ ...t, evidence: [...(t.evidence || [])] }));
  for (const t of priv.tools) {
    const hit = tools.find((x) => x.name === t.name);
    if (hit) {
      hit.weight = Math.max(hit.weight || 0, t.weight);
      if (!hit.evidence.includes(PRIVATE_EVIDENCE)) hit.evidence = [...hit.evidence.slice(0, 4), PRIVATE_EVIDENCE];
    } else {
      tools.push({ name: t.name, label: t.label, weight: t.weight, evidence: [PRIVATE_EVIDENCE] });
    }
  }
  const languages = (profile.languages || []).map((l) => ({ ...l }));
  for (const l of priv.languages) {
    const hit = languages.find((x) => x.name === l.name);
    if (hit) hit.weight = Math.max(hit.weight || 0, l.weight);
    else languages.push({ name: l.name, weight: l.weight });
  }
  return {
    ...profile,
    tools: tools.sort(byWeight).slice(0, MAX_TOOLS),
    languages: languages.sort(byWeight).slice(0, MAX_LANGUAGES),
    privateRepos: priv.repoCount,
  };
}

module.exports = { buildPrivateProfile, mergePrivate, pickPrivateRepos, sanitizePrivateProfile, PRIVATE_EVIDENCE };
