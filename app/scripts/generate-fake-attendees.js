// Generate FICTIONAL demo attendees for suggested connections:
//   cd app && npm run generate:attendees
// Deterministic (seeded PRNG), so the committed output only changes when this
// script does. Names are invented, handles start with "demo-", companies are
// generic ("a fintech"). No real people or GitHub accounts.
const fs = require('node:fs');
const path = require('node:path');
const { TOOLS, TOPICS, termKey } = require('../social/catalog');

const CONFERENCE_ID = 'kubecon-na-2026';
const SEED = 20261109;
const SNAPSHOT = path.join(__dirname, '..', 'data', 'conferences', `${CONFERENCE_ID}.json`);
const OUT = path.join(__dirname, '..', 'data', 'attendees', `${CONFERENCE_ID}.json`);

// mulberry32: small, fast, seedable.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = prng(SEED);
const pick = (list) => list[Math.floor(rand() * list.length)];
function sample(list, n) {
  const copy = [...list];
  const out = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}
const between = (lo, hi) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
const intBetween = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// Invented name parts: whimsical surnames so nobody mistakes them for real people.
const FIRST = [
  'Ada', 'Bram', 'Cleo', 'Dax', 'Edie', 'Faro', 'Gus', 'Hollis', 'Ines', 'Juno', 'Kit', 'Lark',
  'Milo', 'Nell', 'Orrin', 'Pax', 'Quinn', 'Rue', 'Sol', 'Tamsin', 'Uma', 'Vesper', 'Wren', 'Xan',
  'Yara', 'Zeke', 'Arlo', 'Bea', 'Cass', 'Dov', 'Esme', 'Fenn', 'Greer', 'Hale', 'Ivo', 'Jessa',
];
const LAST = [
  'Quillfeather', 'Brightwater', 'Copperkettle', 'Moonvale', 'Thistledown', 'Ashgrove', 'Fernwhistle',
  'Lanternfield', 'Pebblecrest', 'Saltmarsh', 'Tinderbox', 'Wavecrest', 'Hollowbrook', 'Starling-Vey',
  'Driftwood', 'Emberlyn', 'Frostmantle', 'Glimmerton', 'Harrowgate-Pine', 'Inkwell', 'Juniperlane',
  'Kettleburn', 'Larkspur', 'Mistlewood', 'Nettlefold', 'Oakhollow', 'Puddlefoot', 'Quarrystone',
  'Riverlace', 'Sparrowby', 'Tumbleweed', 'Underhill-Ray', 'Velvetmoss', 'Willowmere', 'Yarrowby',
];
const COMPANIES = [
  'a fintech', 'a regional bank', 'an online retailer', 'a healthcare startup', 'a cloud provider',
  'a university', 'a game studio', 'a public-sector agency', 'a telecom', 'a logistics company',
  'a SaaS startup', 'an insurance company', 'a media streaming service', 'an automaker', 'an airline',
  'a consultancy', 'a research lab', 'a nonprofit',
];

