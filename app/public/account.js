// Accounts (optional): "Sign in with GitHub", auto-saving the plan for the
// signed-in user, restoring it on the next visit, and the social opt-in.
// When the server has accounts off (GET /api/me says enabled: false), none
// of this shows and the planner works exactly as before.
// The DOM is only touched inside functions, so node:test can import the
// pure helpers (snapshotState, applySnapshot, isOwnGithubProfile).
import { h } from './render.js';
import { persistableRequest, state } from './state.js';

const SAVE_DELAY_MS = 800;
const MAX_SAVE_CHARS = 450 * 1024; // the server takes up to 500 KB of state
const PENDING_KEY = 'switchback:pending-save';

const account = {
  enabled: false,
  user: null,
  privateRepos: { enabled: false, repoCount: 0, scannedAt: null },
  conferenceId: null,
  socialOptedIn: false,
};
let hooks = { conferenceId: () => null, restore: () => {} };

// ---------- Pure helpers ----------

// What the server stores for a plan: enough to put the page back as it was.
export function snapshotState(s, { includePlan = true } = {}) {
  return {
    // A pasted LinkedIn profile is never stored: only what we derived from it.
    request: persistableRequest(s.request, s.profile),
    pinned: [...s.pinned],
    skipped: [...s.skipped],
    swaps: [...s.swaps],
    activeDay: s.activeDay,
    plan: includePlan ? s.plan : null,
    profile: s.profile,
  };
}

// Puts a saved snapshot back into the state. Returns false when it has nothing to show.
export function applySnapshot(s, saved) {
  if (!saved || typeof saved !== 'object' || !saved.request) return false;
  s.request = saved.request;
  s.pinned = new Set(Array.isArray(saved.pinned) ? saved.pinned : []);
  s.skipped = new Set(Array.isArray(saved.skipped) ? saved.skipped : []);
  s.swaps = new Map(Array.isArray(saved.swaps) ? saved.swaps : []);
  s.activeDay = typeof saved.activeDay === 'string' ? saved.activeDay : null;
  s.plan = saved.plan && Array.isArray(saved.plan.days) ? saved.plan : null;
  s.profile = saved.profile && typeof saved.profile === 'object' ? saved.profile : null;
  return true;
}

// Only your own GitHub profile can be opted in to social matching.
export function isOwnGithubProfile(profile, user) {
  return Boolean(profile && user && (profile.source === 'github' || profile.source === 'github+interests') && typeof profile.username === 'string'
    && profile.username.toLowerCase() === String(user.login).toLowerCase());
}

// Can this signed-in user opt this profile in to matching? Your own GitHub
// profile, or one from typed interests / a pasted LinkedIn profile (no
// username: taken as yours). Mirrors isOwnProfile in app/api/me.js.
export function canOptInProfile(profile, user) {
  if (!profile || !user) return false;
  if (profile.source === 'interests') return profile.username == null;
  return isOwnGithubProfile(profile, user);
}

// The GitHub username field when someone signs in: fill in their login when
// the field is empty, keep whatever they typed (they may plan for someone else).
export function prefillGithub(current, login) {
  const typed = typeof current === 'string' ? current.trim() : '';
  if (typed) return typed;
  return typeof login === 'string' ? login : '';
}

export function isSameLogin(value, login) {
  return typeof value === 'string' && typeof login === 'string'
    && value.trim().replace(/^@/, '').toLowerCase() === login.toLowerCase();
}

// ---------- API ----------

