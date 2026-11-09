// Calls to the planner's HTTP API (see docs/CONTRACTS.md). Errors come back
// as ApiError with the API's { error: { code, message } } fields.

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function call(path, init) {
  let res;
  try {
    res = await fetch(path, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } });
  } catch {
    throw new ApiError('network', 'Could not reach the planner. Check your connection and try again.', 0);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON; handled below
  }
  if (!res.ok) {
    const err = body?.error;
    throw new ApiError(err?.code || 'internal', err?.message || `The planner answered ${res.status}.`, res.status);
  }
  if (!body) throw new ApiError('internal', 'The planner sent an unreadable answer.', res.status);
  return body;
}

export async function fetchConferences() {
  const body = await call('/api/conferences');
  return body.conferences || [];
}

// body: { conferenceId, github | interests, options }
export function requestPlan(body) {
  return call('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Schedule changes for the sessions in a plan (GET /api/changes).
// { conferenceId, since: ISO string, sessionIds: string[] (max 200) } -> { changes, checkedAt }
export function fetchChanges({ conferenceId, since, sessionIds }) {
  const params = new URLSearchParams({ conferenceId });
  if (since) params.set('since', since);
  if (sessionIds?.length) params.set('sessionIds', sessionIds.join(','));
  return call(`/api/changes?${params}`);
}

// "People to meet" (demo attendees). body: { conferenceId, profile,
// pickedSessionIds, limit, firstTimer }. Callers hide the panel on any error.
export function requestConnections(body) {
  return call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
