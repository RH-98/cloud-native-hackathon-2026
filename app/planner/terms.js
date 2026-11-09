// Turns a profile into weighted search terms, and scores / explains how a
// session or sponsor matches them. Pure functions, shared by the Elasticsearch
// search (to explain and blend its hits) and the offline snapshot search.

// Terms that match almost every KubeCon session: they still count, but little.
const GENERIC = new Set(['kubernetes', 'k8s', 'cloud native', 'containers', 'container', 'devops', 'cncf', 'docker compose']);

// Languages whose names are ordinary words or too short to match safely.
const LANGUAGE_STOPLIST = new Set(['go', 'c', 'shell', 'makefile', 'dockerfile', 'html', 'css', 'hcl', 'jsonnet', 'smarty']);

// A few spellings people actually use for the same tool.
const ALIASES = {
  kubernetes: ['k8s'],
  opentelemetry: ['otel'],
  'argo cd': ['argocd'],
  'argo rollouts': ['argo rollout'],
  postgresql: ['postgres'],
  postgres: ['postgresql'],
  'cloudnative pg': ['cloudnativepg', 'cnpg'],
  webassembly: ['wasm'],
  ebpf: ['bpf'],
};

const KIND_WEIGHT = { tool: 1, topic: 0.6, keyword: 0.5, language: 0.4 };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantsOf(key) {
  return [key, ...(ALIASES[key] || [])];
}

function matcherFor(key) {
  const alternatives = variantsOf(key).map(escapeRegExp).join('|');
  return new RegExp(`(^|[^a-z0-9])(${alternatives})(?=$|[^a-z0-9])`);
}

// Profile -> [{ key, label, weight, kind, variants, re }], strongest first.
function profileTerms(profile = {}) {
  const byKey = new Map();
  const add = (raw, label, weight, kind) => {
    const key = normalize(raw);
    if (!key || key.length < 2) return;
    let w = (Number.isFinite(weight) ? weight : 1) * KIND_WEIGHT[kind];
    if (GENERIC.has(key)) w *= 0.15;
    const existing = byKey.get(key);
    if (existing && existing.weight >= w) return;
    byKey.set(key, {
      key,
      label: label || key,
      weight: w,
      kind,
      generic: GENERIC.has(key),
      variants: variantsOf(key),
      re: matcherFor(key),
    });
  };
  for (const t of profile.tools || []) {
    add(t.label || t.name, t.label || String(t.name || '').replace(/-/g, ' '), t.weight, 'tool');
  }
  for (const topic of profile.topics || []) add(topic, String(topic).replace(/-/g, ' '), 1, 'topic');
  for (const kw of profile.keywords || []) add(kw, kw, 1, 'keyword');
  for (const lang of profile.languages || []) {
    if (!LANGUAGE_STOPLIST.has(normalize(lang.name))) add(lang.name, lang.name, lang.weight, 'language');
  }
  return [...byKey.values()].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key)).slice(0, 30);
}

