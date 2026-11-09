// Turns repo files into derived signals: dependency names, manifest
// apiVersion/kind pairs, image names, action names and keywords. Pure. File
// contents are read here and dropped; only the derived names leave.

const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|dist|build|\.git|testdata|fixtures?|examples?|test|tests|docs?)\//i;
const MAX_FILE_BYTES = 200 * 1024;

const DEP_FILES = /(^|\/)(package\.json|go\.mod|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml)$/;
const CHART_FILE = /(^|\/)Chart\.ya?ml$/;
const KUSTOMIZATION = /(^|\/)kustomization\.ya?ml$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const COMPOSE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const MANIFEST_DIR = /(^|\/)(deploy|deployment|deployments|k8s|kube|kubernetes|manifests|charts?|helm|gitops|argocd|argo|apps|clusters|config|infra|infrastructure|platform|overlays|base|templates|crds?|operator)\//i;
const YAML = /\.ya?ml$/i;
const README = /^readme(\.(md|markdown|rst|txt|adoc))?$/i;

function depth(path) {
  return path.split('/').length - 1;
}

// Pick up to `max` files worth reading, balanced across kinds: one dependency
// file, one manifest, then the next best of each kind, round-robin.
function pickFiles(tree, max = 4) {
  const blobs = (tree || []).filter(
    (e) => e.type === 'blob' && typeof e.path === 'string' && (e.size || 0) <= MAX_FILE_BYTES,
  );
  const buckets = { dep: [], manifest: [], chart: [], kustomize: [], workflow: [], compose: [] };
  for (const e of blobs) {
    const p = e.path;
    if (p.startsWith('.github/')) {
      if (WORKFLOW.test(p)) buckets.workflow.push(p);
      continue;
    }
    if (SKIP_DIR.test(p)) continue;
    if (DEP_FILES.test(p)) buckets.dep.push(p);
    else if (CHART_FILE.test(p)) buckets.chart.push(p);
    else if (KUSTOMIZATION.test(p)) buckets.kustomize.push(p);
    else if (COMPOSE.test(p)) buckets.compose.push(p);
    else if (YAML.test(p) && MANIFEST_DIR.test(p) && !/values[^/]*\.ya?ml$/i.test(p)) buckets.manifest.push(p);
  }
  for (const list of Object.values(buckets)) list.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const order = ['dep', 'manifest', 'chart', 'dep', 'manifest', 'kustomize', 'compose', 'workflow', 'manifest', 'dep'];
  const picked = [];
  const dir = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  for (const kind of order) {
    if (picked.length >= max) break;
    // Prefer a manifest from a directory not read yet (argocd/ and deploy/
    // say more together than two files from argocd/).
    const list = buckets[kind];
    const fresh = list.findIndex((p) => !picked.some((q) => dir(q) === dir(p)));
    const next = list.splice(kind === 'manifest' && fresh > 0 ? fresh : 0, 1)[0];
    if (next) picked.push(next);
  }
  // Fill any space left with whatever remains.
  for (const kind of Object.keys(buckets)) {
    while (picked.length < max && buckets[kind].length) picked.push(buckets[kind].shift());
  }
  return picked;
}

function findReadme(tree) {
  const e = (tree || []).find((x) => x.type === 'blob' && README.test(x.path));
  return e ? e.path : null;
}

// ------------------------------------------------------------- parsers

function parsePackageJson(text) {
  try {
    const pkg = JSON.parse(text);
    const names = new Set();
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg && typeof pkg[k] === 'object' && pkg[k]) Object.keys(pkg[k]).forEach((n) => names.add(n));
    }
    return [...names].map((n) => `npm:${n}`);
  } catch {
    return [];
  }
}

function parseGoMod(text) {
  const out = new Set();
  const re = /^\s*(?:require\s+)?([a-z0-9][\w.-]*\.[a-z]{2,}(?:\/[^\s]+)*)\s+v[0-9]/gim;
  let m;
  while ((m = re.exec(text))) out.add(`go:${m[1].replace(/\/v\d+$/, '')}`);
  return [...out];
}

function pyName(s) {
  return s.toLowerCase().replace(/\[.*$/, '').replace(/_/g, '-');
}

function parseRequirements(text) {
  const out = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[^\]]*\])?/.exec(line);
    if (m) out.add(`pypi:${pyName(m[1])}`);
  }
  return [...out];
}

function parsePyproject(text) {
  const out = new Set();
  // PEP 621 / requirements-style strings: "ray[serve]>=2.0"
  const strRe = /["']([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[^\]]*\])?\s*(?:[<>=!~;@ ][^"']*)?["']/g;
  let m;
  while ((m = strRe.exec(text))) out.add(`pypi:${pyName(m[1])}`);
  // Poetry tables: name = "^1.0" or name = { version = ... }
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inDeps = /dependencies/.test(header[1]);
      continue;
    }
    const kv = inDeps && /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (kv && kv[1] !== 'python') out.add(`pypi:${pyName(kv[1])}`);
  }
  return [...out];
}

