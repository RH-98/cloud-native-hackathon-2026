// The account page (/account): profile, saved plans per conference,
// "People to meet" opt-ins and what is stored, and deleting the account.
// Pure helpers are exported for node:test; the DOM is only touched in init(),
// which runs in the browser.
import { accountNav, api, canOptInProfile, signOut } from './account.js';
import { cityOf, formatDateSpan } from './format.js';
import { h } from './render.js';

// ---------- Pure helpers ----------

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// "just now", "5 min ago", "2 hours ago", "yesterday", "3 days ago", "on Nov 2, 2026".
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const seconds = Math.round((now - t) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${dateFmt.format(new Date(t))}`;
}

export function formatDate(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dateFmt.format(new Date(t)) : '';
}

// pickCount from GET /api/me/plans: a number, or null when unknown.
export function pickLabel(n) {
  if (typeof n !== 'number') return 'Plan saved';
  if (n === 0) return 'No sessions picked yet';
  return `${n} session${n === 1 ? '' : 's'} picked`;
}

// "Nov 9–12, 2026 · Salt Lake City, Utah"
export function conferenceMeta(c) {
  return [formatDateSpan(c?.startDate, c?.endDate), cityOf(c?.location)].filter(Boolean).join(' · ');
}

export function openPlanHref(conferenceId) {
  return `/?conference=${encodeURIComponent(conferenceId)}`;
}

// Conferences with a saved plan (newest save first, as the API sends them)
// and the rest. A plan for a conference no longer listed keeps its id as name.
export function splitConferences(conferences, plans) {
  const byId = new Map((conferences || []).map((c) => [c.id, c]));
  const planned = new Set();
  const withPlans = [];
  for (const plan of plans || []) {
    if (!plan || typeof plan.conferenceId !== 'string' || planned.has(plan.conferenceId)) continue;
    planned.add(plan.conferenceId);
    withPlans.push({ plan, conference: byId.get(plan.conferenceId) || { id: plan.conferenceId, name: plan.conferenceId } });
  }
  return { withPlans, without: (conferences || []).filter((c) => !planned.has(c.id)) };
}

// ---------- DOM ----------

const page = {
  user: null,
  conferences: [],
  plans: [],
  plansError: null,
  social: new Map(), // conferenceId -> { optedIn, optedInAt } | null (unknown)
  privateRepos: undefined,
  connections: null, // { outgoing, incoming, accepted } from GET /api/me/connections, or { error }
};

const $ = (sel) => document.querySelector(sel);
const srOnly = (text) => h('span', { class: 'sr-only' }, text);
const confName = (id) => page.conferences.find((c) => c.id === id)?.name || id;

function announce(message) {
  const el = $('#acct-status');
  el.textContent = '';
  window.setTimeout(() => { el.textContent = message; }, 50);
}

function timeEl(iso, text) {
  return h('time', { datetime: iso, title: new Date(iso).toLocaleString() }, text);
}

function section(id, title, ...children) {
  return h('section', { class: 'acct-card', id: `sec-${id}`, 'aria-labelledby': `${id}-h` },
    h('h2', { class: 'acct__h2', id: `${id}-h`, tabindex: '-1' }, title), ...children);
}

function replaceSection(id, node) {
  $(`#sec-${id}`)?.replaceWith(node);
}

// An inline "are you sure?": replaces `actions` with a question and two
// buttons. Escape or the keep button puts the actions back and refocuses
// `returnFocus`; the confirm button runs onConfirm(setError).
function inlineConfirm({ actions, returnFocus, question, confirmText, keepText, onConfirm }) {
  const id = `confirm-${Math.random().toString(36).slice(2, 8)}`;
  const error = h('p', { class: 'field-error', hidden: true });
  const yes = h('button', { type: 'button', class: 'btn btn--small btn--danger' }, confirmText);
  const keep = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, keepText);
  const box = h('div', { class: 'acct-confirm', role: 'group', 'aria-labelledby': id },
    h('p', { id, class: 'acct-confirm__q' }, question),
    h('div', { class: 'acct-actions' }, yes, keep),
    error);
  const close = () => {
    box.remove();
    actions.hidden = false;
    returnFocus.focus();
  };
  keep.addEventListener('click', close);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    keep.disabled = true;
    error.hidden = true;
    try {
      await onConfirm();
    } catch (err) {
      error.replaceChildren(h('strong', {}, 'Error: '), err.message || 'Something went wrong.');
      error.hidden = false;
      yes.disabled = false;
      keep.disabled = false;
      yes.focus();
    }
  });
  actions.hidden = true;
  actions.after(box);
  keep.focus();
}

