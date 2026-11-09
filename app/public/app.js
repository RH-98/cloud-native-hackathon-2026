// Wires the page together: the form, loading and error states, plan actions
// (swap, pin, skip, day tabs) and the exports. Rendering lives in render.js,
// API calls in api.js, state and swaps in state.js, exports in ics.js.
import { initAccount, notifyPlanChanged } from './account.js';
import { ApiError, fetchConferences, requestConnections, requestPlan } from './api.js';
import { buildIcs, planToText } from './ics.js';
import { dateRange, formatDay } from './format.js';
import { h, planMeta, renderConnections, renderPlan, renderProfile } from './render.js';
import { applySwaps, countPicks, loadInputs, planRequest, saveInputs, slotKey, state, swapSlot } from './state.js';

const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const DEFAULT_CONFERENCE = 'kubecon-na-2026';
const PEOPLE_LIMIT = 5; // 1-20

const $ = (sel) => document.querySelector(sel);
const el = {
  form: $('#plan-form'),
  github: $('#github'),
  githubField: $('#github-field'),
  interests: $('#interests'),
  interestsField: $('#interests-field'),
  interestsCount: $('#interests-count'),
  conference: $('#conference'),
  daysList: $('#days-list'),
  firstTimer: $('#first-timer'),
  includeSponsored: $('#include-sponsored'),
  breakMinutes: $('#break-minutes'),
  suggestPeople: $('#suggest-people'),
  submit: $('#submit'),
  status: $('#status'),
  error: $('#error'),
  empty: $('#empty'),
  skeleton: $('#skeleton'),
  profile: $('#profile'),
  people: $('#people'),
  plan: $('#plan'),
  planMeta: $('#plan-meta'),
  planDays: $('#plan-days'),
  exportIcs: $('#export-ics'),
  copyText: $('#copy-text'),
  resetChoices: $('#reset-choices'),
};

// ---------- Announcements and errors ----------

// Polite live region. Clearing first makes repeated messages announce again.
function announce(message) {
  el.status.textContent = '';
  window.setTimeout(() => { el.status.textContent = message; }, 50);
}

function showError(err) {
  const code = err instanceof ApiError ? err.code : 'internal';
  const message = err?.message || 'Something went wrong.';
  el.error.replaceChildren(h('p', { class: 'alert__title' }, h('strong', {}, 'We could not build your route.'), ' ', message));
  if (code === 'rate_limited' || code === 'upstream' || code === 'not_found') {
    if (source() === 'github') {
      const hint = code === 'not_found'
        ? 'Check the spelling, or skip GitHub and type what you work on.'
        : 'GitHub is busy. You can still get a plan from your interests.';
      el.error.append(h('p', {}, hint), h('button', { type: 'button', class: 'btn btn--small', dataset: { action: 'use-interests' } }, 'Type my interests instead'));
    }
  }
  el.error.hidden = false;
}

function clearError() {
  el.error.hidden = true;
  el.error.replaceChildren();
}

function setLoading(on, message) {
  state.loading = on;
  el.submit.disabled = on;
  el.submit.setAttribute('aria-busy', on ? 'true' : 'false');
  el.submit.textContent = on ? 'Mapping your route…' : 'Map my route';
  el.plan.setAttribute('aria-busy', on ? 'true' : 'false');
  for (const b of el.plan.querySelectorAll('[data-action="pin"], [data-action="skip"]')) b.disabled = on;
  el.resetChoices.disabled = on;
  // Show the skeleton only when there is no plan on screen yet.
  el.skeleton.hidden = !on || !el.plan.hidden;
  if (on) {
    el.empty.hidden = true;
    announce(message);
  }
}

// ---------- Form ----------

function source() {
  return el.form.elements.source.value;
}

function setSource(value, { focus = false } = {}) {
  el.form.elements.source.value = value;
  el.githubField.hidden = value !== 'github';
  el.interestsField.hidden = value !== 'interests';
  if (focus) (value === 'github' ? el.github : el.interests).focus();
}

function updateCount() {
  el.interestsCount.textContent = `${el.interests.value.length} of 500 characters`;
}

