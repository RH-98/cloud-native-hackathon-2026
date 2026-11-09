// Rebuild the Convergence 2026 snapshot from its public sources:
//   cd app && npm run import:convergence
// Sessions come from the event's public Sessionize API, sponsors from its
// sponsor page. Writes data/conferences/convergence-2026.json in the common
// conference format. Session content belongs to the organizers and speakers;
// every session links back to the official sessions page.
const fs = require('node:fs/promises');
const path = require('node:path');
const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { parseSessionize } = require('../importers/sessionize');
const { parseSponsorLogos } = require('../importers/sponsor-logos');

const tracer = trace.getTracer('conference-importer');

const SESSIONIZE_ID = 'i9eggm8p'; // from the Sessionize embed on convergence365.com/sessions/
const conference = {
  id: 'convergence-2026',
  name: 'Convergence 2026',
  location: 'Fontainebleau Miami Beach, Miami Beach, Florida',
  timezone: 'America/New_York',
  utcOffset: '-05:00', // EST during the event (Dec 8-11)
  // Dec 8 is the separately ticketed Partner Pre-Day, which has no sessions on
  // the public schedule; the planned conference days are Dec 9-11.
  startDate: '2026-12-09',
  endDate: '2026-12-11',
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
  const apiUrl = `https://sessionize.com/api/v2/${SESSIONIZE_ID}/view/All`;
  const scheduleUrl = 'https://convergence365.com/sessions/';
  const sponsorsUrl = 'https://convergence365.com/our-sponsors/';
  const [json, sponsorsHtml] = await Promise.all([
    fetchText(apiUrl, 'conference.schedule.fetch'),
    fetchText(sponsorsUrl, 'conference.sponsors.fetch'),
  ]);

  const sessions = parseSessionize(JSON.parse(json), {
    conferenceId: conference.id,
    utcOffset: conference.utcOffset,
    sessionUrl: scheduleUrl,
    // Community sessions name a Primary Product, Microsoft-led ones a Product Team.
    trackCategory: ['Primary Product', 'Product Team', 'Session Topic/Category (Technical)'],
  });
  const sponsors = parseSponsorLogos(sponsorsHtml, { conferenceId: conference.id, skipTiers: ['Media'] });
  if (sessions.length === 0) throw new Error('No scheduled sessions: has the Sessionize API been turned off?');

  const snapshot = {
    conference: {
      ...conference,
      source: { scheduleUrl, sessionizeApiUrl: apiUrl, sponsorsUrl, retrievedAt: new Date().toISOString() },
    },
    sessions,
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