// ---------- Sections ----------

function profileSection() {
  const u = page.user;
  const name = u.name || u.login;
  const avatar = u.avatarUrl
    ? h('img', { class: 'acct-profile__avatar', src: u.avatarUrl, alt: `${name}'s GitHub avatar`, width: 72, height: 72 })
    : null;
  const since = u.memberSince ? [' · Member since ', timeEl(u.memberSince, formatDate(u.memberSince))] : [];
  return section('profile', 'Profile',
    h('div', { class: 'acct-profile' },
      avatar,
      h('div', {},
        h('p', { class: 'acct-profile__name' }, name),
        h('p', { class: 'acct-profile__login' },
          h('a', { href: `https://github.com/${encodeURIComponent(u.login)}`, target: '_blank', rel: 'noopener noreferrer' },
            `@${u.login}`, srOnly(' on GitHub (opens in a new tab)'))),
        h('p', { class: 'hint' }, 'Signed in with GitHub', ...since))));
}

function planCard({ plan, conference }) {
  const hid = `plan-${conference.id}-h`;
  const del = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, 'Delete plan', srOnly(` for ${conference.name}`));
  const actions = h('div', { class: 'acct-actions' },
    h('a', { class: 'btn btn--small btn--primary', href: openPlanHref(conference.id) }, 'Open plan', srOnly(` for ${conference.name}`)),
    del);
  del.addEventListener('click', () => inlineConfirm({
    actions,
    returnFocus: del,
    question: `Delete your saved plan for ${conference.name}? This can't be undone.`,
    confirmText: 'Delete plan',
    keepText: 'Keep plan',
    onConfirm: () => deletePlan(conference.id),
  }));
  const meta = conferenceMeta(conference);
  return h('li', {},
    h('article', { class: 'acct-plan', 'aria-labelledby': hid },
      h('h3', { class: 'acct-plan__name', id: hid }, conference.name),
      meta ? h('p', { class: 'acct-plan__meta' }, meta) : null,
      h('p', { class: 'acct-plan__facts' }, pickLabel(plan.pickCount), ' · Saved ', timeEl(plan.savedAt, relativeTime(plan.savedAt))),
      actions));
}

function plansSection() {
  const { withPlans, without } = splitConferences(page.conferences, page.plans);
  const body = [];
  if (page.plansError) {
    body.push(h('p', { class: 'alert' }, h('strong', {}, 'Your plans could not be loaded. '), page.plansError));
  } else if (withPlans.length) {
    body.push(h('ul', { class: 'acct-plans' }, withPlans.map(planCard)));
  } else {
    body.push(h('p', {}, 'No saved plans yet. While you are signed in, every route you map is saved here automatically.'));
  }
  if (!page.plansError && without.length) {
    body.push(h('ul', { class: 'acct-start' }, without.map((c) => h('li', {},
      h('a', { href: openPlanHref(c.id) }, `Start a plan for ${c.name}`, h('span', { 'aria-hidden': 'true' }, ' →'))))));
  }
  return section('plans', 'My plans', ...body);
}

function socialState(conferenceId) {
  const s = page.social.get(conferenceId);
  if (!s) return 'Status unavailable right now.';
  return s.optedIn ? ['On since ', timeEl(s.optedInAt, formatDate(s.optedInAt)), '.'] : 'Off.';
}

function socialRow(c) {
  const s = page.social.get(c.id);
  const plan = page.plans.find((p) => p.conferenceId === c.id);
  const stateId = `social-${c.id}-state`;
  if (s && (s.optedIn || plan?.canOptIn)) {
    const box = h('input', { type: 'checkbox', id: `social-${c.id}`, checked: s.optedIn, 'aria-describedby': stateId });
    box.addEventListener('change', () => setOptIn(c.id, box));
    return h('li', { class: 'acct-toggle' },
      h('label', { class: 'check' }, box, ` Suggest me at ${c.name}`),
      h('p', { class: 'hint', id: stateId }, socialState(c.id)));
  }
  return h('li', { class: 'acct-toggle' },
    h('p', { class: 'acct-toggle__name' }, c.name),
    h('p', { class: 'hint', id: stateId }, socialState(c.id), ' ',
      s ? h('a', { href: openPlanHref(c.id) }, 'Generate a plan to opt in') : null));
}

