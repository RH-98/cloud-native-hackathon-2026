// Check every conference's live schedule for changes and record them.
// Runs as the schedule-watch CronJob (deploy/schedule-watch.yaml) every 10
// minutes, or locally:
//   cd app && ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... npm run watch:schedule
// Demo overrides come from /etc/schedule-overrides/overrides.json (ConfigMap
// schedule-overrides), or the file named by SCHEDULE_OVERRIDES_FILE.
const fs = require('node:fs/promises');
const path = require('node:path');
const { trace, metrics } = require('@opentelemetry/api');
const es = require('../search/elasticsearch');
const { readOverrides } = require('../schedule/overrides');
const { watchConference } = require('../schedule/watch');

const DATA_DIR = path.join(__dirname, '..', 'data', 'conferences');

// Export buffered spans and metrics before the process exits. telemetry.js
// also shuts the SDK down on beforeExit; flushing here first is harmless.
async function flushTelemetry() {
  for (const provider of [trace.getTracerProvider(), metrics.getMeterProvider()]) {
    const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider;
    if (delegate && typeof delegate.forceFlush === 'function') await delegate.forceFlush().catch(() => {});
  }
}

async function main() {
  const client = es.createClient();
  try {
    await es.ensureScheduleIndices(client);
    const { overrides, warnings } = readOverrides();
    for (const w of warnings) console.warn(`overrides: ${w}`);
    if (overrides.length) console.log(`overrides: ${overrides.length} simulated change(s) configured`);

    const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
    let failed = 0;
    for (const file of files) {
      const { conference } = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
      const mine = overrides.filter((o) => o.sessionId.startsWith(`${conference.id}:`));
      try {
        const result = await watchConference(conference, { client, overrides: mine });
        for (const w of result.warnings) console.warn(`${conference.id}: ${w}`);
        console.log(`${conference.id}: ${result.changes.length} change(s) (source ${result.sourceUsed ? 'fetched' : 'not used'})`);
        for (const c of result.changes) {
          const from = c.before ? `${c.before.start} ${c.before.room || ''}`.trim() : '-';
          const to = c.after ? `${c.after.start} ${c.after.room || ''}`.trim() : '-';
          console.log(`  ${c.type} [${c.source}] ${c.sessionId} "${c.sessionTitle}": ${from} -> ${to}`);
        }
      } catch (err) {
        failed += 1;
        console.error(`${conference.id}: ${err.message}`);
      }
    }
    if (failed) throw new Error(`${failed} conference(s) failed`);
  } finally {
    await client.close().catch(() => {});
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(flushTelemetry);
