// Connection requests between opted-in attendees ("People to meet": Connect).
//   GET    /api/me/connections[?conferenceId=]   -> { outgoing, incoming, accepted }
//   POST   /api/me/connections                   { conferenceId, to: { userId } | { demoHandle } }
//   POST   /api/me/connections/:id/accept | /decline   (the recipient)
//   DELETE /api/me/connections/:id               (the sender withdraws a request not yet accepted)
// Signed in only; writes need a same-origin request. Called from app/api/me.js,
// which supplies the database wrapper (503 on failure), sign-in and CSRF checks.
//
// Privacy: a real attendee can only be asked if they opted in to "People to
// meet" for that conference, and only an opted-in attendee can ask. Each side
// sees only what "People to meet" already shows (name, @login, shared public
// tools and topics); the GitHub profile link appears once both agreed. A
// decline is never revealed to the sender: it stays "requested" for them.
// Demo attendees are fictional: requests to them are accepted at once and
// marked simulated.
const { HttpError, sendJson, sendError, readJsonBody } = require('./http');
const { loadAttendees } = require('../social');
const { matchAttendees } = require('../social/match');

const CONFERENCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USER_ID = /^[1-9][0-9]{0,17}$/;
const DEMO_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQUEST_PATH = /^\/api\/me\/connections\/([1-9][0-9]{0,17})(?:\/(accept|decline))?$/;
const DEMO_NOTE = 'Demo attendee: auto-accepted (simulated)';

const bad = (message) => new HttpError('invalid_input', message);

// The viewer's state with each person, keyed `user:<id>` or `demo:<handle>`:
// connected > incoming > requested. Declined incoming requests count as none.
function requestStates(rows, viewerId) {
  const rank = { requested: 1, incoming: 2, connected: 3 };
  const states = new Map();
  const put = (key, state, requestId) => {
    const prev = states.get(key);
    if (!prev || rank[state] > rank[prev.state]) states.set(key, { state, requestId });
  };
  for (const r of rows || []) {
    if (r.fromUserId === String(viewerId)) {
      const key = r.toUserId ? `user:${r.toUserId}` : `demo:${r.toDemoHandle}`;
      put(key, r.status === 'accepted' ? 'connected' : 'requested', r.id);
    } else if (r.toUserId === String(viewerId)) {
      if (r.status === 'accepted') put(`user:${r.fromUserId}`, 'connected', r.id);
      else if (r.status === 'pending') put(`user:${r.fromUserId}`, 'incoming', r.id);
    }
  }
  return states;
}

// The key of a "People to meet" suggestion, matching requestStates().
function candidateKey(attendee) {
  if (!attendee) return null;
  if (attendee.demo === false) return attendee.userId ? `user:${attendee.userId}` : null;
  return attendee.handle ? `demo:${attendee.handle}` : null;
}

// Adds requestState (none | requested | incoming | connected) and, when
// there is one, requestId to each suggestion.
function withRequestStates(connections, states) {
  return connections.map((c) => {
    const key = candidateKey(c.attendee);
    if (!key) return c;
    const s = states.get(key);
    return { ...c, requestState: s ? s.state : 'none', ...(s ? { requestId: s.requestId } : {}) };
  });
}

function demoAttendee(conferenceId, handle) {
  const list = loadAttendees(conferenceId) || [];
  return list.find((a) => a && a.optIn === true && a.handle === handle) || null;
}

// Shared public tools and topics between the viewer's opted-in signals and
// another attendee's, as "People to meet" shows them. [] when either side
// has none.
function sharedLabels(viewerProfile, attendee) {
  if (!viewerProfile || !attendee) return [];
  const [match] = matchAttendees(viewerProfile, [{ ...attendee, optIn: true }], { limit: 1 });
  return match ? match.shared : [];
}