function privateReposBlock() {
  const pr = page.privateRepos;
  if (pr === undefined || pr === null) return [];
  if (typeof pr === 'object' && !pr.enabled && !(Number(pr.repoCount) > 0)) return [];
  // GET /api/me privateRepos: { enabled, repoCount, scannedAt }; on once a scan stored signals.
  const n = typeof pr === 'boolean' ? (pr ? 1 : 0) : Number(pr.repoCount) || 0;
  const connected = n > 0;
  const out = [
    h('h3', { class: 'acct__h3' }, 'Private repositories'),
    h('p', { id: 'private-state' }, connected
      ? `On: tool and language signals from ${n} private repo${n === 1 ? '' : 's'} are used for your plans. Never their names or code. You can also uninstall the app in GitHub settings.`
      : 'Off: only your public repositories are read.'),
  ];
  if (!connected) {
    out.push(h('p', {}, h('a', { href: '/auth/github-app/install?returnTo=%2Faccount' }, 'Include my private repos (read-only)'),
      ' installs the Switchback GitHub App with read-only access to the repos you choose.'));
  } else {
    out.push(h('p', {}, h('a', { href: 'https://github.com/settings/installations', target: '_blank', rel: 'noopener noreferrer' }, 'Manage or uninstall the GitHub App')));
  }
  if (connected) {
    const forget = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, 'Forget private-repo signals');
    const actions = h('div', { class: 'acct-actions' }, forget);
    forget.addEventListener('click', () => inlineConfirm({
      actions,
      returnFocus: forget,
      question: 'Forget everything derived from your private repositories?',
      confirmText: 'Forget them',
      keepText: 'Keep them',
      onConfirm: async () => {
        await api('/api/me/private-profile', { method: 'DELETE' });
        page.privateRepos = typeof pr === 'boolean' ? false : { ...pr, repoCount: 0, scannedAt: null };
        replaceSection('privacy', privacySection());
        $('#private-state')?.setAttribute('tabindex', '-1');
        $('#private-state')?.focus();
        announce('Private-repo signals forgotten.');
      },
    }));
    out.push(actions);
  }
  return out;
}

function privacySection() {
  const ids = new Set(page.conferences.map((c) => c.id));
  const confs = [...page.conferences];
  for (const id of page.social.keys()) if (!ids.has(id)) confs.push({ id, name: id });
  return section('privacy', 'Matching & privacy',
    h('h3', { class: 'acct__h3' }, 'People to meet'),
    h('p', { class: 'hint' }, 'When this is on, other signed-in attendees at that conference can be suggested to meet you. They see your name, avatar and the tools, topics and languages you share.'),
    h('ul', { class: 'acct-toggles' }, confs.map(socialRow)),
    h('div', { class: 'acct-columns' },
      h('div', {},
        h('h3', { class: 'acct__h3' }, 'What we store'),
        h('ul', { class: 'acct-list' },
          h('li', {}, 'Your GitHub account id, username, name and avatar link.'),
          h('li', {}, 'The plans you save: your picks, pins, skips and the profile they were built from.'),
          h('li', {}, 'A sign-in session, stored only as a hash. It expires after 7 days.'),
          h('li', {}, 'Only if you opt in: tool, topic, language and keyword labels for “People to meet”.'),
          h('li', {}, 'Connection requests you send or receive, and whether they were accepted.'))),
      h('div', {},
        h('h3', { class: 'acct__h3' }, 'What we never store'),
        h('ul', { class: 'acct-list' },
          h('li', {}, 'Your code or the contents of your files.'),
          h('li', {}, 'Your GitHub access token: it is used once while you sign in, then dropped.'),
          h('li', {}, 'Your email address or password.')))),
    ...privateReposBlock());
}

// ---------- Connections (requests from "People to meet") ----------

function connPerson(r) {
  const p = r.person || {};
  const who = h('span', { class: 'acct-conn__who' }, p.displayName || p.handle,
    p.handle ? h('span', { class: 'acct-plan__meta' }, ` @${p.handle}`) : null);
  return who;
}

function connMeta(r) {
  const bits = [];
  if (r.person?.role) bits.push(r.person.role);
  if (r.shared?.length) bits.push(`In common: ${r.shared.join(', ')}`);
  if (r.simulated) bits.push(r.note || 'Demo attendee: auto-accepted (simulated)');
  return bits.length ? h('p', { class: 'acct-conn__meta' }, bits.join(' · ')) : null;
}

function connButton(text, sr, cls, onClick) {
  const b = h('button', { type: 'button', class: `btn btn--small ${cls}` }, text, srOnly(` ${sr}`));
  b.addEventListener('click', () => onClick(b));
  return b;
}