// A natural-language description of the profile, for the semantic query.
function semanticQueryText(profile = {}, terms = profileTerms(profile)) {
  const tools = terms.filter((t) => t.kind === 'tool').slice(0, 8).map((t) => t.label);
  const themes = terms.filter((t) => t.kind === 'topic' || t.kind === 'keyword').slice(0, 8).map((t) => t.label);
  const langs = (profile.languages || []).slice(0, 3).map((l) => l.name).filter(Boolean);
  const parts = [];
  if (tools.length) parts.push(`Talks about ${joinList(tools)}`);
  if (themes.length) parts.push(`${parts.length ? 'covering' : 'Talks covering'} ${joinList(themes)}`);
  if (langs.length) parts.push(`for an engineer who works in ${joinList(langs)}`);
  return parts.length ? `${parts.join(' ')}.` : 'Practical cloud native talks for Kubernetes engineers.';
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Where each term appears in a session. Title counts most, then tags/track.
function sessionMatches(session, terms) {
  const title = normalize(session.title);
  const desc = normalize(session.description);
  const tags = normalize([...(session.tags || []), session.track || ''].join(' | '));
  const matches = [];
  for (const term of terms) {
    const inTitle = term.re.test(title);
    const inTags = term.re.test(tags);
    const inDesc = term.re.test(desc);
    if (inTitle || inTags || inDesc) {
      const raw = term.weight * ((inTitle ? 3 : 0) + (inTags ? 2 : 0) + (inDesc ? 1 : 0));
      matches.push({ term, raw });
    }
  }
  return matches.sort((a, b) => b.raw - a.raw);
}

// 0..1, saturating: one strong title match ~0.5, several matches approach 1.
function lexicalScore(matches) {
  const raw = matches.reduce((sum, m) => sum + m.raw, 0);
  return 1 - Math.exp(-raw / 4);
}

function sessionReasons(session, matches, { semantic = false } = {}) {
  // "Matches kubernetes" says little at KubeCon: show it only when nothing more specific matched.
  const specific = matches.filter((m) => !m.term.generic);
  const reasons = (specific.length ? specific : matches).slice(0, 3).map((m) => `Matches ${m.term.label}`);
  if (!reasons.length && semantic) reasons.push('Similar to your work');
  if (session.level === 'Beginner') reasons.push('Beginner friendly');
  else if (session.level === 'Advanced') reasons.push('Advanced level');
  return reasons;
}

// --- Sponsors ---------------------------------------------------------------

// Tool -> sponsors that build on or sell a product around it. Small on purpose:
// only well-known, current relationships.
const TOOL_VENDORS = {
  opentelemetry: ['Dash0', 'Honeycomb.io', 'Grafana Labs', 'Datadog', 'Bindplane', 'OllyGarden'],
  prometheus: ['Grafana Labs', 'VictoriaMetrics', 'Dash0'],
  grafana: ['Grafana Labs'],
  loki: ['Grafana Labs'],
  tempo: ['Grafana Labs'],
  k6: ['Grafana Labs'],
  elasticsearch: ['Elastic'],
  opensearch: ['OpenSearch'],
  'argo cd': ['Akuity', 'Octopus Deploy'],
  argo: ['Akuity'],
  'argo rollouts': ['Akuity'],
  kubernetes: ['Google Cloud', 'AWS', 'Microsoft Azure', 'Red Hat', 'SUSE', 'Canonical'],
  terraform: ['HashiCorp', 'Spacelift'],
  vault: ['HashiCorp'],
  crossplane: ['upbound'],
  istio: ['Solo.io'],
  envoy: ['Solo.io'],
  cilium: ['Isovalent'],
  ebpf: ['Isovalent'],
  calico: ['Tigera'],
  backstage: ['Spotify'],
  postgresql: ['EDB Postgres', 'Percona'],
  postgres: ['EDB Postgres', 'Percona'],
  'cloudnative pg': ['EDB Postgres'],
  dapr: ['Diagrid'],
  falco: ['sysdig'],
  kyverno: ['Nirmata'],
  sigstore: ['Chainguard'],
  cosign: ['Chainguard'],
  opencost: ['IBM Kubecost'],
  kubecost: ['IBM Kubecost'],
  testkube: ['testkube – kubeshop'],
  wasmcloud: ['Cosmonic'],
  'github actions': ['Depot', 'Blacksmith'],
  talos: ['Talos by Sidero'],
};

const TIER_RANK = {
  Diamond: 6,
  Platinum: 5,
  Gold: 4,
  Silver: 3,
  'Start-up': 2,
  'End User': 1,
  'Media Partners': 0,
};

function tierRank(tier) {
  return TIER_RANK[tier] ?? 0;
}

// Vendor names worth asking Elasticsearch for, given these terms.
function vendorNamesFor(terms) {
  const names = new Set();
  for (const t of terms) for (const v of t.variants) for (const n of TOOL_VENDORS[v] || []) names.add(n);
  return [...names];
}

function scoreSponsor(sponsor, terms) {
  const name = normalize(sponsor.name);
  let raw = 0;
  const reasons = [];
  for (const t of terms) {
    if (t.kind === 'language') continue;
    const vendorHit = t.variants.some((v) => (TOOL_VENDORS[v] || []).includes(sponsor.name));
    const nameHit = t.kind === 'tool' && t.key.length >= 4 && t.re.test(name);
    if (nameHit) {
      raw += t.weight;
      reasons.push(`Makes ${t.label}`);
    } else if (vendorHit) {
      raw += t.weight * 0.8;
      reasons.push(`Works with ${t.label}`);
    }
  }
  if (!raw) return null;
  const score = Math.round((1 - Math.exp(-raw)) * 1000) / 1000;
  return { sponsor, score, reasons: reasons.slice(0, 3) };
}

// [{ sponsor, score, reasons }], best match first, tier as tiebreak.
function rankSponsors(sponsors, terms) {
  return sponsors
    .map((s) => scoreSponsor(s, terms))
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.score - a.score ||
        tierRank(b.sponsor.tier) - tierRank(a.sponsor.tier) ||
        a.sponsor.name.localeCompare(b.sponsor.name),
    );
}

module.exports = {
  normalize,
  profileTerms,
  semanticQueryText,
  sessionMatches,
  lexicalScore,
  sessionReasons,
  TOOL_VENDORS,
  tierRank,
  vendorNamesFor,
  scoreSponsor,
  rankSponsors,
};
