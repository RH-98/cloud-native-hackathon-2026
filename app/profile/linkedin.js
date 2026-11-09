// Pasted LinkedIn profile text -> profile signals (tools, languages, topics,
// keywords). LinkedIn's APIs don't give new apps skills or positions, so the
// person copies a profile page (theirs or anyone's public one) and pastes it.
//
// Pure: no network, no I/O, no logging. The pasted text is only read here,
// never kept: only the derived signals leave this module. Names, companies,
// schools and other people are never extracted: we only keep catalog tools,
// languages, topics implied by job titles, skills and a short list of strong
// keywords.
const { detectInterest, lookupAlias, matchInterests, phraseRegex } = require('./tools');
const { languageOf } = require('./languages');

const MAX_PASTE = 10000;
const MAX_TOOLS = 15;
const MAX_TOPICS = 8;
const MAX_KEYWORDS = 10;
const MAX_LANGUAGES = 6;

// Evidence weights: a listed skill or the headline says more than a mention in prose.
const WEIGHT = { skill: 1, headline: 1, headlineMention: 0.8, experienceSkill: 0.9, cert: 0.8, prose: 0.6 };

// Section headers as LinkedIn renders them, and what each section is worth.
//   top: the headline area (before any header); prose: tool mentions only;
//   skills: one skill per line; drop: ignored (other people, posts, schools).
const SECTIONS = new Map(Object.entries({
  about: 'prose',
  summary: 'prose',
  featured: 'drop',
  activity: 'drop',
  experience: 'experience',
  education: 'drop',
  skills: 'skills',
  'top skills': 'skills',
  'licenses & certifications': 'cert',
  'licenses and certifications': 'cert',
  certifications: 'cert',
  volunteering: 'prose',
  'volunteer experience': 'prose',
  projects: 'prose',
  publications: 'prose',
  patents: 'prose',
  courses: 'drop',
  'honors & awards': 'drop',
  'honors and awards': 'drop',
  'test scores': 'drop',
  languages: 'drop', // spoken languages, not programming ones
  organizations: 'drop',
  causes: 'drop',
  recommendations: 'drop',
  interests: 'drop',
  'people also viewed': 'drop',
  'people you may know': 'drop',
  'more profiles for you': 'drop',
  'explore premium profiles': 'drop',
  'you might like': 'drop',
  'pages for you': 'drop',
  analytics: 'drop',
  resources: 'drop',
  services: 'drop',
}));
const DROP_PREFIX = /^(others named|people also viewed|more profiles|explore more|you might like|pages for you)\b/i;

// Whole lines that carry no signal.
const NOISE_LINES = [
  /^[\d,.]+[k+]*\s*\+?\s*(connections?|followers?|following|endorsements?|reactions?|comments?|reposts?|likes?|mutual connections?)\b/i,
  /\b\d[\d,.]*\+?\s*(connections|followers)$/i,
  /^(show|see) (all|more|less)\b/i,
  /^…?\s*(see )?more$/i,
  /^endorsed by\b/i,
  /\bendorsements?$/i,
  /\bmutual connections?\b/i,
  /^(message|follow|following|connect|more|contact info|open to|add profile section|enhance profile|pending|save to pdf|share profile|view profile|visit website|see all|send profile in a message|report \/ block|about this profile|like|comment|repost|send|posts|comments|images|videos|documents|articles|newsletters|events|·)$/i,
  /^(\d+(st|nd|rd|th)\+?|1st|2nd|3rd\+?)( degree connection)?$/i,
  /\bhas no recent posts\b/i,
  /^\d+\s*(d|w|mo|yr|h|m)s?\s*(•|·)?\s*(edited)?\s*(•|·)?$/i,
];

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const STRIP = [
  /https?:\/\/\S+|www\.\S+|\b[\w-]+\.(?:com|io|dev|org|net|co)\/\S*/gi, // URLs
  /\p{Extended_Pictographic}|️|‍/gu, // emoji
  new RegExp(`\\b${MONTH}\\s+\\d{4}\\s*(?:[-–—]\\s*(?:${MONTH}\\s+\\d{4}|present))?`, 'gi'), // Jan 2020 - Present
  /\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present)\b/gi, // 2018 - 2020
  /\b\d+\s+(?:yrs?|years?|mos?|months?)\b/gi, // 4 yrs 2 mos
  /\b(?:full-time|part-time|self-employed|freelance|contract|internship|apprenticeship|seasonal|remote|hybrid|on-site)\b/gi,
  /\(?\b(?:he\/him|she\/her|they\/them|he\/they|she\/they)\b[^)\n]*\)?/gi, // pronouns
  /\b\d[\d,.]*\+?\s*(?:connections|followers|endorsements?|reactions?|comments?|reposts?)\b/gi,
];