function connItem(r, kind) {
  const name = r.person?.displayName || r.person?.handle || 'this attendee';
  const actions = [];
  if (kind === 'incoming') {
    actions.push(
      connButton('Accept', name, 'btn--primary', (b) => answerRequest(b, r, 'accept', `Connected with ${name}.`)),
      connButton('Decline', name, 'btn--quiet', (b) => answerRequest(b, r, 'decline', `Declined ${name}'s request.`)),
    );
  } else if (kind === 'outgoing') {
    actions.push(h('span', {}, '✓ Requested'),
      connButton('Withdraw', `request to ${name}`, 'btn--quiet', (b) => withdrawRequest(b, r, `Withdrew your request to ${name}.`)));
  } else if (r.person?.profileUrl) {
    actions.push(h('span', {}, '✓ Connected · '),
      h('a', { href: r.person.profileUrl, target: '_blank', rel: 'noopener noreferrer' }, `@${r.person.handle}`, srOnly(' on GitHub (opens in a new tab)')));
  } else {
    actions.push(h('span', {}, '✓ Connected'));
  }
  return h('li', { class: 'acct-conn' }, connPerson(r), ...actions, connMeta(r));
}

function connectionsSection() {
  const c = page.connections;
  if (!c) return section('connections', 'Connections', h('p', { class: 'hint' }, 'Loading…'));
  if (c.error) return section('connections', 'Connections', h('p', {}, `Your connections are unavailable right now: ${c.error}`));
  const all = [...c.incoming, ...c.outgoing, ...c.accepted];
  if (!all.length) {
    return section('connections', 'Connections',
      h('p', { class: 'hint' }, 'No connection requests yet. Use “Connect” on a card in “People to meet” on your plan. Real attendees see your request only if you both opted in for that conference.'));
  }
  const ids = [...new Set(all.map((r) => r.conferenceId))];
  const groups = ids.map((id) => {
    const of = (list) => list.filter((r) => r.conferenceId === id);
    const block = (title, list, kind) => (list.length
      ? [h('h4', { class: 'acct__h3' }, `${title} (${list.length})`), h('ul', { class: 'acct-conns' }, list.map((r) => connItem(r, kind)))]
      : []);
    return [
      h('h3', { class: 'acct__h3' }, confName(id)),
      ...block('Wants to connect with you', of(c.incoming), 'incoming'),
      ...block('Your requests', of(c.outgoing), 'outgoing'),
      ...block('Connected', of(c.accepted), 'accepted'),
    ];
  });
  return section('connections', 'Connections',
    h('p', { class: 'hint' }, 'People you asked to connect with, and people who asked you, from “People to meet”. Their GitHub profile shows once you both agree. A decline is never shown to the person who asked.'),
    ...groups.flat());
}

async function loadConnections() {
  try {
    const data = await api('/api/me/connections');
    page.connections = { outgoing: data?.outgoing || [], incoming: data?.incoming || [], accepted: data?.accepted || [] };
  } catch (err) {
    page.connections = { error: err.message };
  }
}

async function refreshConnections(message) {
  await loadConnections();
  replaceSection('connections', connectionsSection());
  if (page.user && !page.connections.error) {
    $('#account')?.replaceChildren(...accountNav(page.user, { current: true, incoming: page.connections.incoming.length }));
  }
  $('#connections-h')?.focus();
  announce(message);
}

async function answerRequest(button, r, action, done) {
  button.disabled = true;
  try {
    await api(`/api/me/connections/${encodeURIComponent(r.id)}/${action}`, { method: 'POST' });
    await refreshConnections(done);
  } catch (err) {
    button.disabled = false;
    announce(`Could not update: ${err.message}`);
  }
}

