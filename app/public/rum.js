// Real-user monitoring: the Dash0 Web SDK, as service `switchback-web`.
// Loaded before app.js / account-page.js so it sees page loads, Web Vitals,
// errors and fetches from the start; same-origin fetches carry a W3C
// traceparent, so a browser request links to its backend trace in
// `conference-planner`. Settings come from /config.js (null in local dev and
// CI: then nothing is sent). Everything is wrapped: RUM never breaks the page.
import config from '/config.js';
import { init, identify } from '/vendor/dash0-sdk-web.js';

const ANON_KEY = 'sb_rum_anon_id';

function anonymousId() {
  try {
    let id = localStorage.getItem(ANON_KEY);
    if (!id) {
      id = `anon-${crypto.randomUUID()}`;
      localStorage.setItem(ANON_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

async function identifyViewer() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const me = res.ok ? await res.json() : null;
    const user = me && me.user;
    if (user && typeof user.login === 'string') {
      identify(user.login, { name: user.name || user.login });
      return;
    }
  } catch {
    // Fall through to an anonymous id.
  }
  try {
    const id = anonymousId();
    if (id) identify(id);
  } catch {
    // Ignore.
  }
}

try {
  const dash0 = config && config.dash0;
  if (dash0 && dash0.url && dash0.authToken) {
    init({
      serviceName: dash0.serviceName || 'switchback-web',
      serviceVersion: dash0.version,
      environment: dash0.environment,
      endpoint: { url: dash0.url, authToken: dash0.authToken },
    });
    identifyViewer();
  }
} catch {
  // RUM is best effort.
}
