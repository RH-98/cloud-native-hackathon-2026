// "People to meet": Connect. Shows and changes the signed-in viewer's
// connection request with each suggested person (POST /api/me/connections,
// /accept, /decline, DELETE to withdraw), plus the header badge for requests
// waiting for an answer. State is shown in text and an icon, never color
// alone, and every change is announced in the card's live region.
// The DOM is only touched inside functions, so node:test can import connectView.
import { h } from './render.js';

const DEMO_NOTE = 'Demo attendee: auto-accepted (simulated).';

// Pure: what a card shows. connect = the /api/connections `connect` field.
// null: nothing (accounts off, or a person who can't be asked).
export function connectView(c, connect) {
  if (!connect?.enabled || !c?.attendee) return null;
  if (!connect.signedIn) return { kind: 'signin' };
  const a = c.attendee;
  if (a.demo === false && !a.userId) return null;
  const kind = ['requested', 'incoming', 'connected'].includes(c.requestState) ? c.requestState : 'none';
  return { kind, requestId: c.requestId || null, demo: a.demo !== false };
}

// Pure: the text for a badge count, or null for none.
export function badgeText(n) {
  const count = Number(n) || 0;
  if (count <= 0) return null;
  return { visible: count > 9 ? '9+' : String(count), spoken: `${count} connection request${count === 1 ? '' : 's'}` };
}

// The header badge next to the avatar link, or null.
export function requestBadge(n) {
  const t = badgeText(n);
  if (!t) return null;
  return h('span', { class: 'account__badge' },
    h('span', { 'aria-hidden': 'true' }, t.visible),
    h('span', { class: 'sr-only' }, `, ${t.spoken}`));
}

async function send(path, method, body) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data?.error?.message || `The server answered ${res.status}.`);
  return data;
}

const btn = (text, onClick, extra = '') => {
  const b = h('button', { type: 'button', class: `btn btn--small ${extra}`.trim() }, text);
  b.addEventListener('click', onClick);
  return b;
};

// A card's Connect controls, or null. ctx: { conferenceId, connect, signInLink? }.
export function connectControls(c, ctx) {
  const view = connectView(c, ctx?.connect);
  if (!view) return null;
  const box = h('div', { class: 'person__connect' });
  const status = h('p', { class: 'person__connect-status', role: 'status' });
  const name = c.attendee.displayName || c.attendee.handle || 'this attendee';
  let current = { ...c };

  const say = (text) => {
    status.textContent = '';
    window.setTimeout(() => { status.textContent = text; }, 50);
  };

  async function act(fn, done) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const data = await fn();
      const r = data?.request;
      current = {
        ...current,
        requestId: r ? r.id : null,
        requestState: !r ? 'none' : r.status === 'accepted' ? 'connected' : r.direction === 'incoming' ? (r.status === 'pending' ? 'incoming' : 'none') : 'requested',
      };
      draw();
      box.querySelector('button, a')?.focus();
      say(done(r));
    } catch (err) {
      for (const b of box.querySelectorAll('button')) b.disabled = false;
      say(`Could not update: ${err.message}`);
    }
  }

  function draw() {
    const v = connectView(current, ctx.connect);
    const a = current.attendee;
    let row;
    if (v.kind === 'signin') {
      row = [ctx.signInLink ? ctx.signInLink('Sign in to connect', 'btn btn--small btn--quiet')
        : h('a', { class: 'btn btn--small btn--quiet', href: '/auth/github/login?returnTo=%2F' }, 'Sign in to connect')];
    } else if (v.kind === 'none') {
      row = [btn(['+ Connect', h('span', { class: 'sr-only' }, ` with ${name}`)], () => act(
        () => send('/api/me/connections', 'POST', { conferenceId: ctx.conferenceId, to: a.demo === false ? { userId: a.userId } : { demoHandle: a.handle } }),
        (r) => (r?.simulated ? `Connected with ${name}. ${DEMO_NOTE}` : r?.status === 'accepted' ? `Connected with ${name}.` : `Connection request sent to ${name}.`),
      ), 'btn--primary')];
    } else if (v.kind === 'requested') {
      row = [h('span', { class: 'person__connect-state' }, '✓ Requested'),
        btn(['Withdraw', h('span', { class: 'sr-only' }, ` request to ${name}`)], () => act(
          () => send(`/api/me/connections/${encodeURIComponent(v.requestId)}`, 'DELETE').then(() => ({ request: null })),
          () => `Withdrew your request to ${name}.`,
        ), 'btn--quiet')];
    } else if (v.kind === 'incoming') {
      row = [h('span', { class: 'person__connect-state' }, '→ Wants to connect'),
        btn(['Accept', h('span', { class: 'sr-only' }, ` ${name}`)], () => act(
          () => send(`/api/me/connections/${encodeURIComponent(v.requestId)}/accept`, 'POST'),
          () => `Connected with ${name}.`,
        ), 'btn--primary'),
        btn(['Decline', h('span', { class: 'sr-only' }, ` ${name}`)], () => act(
          () => send(`/api/me/connections/${encodeURIComponent(v.requestId)}/decline`, 'POST'),
          () => `Declined ${name}'s request.`,
        ), 'btn--quiet')];
    } else {
      row = [h('span', { class: 'person__connect-state' }, '✓ Connected'),
        v.demo ? h('span', { class: 'person__connect-note' }, DEMO_NOTE)
          : [' · ', h('a', { href: `https://github.com/${encodeURIComponent(a.handle)}`, rel: 'noopener noreferrer', target: '_blank' }, `@${a.handle}`, h('span', { class: 'sr-only' }, ' on GitHub (opens in a new tab)'))]];
    }
    box.replaceChildren(h('div', { class: 'person__connect-row' }, ...row.flat()), status);
  }

  draw();
  return box;
}