function createRequestRoutes({ db, requireUser, requireSameOrigin }) {
  // Per-conference context for one response: the viewer's opted-in signals
  // and the other opted-in attendees' signals (to name what is shared).
  async function contextFor(user, conferenceId, cache) {
    if (!cache.has(conferenceId)) {
      cache.set(conferenceId, (async () => {
        const [mine, others] = await Promise.all([
          db((d) => d.getSocialProfile(user.id, conferenceId)),
          db((d) => d.listOptedInProfiles(conferenceId)),
        ]);
        return { viewerProfile: mine ? mine.profile : null, profiles: new Map((others || []).map((p) => [String(p.userId), p])) };
      })());
    }
    return cache.get(conferenceId);
  }

  // A request as the viewer sees it: only public fields of the other side.
  async function view(r, user, cache) {
    const ctx = await contextFor(user, r.conferenceId, cache);
    const outgoing = r.fromUserId === String(user.id);
    // A decline stays "pending" for the sender, timestamp included.
    const hideDecline = outgoing && r.status === 'declined';
    let person;
    let shared = [];
    let simulated = false;
    if (r.toDemoHandle) {
      const a = demoAttendee(r.conferenceId, r.toDemoHandle);
      person = { displayName: a ? a.displayName : r.toDemoHandle, handle: r.toDemoHandle, role: a?.role || null, bio: a?.bio || null, demo: true };
      shared = sharedLabels(ctx.viewerProfile, a);
      simulated = true;
    } else {
      const other = outgoing ? { id: r.toUserId, ...r.to } : { id: r.fromUserId, ...r.from };
      const accepted = r.status === 'accepted';
      person = {
        displayName: other.name || other.login,
        handle: other.login,
        demo: false,
        // The way to reach them, once both agreed.
        profileUrl: accepted ? `https://github.com/${encodeURIComponent(other.login)}` : null,
      };
      const p = ctx.profiles.get(String(other.id));
      if (p) shared = sharedLabels(ctx.viewerProfile, { handle: other.login, fictional: false, interests: p.profile || {} });
    }
    return {
      id: r.id,
      conferenceId: r.conferenceId,
      direction: outgoing ? 'outgoing' : 'incoming',
      status: hideDecline ? 'pending' : r.status,
      createdAt: r.createdAt,
      updatedAt: hideDecline ? r.createdAt : r.updatedAt,
      person,
      shared,
      ...(simulated ? { simulated: true, note: DEMO_NOTE } : {}),
    };
  }

  async function list(user, conferenceId) {
    const rows = await db((d) => d.listConnectionRequests(user.id, conferenceId));
    const cache = new Map();
    const out = { outgoing: [], incoming: [], accepted: [] };
    for (const r of rows) {
      const outgoing = r.fromUserId === String(user.id);
      if (r.status === 'accepted') out.accepted.push(await view(r, user, cache));
      else if (outgoing) out.outgoing.push(await view(r, user, cache));
      else if (r.status === 'pending') out.incoming.push(await view(r, user, cache));
    }
    return out;
  }

  async function create(req, res, user) {
    const body = await readJsonBody(req, 4 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object');
    const { conferenceId, to } = body;
    if (typeof conferenceId !== 'string' || !CONFERENCE_ID.test(conferenceId)) throw bad('conferenceId must be a conference id');
    if (!to || typeof to !== 'object' || Array.isArray(to)) throw bad('to must be { userId } or { demoHandle }');
    const hasUser = typeof to.userId === 'string' && USER_ID.test(to.userId);
    const hasDemo = typeof to.demoHandle === 'string' && DEMO_HANDLE.test(to.demoHandle);
    if (hasUser === hasDemo) throw bad('to must be { userId } or { demoHandle }');
    const cache = new Map();

    if (hasDemo) {
      if (!demoAttendee(conferenceId, to.demoHandle)) throw new HttpError('not_found', 'That attendee is not available to connect');
      const { request, created } = await db((d) => d.createConnectionRequest({
        conferenceId, fromUserId: user.id, to: { demoHandle: to.demoHandle }, status: 'accepted',
      }));
      return sendJson(res, created ? 201 : 200, { request: await view(request, user, cache) });
    }

    if (to.userId === String(user.id)) throw bad('You can’t send a connection request to yourself');
    const [mine, others] = await Promise.all([
      db((d) => d.getSocialProfile(user.id, conferenceId)),
      db((d) => d.listOptedInProfiles(conferenceId)),
    ]);
    if (!mine) throw new HttpError('forbidden', 'Turn on “People to meet” for this conference on your account page first, so they can see who is asking.');
    // Not opted in, or no such user: the same answer either way.
    if (!(others || []).some((p) => String(p.userId) === to.userId)) throw new HttpError('not_found', 'That attendee is not available to connect');

    // They already asked you: connecting accepts their request.
    const existing = await db((d) => d.listConnectionRequests(user.id, conferenceId));
    const theirs = existing.find((r) => r.fromUserId === to.userId && r.toUserId === String(user.id));
    if (theirs) {
      const request = theirs.status === 'accepted' ? theirs : await db((d) => d.answerConnectionRequest(theirs.id, user.id, 'accepted'));
      return sendJson(res, 200, { request: await view(request || theirs, user, cache) });
    }
    const { request, created } = await db((d) => d.createConnectionRequest({ conferenceId, fromUserId: user.id, to: { userId: to.userId } }));
    return sendJson(res, created ? 201 : 200, { request: await view(request, user, cache) });
  }

  // Returns true when it handled the path.
  return async function routeRequests(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/me/connections') {
      if (m === 'GET') {
        const raw = url.searchParams.get('conferenceId');
        if (raw !== null && !CONFERENCE_ID.test(raw)) throw bad('conferenceId must be a conference id such as kubecon-na-2026');
        const user = await requireUser(req);
        return sendJson(res, 200, await list(user, raw));
      }
      if (m === 'POST') {
        requireSameOrigin(req);
        const user = await requireUser(req);
        return create(req, res, user);
      }
      return sendError(res, 'method_not_allowed', 'Use GET or POST', { allow: 'GET, POST' });
    }
    const match = REQUEST_PATH.exec(p);
    if (!match) return sendError(res, 'not_found', 'No such API route');
    const [, id, action] = match;
    if (action) {
      if (m !== 'POST') return sendError(res, 'method_not_allowed', 'Use POST', { allow: 'POST' });
      requireSameOrigin(req);
      const user = await requireUser(req);
      const updated = await db((d) => d.answerConnectionRequest(id, user.id, action === 'accept' ? 'accepted' : 'declined'));
      if (!updated) throw new HttpError('not_found', 'No open request with that id was sent to you');
      return sendJson(res, 200, { request: await view(updated, user, new Map()) });
    }
    if (m !== 'DELETE') return sendError(res, 'method_not_allowed', 'Use DELETE', { allow: 'DELETE' });
    requireSameOrigin(req);
    const user = await requireUser(req);
    const deleted = await db((d) => d.withdrawConnectionRequest(id, user.id));
    if (!deleted) throw new HttpError('not_found', 'No open request with that id from you');
    return sendJson(res, 200, { deleted: true });
  };
}

module.exports = { createRequestRoutes, requestStates, withRequestStates, candidateKey, DEMO_NOTE };