// Job titles (headline, Experience) -> topics the planner matches against talks.
const TITLES = [
  [/\bplatform (engineer|engineering|team|lead|architect)/i, ['platform engineering']],
  [/\bsite reliability\b|\bsres?\b|\breliability engineer/i, ['reliability', 'observability']],
  [/\bsecurity (engineer|architect|researcher|analyst|lead)|\bsecops\b|\bdevsecops\b|\bciso\b|\bappsec\b/i, ['security']],
  [/\bdata (engineer|platform|architect|scientist)|\banalytics engineer/i, ['data engineering']],
  [/\b(ml|machine learning|ai|mlops|llm) (engineer|researcher|platform|scientist|lead)|\bai\/ml\b/i, ['ai', 'machine learning']],
  [/\bdeveloper (advocate|relations|evangelist)|\bdevrel\b|\bcommunity (manager|lead)|\btechnical evangelist/i, ['community', 'developer experience']],
  [/\bdeveloper experience\b|\bdevex\b/i, ['developer experience']],
  [/\bengineering manager|\b(head|director|vp|vice president) of (engineering|platform|infrastructure)|\bcto\b|\bchief technology officer|\bvp,? engineering/i, ['leadership', 'platform strategy']],
  [/\bproduct (manager|owner|lead)|\bhead of product/i, ['product management']],
  [/\b(co-?)?founder\b/i, ['startups']],
  [/\bdevops (engineer|lead|architect)/i, ['devops']],
  [/\bcloud (engineer|architect)|\bsolutions architect/i, ['cloud architecture']],
  [/\bobservability (engineer|lead)/i, ['observability']],
  [/\bnetwork(ing)? engineer/i, ['networking']],
  [/\b(open source|oss) (maintainer|contributor|program)|\bmaintainer\b/i, ['open source']],
];

// LinkedIn skill names that are not catalog aliases -> a keyword the planner can match.
const SKILL_KEYWORDS = new Map(Object.entries({
  aws: 'aws', amazonwebservices: 'aws', amazonwebservicesaws: 'aws',
  gcp: 'google cloud', googlecloud: 'google cloud', googlecloudplatform: 'google cloud', googlecloudplatformgcp: 'google cloud',
  azure: 'azure', microsoftazure: 'azure',
  sitereliabilityengineering: 'reliability', sre: 'reliability',
  infrastructureascode: 'infrastructure as code', infrastructureascodeiac: 'infrastructure as code', iac: 'infrastructure as code',
  devops: 'devops', linux: 'linux', microservices: 'microservices', serverless: 'serverless',
  distributedsystems: 'distributed systems', networking: 'networking', finops: 'finops',
  incidentmanagement: 'incident response', incidentresponse: 'incident response',
  supplychainsecurity: 'supply chain security', multitenancy: 'multi-tenancy',
}));

// Skills too generic to steer a conference plan.
const SKILL_STOPLIST = new Set([
  'leadership', 'team leadership', 'communication', 'communications', 'management', 'team management', 'project management',
  'agile methodologies', 'agile', 'scrum', 'software development', 'software engineering', 'computer science',
  'microsoft office', 'microsoft excel', 'public speaking', 'teamwork', 'problem solving', 'strategy', 'cloud computing',
  'engineering', 'research', 'english', 'customer service', 'strategic planning', 'mentoring', 'coaching',
  'people management', 'cross-functional team leadership', 'technical leadership', 'hiring', 'recruiting',
  'presentations', 'writing', 'sql', 'git', 'github', 'jira', 'confluence', 'html', 'css', 'rest apis', 'apis',
]);

