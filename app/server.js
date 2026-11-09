// Switchback, a personal KubeCon day planner. Listens on $PORT, keeps
// /healthz and /readyz for Kubernetes, serves the API (app/api/) and the UI
// (app/public/). See docs/CONTRACTS.md.
const http = require('node:http');
const { logs, SeverityNumber } = require('@opentelemetry/api');
const { buildProfile } = require('./profile');
const { buildPlan } = require('./planner');
const { createHandler } = require('./api/router');
const { accountsFromEnv } = require('./auth');

const port = Number(process.env.PORT || 8080);
const version = process.env.APP_VERSION || 'dev';
const otelLogger = logs.getLogger('conference-planner');

const accounts = accountsFromEnv();
const server = http.createServer(createHandler({ buildProfile, buildPlan, accounts }));

// Accounts (optional): run the database migration in the background, retrying
// while the database starts. /readyz never waits for it; account routes retry
// the migration themselves and answer 503 until the database is reachable.
function migrateAccounts(attempt = 1) {
  accounts.db.ready().then(
    () => console.log('accounts: database ready'),
    (err) => {
      console.error(`accounts: database not ready (attempt ${attempt}): ${err && (err.code || err.name)}`);
      if (attempt < 20) setTimeout(() => migrateAccounts(attempt + 1), Math.min(30000, 2000 * attempt)).unref();
    },
  );
}
if (accounts.enabled) migrateAccounts();
console.log(`accounts: ${accounts.enabled ? 'on' : 'off'}`);

server.listen(port, () => {
  const message = `listening on :${port}, version ${version}`;
  console.log(message);
  otelLogger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: message,
  });
});

// Exit cleanly when Kubernetes stops the pod, so rollouts don't drop requests.
process.on('SIGTERM', () => server.close());
