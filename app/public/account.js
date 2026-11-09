// Accounts (optional): "Sign in with GitHub", auto-saving the plan for the
// signed-in user, restoring it on the next visit, and the social opt-in.
// When the server has accounts off (GET /api/me says enabled: false), none
// of this shows and the planner works exactly as before.
// The DOM is only touched inside functions, so node:test can import the
// pure helpers (snapshotState, applySnapshot, isOwnGithubProfile).
import { h } from './render.js';
import { state } from './state.js';

const SAVE_DELAY_MS = 800;
const MAX_SAVE_CHARS = 450 * 1024; // the server takes up to 500 KB of state
const PENDING_KEY = 'switchback:pending-save';

const account = {
  enabled: false,
  user: null,
  conferenceId: null,
  socialOptedIn: false,
};
let hooks = { conferenceId: () => null, restore: () => {} };

// ---------- Pure helpers ----------

// What the server stores for a plan: enough to put the page back as it was.
export function snapshotState(s, { includePlan = true } = {}) {
  return {
    request: s.request,
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

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
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
    const u = account.user;
    const avatar = u.avatarUrl ? h('img', { class: 'account__avatar', src: u.avatarUrl, alt: '', width: 28, height: 28 }) : null;
    const out = h('button', { type: 'button', class: 'btn btn--small account__out' }, 'Sign out');
    out.addEventListener('click', signOut);
    nav.replaceChildren(
      h('span', { class: 'account__who' }, avatar, h('span', {}, 'Signed in as ', h('strong', {}, `@${u.login}`))),
      out,
    );
  }
  nav.hidden = false;
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

async function signOut() {
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
  if (!account.user) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, SAVE_DELAY_MS);
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
  } catch {
    account.enabled = false;
  }
  renderHeader();
  if (!account.user) {
    takePending(); // signed out: drop anything left over
    return;
  }

  // Just back from GitHub with a plan made before signing in: keep it and save it.
  const pending = takePending();
  if (pending && applySnapshot(state, pending)) {
    hooks.restore();
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
    renderSaveBox();
    if (savedAt) {
      const when = new Date(savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      setSaveStatus(`Restored your saved plan (saved ${when}).`);
    }
  } catch (err) {
    hooks.notify?.(`Could not load your saved plan: ${err.message}`);
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