function renderDays(conferenceId, checked) {
  const conf = state.conferences.find((c) => c.id === conferenceId);
  const dates = conf ? dateRange(conf.startDate, conf.endDate) : [];
  el.daysList.replaceChildren(...dates.map((date) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', name: 'days', value: date, checked: !checked || checked.includes(date) }),
    ` ${formatDay(date)}`)));
  $('#days-fieldset').hidden = !dates.length;
}

function readInputs() {
  const f = el.form.elements;
  const days = [...el.daysList.querySelectorAll('input:checked')].map((i) => i.value);
  const allDays = el.daysList.querySelectorAll('input').length;
  const levels = [...el.form.querySelectorAll('input[name="levels"]:checked')].map((i) => i.value);
  const breakMinutes = Math.max(0, Math.min(120, Math.round(Number(f.breakMinutes.value) || 0)));
  return {
    source: source(),
    github: el.github.value.trim().replace(/^@/, ''),
    interests: el.interests.value.trim(),
    conferenceId: el.conference.value || DEFAULT_CONFERENCE,
    // Always send the checked days (when known), so pre-event days stay out.
    days: allDays ? days : null,
    levels,
    firstTimer: el.firstTimer.checked,
    includeSponsored: el.includeSponsored.checked,
    breakMinutes,
    suggestPeople: el.suggestPeople.checked,
  };
}

function restoreInputs(saved) {
  if (!saved) return;
  if (typeof saved.github === 'string') el.github.value = saved.github;
  if (typeof saved.interests === 'string') el.interests.value = saved.interests.slice(0, 500);
  if (saved.source === 'interests' || saved.source === 'github') setSource(saved.source);
  for (const box of el.form.querySelectorAll('input[name="levels"]')) box.checked = (saved.levels || []).includes(box.value);
  el.firstTimer.checked = Boolean(saved.firstTimer);
  el.includeSponsored.checked = saved.includeSponsored !== false;
  if (Number.isFinite(saved.breakMinutes)) el.breakMinutes.value = String(saved.breakMinutes);
  el.suggestPeople.checked = saved.suggestPeople !== false;
  updateCount();
}

// Returns the API body, or null after showing a field error.
function buildRequest(inputs) {
  const body = { conferenceId: inputs.conferenceId };
  if (inputs.source === 'github') {
    if (!GITHUB_USER.test(inputs.github)) {
      showFieldError(el.github, inputs.github ? 'That does not look like a GitHub username (letters, numbers and single hyphens).' : 'Enter a GitHub username.');
      return null;
    }
    body.github = inputs.github;
  } else {
    if (!inputs.interests) {
      showFieldError(el.interests, 'Type at least one interest, for example "argo cd, opentelemetry".');
      return null;
    }
    body.interests = inputs.interests;
  }
  const options = {
    includeSponsored: inputs.includeSponsored,
    firstTimer: inputs.firstTimer,
    breakMinutes: inputs.breakMinutes,
  };
  if (inputs.days) {
    if (!inputs.days.length) {
      showFieldError(el.daysList.querySelector('input'), 'Pick at least one day.');
      return null;
    }
    options.days = inputs.days;
  }
  if (inputs.levels.length) options.levels = [...inputs.levels, 'Any Level'];
  body.options = options;
  return body;
}

function showFieldError(input, message) {
  clearFieldErrors();
  const id = 'field-error';
  const p = h('p', { class: 'field-error', id }, h('strong', {}, 'Error: '), message);
  const field = input?.closest('.field, fieldset') || el.form;
  field.append(p);
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') || '';
    input.setAttribute('aria-describedby', `${id} ${describedBy}`.trim());
    input.focus();
  }
}

function clearFieldErrors() {
  document.getElementById('field-error')?.remove();
  for (const input of el.form.querySelectorAll('[aria-invalid]')) {
    input.removeAttribute('aria-invalid');
    const rest = (input.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && x !== 'field-error');
    if (rest.length) input.setAttribute('aria-describedby', rest.join(' '));
    else input.removeAttribute('aria-describedby');
  }
}

// ---------- Plan ----------

function showPlan({ focusKey } = {}) {
  el.plan.hidden = false;
  el.empty.hidden = true;
  el.planMeta.textContent = planMeta(state.plan);
  state.activeDay = renderPlan(el.planDays, state.plan, state.activeDay);
  el.resetChoices.hidden = !(state.pinned.size || state.skipped.size || state.swaps.size);
  if (focusKey) {
    const target = el.planDays.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (target) target.focus();
  }
}

