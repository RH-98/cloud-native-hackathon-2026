// Load every conference snapshot in data/conferences/ into Elasticsearch.
// Runs as a one-off Kubernetes Job (jobs/load-elasticsearch.yaml) or locally:
//   cd app && ELASTICSEARCH_URL=... ELASTICSEARCH_API_KEY=... npm run load:es
// Skips a conference whose snapshot was already loaded, unless --force.
const fs = require('node:fs/promises');
const path = require('node:path');
const { trace } = require('@opentelemetry/api');
const es = require('../search/elasticsearch');

const DATA_DIR = path.join(__dirname, '..', 'data', 'conferences');

// Send buffered spans as soon as the work is done. With --require ./telemetry.js
// (the Job sets it), telemetry.js also shuts the SDK down on beforeExit, which
// flushes spans, metrics and logs; this early span flush is a no-op without an SDK.
async function flushTelemetry() {
  const provider = trace.getTracerProvider();
  const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider;
  if (typeof delegate.forceFlush === 'function') await delegate.forceFlush();
}

async function main() {
  const force = process.argv.includes('--force');
  const client = es.createClient();
  const created = await es.ensureIndices(client);
  if (created.length) console.log(`Created indices: ${created.join(', ')}`);

  const files = (await fs.readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  let failed = 0;
  for (const file of files) {
    const snapshot = JSON.parse(await fs.readFile(path.join(DATA_DIR, file), 'utf8'));
    const { id, source } = snapshot.conference;
    const loaded = await es.getLoadedConference(client, id);
    if (!force && loaded && loaded.retrievedAt === source?.retrievedAt) {
      console.log(`${id}: already loaded (snapshot ${source?.retrievedAt}), skipping`);
      continue;
    }
    const started = Date.now();
    const { indexed, failures } = await es.loadSnapshot(client, snapshot);
    console.log(`${id}: indexed ${indexed} documents in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const f of failures.slice(0, 10)) console.error(`  failed ${f.id}: ${f.reason}`);
    failed += failures.length;
  }
  if (failed) throw new Error(`${failed} documents failed to index`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(flushTelemetry);
