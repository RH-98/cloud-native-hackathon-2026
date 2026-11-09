// Rebuild the KubeCon NA 2026 snapshot from the official public pages:
//   cd app && npm run import:kubecon
// Writes data/conferences/kubecon-na-2026.json in the common conference format.
const fs = require('node:fs/promises');
const path = require('node:path');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { parseSchedule, parseSponsors } = require('../importers/lf-events');

const tracer = trace.getTracer('conference-importer');

const BASE = 'https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america';
const conference = {
  id: 'kubecon-na-2026',
  name: 'KubeCon + CloudNativeCon North America 2026',
  location: 'Salt Palace Convention Center, Salt Lake City, Utah',
  timezone: 'America/Denver',
  utcOffset: '-07:00', // MST during the event (Nov 8-12)
  startDate: '2026-11-09',
  endDate: '2026-11-12',
};

async function fetchText(url, spanName) {
  return tracer.startActiveSpan(spanName, { attributes: { 'url.full': url } }, async (span) => {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'conference-planner-importer (Cloud Native Hackathon 2026)' },
        signal: AbortSignal.timeout(30_000),
      });
      span.setAttribute('http.response.status_code', res.status);
      if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function main() {
  const scheduleUrl = `${BASE}/program/schedule/`;
  const sponsorsUrl = `${BASE}/sponsor-list/`;
  const [scheduleHtml, sponsorsHtml] = await Promise.all([
    fetchText(scheduleUrl, 'conference.schedule.fetch'),
    fetchText(sponsorsUrl, 'conference.sponsors.fetch'),
  ]);

  const sessions = parseSchedule(scheduleHtml, {
    conferenceId: conference.id,
    utcOffset: conference.utcOffset,
    pageUrl: scheduleUrl,
  });
  const sponsors = parseSponsors(sponsorsHtml, { conferenceId: conference.id });
  if (sessions.length === 0) throw new Error('No sessions parsed: the schedule page layout may have changed');

  const snapshot = {
    conference: {
      ...conference,
      source: { scheduleUrl, sponsorsUrl, retrievedAt: new Date().toISOString() },
    },
    sessions: sessions.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.title.localeCompare(b.title)),
    sponsors: sponsors.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const out = path.join(__dirname, '..', 'data', 'conferences', `${conference.id}.json`);
  await fs.writeFile(out, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`Wrote ${sessions.length} sessions and ${sponsors.length} sponsors to ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