// Strong phrases worth keeping from prose (About, Experience). Fewer, better.
const PROSE_KEYWORDS = [
  'developer experience', 'internal developer platform', 'multi-tenancy', 'multi-cluster', 'supply chain security',
  'incident response', 'distributed systems', 'microservices', 'serverless', 'edge computing', 'finops',
  'cost optimization', 'sustainability', 'infrastructure as code', 'zero trust', 'policy as code', 'service mesh',
  'disaster recovery', 'site reliability', 'slos', 'cloud cost', 'data platform', 'stream processing',
  'aws', 'google cloud', 'azure', 'devops',
].map((k) => ({ k: k === 'site reliability' ? 'reliability' : k, re: phraseRegex(k) }));

// Programming languages safe to read from prose (others are ordinary words: go, swift, shell).
const PROSE_LANGUAGES = ['golang', 'rust', 'python', 'typescript', 'javascript', 'java', 'kotlin', 'scala', 'elixir', 'haskell'];
const PROSE_LANGUAGE_RES = PROSE_LANGUAGES.map((l) => ({ l, re: phraseRegex(l) }));

const SECTION_HINTS = /^(about|experience|education|skills|activity|licenses & certifications|featured|interests|people also viewed|recommendations)$/im;
const MARKERS = [
  /\b\d[\d,.]*\+?\s*(connections|followers)\b/i,
  /^endorsed by\b/im,
  /\bshow all \d+/i,
  /\bcontact info\b/i,
  new RegExp(`\\b${MONTH}\\s+\\d{4}\\s*[-–—]`, 'i'),
  /\bendorsements?\b/i,
];

const headerOf = (line) => line.toLowerCase().replace(/\s+/g, ' ').trim();

// Does this text look like a pasted LinkedIn profile (rather than a short list of interests)?
function looksLikeLinkedIn(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const headers = text.split(/\r?\n/).filter((l) => SECTIONS.has(headerOf(l))).length;
  let markers = MARKERS.filter((re) => re.test(text)).length;
  if ((text.match(/·/g) || []).length >= 2) markers += 1;
  return headers >= 2 || (headers >= 1 && markers >= 1) || markers >= 2 || (SECTION_HINTS.test(text) && markers >= 1);
}

function clean(line) {
  let out = line;
  for (const re of STRIP) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').replace(/^[\s·•|,\-–—:]+|[\s·•|,\-–—:]+$/g, '').trim();
}

// Lines grouped by section; dropped sections and noise removed.
function sectionsOf(text) {
  const groups = { top: [], prose: [], experience: [], skills: [], cert: [] };
  let kind = 'top';
  let prev = null;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const header = headerOf(trimmed);
    if (SECTIONS.has(header)) {
      kind = SECTIONS.get(header);
      prev = null;
      continue;
    }
    if (DROP_PREFIX.test(trimmed)) {
      kind = 'drop';
      continue;
    }
    if (kind === 'drop') continue;
    if (NOISE_LINES.some((re) => re.test(trimmed))) continue;
    const line = clean(trimmed);
    if (!line || line === prev) continue; // LinkedIn repeats titles for screen readers
    prev = line;
    groups[kind].push(line);
  }
  return groups;
}

function createCollector() {
  const tools = new Map();
  const languages = new Map();
  const topics = [];
  const skillKeywords = [];
  const proseKeywords = [];
  const addTool = (name, w) => {
    if (!name) return;
    const had = tools.get(name);
    // Seen again: a little stronger, never above 1.
    tools.set(name, had === undefined ? w : Math.min(1, Math.max(had, w) + 0.05));
  };
  const addLanguage = (name, w) => {
    if (name) languages.set(name, Math.max(languages.get(name) || 0, w));
  };
  const addTopics = (line) => {
    for (const [re, ts] of TITLES) {
      if (re.test(line)) ts.forEach((t) => !topics.includes(t) && topics.push(t));
    }
  };
  return { tools, languages, topics, skillKeywords, proseKeywords, addTool, addLanguage, addTopics };
}

const stripParens = (s) => s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
const parensOf = (s) => [...s.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());

