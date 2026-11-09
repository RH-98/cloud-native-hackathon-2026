const metrics = require('./metrics');

const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const POLL_INTERVAL_MS = 60_000;

async function pollGithubRateLimit({ fetchImpl = globalThis.fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetchImpl(RATE_LIMIT_URL, { headers });
  metrics.recordGithubRateLimit(response.headers.get('x-ratelimit-remaining'));
}

function startGithubRateLimitPolling() {
  const poll = () => {
    pollGithubRateLimit().catch((error) => {
      console.warn('GitHub rate-limit polling failed:', error.message);
    });
  };

  poll();
  const timer = setInterval(poll, POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { pollGithubRateLimit, startGithubRateLimitPolling };
