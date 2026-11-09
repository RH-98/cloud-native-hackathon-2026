// getChanges: the schedule changes the schedule-watch CronJob recorded, for
// GET /api/changes. Without Elasticsearch (local runs, tests) there is no
// watcher, so there are no changes: { changes: [], checkedAt: null }.
const es = require('../search/elasticsearch');

let sharedClient = null;
function defaultClient(env) {
  if (!sharedClient) sharedClient = es.createClient(env);
  return sharedClient;
}

// deps (tests): { env, client }
async function getChanges({ conferenceId, since = null, sessionIds = null }, deps = {}) {
  const env = deps.env || process.env;
  if (!deps.client && !es.searchAvailable(env)) return { changes: [], checkedAt: null };
  const client = deps.client || defaultClient(env);
  const { changes, checkedAt } = await es.searchChanges(client, { conferenceId, since, sessionIds, size: 200 });
  return { changes, checkedAt };
}

module.exports = { getChanges };