// One LinkedIn skill ("Go (Programming Language)", "Amazon Web Services (AWS)").
function addSkill(c, item, weight) {
  const s = item.replace(/\+\s*\d+\s+skills?$/i, '').trim();
  if (!s || s.length > 60) return;
  const base = stripParens(s);
  const lang = languageOf(base) || languageOf(s);
  if (lang) return c.addLanguage(lang, weight);
  const tool = lookupAlias(s) || lookupAlias(base) || parensOf(s).map(lookupAlias).find(Boolean);
  if (tool) return c.addTool(tool, weight);
  const compactKey = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const kw = SKILL_KEYWORDS.get(compactKey(s)) || SKILL_KEYWORDS.get(compactKey(base))
    || parensOf(s).map((p) => SKILL_KEYWORDS.get(compactKey(p))).find(Boolean);
  if (kw) {
    if (!c.skillKeywords.includes(kw)) c.skillKeywords.push(kw);
    return undefined;
  }
  const { tools } = matchInterests(base);
  if (tools.length) return tools.forEach((t) => c.addTool(t, weight * 0.9));
  const key = base.toLowerCase();
  if (SKILL_STOPLIST.has(key) || key.split(' ').length > 4 || key.length < 3) return undefined;
  c.addTopics(base);
  if (!c.skillKeywords.includes(key)) c.skillKeywords.push(key);
  return undefined;
}

// Free text: catalog mentions (strict), strong keywords, safe language names, titles.
function addProse(c, lines, weight) {
  if (!lines.length) return;
  const text = lines.join('\n').toLowerCase();
  // Plain catalog mentions (no README list filtering: a sentence naming several tools is real signal here).
  for (const name of detectInterest({ description: text }, 'mention').keys()) c.addTool(name, weight);
  for (const { k, re } of PROSE_KEYWORDS) {
    if (re.test(text) && !c.proseKeywords.includes(k)) c.proseKeywords.push(k);
  }
  for (const { l, re } of PROSE_LANGUAGE_RES) if (re.test(text)) c.addLanguage(languageOf(l), weight);
  lines.forEach(c.addTopics);
}

// Headline-ish lines: phrases split on "·", "|", ",", " at ", "@".
function addHeadline(c, lines) {
  for (const line of lines) {
    c.addTopics(line);
    for (const phrase of line.split(/\s*(?:[·•|,@/]|\s+at\s+|\s+&\s+|\s+and\s+)\s*/i)) {
      const p = phrase.trim();
      if (!p) continue;
      const lang = languageOf(p);
      if (lang) c.addLanguage(lang, WEIGHT.headline);
      const tool = lookupAlias(p);
      if (tool) c.addTool(tool, WEIGHT.headline);
      const kw = SKILL_KEYWORDS.get(p.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (kw && !c.skillKeywords.includes(kw)) c.skillKeywords.push(kw);
    }
  }
  addProse(c, lines, WEIGHT.headlineMention);
}

const round2 = (n) => Math.round(n * 100) / 100;

// Pasted LinkedIn text -> { tools: [{ name, weight }], languages, topics, keywords }.
function parseLinkedIn(text) {
  const input = typeof text === 'string' ? text.slice(0, MAX_PASTE) : '';
  const groups = sectionsOf(input);
  const c = createCollector();

  for (const line of groups.skills) line.split(/\s*·\s*/).forEach((item) => addSkill(c, item, WEIGHT.skill));
  for (const line of groups.cert) {
    const { tools } = matchInterests(stripParens(line));
    tools.forEach((t) => c.addTool(t, WEIGHT.cert));
  }
  addHeadline(c, groups.top);
  // Experience: "Skills: A · B" lines are skills; the rest is titles and prose.
  const expProse = [];
  for (const line of groups.experience) {
    const m = /^skills?\s*:\s*(.+)$/i.exec(line);
    if (m) m[1].split(/\s*·\s*/).forEach((item) => addSkill(c, item, WEIGHT.experienceSkill));
    else expProse.push(line);
  }
  addProse(c, expProse, WEIGHT.prose);
  addProse(c, groups.prose, WEIGHT.prose);

  const sortByWeight = (a, b) => b.weight - a.weight || a.name.localeCompare(b.name);
  const tools = [...c.tools].map(([name, w]) => ({ name, weight: round2(w) })).sort(sortByWeight).slice(0, MAX_TOOLS);
  const languages = [...c.languages].map(([name, w]) => ({ name, weight: round2(w) })).sort(sortByWeight).slice(0, MAX_LANGUAGES);
  const topics = c.topics.slice(0, MAX_TOPICS);
  const keywords = [...new Set([...c.skillKeywords.slice(0, 6), ...c.proseKeywords])]
    .filter((k) => !topics.includes(k))
    .slice(0, MAX_KEYWORDS);
  return { tools, languages, topics, keywords };
}

module.exports = { parseLinkedIn, looksLikeLinkedIn, MAX_PASTE };