// Only the latest plan request may render, whatever order responses arrive in.
let planRequestSeq = 0;
async function loadPlan(body, { message, done, focusKey, fresh = false }) {
  const mine = ++planRequestSeq;
  clearError();
  setLoading(true, message);
  try {
    const { profile, plan } = await requestPlan(planRequest(body, state.pinned, state.skipped));
    if (mine !== planRequestSeq) return false;
    state.request = body;
    state.profile = profile;
    state.plan = applySwaps(plan, state.swaps);
    renderProfile(el.profile, profile);
    el.profile.hidden = false;
    if (fresh) state.activeDay = null;
    setLoading(false);
    showPlan({ focusKey });
    const n = countPicks(state.plan);
    announce(done || `Route ready: ${n} session${n === 1 ? '' : 's'} over ${state.plan.days.length} day${state.plan.days.length === 1 ? '' : 's'}.`);
    if (fresh) $('#profile-heading')?.scrollIntoView({ block: 'start' });
    loadPeople();
    notifyPlanChanged();
    return true;
  } catch (err) {
    if (mine !== planRequestSeq) return false;
    setLoading(false);
    showError(err);
    if (el.plan.hidden && el.profile.hidden) el.empty.hidden = false;
    announce('');
    return false;
  }
}

// "People to meet": optional. Any error (including 404 before the route
// exists) hides the panel quietly. Only the latest request may render.
let peopleRequest = 0;
async function loadPeople() {
  const mine = ++peopleRequest;
  // Opt-in: only ask for people when the box is ticked.
  if (!el.suggestPeople.checked) {
    el.people.hidden = true;
    el.people.replaceChildren();
    return;
  }
  const plan = state.plan;
  const picked = [];
  for (const day of plan?.days || []) for (const slot of day.slots || []) if (slot.pick?.session?.id) picked.push(slot.pick.session.id);
  try {
    const data = await requestConnections({
      conferenceId: plan.conferenceId,
      profile: state.profile,
      pickedSessionIds: picked.slice(0, 100),
      limit: PEOPLE_LIMIT,
      firstTimer: Boolean(state.request?.options?.firstTimer),
    });
    if (mine !== peopleRequest) return;
    el.people.hidden = !renderConnections(el.people, data, plan.conference?.timezone || 'UTC');
  } catch {
    if (mine === peopleRequest) el.people.hidden = true;
  }
}

function findSlot(date, index) {
  const day = state.plan?.days.find((d) => d.date === date);
  return day ? { day, slot: day.slots[Number(index)] } : {};
}

function onSwap(date, index, backupIndex) {
  const { slot } = findSlot(date, index);
  if (!slot) return;
  const rec = swapSlot(slot, Number(backupIndex) || 0);
  if (!rec) return;
  state.swaps.set(slotKey(date, slot), rec.session.id);
  // A swapped slot is no longer pinned to the old pick.
  for (const b of slot.backups) state.pinned.delete(b?.session?.id);
  showPlan({ focusKey: `pick-${date}-${index}` });
  announce(`Swapped in ${rec.session.title}.`);
  notifyPlanChanged();
}

function onPin(date, index) {
  const { slot } = findSlot(date, index);
  if (!slot?.pick || state.loading) return;
  const id = slot.pick.session.id;
  const title = slot.pick.session.title;
  const pin = !slot.pinned;
  if (pin) state.pinned.add(id);
  else state.pinned.delete(id);
  loadPlan(state.request, {
    message: pin ? `Pinning ${title} and updating your route…` : `Unpinning ${title}…`,
    done: pin ? `Pinned ${title}. Route updated.` : `Unpinned ${title}. Route updated.`,
    focusKey: `pin-${date}-${index}`,
  });
}

function onSkip(date, index) {
  const { slot } = findSlot(date, index);
  if (!slot?.pick || state.loading) return;
  const { id, title } = slot.pick.session;
  state.skipped.add(id);
  state.pinned.delete(id);
  state.swaps.delete(slotKey(date, slot));
  loadPlan(state.request, {
    message: `Skipping ${title} and finding another…`,
    done: `Skipped ${title}. Route updated.`,
    focusKey: `pick-${date}-${index}`,
  });
}

