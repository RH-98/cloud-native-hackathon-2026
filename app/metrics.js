// Custom OpenTelemetry metrics for the planner (meter `conference-planner`).
// Exported to Dash0 by whatever MeterProvider the process registers
// (OTEL_METRICS_EXPORTER=otlp); without one, the API hands out no-op
// instruments, so every helper here is safe in tests and local runs.
//
// Attributes are low-cardinality on purpose: every value is clamped to a fixed
// set (or a validated conference id). Never pass usernames, tokens or free text.
const { metrics } = require('@opentelemetry/api');

const METER_NAME = 'conference-planner';

// Seconds, matching the http.server.request.duration semantic convention buckets.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const PICK_BUCKETS = [0, 1, 2, 4, 6, 8, 10, 15, 20, 30, 50];

const VALUES = {
  planSource: ['github', 'interests'],
  searchBackend: ['elasticsearch', 'snapshot', 'none'],
  // rejected: the request itself was bad (unknown conference, invalid options).
  outcome: ['ok', 'error', 'rejected'],
  fallbackReason: ['no_credentials', 'es_error'],
  index: ['sessions', 'sponsors'],
  fusion: ['rrf', 'js', 'snapshot', 'none'],
};
const OTHER = 'other';
const CONFERENCE_ID = /^[a-z0-9-]{1,64}$/;

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : OTHER;
}

function conferenceId(value) {
  return typeof value === 'string' && CONFERENCE_ID.test(value) ? value : 'unknown';
}

let latestRateLimit = null;
let instruments = null;

// Created on first use, not at require time: the metrics API has no proxy
// provider, so instruments made before the SDK registers would stay no-ops.
function get() {
  if (instruments) return instruments;
  const meter = metrics.getMeter(METER_NAME);
  instruments = {
    plans: meter.createCounter('planner.plans', {
      description: 'Plans built, by conference, profile source, search backend and outcome',
      unit: '{plan}',
    }),
    planDuration: meter.createHistogram('planner.plan.duration', {
      description: 'Time to build a plan',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    fallbacks: meter.createCounter('planner.search.fallbacks', {
      description: 'Plans served from the bundled snapshot instead of Elasticsearch',
      unit: '{fallback}',
    }),
    picks: meter.createHistogram('planner.plan.picks', {
      description: 'Sessions picked per plan',
      unit: '{session}',
      advice: { explicitBucketBoundaries: PICK_BUCKETS },
    }),
    searchDuration: meter.createHistogram('planner.search.duration', {
      description: 'Time for one session or sponsor search',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    rateLimit: meter.createObservableGauge('github.ratelimit.remaining', {
      description: 'GitHub API requests left in the current rate-limit window (latest response)',
      unit: '{request}',
    }),
  };
  instruments.rateLimit.addCallback((result) => {
    if (latestRateLimit != null) result.observe(latestRateLimit);
  });
  return instruments;
}

function seconds(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}

// Monotonic start time for the duration helpers.
function now() {
  return process.hrtime.bigint();
}

// One finished (or failed) plan.
function recordPlan({ conference, source, backend, outcome, startedAt, picks }) {
  const m = get();
  const searchBackend = oneOf(backend, VALUES.searchBackend);
  m.plans.add(1, {
    'conference.id': conferenceId(conference),
    'plan.source': oneOf(source, VALUES.planSource),
    'search.backend': searchBackend,
    outcome: oneOf(outcome, VALUES.outcome),
  });
  if (startedAt != null) m.planDuration.record(seconds(startedAt), { 'search.backend': searchBackend });
  if (Number.isFinite(picks) && picks >= 0) m.picks.record(picks);
}

function recordSearchFallback(reason) {
  get().fallbacks.add(1, { reason: oneOf(reason, VALUES.fallbackReason) });
}

function recordSearchDuration({ index, fusion, startedAt }) {
  get().searchDuration.record(seconds(startedAt), {
    index: oneOf(index, VALUES.index),
    fusion: oneOf(fusion, VALUES.fusion),
  });
}

// Call with the x-ratelimit-remaining header of each GitHub response.
function recordGithubRateLimit(remaining) {
  const n = Number(remaining);
  if (remaining == null || remaining === '' || !Number.isFinite(n) || n < 0) return;
  get();
  latestRateLimit = n;
}

module.exports = {
  METER_NAME,
  VALUES,
  OTHER,
  now,
  recordPlan,
  recordSearchFallback,
  recordSearchDuration,
  recordGithubRateLimit,
  // tests
  _attributes: { oneOf, conferenceId },
  _latestRateLimit: () => latestRateLimit,
  _reset: () => {
    instruments = null;
    latestRateLimit = null;
  },
};
