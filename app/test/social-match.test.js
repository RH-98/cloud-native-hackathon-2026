const test = require('node:test');
const assert = require('node:assert/strict');
const { matchAttendees, interestSummary, interestVector } = require('../social/match');
const { termKey } = require('../social/catalog');
const { generate } = require('../scripts/generate-fake-attendees');

const attendee = (handle, interests, extra = {}) => ({
  id: `conf:${handle}`,
  conferenceId: 'conf',
  displayName: handle,
  handle,
  role: 'Engineer',
  bio: 'Bio',
  optIn: true,
  experience: 'practitioner',
  maintains: [],
  goingTo: [],
  interests,
  ...extra,
});

const platform = attendee('demo-platform', {
  tools: [
    { name: 'argo-cd', label: 'Argo CD', weight: 1 },
    { name: 'crossplane', label: 'Crossplane', weight: 0.8 },
  ],
  topics: ['gitops'],
  languages: [{ name: 'Go', weight: 0.8 }],
  keywords: ['golden paths'],
});
const observability = attendee(
  'demo-otel',
  {
    tools: [{ name: 'opentelemetry', label: 'OpenTelemetry', weight: 1 }],
    topics: ['observability'],
    languages: [{ name: 'Go', weight: 0.5 }],
    keywords: [],
  },
  { experience: 'maintainer', maintains: ['opentelemetry'], goingTo: ['conf:1', 'conf:2'] },
);
const hidden = attendee('demo-hidden', platform.interests, { optIn: false });
const unset = attendee('demo-unset', platform.interests, { optIn: undefined });

const profile = {
  username: 'someone',
  tools: [
    { name: 'argocd', weight: 0.9 },
    { name: 'Crossplane', weight: 0.5 },
  ],
  topics: ['gitops'],
  languages: [{ name: 'Go', weight: 1 }],
  keywords: [],
};

test('termKey folds spelling variants and aliases', () => {
  assert.equal(termKey('Argo CD'), 'argocd');
  assert.equal(termKey('argo-cd'), 'argocd');
  assert.equal(termKey('OTel'), 'opentelemetry');
  assert.equal(termKey('k8s'), 'kubernetes');
});

test('never returns attendees who have not opted in', () => {
  const results = matchAttendees(profile, [hidden, unset, platform, observability], { limit: 10 });
  const handles = results.map((r) => r.attendee.handle);
  assert.ok(handles.includes('demo-platform'));
  assert.ok(!handles.includes('demo-hidden'));
  assert.ok(!handles.includes('demo-unset'));
});

test('ranks the closest attendee first, with shared labels and a why line', () => {
  const [first, second] = matchAttendees(profile, [observability, platform]);
  assert.equal(first.attendee.handle, 'demo-platform');
  assert.deepEqual(first.shared, ['Argo CD', 'Crossplane', 'GitOps']);
  assert.equal(first.why, 'You both work with Argo CD and Crossplane');
  assert.ok(first.score > second.score);
  assert.ok(first.score > 0 && first.score <= 1);
  // Only a language in common: not a "shared" public topic, but explained.
  assert.deepEqual(second.shared, []);
  assert.equal(second.why, 'You both write Go');
});

test('returns only public attendee fields', () => {
  const [result] = matchAttendees(profile, [platform]);
  assert.deepEqual(Object.keys(result.attendee).sort(), ['bio', 'demo', 'displayName', 'handle', 'role']);
  assert.equal(result.interests, undefined);
});

test('keywords count toward the score but are never listed as shared', () => {
  const [result] = matchAttendees({ tools: [], topics: [], languages: [], keywords: ['observability'] }, [observability]);
  assert.ok(result.score > 0);
  assert.deepEqual(result.shared, []);
});

test('lists common sessions and boosts for them', () => {
  const otelProfile = { tools: [{ name: 'opentelemetry', weight: 1 }], topics: ['observability'], languages: [], keywords: [] };
  const [without] = matchAttendees(otelProfile, [observability]);
  const [withPicks] = matchAttendees(otelProfile, [observability], { pickedSessionIds: ['conf:2', 'conf:9'] });
  assert.deepEqual(without.commonSessions, []);
  assert.deepEqual(withPicks.commonSessions, ['conf:2']);
  assert.ok(withPicks.score >= without.score);
  assert.match(withPicks.why, /going to 1 of the same session$/);
});

test('a first-timer is pointed at a maintainer of what they share', () => {
  const peer = attendee('demo-peer', observability.interests);
  const newcomer = { tools: [{ name: 'opentelemetry', weight: 0.3 }], topics: [], languages: [], keywords: [] };
  const results = matchAttendees(newcomer, [peer, observability], { firstTimer: true });
  assert.equal(results[0].attendee.handle, 'demo-otel');
  assert.match(results[0].why, /they help maintain OpenTelemetry/);
  assert.ok(results[0].score > results[1].score);
});

test('skips the user themselves and people with nothing in common', () => {
  const self = attendee('someone', platform.interests);
  const stranger = attendee('demo-stranger', { tools: [{ name: 'vitess', weight: 1 }], topics: [], languages: [], keywords: [] });
  const handles = matchAttendees(profile, [self, stranger, platform]).map((r) => r.attendee.handle);
  assert.deepEqual(handles, ['demo-platform']);
});

test('interestSummary reads as a sentence for semantic search', () => {
  assert.equal(
    interestSummary(profile),
    'Works with Argo CD and Crossplane. Interested in GitOps. Writes Go.',
  );
  assert.equal(interestVector({}).size, 0);
});

test('the fake-attendee generator is deterministic and only makes fictional, demo- handles', () => {
  const snapshot = {
    conference: { id: 'kubecon-na-2026', startDate: '2026-11-09' },
    sessions: [
      { id: 's1', kind: 'session', start: '2026-11-10T10:00:00-07:00', title: 'Argo CD at scale', description: '' },
      { id: 's2', kind: 'session', start: '2026-11-10T11:00:00-07:00', title: 'OpenTelemetry tracing', description: '' },
      { id: 's3', kind: 'session', start: '2026-11-10T12:00:00-07:00', title: 'Cilium and eBPF', description: '' },
    ],
  };
  const a = generate(snapshot);
  const b = generate(snapshot);
  assert.deepEqual(a, b);
  assert.ok(a.attendees.length >= 50);
  assert.ok(a.attendees.every((x) => x.handle.startsWith('demo-') && x.fictional === true));
  assert.ok(a.attendees.some((x) => x.optIn === false));
  assert.equal(new Set(a.attendees.map((x) => x.handle)).size, a.attendees.length);
});

test('the committed demo attendees are fictional and opt-in flagged', () => {
  const data = require('../data/attendees/kubecon-na-2026.json');
  assert.match(data.notice, /FICTIONAL/);
  for (const x of data.attendees) {
    assert.ok(x.handle.startsWith('demo-'));
    assert.equal(typeof x.optIn, 'boolean');
    assert.ok(x.goingTo.length > 0);
  }
});