function onTab(date, { focus = true } = {}) {
  state.activeDay = date;
  for (const tab of el.planDays.querySelectorAll('[role="tab"]')) {
    const on = tab.dataset.day === date;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const panel of el.planDays.querySelectorAll('[role="tabpanel"]')) panel.hidden = panel.id !== `panel-${date}`;
}

// Arrow keys, Home and End move between day tabs.
function onTabKey(event) {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const tabs = [...el.planDays.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(tab);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  const target = tabs[(next + tabs.length) % tabs.length];
  onTab(target.dataset.day);
}

// ---------- Exports ----------

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportIcs() {
  if (!state.plan) return;
  download(`switchback-${state.plan.conferenceId}.ics`, buildIcs(state.plan), 'text/calendar;charset=utf-8');
  announce('Calendar file downloaded. Open it to add your sessions.');
}

async function copyText() {
  if (!state.plan) return;
  const text = planToText(state.plan);
  try {
    await navigator.clipboard.writeText(text);
    announce('Plan copied to the clipboard.');
  } catch {
    download(`switchback-${state.plan.conferenceId}.txt`, text, 'text/plain;charset=utf-8');
    announce('Could not use the clipboard, so the plan was downloaded as a text file.');
  }
}

// ---------- Start-up ----------

async function init() {
  const saved = loadInputs();
  restoreInputs(saved);

  el.form.addEventListener('change', (e) => {
    if (e.target.name === 'source') setSource(e.target.value, { focus: true });
    if (e.target === el.conference) renderDays(el.conference.value);
  });
  el.interests.addEventListener('input', updateCount);
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.loading) return;
    clearFieldErrors();
    const inputs = readInputs();
    const body = buildRequest(inputs);
    if (!body) return;
    saveInputs(inputs);
    state.pinned.clear();
    state.skipped.clear();
    state.swaps.clear();
    const who = body.github ? `@${body.github}'s public repos` : 'your interests';
    await loadPlan(body, { message: `Reading ${who} and scouting sessions…`, fresh: true });
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName !== 'BUTTON') return;
    const { action, day, slot, backup } = btn.dataset;
    if (action === 'swap') onSwap(day, slot, backup);
    else if (action === 'pin') onPin(day, slot);
    else if (action === 'skip') onSkip(day, slot);
    else if (action === 'tab') onTab(day);
    else if (action === 'use-interests') {
      clearError();
      setSource('interests', { focus: true });
    }
  });
  el.planDays.addEventListener('keydown', onTabKey);
  el.exportIcs.addEventListener('click', exportIcs);
  el.copyText.addEventListener('click', copyText);
  el.resetChoices.addEventListener('click', () => {
    if (state.loading || !state.request) return;
    state.pinned.clear();
    state.skipped.clear();
    state.swaps.clear();
    loadPlan(state.request, { message: 'Clearing pins and skips…', done: 'Pins, skips and swaps cleared. Route updated.' });
  });

  try {
    state.conferences = await fetchConferences();
  } catch {
    state.conferences = [];
  }
  if (state.conferences.length) {
    el.conference.replaceChildren(...state.conferences.map((c) => h('option', { value: c.id }, c.name)));
    const want = saved?.conferenceId && state.conferences.some((c) => c.id === saved.conferenceId) ? saved.conferenceId : DEFAULT_CONFERENCE;
    if (state.conferences.some((c) => c.id === want)) el.conference.value = want;
  }
  renderDays(el.conference.value, saved?.conferenceId === el.conference.value ? saved?.days : null);
  initAccount({ conferenceId: () => el.conference.value, restore: restoreSaved, notify: announce });
}

// Shows a plan restored from the user's account (account.js has already put
// it into `state`). Without a stored plan, re-requests it.
function restoreSaved() {
  const req = state.request;
  if (req.github) {
    el.github.value = req.github;
    setSource('github');
  } else if (req.interests) {
    el.interests.value = req.interests;
    setSource('interests');
    updateCount();
  }
  if (!state.plan) {
    loadPlan(req, { message: 'Loading your saved plan…', done: 'Your saved plan is back.', fresh: true });
    return;
  }
  if (state.profile) {
    renderProfile(el.profile, state.profile);
    el.profile.hidden = false;
  }
  showPlan();
  announce('Your saved plan is back.');
  loadPeople();
}

init();
