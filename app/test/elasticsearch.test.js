const test = require('node:test');
const assert = require('node:assert/strict');
const es = require('../search/elasticsearch');

const snapshot = {
  conference: {
    id: 'test-conf',
    name: 'Test Conf',
    location: 'Somewhere',
    timezone: 'America/Denver',
    utcOffset: '-07:00',
    startDate: '2026-11-09',
    endDate: '2026-11-12',
    source: { retrievedAt: '2026-11-09T19:40:00.000Z' },
  },
  sessions: [{ id: 'test-conf:1', conferenceId: 'test-conf', title: 'A talk' }],
  sponsors: [{ id: 'test-conf:acme', conferenceId: 'test-conf', name: 'Acme' }],
};

test('toBulkOperations indexes sessions, sponsors and the conference record by stable id', () => {
  const ops = es.toBulkOperations(snapshot);
  assert.equal(ops.length, 6);
  assert.deepEqual(ops[0], { index: { _index: 'conference-sessions', _id: 'test-conf:1' } });
  assert.deepEqual(ops[2], { index: { _index: 'conference-sponsors', _id: 'test-conf:acme' } });
  assert.deepEqual(ops[4], { index: { _index: 'conference-meta', _id: 'test-conf' } });
  assert.equal(ops[5].retrievedAt, '2026-11-09T19:40:00.000Z');
  assert.equal(ops[5].sessionCount, 1);
  assert.equal(ops[5].sponsorCount, 1);
});

test('loadSnapshot writes the conference metadata only after all data documents succeed', async () => {
  const calls = [];
  const client = {
    bulk: async (request) => {
      calls.push(request);
      return {
        items: request.operations
          .filter((_, index) => index % 2 === 0)
          .map((operation) => ({ index: { _id: operation.index._id } })),
      };
    },
    indices: { refresh: async () => {} },
  };

  const result = await es.loadSnapshot(client, snapshot);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].refresh, undefined);
  assert.deepEqual(calls[1].operations, [
    { index: { _index: 'conference-meta', _id: 'test-conf' } },
    {
      id: 'test-conf',
      name: 'Test Conf',
      location: 'Somewhere',
      timezone: 'America/Denver',
      utcOffset: '-07:00',
      startDate: '2026-11-09',
      endDate: '2026-11-12',
      retrievedAt: '2026-11-09T19:40:00.000Z',
      sessionCount: 1,
      sponsorCount: 1,
    },
  ]);
  assert.equal(calls[1].refresh, true);
  assert.deepEqual(result, { indexed: 3, failures: [] });
});

test('loadSnapshot does not write conference metadata when a data document fails', async () => {
  const calls = [];
  const client = {
    bulk: async (request) => {
      calls.push(request);
      return {
        items: request.operations
          .filter((_, index) => index % 2 === 0)
          .map((operation, index) => ({
            index: index === 0
              ? { _id: operation.index._id, error: { reason: 'indexing failed' } }
              : { _id: operation.index._id },
          })),
      };
    },
    indices: { refresh: async () => {} },
  };

  const result = await es.loadSnapshot(client, snapshot);

  assert.equal(calls.length, 1);
  assert.deepEqual(result, {
    indexed: 1,
    failures: [{ id: 'test-conf:1', reason: 'indexing failed' }],
  });
});

test('session mapping covers every field the importer produces', () => {
  const fields = Object.keys(es.MAPPINGS[es.INDEX.sessions].properties);
  const sessionFields = [
    'id', 'conferenceId', 'sourceId', 'title', 'description', 'start', 'end', 'room', 'speakers',
    'track', 'level', 'tags', 'sponsored', 'kind', 'slidesAvailable', 'url',
  ];
  for (const f of sessionFields) assert.ok(fields.includes(f), `missing mapping for ${f}`);
  assert.equal(es.MAPPINGS[es.INDEX.sessions].properties.semantic.type, 'semantic_text');
});

test('createClient refuses to start without credentials', () => {
  assert.throws(() => es.createClient({}), /ELASTICSEARCH_URL and ELASTICSEARCH_API_KEY/);
});