function parseCargo(text) {
  const out = new Set();
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      const h = header[1].trim();
      const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(h);
      if (sub) {
        out.add(`cargo:${sub[1]}`);
        inDeps = false;
      } else {
        inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(h);
      }
      continue;
    }
    const kv = inDeps && /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (kv) out.add(`cargo:${kv[1]}`);
  }
  return [...out];
}

function parseChart(text) {
  const out = new Set();
  const re = /^\s*-?\s*name:\s*["']?([\w.-]+)/gm;
  let m;
  while ((m = re.exec(text))) out.add(`helm:${m[1].toLowerCase()}`);
  return [...out];
}

function normalizeImage(ref) {
  let s = ref.toLowerCase().replace(/@.*$/, '');
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > slash) s = s.slice(0, colon);
  const parts = s.split('/');
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) parts.shift();
  if (parts[0] === 'library' && parts.length > 1) parts.shift();
  return parts.join('/');
}

// YAML (manifests, kustomizations, compose files, workflows): apiVersion/kind
// per document, image references and GitHub Actions `uses:`.
function parseYaml(text) {
  const manifests = [];
  for (const doc of text.split(/^---\s*$/m)) {
    const api = /^apiVersion:\s*["']?([^\s"'#]+)/m.exec(doc);
    const kind = /^kind:\s*["']?([A-Za-z][A-Za-z0-9]*)/m.exec(doc);
    if (api && kind) {
      const group = api[1].includes('/') ? api[1].split('/')[0].toLowerCase() : '';
      manifests.push({ group, kind: kind[1] });
    }
  }
  const images = new Set();
  const imgRe = /^\s*-?\s*image:\s*["']?([^\s"'#{}]+)/gm;
  let m;
  while ((m = imgRe.exec(text))) images.add(normalizeImage(m[1]));
  const deps = new Set();
  const usesRe = /^\s*-?\s*uses:\s*["']?([^\s"'#@]+)/gm;
  while ((m = usesRe.exec(text))) {
    if (!m[1].startsWith('.')) deps.add(`action:${m[1].toLowerCase().split('/').slice(0, 2).join('/')}`);
  }
  return { manifests, images: [...images], deps: [...deps] };
}

// One fetched file -> { deps, manifests, images }.
function parseFile(path, text) {
  const empty = { deps: [], manifests: [], images: [] };
  if (typeof text !== 'string') return empty;
  const base = path.split('/').pop();
  if (base === 'package.json') return { ...empty, deps: parsePackageJson(text) };
  if (base === 'go.mod') return { ...empty, deps: parseGoMod(text) };
  if (/^requirements[^/]*\.txt$/.test(base)) return { ...empty, deps: parseRequirements(text) };
  if (base === 'pyproject.toml') return { ...empty, deps: parsePyproject(text) };
  if (base === 'Cargo.toml') return { ...empty, deps: parseCargo(text) };
  if (CHART_FILE.test(path)) return { ...empty, deps: parseChart(text) };
  if (YAML.test(path)) return parseYaml(text);
  return empty;
}

// ------------------------------------------------------------ keywords

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both
  but by can could did do does doing down during each few for from further had has have having he her here hers him his
  how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own
  same she should so some such than that the their theirs them then there these they this those through to too under until
  up very was we were what when where which while who whom why will with would you your yours yourself etc eg ie via
  using use used uses get gets set sets make makes made run runs running build builds built install installation installing
  usage license licensed mit apache bsd gpl contributing contribute contributors contribution readme doc docs documentation
  github gitlab com http https www org io html md yaml yml json toml txt png jpg svg gif img badge badges shields alt
  example examples project projects repo repository repositories see please want need one two three first following note
  start started starting getting quick quickstart setup step steps command commands line open issue issues pull request
  feature features support supports supported simple simply easy like just new more based version versions release releases
  todo wip tbd file files code src source app application local locally default config configuration configure env
  environment variable variables value values true false null yes name type hello world copyright rights reserved author
  authors year localhost port clone cd git npm yarn pip cargo go make makefile test tests testing run dev development
  available within without well may might must shall also either neither every another able across along among around
  thing things way ways lot lots really much many something anything everything here there now today welcome thanks
  thank built-in check out check-out read find found create created creating add added adding update updated latest
  work works working commit commits copy push pushed access action merge branch main master needs meant interested
  participate keep keeps going goes put puts give gives take takes ask asked done sure instead already still back
  api apis call calls request requests response responses hour hours minute minutes second seconds limit limits
  limited rate live agent agents data app apps user users page pages site website web service services server
  client clients endpoint endpoints route routes time times day days week weeks month months year years list lists
  text link links button buttons click form forms input output result results info information view views show shows
  real good best better great fast faster small large full free help idea ideas plan plans part parts thing
  item items kind kinds sort level levels number numbers count total key keys token tokens job jobs task tasks
  tool tools stack stacks system systems platform platforms solution solutions product products feature
  everything nothing someone everyone people person each other next last end ends live-reload ready status
  error errors fix fixes bug bugs log logs debug option options flag flags script scripts folder directory
  directories path paths url urls link-to output outputs mode modes state states check checks session sessions
  minimal basic basics overview intro introduction summary details detail note notes section sections table
  architecture instance instances binary binaries bundle bundles house home homepage per change changes inside
  cluster clusters image images host hosts disk disks machine machines thing stuff misc various random`
    .split(/\s+/)
    .filter(Boolean),
);

// Words about the event or the coursework rather than the person's interests:
// fine as a repo topic someone chose, noise when they come from prose.
const META = new Set(
  `hackathon hackathons demo demos attendee attendees judge judges judging track tracks sponsor sponsors prize
  prizes submission submissions team teams organizer organizers workshop workshops homework assignment assignments
  course courses class classes lab labs tutorial tutorials conference conferences talk talks slide slides deadline
  starter template templates boilerplate personal portfolio resume`
    .split(/\s+/)
    .filter(Boolean),
);

function stripMarkdown(text) {
  return String(text)
    .slice(0, 20000)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ');
}

function terms(text, exclude, allowMeta = false) {
  const out = new Map();
  const add = (t) => out.set(t, (out.get(t) || 0) + 1);
  for (const segment of stripMarkdown(text).toLowerCase().split(/[\n\r.!?;:,()[\]{}|"*_=>]+/)) {
    const words = segment
      .split(/[^a-z0-9+#-]+/)
      .map((w) => w.replace(/^-+|-+$/g, ''))
      .filter(Boolean);
    let prev = null;
    for (const w of words) {
      const ok =
        w.length >= 3 && w.length <= 30 && /[a-z]/.test(w) && !STOP.has(w) && !exclude.has(w) && (allowMeta || !META.has(w));
      if (ok) {
        add(w);
        if (prev) add(`${prev} ${w}`);
        prev = w;
      } else {
        prev = null;
      }
    }
  }
  return out;
}

// A README's title: level-1 Markdown headings (atx or setext), outside code blocks.
function readmeHeadings(text) {
  const body = String(text || '')
    .slice(0, 20000)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ');
  const out = [];
  const lines = body.split(/\r?\n/);
  lines.forEach((line, i) => {
    const atx = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) out.push(atx[1]);
    else if (i > 0 && /^\s*=+\s*$/.test(line) && lines[i - 1].trim() && !/^\s*[-*|]/.test(lines[i - 1])) {
      out.push(lines[i - 1].trim());
    }
  });
  return out.join('\n');
}

// docs: [{ text, weight, kind, repo }], one per text source. kind is
//   topic       repo topics (meta words like "hackathon" are fine here)
//   description a repo description (the default)
//   heading     README titles and level-2 headings
//   readme      README prose: a term from here alone must show up in 2+ repos
//   weak        forks, starred repos, contributions: counts only alongside
//               another source
// Returns up to `max` short phrases ranked by weighted term frequency (capped
// at 3 per source); bigrams get a bonus and absorb the unigrams they contain.
function extractKeywords(docs, { max = 10, exclude = [] } = {}) {
  const ex = new Set(exclude.map((e) => String(e).toLowerCase()));
  const score = new Map();
  const seen = new Map(); // term -> { strong: bool, readmeRepos: Set, weak: bool }
  docs.forEach(({ text, weight = 1, kind = 'description', repo }, i) => {
    if (!text) return;
    for (const [t, count] of terms(text, ex, kind === 'topic')) {
      const bonus = t.includes(' ') ? 1.5 : 1;
      score.set(t, (score.get(t) || 0) + weight * bonus * Math.min(count, 3));
      const s = seen.get(t) || { strong: false, readmeRepos: new Set(), weak: false };
      if (kind === 'readme') s.readmeRepos.add(repo || `doc${i}`);
      else if (kind === 'weak') s.weak = true;
      else s.strong = true;
      seen.set(t, s);
    }
  });
  const ranked = [...score.entries()]
    .filter(([t]) => {
      const s = seen.get(t);
      return s.strong || s.readmeRepos.size >= 2 || (s.weak && s.readmeRepos.size >= 1);
    })
    .filter(([t, s]) => !t.includes(' ') || s >= 2) // a bigram needs more than one weak sighting
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const picked = [];
  for (const [t] of ranked) {
    if (picked.length >= max) break;
    if (t.includes(' ')) {
      const parts = t.split(' ');
      for (let i = picked.length - 1; i >= 0; i--) if (parts.includes(picked[i])) picked.splice(i, 1);
      picked.push(t);
    } else if (!picked.some((p) => p.split(' ').includes(t))) {
      picked.push(t);
    }
  }
  return picked.slice(0, max);
}

module.exports = {
  pickFiles,
  findReadme,
  parseFile,
  parseYaml,
  parseGoMod,
  parseCargo,
  parsePyproject,
  parseRequirements,
  normalizeImage,
  stripMarkdown,
  extractKeywords,
  readmeHeadings,
};
