// STUB, to be replaced by the profile work (see docs/CONTRACTS.md).
// Returns a fixed profile so the API and UI can be built against the contract.

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code; // not_found | rate_limited | upstream | invalid_input
  }
}

async function buildProfile({ github, interests } = {}) {
  if (!github && !interests) {
    throw new ProfileError('invalid_input', 'Give a GitHub username or some interests');
  }
  const words = (interests || '')
    .split(/[,\n]/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return {
    source: github ? 'github' : 'interests',
    username: github || null,
    displayName: github || 'You',
    avatarUrl: null,
    repoCount: github ? 3 : 0,
    languages: github ? [{ name: 'Go', weight: 0.6 }, { name: 'TypeScript', weight: 0.4 }] : [],
    tools: github
      ? [
          { name: 'kubernetes', weight: 1, evidence: [`${github}/stub`] },
          { name: 'argo-cd', weight: 0.8, evidence: [`${github}/stub`] },
          { name: 'opentelemetry', weight: 0.6, evidence: [`${github}/stub`] },
        ]
      : words.map((name) => ({ name, weight: 1, evidence: [] })),
    topics: github ? ['kubernetes', 'gitops'] : [],
    keywords: words,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildProfile, ProfileError };
