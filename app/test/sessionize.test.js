const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSessionize, normalizeLevel } = require('../importers/sessionize');
const { parseSponsorLogos } = require('../importers/sponsor-logos');
const { isKeynote } = require('../planner/plan');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const data = JSON.parse(fixture('sessionize-all.json'));
const opts = {
  conferenceId: 'test-conf',
  utcOffset: '-05:00',
  sessionUrl: 'https://example.org/sessions/#{id}',
  trackCategory: ['Primary Product', 'Product Team'],
};

test('parseSessionize converts a Sessionize "All" view into the common format', () => {
  const sessions = parseSessionize(data, opts);
  assert.equal(sessions.length, 4, 'the session without a time slot is left out');
  assert.deepEqual(
    sessions.map((s) => s.title),
    ['KEYNOTE', 'Revolutionizing Finance: Harnessing the Latest Innovations', 'LUNCH BREAK', 'Fast Track: Upgrades'],
    'sorted by start time',
  );

  const talk = sessions.find((s) => s.sourceId === '1293020');
  assert.deepEqual(talk, {
    id: 'test-conf:1293020',
    conferenceId: 'test-conf',
    sourceId: '1293020',
    title: 'Revolutionizing Finance: Harnessing the Latest Innovations',
    description: 'Join Marco and Lone as we explore the newest innovations. In this session we look at AI agents.',
    start: '2026-12-09T10:30:00-05:00',
    end: '2026-12-09T11:30:00-05:00',
    room: 'Splash 9',
    speakers: ['Lone Gru', 'Marco Smits'],
    track: 'AI',
    level: 'Beginner',
    tags: ['Functional', 'AI', 'Finance', 'Community', 'Introductory and overview'],
    sponsored: false,
    kind: 'session',
    slidesAvailable: false,
    url: 'https://example.org/sessions/#1293020',
  });
});

test('parseSessionize falls back to the next track category and flags sponsored sessions', () => {
  const s = parseSessionize(data, opts).find((x) => x.sourceId === '1300001');
  assert.equal(s.track, 'Fast Track');
  assert.equal(s.sponsored, true);
  assert.equal(s.level, null);
});

test('service sessions are logistics, except keynotes, which the planner recognizes', () => {
  const sessions = parseSessionize(data, opts);
  const keynote = sessions.find((s) => s.title === 'KEYNOTE');
  assert.equal(keynote.kind, 'session');
  assert.equal(keynote.track, 'Keynote');
  assert.equal(keynote.room, 'Glimmer');
  assert.ok(isKeynote(keynote));
  const lunch = sessions.find((s) => s.title === 'LUNCH BREAK');
  assert.equal(lunch.kind, 'logistics');
  assert.equal(lunch.description, '');
});

test('parseSessionize defaults: first non-level category as track, no url', () => {
  const s = parseSessionize(data, { conferenceId: 'c', utcOffset: '-05:00' }).find((x) => x.sourceId === '1293020');
  assert.equal(s.track, 'Functional');
  assert.equal(s.url, null);
});

test('parseSessionize rejects input that is not a Sessionize view', () => {
  assert.throws(() => parseSessionize({}, opts), /no sessions array/);
});

test('normalizeLevel maps common Sessionize level names', () => {
  assert.equal(normalizeLevel('Introductory and overview'), 'Beginner');
  assert.equal(normalizeLevel('Intermediate'), 'Intermediate');
  assert.equal(normalizeLevel('Advanced'), 'Advanced');
  assert.equal(normalizeLevel('Expert'), 'Advanced');
  assert.equal(normalizeLevel('All levels'), 'Any Level');
  assert.equal(normalizeLevel('Something else'), null);
});

test('the committed Convergence snapshot is in the common format and listed after KubeCon', () => {
  const snapshot = require('../data/conferences/convergence-2026.json');
  const { conference, sessions } = snapshot;
  assert.equal(conference.timezone, 'America/New_York');
  assert.ok(sessions.length >= 50);
  for (const s of sessions) {
    assert.ok(s.id.startsWith('convergence-2026:') && s.conferenceId === 'convergence-2026');
    assert.match(s.start, /-05:00$/);
    assert.ok(s.start.slice(0, 10) >= conference.startDate && s.start.slice(0, 10) <= conference.endDate);
  }
  const { loadConferences } = require('../api/conferences');
  const ids = loadConferences().map((c) => c.id);
  assert.ok(ids.indexOf('kubecon-na-2026') < ids.indexOf('convergence-2026'), 'soonest conference first');
});

test('parseSponsorLogos reads tier headings and linked logos', () => {
  const sponsors = parseSponsorLogos(fixture('sponsor-logos.html'), { conferenceId: 'test-conf', skipTiers: ['Media'] });
  assert.deepEqual(sponsors, [
    { id: 'test-conf:microsoft', conferenceId: 'test-conf', name: 'Microsoft', tier: 'Title', url: 'https://www.microsoft.com/' },
    { id: 'test-conf:pwc', conferenceId: 'test-conf', name: 'PwC', tier: 'Premier', url: 'https://www.pwc.com/us/en.html' },
    { id: 'test-conf:hso', conferenceId: 'test-conf', name: 'HSO', tier: 'Premier', url: 'https://www.hso.com/' },
    { id: 'test-conf:sikich', conferenceId: 'test-conf', name: 'Sikich', tier: 'Supporting', url: null },
  ]);
});
