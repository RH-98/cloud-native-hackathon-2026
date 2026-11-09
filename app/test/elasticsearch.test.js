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
