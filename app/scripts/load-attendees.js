// Load the fictional demo attendees in data/attendees/ into Elasticsearch
// (index conference-attendees), for suggested connections:
//   cd app && ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... npm run load:attendees
// Re-running overwrites documents by id, so it is safe to repeat.
const fs = require('node:fs/promises');
const path = require('node:path');
const { trace } = require('@opentelemetry/api');
const es = require('../search/elasticsearch');

const DATA_DIR = path.join(__dirname, '..', 'data', 'attendees');

async function flushTelemetry() {
  const provider = trace.getTracerProvider();
  const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider;
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush();
}

async function main() {
  const client = es.createClient();
  if (await es.ensureAttendeesIndex(client)) console.log(`Created index ${es.ATTENDEES_INDEX}`);

  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  let failed = 0;
  for (const file of files) {
    const { conferenceId, attendees } = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
    const started = Date.now();
    const { indexed, failures } = await es.loadAttendees(client, conferenceId, attendees);
    console.log(`${conferenceId}: indexed ${indexed} attendees in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const f of failures.slice(0, 10)) console.error(`  failed ${f.id}: ${f.reason}`);
    failed += failures.length;
  }
  if (failed) throw new Error(`${failed} attendees failed to index`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(flushTelemetry);
