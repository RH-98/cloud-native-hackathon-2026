'use strict';

// OpenTelemetry bootstrap, loaded before the app with
//   NODE_OPTIONS="--require ./telemetry.js"
// It does what @opentelemetry/auto-instrumentations-node/register does, with
// these changes:
// - no spans for the kubelet's /healthz and /readyz probes (they would flood
//   Dash0 every 5-10 seconds per pod);
// - no file-system spans;
// - service.version comes from APP_VERSION, so Dash0 can compare deploys;
// - without OTEL_NODE_RESOURCE_DETECTORS, only the env, host, os, process
//   and serviceinstance detectors run (no cloud metadata probes).
// Exporters, endpoint and headers still come from the standard OTEL_*
// environment variables. With OTEL_*_EXPORTER=none, or with
// OTEL_SDK_DISABLED=true, nothing is sent.
//
// Local dev: with no OTEL_EXPORTER_OTLP_*ENDPOINT and no OTEL_*_EXPORTER set,
// the SDK stays off. Otherwise it would keep retrying localhost:4318 and the
// process would take a minute or more to exit.

const OTEL_TARGET_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_LOGS_EXPORTER',
];
const DEFAULT_RESOURCE_DETECTORS = 'env,host,os,process,serviceinstance';
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

function isProbe(req) {
  const path = (req.url || '').split('?')[0];
  return PROBE_PATHS.has(path);
}

function startTelemetry() {
  const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { defaultResource, resourceFromAttributes } = require('@opentelemetry/resources');
  const {
    getNodeAutoInstrumentations,
    getResourceDetectors,
  } = require('@opentelemetry/auto-instrumentations-node');

  const logLevel = DiagLogLevel[(process.env.OTEL_LOG_LEVEL || '').toUpperCase()];
  if (logLevel !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), { logLevel });
  }

  if (!process.env.OTEL_NODE_RESOURCE_DETECTORS) {
    process.env.OTEL_NODE_RESOURCE_DETECTORS = DEFAULT_RESOURCE_DETECTORS;
  }

  const instrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: isProbe },
    '@opentelemetry/instrumentation-fs': { enabled: false },
  });

  // Detected attributes (OTEL_RESOURCE_ATTRIBUTES included) are merged on
  // top, so an explicit service.version there still wins.
  let resource = defaultResource();
  if (process.env.APP_VERSION) {
    resource = resource.merge(resourceFromAttributes({ 'service.version': process.env.APP_VERSION }));
  }

  const sdk = new NodeSDK({
    instrumentations,
    resource,
    resourceDetectors: getResourceDetectors(),
  });

  try {
    sdk.start();
    diag.info('OpenTelemetry started');
  } catch (error) {
    diag.error('OpenTelemetry failed to start; the app runs without telemetry', error);
  }

  // Flush buffered spans, metrics and logs once. The app's own SIGTERM
  // handler closes the server, and the process exits when both are done.
  let shuttingDown;
  function shutdown() {
    shuttingDown = shuttingDown || sdk.shutdown().catch((error) => {
      diag.error('OpenTelemetry shutdown failed', error);
    });
    return shuttingDown;
  }
  process.once('SIGTERM', shutdown);
  process.once('beforeExit', shutdown);
}

if (OTEL_TARGET_VARS.some((name) => process.env[name])) {
  startTelemetry();
}