// Archetypes: who they are and what they work with.
const ARCHETYPES = [
  {
    id: 'platform', count: 10,
    roles: ['Platform engineer', 'Staff platform engineer', 'Developer experience lead', 'Infrastructure engineer'],
    tools: ['argocd', 'backstage', 'crossplane', 'flux', 'helm', 'kustomize', 'opentofu', 'kubernetes'],
    topics: ['gitops', 'platformengineering', 'developerexperience', 'multicluster'],
    languages: ['Go', 'TypeScript', 'Python', 'HCL'],
    keywords: ['golden paths', 'internal developer platform', 'self-service', 'progressive delivery', 'templates'],
    bios: [
      'Runs the {0} and {1} setup that dozens of product teams deploy through.',
      'Building a golden path on {0}; happy to compare notes on {1}.',
      'Turning tickets into self-service with {0} and {1}.',
    ],
  },
  {
    id: 'observability', count: 9,
    roles: ['Observability engineer', 'SRE, observability', 'Telemetry platform lead'],
    tools: ['opentelemetry', 'prometheus', 'grafana', 'jaeger', 'fluentbit', 'thanos', 'cortex'],
    topics: ['observability', 'tracing', 'monitoring', 'slo'],
    languages: ['Go', 'Java', 'Python'],
    keywords: ['distributed tracing', 'high cardinality', 'sampling', 'dashboards', 'alerting'],
    bios: [
      'Migrating every service to {0}; still arguing about sampling.',
      'Owns the {0} and {1} stack. Ask me about cardinality.',
      'Making on-call less noisy with {0} and better SLOs.',
    ],
  },
  {
    id: 'security', count: 8,
    roles: ['Security engineer', 'Supply-chain security lead', 'Cloud security architect'],
    tools: ['falco', 'kyverno', 'sigstore', 'spiffe', 'openpolicyagent', 'certmanager', 'intoto'],
    topics: ['supplychainsecurity', 'policyascode', 'zerotrust', 'runtimesecurity'],
    languages: ['Go', 'Rust', 'Python'],
    keywords: ['sbom', 'image signing', 'admission control', 'workload identity', 'least privilege'],
    bios: [
      'Signing everything with {0}; enforcing it with {1}.',
      'Rolling out {0} for workload identity across clusters.',
      'Runtime detection with {0}, policy with {1}.',
    ],
  },
  {
    id: 'networking', count: 8,
    roles: ['Network engineer', 'Service mesh lead', 'Kernel and networking engineer'],
    tools: ['cilium', 'ebpf', 'envoy', 'istio', 'linkerd', 'gatewayapi', 'coredns'],
    topics: ['servicemesh', 'networking', 'zerotrust', 'multicluster'],
    languages: ['Go', 'C', 'Rust'],
    keywords: ['ambient mesh', 'kube-proxy replacement', 'mtls', 'load balancing', 'network policy'],
    bios: [
      'Replaced kube-proxy with {0}; now curious about {1}.',
      'Writes {0} programs for fun and for work.',
      'Moving the mesh from sidecars to {0} ambient-style.',
    ],
  },
  {
    id: 'ai', count: 9,
    roles: ['ML platform engineer', 'MLOps engineer', 'AI infrastructure engineer', 'Inference platform lead'],
    tools: ['kubeflow', 'ray', 'vllm', 'kserve', 'kueue', 'llmd', 'kubernetes'],
    topics: ['mlops', 'llminference', 'gpu', 'aiagents'],
    languages: ['Python', 'Go'],
    keywords: ['gpu scheduling', 'model serving', 'batch jobs', 'autoscaling inference', 'agents'],
    bios: [
      'Serving models with {0} on shared GPUs; scheduling with {1}.',
      'Building the training platform on {0} and {1}.',
      'Keeping GPU utilisation above 60% with {0}.',
    ],
  },
  {
    id: 'data', count: 6,
    roles: ['Database reliability engineer', 'Data platform engineer', 'Streaming platform engineer'],
    tools: ['cloudnativepg', 'postgres', 'kafka', 'strimzi', 'vitess', 'rook', 'etcd'],
    topics: ['databases', 'streaming', 'storage', 'operators'],
    languages: ['Go', 'Java', 'SQL'],
    keywords: ['stateful workloads', 'backups', 'failover', 'event streaming', 'operators'],
    bios: [
      'Runs {0} on Kubernetes and sleeps fine.',
      'Moving {0} clusters onto {1}.',
      'Stateful workloads person: {0}, {1}, backups.',
    ],
  },
  {
    id: 'sre', count: 7,
    roles: ['Site reliability engineer', 'Production engineer', 'Cluster operations lead'],
    tools: ['kubernetes', 'prometheus', 'keda', 'karpenter', 'chaosmesh', 'litmus', 'helm'],
    topics: ['reliability', 'autoscaling', 'incidentresponse', 'chaosengineering', 'costoptimization'],
    languages: ['Go', 'Python', 'Bash'],
    keywords: ['on-call', 'postmortems', 'capacity planning', 'node autoscaling', 'cluster upgrades'],
    bios: [
      'Scaling to zero with {0}, back up with {1}.',
      'Runs game days with {0}; writes the postmortems too.',
      'Keeps 40 clusters upgraded and boring.',
    ],
  },
  {
    id: 'newcomer', count: 7,
    roles: ['Computer science student', 'Junior developer', 'Career changer, ex-teacher', 'Bootcamp graduate'],
    tools: ['kubernetes', 'docker', 'helm', 'prometheus', 'opentelemetry', 'argocd'],
    topics: ['learning', 'community', 'kubernetes', 'observability', 'gitops'],
    languages: ['Python', 'JavaScript', 'Go'],
    keywords: ['first kubecon', 'getting started', 'contributing', 'homelab'],
    bios: [
      'First KubeCon! Learning {0} with a homelab.',
      'Looking for a first open-source contribution, maybe in {0}.',
      'Just deployed my first app with {0}; what next?',
    ],
    firstTimer: true,
  },
];

// Every archetype except newcomers has a few maintainers and first-timers.
function experienceFor(archetype, index) {
  if (archetype.firstTimer) return 'first-timer';
  if (index === 0 || index === 5) return 'maintainer';
  if (index === 3) return 'first-timer';
  return 'practitioner';
}