// Also used by the account page (account-page.js).
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or not JSON
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `The server answered ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- DOM ----------

const $ = (sel) => document.querySelector(sel);

function loginHref() {
  return '/auth/github/login?returnTo=%2F';
}

// Before leaving for GitHub, keep the plan on screen so it can be saved on return.
function rememberPending() {
  if (!state.plan || !state.request) return;
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(snapshotState(state)));
  } catch {
    // too large or storage blocked: the user regenerates after signing in
  }
}

function takePending() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function signInLink(text, cls) {
  const a = h('a', { href: loginHref(), class: cls }, text);
  a.addEventListener('click', rememberPending);
  return a;
}

function renderHeader() {
  const nav = $('#account');
  if (!nav) return;
  if (!account.enabled) {
    nav.hidden = true;
    return;
  }
  if (!account.user) {
    nav.replaceChildren(signInLink('Sign in with GitHub', 'account__link'));
  } else {
    nav.replaceChildren(...accountNav(account.user));
  }
  nav.hidden = false;
}

// Signed-in header: avatar and @login linking to the account page, and Sign out.
// The account page passes { current: true } to mark its own link.
export function accountNav(u, { current = false } = {}) {
  const avatar = u.avatarUrl ? h('img', { class: 'account__avatar', src: u.avatarUrl, alt: '', width: 28, height: 28 }) : null;
  const out = h('button', { type: 'button', class: 'btn btn--small account__out' }, 'Sign out');
  out.addEventListener('click', signOut);
  const link = h('a', { class: 'account__who account__link', href: '/account', 'aria-current': current ? 'page' : null },
    avatar, h('span', {}, h('span', { class: 'sr-only' }, 'Your account: '), `@${u.login}`));
  return [link, out];
}

// The top of the form: a prominent sign-in when signed out; when signed in,
// the username field is pre-filled and says whose account this is.
function renderFormStart() {
  const start = $('#account-start');
  const signed = $('#github-signed-in');
  const input = $('#github');
  if (!start || !signed || !input) return;
  const describedBy = () => (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== 'github-signed-in');
  if (!account.enabled) {
    start.hidden = true;
    signed.hidden = true;
    return;
  }
  if (!account.user) {
    start.replaceChildren(
      signInLink('Sign in with GitHub', 'btn account-start__btn'),
      h('p', { class: 'hint account-start__hint' }, 'Optional. Fills in your username and saves your plan to come back to. We only ask GitHub for your public profile.'),
    );
    start.hidden = false;
    signed.hidden = true;
    input.setAttribute('aria-describedby', describedBy().join(' '));
    return;
  }
  start.hidden = true;
  const login = account.user.login;
  input.value = prefillGithub(input.value, login);
  // "Use @login" shows whenever the field holds another username; it is kept
  // in sync as the user types and after a saved plan is restored.
  const use = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, `Use @${login}`);
  use.addEventListener('click', () => {
    input.value = login;
    syncSignedInHint();
    input.focus();
  });
  signed.replaceChildren('Signed in as ', h('strong', {}, `@${login}`), '. Change the username to plan for someone else. ', use);
  signed.hidden = false;
  input.setAttribute('aria-describedby', [...describedBy(), 'github-signed-in'].join(' '));
  if (!input.dataset.signedInSync) {
    input.dataset.signedInSync = '1';
    input.addEventListener('input', syncSignedInHint);
  }
  syncSignedInHint();
}

function syncSignedInHint() {
  const use = $('#github-signed-in button');
  const input = $('#github');
  if (!use || !input || !account.user) return;
  use.hidden = isSameLogin(input.value, account.user.login);
}

// ---------- Private repos (read-only GitHub App) ----------

const UNINSTALL_URL = 'https://github.com/settings/installations';

function privateHref(rescan) {
  return `/auth/github-app/install?returnTo=%2F${rescan ? '&mode=rescan' : ''}`;
}

function privateLink(text, rescan, cls) {
  const a = h('a', { href: privateHref(rescan), class: cls }, text);
  a.addEventListener('click', rememberPending);
  return a;
}

// Under the username field when signed in and the server has the App set up.
function renderPrivateRepos() {
  const box = $('#private-repos');
  if (!box) return;
  const p = account.privateRepos;
  if (!account.enabled || !account.user || !p.enabled) {
    box.hidden = true;
    return;
  }
  const uninstall = () => h('a', { href: UNINSTALL_URL, target: '_blank', rel: 'noopener noreferrer' }, 'uninstall the app in GitHub settings');
  if (!p.repoCount) {
    box.replaceChildren(
      privateLink('Include my private repos (read-only)', false, 'btn btn--small private-repos__btn'),
      h('p', { class: 'hint' },
        "Installs the Switchback GitHub App with read-only access to the repos you choose. We keep only tool and language labels, never code or repo names, and drop GitHub's token right after the scan. You can ", uninstall(), ' anytime. ',
        privateLink('Already installed? Re-scan', true, 'private-repos__rescan')),
    );
  } else {
    const n = p.repoCount;
    const forget = h('button', { type: 'button', class: 'btn btn--small btn--quiet' }, 'Forget my private-repo signals');
    forget.addEventListener('click', () => forgetPrivate(forget));
    box.replaceChildren(
      h('p', { class: 'hint' }, h('strong', {}, `Includes ${n} private repo${n === 1 ? '' : 's'}`),
        ' (tool and language labels only, never names or code). You can also ', uninstall(), '.'),
      h('div', { class: 'private-repos__actions' }, privateLink('Re-scan private repos', true, 'btn btn--small'), forget),
    );
  }
  box.hidden = false;
}

async function forgetPrivate(button) {
  button.disabled = true;
  try {
    await api('/api/me/private-profile', { method: 'DELETE' });
    account.privateRepos = { ...account.privateRepos, repoCount: 0, scannedAt: null };
    renderPrivateRepos();
    hooks.notify?.('Private-repo signals deleted. Map your route again to plan without them.');
  } catch (err) {
    button.disabled = false;
    hooks.notify?.(`Could not delete private-repo signals: ${err.message}`);
  }
}

// ?private=<outcome> after the GitHub App round trip. Returns the outcome.
function takePrivateOutcome() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('private');
  if (!outcome) return null;
  params.delete('private');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  return outcome;
}

const PRIVATE_MESSAGES = {
  none: 'No private repos were granted, so nothing was added. You can pick repos in GitHub settings, then use Re-scan.',
  mismatch: 'That GitHub account is not the one you signed in with, so nothing was scanned. Sign in to GitHub as the same user and try again.',
  failed: 'Could not read your private repos. Nothing was stored. Try again in a moment.',
  unavailable: 'Private repos are not available on this server right now.',
};

// Text for the banner after the GitHub App round trip (pure, for tests).
export function privateBannerText(outcome, repoCount) {
  if (outcome === 'ready') {
    const n = Number(repoCount) || 0;
    return `✓ Private repos added: ${n} repo${n === 1 ? '' : 's'} scanned. Your plan now includes them.`;
  }
  return Object.hasOwn(PRIVATE_MESSAGES, outcome) ? PRIVATE_MESSAGES[outcome] : null;
}

// A dismissible status banner above the results. Text carries the meaning
// (a check mark or "Could not"), never color alone. action: optional button.
function showPrivateBanner(text, { ok = false, action = null } = {}) {
  const banner = $('#private-banner');
  if (!banner || !text) return;
  const close = h('button', { type: 'button', class: 'btn btn--small btn--quiet private-banner__close', 'aria-label': 'Dismiss this message' }, 'Dismiss');
  close.addEventListener('click', () => { banner.hidden = true; banner.replaceChildren(); });
  banner.classList.toggle('private-banner--ok', ok);
  banner.replaceChildren(
    h('p', { class: 'private-banner__text' }, h('strong', {}, text)),
    h('div', { class: 'private-banner__actions' }, action, close),
  );
  banner.hidden = false;
}

// Re-plans for the signed-in login. When that can't start (nothing to plan
// yet), the banner offers a button instead of failing silently.
async function replanWithPrivate() {
  const login = account.user?.login;
  if (!login) return;
  const ok = await hooks.regenerate?.(login, 'Private repos included. Route updated.');
  if (ok) {
    showPrivateBanner(privateBannerText('ready', account.privateRepos.repoCount), { ok: true });
    return;
  }
  const button = h('button', { type: 'button', class: 'btn btn--primary btn--small' }, 'Update my plan with private repos');
  button.addEventListener('click', replanWithPrivate);
  showPrivateBanner(`Private repos added: ${account.privateRepos.repoCount} scanned. Update your plan to include them.`, { ok: true, action: button });
}

function setSaveStatus(text) {
  const el = $('#save-status');
  if (el) el.textContent = text;
}

// The box under the plan's tools: sign-in prompt, or save status and opt-in.
function renderSaveBox() {
  const box = $('#account-save');
  if (!box) return;
  if (!account.enabled || !state.plan) {
    box.hidden = true;
    return;
  }
  if (!account.user) {
    box.replaceChildren(
      h('p', { class: 'account-save__prompt' }, signInLink('Save this plan: sign in with GitHub', 'account__link account__link--strong'),
        ' to come back and change it later.'),
    );
    box.hidden = false;
    return;
  }
  let status = $('#save-status');
  if (!status) status = h('p', { id: 'save-status', class: 'hint account-save__status', role: 'status', 'aria-live': 'polite' });
  const children = [status];
  if (canOptInProfile(state.profile, account.user)) {
    const box2 = h('input', { type: 'checkbox', id: 'social-opt-in', 'aria-describedby': 'social-opt-in-hint', checked: account.socialOptedIn });
    box2.addEventListener('change', () => setSocialOptIn(box2));
    children.push(
      h('div', { class: 'field field--check' },
        h('label', { class: 'check' }, box2, ' Let other signed-in attendees find me to meet'),
        h('p', { class: 'hint', id: 'social-opt-in-hint' }, 'Shares your name, avatar and the tools, topics and languages in your profile (including skills from a pasted LinkedIn profile, never its text). Never code or repo names. Untick to remove it.')),
    );
  }
  box.replaceChildren(...children);
  box.hidden = false;
}

export async function signOut() {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // reload anyway; the cookie expires on its own
  }
  window.location.assign('/');
}

// ---------- Saving ----------

let saveTimer = null;
let saveSeq = 0;

async function saveNow() {
  if (!account.user || !state.plan || !state.request) return;
  const conferenceId = state.plan.conferenceId || state.request.conferenceId;
  let snapshot = snapshotState(state);
  if (JSON.stringify(snapshot).length > MAX_SAVE_CHARS) snapshot = snapshotState(state, { includePlan: false });
  const mine = ++saveSeq;
  setSaveStatus('Saving…');
  try {
    const { savedAt } = await api('/api/me/plan', { method: 'PUT', body: { conferenceId, state: snapshot } });
    if (mine !== saveSeq) return;
    const time = new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    setSaveStatus(`Saved ✓ to your account at ${time}.`);
  } catch (err) {
    if (mine !== saveSeq) return;
    setSaveStatus(err.status === 401 ? 'Not saved: your sign-in expired. Sign in again to save.' : `Not saved: ${err.message}`);
  }
}

// app.js calls this after every generate, swap, pin, skip or reset.
export function notifyPlanChanged() {
  renderSaveBox();
  syncSignedInHint(); // a restored plan may have put another username in the field
  if (!account.user) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DELAY_MS);
}

async function setSocialOptIn(input) {
  const optIn = input.checked;
  input.disabled = true;
  try {
    await api('/api/me/social', {
      method: 'PUT',
      body: { conferenceId: state.plan?.conferenceId || hooks.conferenceId(), optIn, profile: optIn ? state.profile : undefined },
    });
    account.socialOptedIn = optIn;
    setSaveStatus(optIn ? 'You can now be suggested to other attendees.' : 'You are no longer suggested to other attendees.');
  } catch (err) {
    input.checked = !optIn;
    setSaveStatus(`Could not update: ${err.message}`);
  } finally {
    input.disabled = false;
  }
}

// ---------- Start-up ----------

function loginMessage() {
  const params = new URLSearchParams(window.location.search);
  const login = params.get('login');
  if (!login) return null;
  params.delete('login');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  if (login === 'failed') return 'GitHub sign-in did not complete. Try again, or keep planning without an account.';
  if (login === 'unavailable') return 'Sign-in is not available right now. You can still plan without an account.';
  return null;
}

// opts.conferenceId(): the selected conference. opts.restore(): re-renders
// the page from `state` after a saved plan was applied. opts.notify(text):
// announces a message.
export async function initAccount(opts) {
  hooks = { ...hooks, ...opts };
  const message = loginMessage();
  if (message) hooks.notify?.(message);
  try {
    const me = await api('/api/me');
    account.enabled = Boolean(me?.enabled);
    account.user = me?.user || null;
    const pr = me?.privateRepos;
    account.privateRepos = { enabled: Boolean(pr?.enabled), repoCount: Number(pr?.repoCount) || 0, scannedAt: pr?.scannedAt || null };
  } catch {
    account.enabled = false;
  }
  renderHeader();
  renderFormStart();
  renderPrivateRepos();
  const privateOutcome = takePrivateOutcome();
  if (privateOutcome && privateOutcome !== 'ready') showPrivateBanner(privateBannerText(privateOutcome));
  await restoreFlow();
  // Back from the GitHub App with signals stored: once the saved plan, form
  // and conference are restored, rebuild the plan for the user's own login.
  if (privateOutcome === 'ready' && account.user && account.privateRepos.repoCount) {
    await replanWithPrivate();
  } else if (privateOutcome === 'ready') {
    showPrivateBanner(PRIVATE_MESSAGES.failed);
  }
}

async function restoreFlow() {
  if (!account.user) {
    takePending(); // signed out: drop anything left over
    return;
  }

  // Just back from GitHub with a plan made before signing in: keep it and save it.
  const pending = takePending();
  if (pending && applySnapshot(state, pending)) {
    hooks.restore();
    renderFormStart();
    await loadSocial();
    notifyPlanChanged();
    return;
  }

  const conferenceId = hooks.conferenceId();
  if (!conferenceId) return;
  try {
    const { state: saved, savedAt } = await api(`/api/me/plan?conferenceId=${encodeURIComponent(conferenceId)}`);
    if (state.plan || !applySnapshot(state, saved)) return; // never overwrite a plan the user already made
    await loadSocial();
    hooks.restore();
    renderFormStart();
    renderSaveBox();
    syncSignedInHint();
    if (savedAt) {
      const when = new Date(savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      setSaveStatus(`Restored your saved plan (saved ${when}).`);
    }
  } catch (err) {
    hooks.notify?.(`Could not load your saved plan: ${err.message}`);
  }
}

// Switching conference cards while signed in: show that conference's saved
// plan, if there is one. Saves any pending change to the plan on screen first.
let switchSeq = 0;
export async function loadSavedFor(conferenceId) {
  if (!account.user || !conferenceId || state.loading) return false;
  if ((state.plan?.conferenceId || state.request?.conferenceId) === conferenceId) return false;
  const mine = ++switchSeq;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    await saveNow();
  }
  try {
    const { state: saved, savedAt } = await api(`/api/me/plan?conferenceId=${encodeURIComponent(conferenceId)}`);
    if (mine !== switchSeq || hooks.conferenceId() !== conferenceId || state.loading) return false;
    if (!saved?.request || saved.request.conferenceId !== conferenceId || !applySnapshot(state, saved)) return false;
    await loadSocial();
    if (mine !== switchSeq) return false;
    hooks.restore();
    renderSaveBox();
    syncSignedInHint(); // the restored plan may be for another username
    if (savedAt) setSaveStatus(`Showing your saved plan for this conference (saved ${new Date(savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}).`);
    return true;
  } catch (err) {
    if (mine === switchSeq) hooks.notify?.(`Could not load your saved plan: ${err.message}`);
    return false;
  }
}

async function loadSocial() {
  const conferenceId = state.plan?.conferenceId || state.request?.conferenceId || hooks.conferenceId();
  if (!conferenceId) return;
  try {
    const { optedIn } = await api(`/api/me/social?conferenceId=${encodeURIComponent(conferenceId)}`);
    account.socialOptedIn = Boolean(optedIn);
  } catch {
    account.socialOptedIn = false;
  }
}
