const test = require('node:test');
const assert = require('node:assert/strict');
const { metrics: otelMetrics } = require('@opentelemetry/api');
const metrics = require('../metrics');
const { buildPlan } = require('../planner');

// A fake MeterProvider that records every measurement, so tests need no SDK.
function fakeProvider() {
  const recorded = [];
  const callbacks = [];
  const instrument = (name) => ({
    add: (value, attributes = {}) => recorded.push({ name, value, attributes }),
    record: (value, attributes = {}) => recorded.push({ name, value, attributes }),
    addCallback: (cb) => callbacks.push({ name, cb }),
  });
  const meter = {
    createCounter: instrument,
    createHistogram: instrument,
    createObservableGauge: instrument,
  };
  return {
    recorded,
    observe() {
      const out = [];
      for (const { name, cb } of callbacks) cb({ observe: (value, attributes = {}) => out.push({ name, value, attributes }) });
      return out;
    },
    provider: { getMeter: () => meter },
  };
}

test('metrics helpers never throw without a registered MeterProvider', async () => {
  metrics._reset();
  otelMetrics.disable();
  assert.doesNotThrow(() => {
    metrics.recordPlan({ conference: 'kubecon-na-2026', source: 'github', backend: 'snapshot', outcome: 'ok', startedAt: metrics.now(), picks: 3 });
    metrics.recordPlan({});
    metrics.recordSearchFallback('no_credentials');
    metrics.recordSearchDuration({ index: 'sessions', fusion: 'rrf', startedAt: metrics.now() });
    metrics.recordGithubRateLimit('4999');
    metrics.recordGithubRateLimit(undefined);
  });
  const plan = await buildPlan({ conferenceId: 'kubecon-na-2026', profile: { source: 'interests', keywords: ['argo cd'] } }, { env: {} });
  assert.equal(plan.searchBackend, 'snapshot');
});

test('metric attributes only ever take values from fixed sets', async () => {
  metrics._reset();
  otelMetrics.disable();
  const fake = fakeProvider();
  otelMetrics.setGlobalMeterProvider(fake.provider);
  try {
    await buildPlan({ conferenceId: 'kubecon-na-2026', profile: { source: 'interests', keywords: ['argo cd'] } }, { env: {} });
    await assert.rejects(buildPlan({ conferenceId: 'nope', profile: { source: 'github' } }, { env: {} }));
    await assert.rejects(buildPlan({ conferenceId: '../../etc/passwd', profile: { source: 'x'.repeat(500) } }, { env: {} }));
    metrics.recordSearchFallback('octocat');
    metrics.recordSearchDuration({ index: 'secret-index', fusion: 'token', startedAt: metrics.now() });
    metrics.recordPlan({ conference: 'Has Spaces!', source: 'octocat', backend: 'mongo', outcome: 'meh', startedAt: metrics.now() });

    const allowed = {
      'plan.source': [...metrics.VALUES.planSource, metrics.OTHER],
      'search.backend': [...metrics.VALUES.searchBackend, metrics.OTHER],
      outcome: [...metrics.VALUES.outcome, metrics.OTHER],
      reason: [...metrics.VALUES.fallbackReason, metrics.OTHER],
      index: [...metrics.VALUES.index, metrics.OTHER],
      fusion: [...metrics.VALUES.fusion, metrics.OTHER],
      'conference.id': ['kubecon-na-2026', 'nope', 'unknown'],
    };
    assert.ok(fake.recorded.length > 0);
    for (const { name, attributes, value } of fake.recorded) {
      assert.ok(Number.isFinite(value) && value >= 0, `${name} value ${value}`);
      for (const [key, v] of Object.entries(attributes)) {
        assert.ok(allowed[key], `${name}: unexpected attribute ${key}`);
        assert.ok(allowed[key].includes(v), `${name}: ${key}=${v} is not from the fixed set`);
      }
    }
    const plans = fake.recorded.filter((r) => r.name === 'planner.plans');
    assert.deepEqual(
      plans.slice(0, 3).map((r) => [r.attributes['conference.id'], r.attributes['plan.source'], r.attributes['search.backend'], r.attributes.outcome]),
      [
        ['kubecon-na-2026', 'interests', 'snapshot', 'ok'],
        ['unknown', 'github', 'none', 'rejected'],
        ['unknown', 'other', 'none', 'rejected'],
      ],
    );
    assert.ok(fake.recorded.some((r) => r.name === 'planner.search.fallbacks' && r.attributes.reason === 'no_credentials'));
    assert.ok(fake.recorded.some((r) => r.name === 'planner.search.duration' && r.attributes.fusion === 'snapshot'));
    assert.ok(fake.recorded.some((r) => r.name === 'planner.plan.picks'));

    assert.deepEqual(fake.observe(), []); // no GitHub response seen yet
    metrics.recordGithubRateLimit('4321');
    metrics.recordGithubRateLimit('not a number');
    assert.deepEqual(fake.observe(), [{ name: 'github.ratelimit.remaining', value: 4321, attributes: {} }]);
  } finally {
    otelMetrics.disable();
    metrics._reset();
  }
});