async function withdrawRequest(button, r, done) {
  button.disabled = true;
  try {
    await api(`/api/me/connections/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
    await refreshConnections(done);
  } catch (err) {
    button.disabled = false;
    announce(`Could not update: ${err.message}`);
  }
}

function dangerSection() {
  const del = h('button', { type: 'button', class: 'btn btn--small btn--danger-quiet' }, 'Delete my account and data');
  const out = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, 'Sign out');
  out.addEventListener('click', signOut);
  const actions = h('div', { class: 'acct-actions' }, out, del);
  del.addEventListener('click', () => inlineConfirm({
    actions,
    returnFocus: del,
    question: 'Delete your account and everything stored with it? This can’t be undone.',
    confirmText: 'Delete everything',
    keepText: 'Keep my account',
    onConfirm: deleteAccount,
  }));
  const node = section('danger', 'Danger zone',
    h('p', {}, 'Deleting your account removes your saved plans, your “People to meet” opt-ins, your connection requests (sent and received), your sign-in sessions and your account record. You can sign in again later to start fresh.'),
    actions);
  node.classList.add('acct-card--danger');
  return node;
}

// ---------- Actions ----------

async function deletePlan(conferenceId) {
  await api(`/api/me/plan?conferenceId=${encodeURIComponent(conferenceId)}`, { method: 'DELETE' });
  page.plans = page.plans.filter((p) => p.conferenceId !== conferenceId);
  replaceSection('plans', plansSection());
  replaceSection('privacy', privacySection());
  $('#plans-h').focus();
  announce(`Deleted your saved plan for ${confName(conferenceId)}.`);
}

async function setOptIn(conferenceId, box) {
  const optIn = box.checked;
  box.disabled = true;
  try {
    let profile;
    if (optIn) {
      const saved = await api(`/api/me/plan?conferenceId=${encodeURIComponent(conferenceId)}`);
      profile = saved?.state?.profile;
      if (!canOptInProfile(profile, page.user)) throw new Error('Generate a plan from your own GitHub, interests or LinkedIn profile first.');
    }
    await api('/api/me/social', { method: 'PUT', body: { conferenceId, optIn, profile } });
    page.social.set(conferenceId, { optedIn: optIn, optedInAt: optIn ? new Date().toISOString() : null });
    $(`#social-${CSS.escape(conferenceId)}-state`)?.replaceChildren(...[socialState(conferenceId)].flat());
    announce(optIn
      ? `You can now be suggested to other attendees at ${confName(conferenceId)}.`
      : `You are no longer suggested to attendees at ${confName(conferenceId)}.`);
  } catch (err) {
    box.checked = !optIn;
    announce(`Could not update: ${err.message}`);
  } finally {
    box.disabled = false;
  }
}

async function deleteAccount() {
  await api('/api/me', { method: 'DELETE' });
  $('#account').hidden = true;
  const heading = h('h2', { class: 'acct__h2', id: 'gone-h', tabindex: '-1' }, 'Your account is deleted');
  $('#acct-content').replaceChildren(h('section', { class: 'acct-card', 'aria-labelledby': 'gone-h' },
    heading,
    h('p', {}, 'Your saved plans, opt-ins and sessions are gone. The planner still works without an account.'),
    h('p', {}, h('a', { class: 'btn btn--small btn--primary', href: '/' }, 'Back to the planner'))));
  heading.focus();
  announce('Your account and its data were deleted.');
}

// ---------- Start-up ----------

function message(title, text, link) {
  $('#acct-content').replaceChildren(h('section', { class: 'acct-card', 'aria-labelledby': 'msg-h' },
    h('h2', { class: 'acct__h2', id: 'msg-h' }, title),
    h('p', {}, text),
    link ? h('p', {}, link) : null));
}

async function init() {
  const content = $('#acct-content');
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    message('Your account is unavailable', `${err.message} Try again in a moment.`);
    content.removeAttribute('aria-busy');
    return;
  }
  content.removeAttribute('aria-busy');
  if (!me?.enabled) {
    message('Accounts are off', 'This server runs without accounts. The planner works exactly the same without one.',
      h('a', { href: '/' }, 'Go to the planner'));
    return;
  }
  if (!me.user) {
    message('Sign in to see your account', 'Your saved plans and settings are kept with your GitHub sign-in.',
      h('a', { class: 'btn btn--primary', href: '/auth/github/login?returnTo=%2Faccount' }, 'Sign in with GitHub'));
    return;
  }
  page.user = me.user;
  page.privateRepos = me.privateRepos;
  const nav = $('#account');
  nav.replaceChildren(...accountNav(me.user, { current: true, incoming: me.connectionRequests?.incoming }));
  nav.hidden = false;

  const [conferences, plans] = await Promise.all([
    api('/api/conferences').then((b) => b?.conferences || []).catch(() => []),
    api('/api/me/plans').then((b) => b?.plans || []).catch((err) => {
      page.plansError = err.message;
      return [];
    }),
  ]);
  page.conferences = conferences;
  page.plans = plans;
  await loadConnections();
  const ids = [...new Set([...conferences.map((c) => c.id), ...plans.map((p) => p.conferenceId)])];
  await Promise.all(ids.map((id) => api(`/api/me/social?conferenceId=${encodeURIComponent(id)}`)
    .then((s) => page.social.set(id, { optedIn: Boolean(s?.optedIn), optedInAt: s?.optedInAt || null }))
    .catch(() => page.social.set(id, null))));

  content.replaceChildren(profileSection(), plansSection(), connectionsSection(), privacySection(), dangerSection());
}

if (typeof document !== 'undefined' && document.getElementById('acct-content')) init();
