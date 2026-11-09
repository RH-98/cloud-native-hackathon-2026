const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSchedule, parseSponsors, withOffset } = require('../importers/lf-events');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const opts = { conferenceId: 'test-conf', utcOffset: '-07:00', pageUrl: 'https://example.org/schedule/' };

test('parseSchedule extracts sessions in the common format', () => {
  const sessions = parseSchedule(fixture('lf-schedule.html'), opts);
  assert.equal(sessions.length, 3, 'duplicate session ids are merged');

  const talk = sessions.find((s) => s.sourceId === '101');
  assert.deepEqual(talk, {
    id: 'test-conf:101',
    conferenceId: 'test-conf',
    sourceId: '101',
    title: 'SIG Instrumentation & You',
    description: 'Metrics, logs and traces. Second paragraph.',
    start: '2026-11-10T11:30:00-07:00',
    end: '2026-11-10T12:00:00-07:00',
    room: 'Salt Palace | Level 2 | 250 A-C',
    speakers: ['Ada Lovelace', 'Grace Hopper'],
    track: 'Observability',
    level: 'Intermediate',
    tags: ['Observability', 'Intermediate'],
    sponsored: false,
    kind: 'session',
    slidesAvailable: true,
    url: 'https://example.org/schedule/?id=101',
  });
});

test('parseSchedule flags sponsored demos and logistics entries', () => {
  const sessions = parseSchedule(fixture('lf-schedule.html'), opts);
  const demo = sessions.find((s) => s.sourceId === '102');
  assert.equal(demo.sponsored, true);
  assert.equal(demo.track, 'Sponsor Demo Theater');
  assert.equal(demo.description, '');

  const coffee = sessions.find((s) => s.sourceId === '103');
  assert.equal(coffee.kind, 'logistics');
  assert.deepEqual(coffee.speakers, []);
});

test('parseSponsors extracts names, tiers and urls, keeping the first tier for duplicates', () => {
  const sponsors = parseSponsors(fixture('lf-sponsors.html'), { conferenceId: 'test-conf' });
  assert.deepEqual(
    sponsors.map(({ name, tier, url }) => ({ name, tier, url })),
    [
      { name: 'AWS', tier: 'Diamond', url: 'https://aws.example/' },
      { name: 'Acme Cloud', tier: 'Diamond', url: 'https://acme.example/' },
      { name: 'Akuity', tier: 'Gold', url: 'http://akuity.example' },
    ],
  );
  assert.equal(sponsors[1].id, 'test-conf:acme-cloud');
});

test('withOffset keeps explicit offsets and handles missing values', () => {
  assert.equal(withOffset('2026-11-10T11:30:00', '-07:00'), '2026-11-10T11:30:00-07:00');
  assert.equal(withOffset('2026-11-10T18:30:00Z', '-07:00'), '2026-11-10T18:30:00Z');
  assert.equal(withOffset('2026-11-10T11:30:00+01:00', '-07:00'), '2026-11-10T11:30:00+01:00');
  assert.equal(withOffset(undefined, '-07:00'), null);
});
