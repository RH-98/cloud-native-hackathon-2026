const test = require('node:test');
const assert = require('node:assert/strict');
const es = require('../search/elasticsearch');

const attendee = {
  id: 'conf:attendee-001',
  conferenceId: 'conf',
  displayName: 'Ada Quillfeather',
  handle: 'demo-ada-quillfeather',
  fictional: true,
  optIn: true,
  role: 'Platform engineer',
  companyType: 'a fintech',
  bio: 'Platform engineer at a fintech.',
  experience: 'maintainer',
  maintains: ['argo-cd'],
  interests: {
    tools: [{ name: 'argo-cd', label: 'Argo CD', weight: 1 }],
    topics: ['gitops'],
    languages: [{ name: 'Go', weight: 0.8 }],
    keywords: ['golden paths'],
  },
  goingTo: ['conf:1'],
};

const profile = {
  tools: [{ name: 'Argo CD', weight: 1 }],
  topics: ['platform-engineering'],
  languages: [{ name: 'Go', weight: 1 }],
  keywords: ['helm charts'],
};

test('attendee documents fit the strict mapping and use canonical keys', () => {
  const doc = es.toAttendeeDocument(attendee);
  const allowed = new Set(Object.keys(es.ATTENDEES_MAPPING.properties));
  for (const key of Object.keys(doc)) assert.ok(allowed.has(key), `unmapped field ${key}`);
  assert.deepEqual(doc.tools, ['argocd']);
  assert.deepEqual(doc.languages, ['go']);
  assert.equal(doc.optIn, true);
  assert.match(doc.summary, /Works with Argo CD/);
  assert.equal(es.ATTENDEES_MAPPING.properties.summary.copy_to, 'semantic');
  assert.equal(es.ATTENDEES_MAPPING.properties.semantic.inference_id, es.EMBEDDING_INFERENCE_ID);
  assert.deepEqual(es.fromAttendeeDocument(doc).interests, attendee.interests);
});

test('both attendee queries filter on opt-in and conference', () => {
  const { lexical, semantic } = es.attendeeQueries({ conferenceId: 'conf', profile });
  for (const q of [lexical, semantic]) {
    assert.deepEqual(q.bool.filter, [{ term: { conferenceId: 'conf' } }, { term: { optIn: true } }]);
  }
  assert.deepEqual(lexical.bool.should[0], { terms: { tools: ['argocd'], boost: 3 } });
  assert.equal(lexical.bool.minimum_should_match, 1);
  assert.equal(semantic.bool.must[0].semantic.field, 'semantic');
  assert.match(semantic.bool.must[0].semantic.query, /Argo CD/);
});

const hit = (doc) => ({ _id: doc.id, _source: doc });

test('searchAttendees uses the rrf retriever and drops opted-out hits', async () => {
  const requests = [];
  const client = {
    search: async (req) => {
      requests.push(req);
      const out = es.toAttendeeDocument({ ...attendee, id: 'conf:out', handle: 'demo-out', optIn: false });
      return { hits: { hits: [hit(es.toAttendeeDocument(attendee)), hit(out)] } };
    },
  };
  const results = await es.searchAttendees(client, { conferenceId: 'conf', profile, size: 5 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].retriever.rrf.retrievers.length, 2);
  assert.deepEqual(results.map((r) => r.handle), ['demo-ada-quillfeather']);
});

test('searchAttendees fuses in JS when the cluster rejects rrf', async () => {
  const requests = [];
  const client = {
    search: async (req) => {
      requests.push(req);
      if (req.retriever) {
        const err = new Error('rrf not allowed');
        err.meta = { statusCode: 403, body: { error: { reason: 'current license is non-compliant for [rrf]' } } };
        throw err;
      }
      return { hits: { hits: [hit(es.toAttendeeDocument(attendee))] } };
    },
  };
  const results = await es.searchAttendees(client, { conferenceId: 'conf', profile, size: 5 });
  assert.equal(requests.length, 3);
  assert.deepEqual(results.map((r) => r.handle), ['demo-ada-quillfeather']);
});

test('loadAttendees bulk-indexes by id', async () => {
  const calls = [];
  const client = {
    bulk: async ({ operations }) => {
      calls.push(operations);
      return { items: operations.filter((_, i) => i % 2 === 0).map((o) => ({ index: { _id: o.index._id } })) };
    },
    indices: { refresh: async () => {} },
  };
  const result = await es.loadAttendees(client, 'conf', [attendee, { ...attendee, conferenceId: 'other' }]);
  assert.deepEqual(result, { indexed: 1, failures: [] });
  assert.deepEqual(calls[0][0], { index: { _index: 'conference-attendees', _id: 'conf:attendee-001' } });
});