function sessionMatchers(snapshot) {
  return snapshot.sessions
    .filter((s) => s.kind === 'session' && s.start && s.start.slice(0, 10) >= snapshot.conference.startDate)
    // Pavilion kiosk listings name every project, so they'd match everyone.
    .filter((s) => !/kiosk/i.test(s.title))
    .map((s) => ({
      id: s.id,
      title: ` ${s.title} `.toLowerCase(),
      text: ` ${s.title} ${s.description || ''} `.toLowerCase(),
    }));
}

function termsFor(key) {
  return (TOOLS[key] || TOPICS[key])?.terms || [key];
}

// 3-5 sessions whose title (or, less so, description) mentions the attendee's tools or topics.
function pickSessions(sessions, toolKeys, topicKeys) {
  const hit = (s, k, w) => {
    const terms = termsFor(k);
    if (terms.some((t) => s.title.includes(t))) return 3 * w;
    return terms.some((t) => s.text.includes(t)) ? w : 0;
  };
  const scored = sessions
    .map((s) => {
      let score = 0;
      for (const k of toolKeys) score += hit(s, k, 2);
      for (const k of topicKeys) score += hit(s, k, 1);
      return { id: s.id, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return sample(scored.slice(0, 12), intBetween(3, 5))
    .map((s) => s.id)
    .sort();
}

const label = (key) => (TOOLS[key] || TOPICS[key]).label;
// Kebab-case name like the profile uses ("argo-cd"), as long as it maps back to the same key.
function slug(key) {
  const name = label(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return termKey(name) === key ? name : key;
}

function generate(snapshot) {
  rand = prng(SEED);
  const sessions = sessionMatchers(snapshot);
  const usedNames = new Set();
  const attendees = [];
  let n = 0;
  for (const arch of ARCHETYPES) {
    for (let i = 0; i < arch.count; i += 1) {
      n += 1;
      let first;
      let last;
      do {
        first = pick(FIRST);
        last = pick(LAST);
      } while (usedNames.has(`${first} ${last}`));
      usedNames.add(`${first} ${last}`);

      const experience = experienceFor(arch, i);
      const light = experience === 'first-timer';
      const toolKeys = sample(arch.tools, light ? intBetween(2, 3) : intBetween(3, 5));
      // Some people straddle two worlds.
      if (!light && rand() < 0.35) {
        const other = pick(ARCHETYPES.filter((a) => a !== arch && !a.firstTimer));
        const extra = pick(other.tools);
        if (!toolKeys.includes(extra)) toolKeys.push(extra);
      }
      const tools = toolKeys.map((key, idx) => ({
        name: slug(key),
        label: label(key),
        weight: light ? between(0.2, 0.5) : Math.round(Math.max(0.3, between(0.75, 1) - idx * 0.12) * 100) / 100,
      }));
      tools.sort((a, b) => b.weight - a.weight);
      const topicKeys = sample(arch.topics, intBetween(2, 3));
      const languages = sample(arch.languages, intBetween(1, 2)).map((name, idx) => ({
        name,
        weight: idx === 0 ? between(0.6, 1) : between(0.2, 0.5),
      }));
      const keywords = sample(arch.keywords, intBetween(2, 3));
      const role = pick(arch.roles);
      const companyType = pick(COMPANIES);
      const bio = `${role} at ${companyType}. ${pick(arch.bios)
        .replace('{0}', tools[0].label)
        .replace('{1}', (tools[1] || tools[0]).label)}`;

      attendees.push({
        id: `${CONFERENCE_ID}:attendee-${String(n).padStart(3, '0')}`,
        conferenceId: CONFERENCE_ID,
        displayName: `${first} ${last}`,
        handle: `demo-${first}-${last}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        fictional: true,
        // Every 10th attendee has not opted in: they must never be suggested.
        optIn: n % 10 !== 7,
        role,
        companyType,
        bio,
        experience,
        maintains: experience === 'maintainer' ? [tools[0].name] : [],
        interests: {
          tools,
          languages: languages.sort((a, b) => b.weight - a.weight),
          topics: topicKeys.map(slug),
          keywords,
        },
        goingTo: pickSessions(sessions, toolKeys.map(termKey), topicKeys),
      });
    }
  }
  return {
    notice:
      'FICTIONAL DEMO DATA. These attendees are invented for the suggested-connections demo; ' +
      'any resemblance to real people is coincidental. Generated by app/scripts/generate-fake-attendees.js.',
    conferenceId: CONFERENCE_ID,
    seed: SEED,
    attendees,
  };
}

function main() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const data = generate(snapshot);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
  const optedIn = data.attendees.filter((a) => a.optIn).length;
  console.log(`Wrote ${data.attendees.length} fictional attendees (${optedIn} opted in) to ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) main();

module.exports = { generate, prng };
