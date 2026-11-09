// Switchback, a personal KubeCon day planner. Listens on $PORT, keeps
// /healthz and /readyz for Kubernetes, serves the API (app/api/) and the UI
// (app/public/). See docs/CONTRACTS.md.
const http = require('node:http');
const { logs, SeverityNumber } = require('@opentelemetry/api');
const { buildProfile } = require('./profile');
const { buildPlan } = require('./planner');
const { createHandler } = require('./api/router');

const port = Number(process.env.PORT || 8080);
const version = process.env.APP_VERSION || 'dev';
const otelLogger = logs.getLogger('conference-planner');

const server = http.createServer(createHandler({ buildProfile, buildPlan }));

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
