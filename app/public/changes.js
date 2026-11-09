// Live schedule changes: polls GET /api/changes for the sessions in the plan
// on screen, and shows a dismissible notice per affected pick with a fix
// ("Swap to backup" or "Re-plan around it"). Logic is in changes-logic.js.
import { fetchChanges } from './api.js';
import { formatDay, formatTime, zoneLabel } from './format.js';
import { h } from './render.js';
import { affectedPicks, replanChoices, watchedSessionIds } from './changes-logic.js';
import { state } from './state.js';

const POLL_MS = 60_000;

function when(iso, timeZone, withDay) {
  const day = withDay ? `${formatDay(iso.slice(0, 10))}, ` : '';
  return `${day}${formatTime(iso, timeZone)}`;
}

// "Argo and Flux… moved from 2:50 PM to 4:20 PM MT, now in Grand Ballroom BDF."
export function describeChange(change, timeZone) {
  const title = change.sessionTitle || 'A session in your plan';
  const b = change.before || {};
  const a = change.after || {};
  const zone = zoneLabel(timeZone, new Date(a.start || b.start || Date.now()));
  switch (change.type) {
    case 'cancelled':
      return `${title} was cancelled.`;
    case 'room_changed':
      return `${title} moved to ${a.room || 'another room'}${b.room ? ` (was ${b.room})` : ''}.`;
    case 'details_changed':
      return `${title}: the session's details changed. Check the official schedule.`;
    case 'time_changed': {
      if (!a.start || !b.start) return `${title} moved to a new time.`;
      const otherDay = a.start.slice(0, 10) !== b.start.slice(0, 10);
      const room = a.room && a.room !== b.room ? `, now in ${a.room}` : a.room ? ` (room ${a.room})` : '';
      return `${title} moved from ${when(b.start, timeZone, otherDay)} to ${when(a.start, timeZone, otherDay)} ${zone}${room}.`;
    }
    default:
      return `${title} changed.`;
  }
}

/**
 * @param {{ container: HTMLElement, announce: (msg: string) => void,
 *   swap: (date, slotIndex, backupIndex) => void,
 *   replan: (opts: { message, done }) => Promise<boolean> }} deps
 */
export function createChangeWatch({ container, announce, swap, replan }) {
  let changes = [];
  let checkedAt = null;
  let watchedKey = '';
  let seq = 0;
  let timer = null;
  const dismissed = new Set();
  const announced = new Set();
  let entries = [];
  let rendered = '';

  const timeZone = () => state.plan?.conference?.timezone || 'America/Denver';

  function render() {
    entries = state.plan ? affectedPicks(state.plan, changes, { pinned: state.pinned, dismissed }) : [];
    // Don't rebuild (and drop keyboard focus) when nothing changed since the last poll.
    const signature = JSON.stringify([checkedAt, entries.map((e) => [e.change.id, e.date, e.index, e.swap?.index, e.replan?.pin])]);
    if (signature === rendered) return;
    rendered = signature;
    container.hidden = entries.length === 0;
    if (!entries.length) {
      container.replaceChildren();
      return;
    }
    const fresh = [];
    const items = entries.map((entry, i) => {
      const text = describeChange(entry.change, timeZone());
      if (!announced.has(entry.change.id)) {
        announced.add(entry.change.id);
        fresh.push(text);
      }
      const actions = [];
      if (entry.swap) {
        actions.push(h('button', { type: 'button', class: 'btn btn--small btn--primary', dataset: { changeAction: 'swap', entry: i } },
          `Swap to backup: ${entry.swap.rec.session.title}`));
      }
      if (entry.replan) {
        actions.push(h('button', { type: 'button', class: entry.swap ? 'btn btn--small' : 'btn btn--small btn--primary', dataset: { changeAction: 'replan', entry: i } },
          entry.replan.pin ? 'Re-plan around the new time' : 'Re-plan around it'));
      }
      actions.push(h('button', { type: 'button', class: 'btn btn--small btn--quiet', dataset: { changeAction: 'dismiss', entry: i } },
        'Dismiss', h('span', { class: 'sr-only' }, ` the notice about ${entry.change.sessionTitle}`)));
      return h('li', { class: 'change' },
        h('p', { class: 'change__text' },
          h('span', { 'aria-hidden': 'true' }, '⚠ '),
          h('strong', {}, entry.change.source === 'simulated' ? 'Schedule change (demo): ' : 'Schedule change: '),
          text),
        h('div', { class: 'actions' }, actions));
    });
    container.replaceChildren(
      h('h2', { id: 'changes-heading', class: 'changes__title' }, 'Changes to your plan'),
      checkedAt ? h('p', { class: 'changes__meta' }, `Schedule last checked at ${formatTime(checkedAt, timeZone())} ${zoneLabel(timeZone())}.`) : null,
      h('ul', { class: 'changes__list' }, items));
    if (fresh.length) announce(`Schedule change: ${fresh.join(' ')}`);
  }

  async function refresh() {
    const plan = state.plan;
    if (!plan?.conferenceId) return;
    const mine = ++seq;
    try {
      const data = await fetchChanges({
        conferenceId: plan.conferenceId,
        since: plan.generatedAt,
        sessionIds: watchedSessionIds(plan),
      });
      if (mine !== seq) return;
      changes = Array.isArray(data.changes) ? data.changes : [];
      checkedAt = data.checkedAt || null;
      render();
    } catch {
      // Optional feature: keep what we had and try again on the next tick.
    }
  }

  function schedule() {
    if (timer) return;
    timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, POLL_MS);
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-change-action]');
    if (!btn) return;
    const entry = entries[Number(btn.dataset.entry)];
    if (!entry) return;
    const { changeAction } = btn.dataset;
    dismissed.add(entry.change.id);
    if (changeAction === 'swap') {
      swap(entry.date, entry.index, entry.swap.index);
    } else if (changeAction === 'replan') {
      if (state.loading) {
        dismissed.delete(entry.change.id);
        return;
      }
      const { pinned, skipped } = replanChoices(entry, state.pinned, state.skipped);
      state.pinned = pinned;
      state.skipped = skipped;
      const title = entry.change.sessionTitle;
      replan({
        message: `Re-planning around ${title}…`,
        done: entry.replan.pin ? `Kept ${title} at its new time. Route updated.` : `Dropped ${title}. Route updated.`,
      });
    } else {
      render();
      announce('Notice dismissed.');
      container.querySelector('button')?.focus();
    }
  });

  // Called whenever the plan on screen changes (new plan, swap, pin, skip).
  function planShown() {
    const key = state.plan ? `${state.plan.conferenceId}|${state.plan.generatedAt}|${[...watchedSessionIds(state.plan)].sort().join(',')}` : '';
    schedule();
    if (key !== watchedKey) {
      watchedKey = key;
      changes = [];
      refresh();
    }
    render();
  }

  return { planShown, refresh };
}
