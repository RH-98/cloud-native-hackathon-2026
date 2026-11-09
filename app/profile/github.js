// Minimal GitHub client for profiles: public data only, a timeout on every
// request, one OpenTelemetry span per call, and a hard cap on calls per
// profile. The token (optional) is only ever sent to api.github.com and never
// appears in errors, logs or span attributes.
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const metrics = require('../metrics');

const tracer = trace.getTracer('conference-profile');

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const USER_AGENT = 'conference-planner';
const MAX_TEXT = 200 * 1024;

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code; // not_found | rate_limited | upstream | invalid_input
  }
}

// Internal: the per-profile call budget ran out. Never leaves this module's caller.
class BudgetExhausted extends Error {}

function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// contentsApi: read files through the API (GET /repos/{o}/{r}/contents/{path},
// raw media type) with the token, never raw.githubusercontent.com. Used for
// private repos with a user's short-lived GitHub App token.
function createClient({ fetch = globalThis.fetch, token, timeoutMs = 5000, maxCalls = 40, contentsApi = false } = {}) {
  let calls = 0;

  async function request(span, url, { accept, auth }) {
    if (calls >= maxCalls) throw new BudgetExhausted('call budget exhausted');
    calls += 1;
    const headers = { 'User-Agent': USER_AGENT, Accept: accept };
    if (auth) {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProfileError('upstream', timedOut ? 'GitHub did not answer in time' : 'Could not reach GitHub');
    }
    span.setAttribute('http.response.status_code', res.status);
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) span.setAttribute('github.ratelimit.remaining', Number(remaining));
    // Only api.github.com counts against the API rate limit (raw file fetches don't).
    if (auth && remaining !== null) metrics.recordGithubRateLimit(remaining);
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      if (res.status === 429 || (res.status === 403 && (remaining === '0' || res.headers.has('retry-after')))) {
        throw new ProfileError('rate_limited', 'GitHub rate limit reached, try again later or type your interests');
      }
      if (res.status === 404) throw new ProfileError('not_found', 'Not found on GitHub');
      throw new ProfileError('upstream', `GitHub returned ${res.status}`);
    }
    return res;
  }

  const api = (span, path) => request(span, `${API}${path}`, { accept: 'application/vnd.github+json', auth: true });

  return {
    get calls() {
      return calls;
    },

    fetchUser(username) {
      return withSpan('github.fetch_user', {}, async (span) => {
        const res = await api(span, `/users/${encodeURIComponent(username)}`);
        return res.json();
      });
    },

    fetchRepos(username) {
      return withSpan('github.fetch_repos', {}, async (span) => {
        const res = await api(span, `/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=30&type=owner`);
        const repos = await res.json();
        span.setAttribute('github.repo_count', Array.isArray(repos) ? repos.length : 0);
        return Array.isArray(repos) ? repos : [];
      });
    },

    fetchTree(owner, repo, branch) {
      return withSpan('github.fetch_tree', {}, async (span) => {
        const res = await api(
          span,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        );
        const body = await res.json();
        const tree = Array.isArray(body.tree) ? body.tree : [];
        span.setAttribute('github.tree.entries', tree.length);
        span.setAttribute('github.tree.truncated', Boolean(body.truncated));
        return tree;
      });
    },

    // Raw file contents from raw.githubusercontent.com (public repos; does not
    // use the API rate limit). Returned to the caller for parsing only.
    fetchFile(owner, repo, branch, path) {
      const base = path.split('/').pop();
      const kind = /^readme/i.test(base) ? 'readme' : base.includes('.') ? base.slice(base.lastIndexOf('.')) : base;
      return withSpan('github.fetch_file', { 'github.file.kind': kind }, async (span) => {
        const res = contentsApi
          ? await request(span, `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
            { accept: 'application/vnd.github.raw', auth: true })
          : await request(span, `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodePath(path)}`,
            { accept: 'text/plain', auth: false });
        const text = await res.text();
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
      });
    },
  };
}

module.exports = { createClient, ProfileError, BudgetExhausted, withSpan };
