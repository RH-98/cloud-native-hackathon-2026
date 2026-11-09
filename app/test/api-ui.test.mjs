// Tests for the browser modules that have no DOM: the .ics and text exports,
// time formatting, and local swaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, escapeText, foldLine, planToText, toUtcStamp } from '../public/ics.js';
import { cityOf, formatDateSpan, formatTimeRange, dateRange, safeUrl } from '../public/format.js';
import { applySwaps, planRequest, slotKey, swapSlot, warningMessages } from '../public/state.js';

const session = (id, title, start, end, extra = {}) => ({
  id: `kubecon-na-2026:${id}`,
  title,
  start,
  end,
  room: 'Salt Palace | Level 2 | 250 A-C',
  speakers: ['Ada Lovelace', 'Grace Hopper'],
  track: 'Observability',
  level: 'Beginner',
  url: `https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/?id=${id}`,
  ...extra,
});

function samplePlan() {
  return {
    conferenceId: 'kubecon-na-2026',
    conference: { name: 'KubeCon + CloudNativeCon North America 2026', timezone: 'America/Denver', utcOffset: '-07:00' },
    days: [{
      date: '2026-11-10',
      slots: [{
        start: '2026-11-10T11:30:00-07:00',
        end: '2026-11-10T12:00:00-07:00',
        pick: { session: session(1, 'Tracing, Metrics; and\nLogs', '2026-11-10T11:30:00-07:00', '2026-11-10T12:00:00-07:00'), score: 0.9, reasons: ['Matches opentelemetry'] },
        backups: [
          { session: session(2, 'Backup A', '2026-11-10T11:30:00-07:00', '2026-11-10T12:00:00-07:00'), score: 0.5, reasons: [] },
          { session: session(3, 'Backup B', '2026-11-10T11:45:00-07:00', '2026-11-10T12:15:00-07:00'), score: 0.4, reasons: [] },
        ],
        pinned: false,
      }, {
        start: '2026-11-10T14:00:00-07:00', end: '2026-11-10T14:30:00-07:00', pick: null, backups: [], pinned: false,
      }],
      booths: [],
    }],
  };
}

test('escapeText escapes commas, semicolons, backslashes and newlines', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('toUtcStamp converts an offset time to UTC Z', () => {
  assert.equal(toUtcStamp('2026-11-10T11:30:00-07:00'), '20261110T183000Z');
});

test('foldLine keeps lines at 75 octets without splitting characters', () => {
  const folded = foldLine(`DESCRIPTION:${'é'.repeat(100)}`);
  for (const line of folded.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), `DESCRIPTION:${'é'.repeat(100)}`);
});

test('buildIcs makes one VEVENT per pick with UTC times and CRLF lines', () => {
  const ics = buildIcs(samplePlan(), { now: new Date('2026-11-09T21:00:00Z') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /\n/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /DTSTART:20261110T183000Z\r\n/);
  assert.match(unfolded, /DTEND:20261110T190000Z\r\n/);
  assert.match(unfolded, /DTSTAMP:20261109T210000Z\r\n/);
  assert.match(unfolded, /SUMMARY:Tracing\\, Metrics\\; and\\nLogs\r\n/);
  assert.match(unfolded, /LOCATION:Salt Palace \| Level 2 \| 250 A-C\r\n/);
  assert.match(unfolded, /URL:https:\/\/events\.linuxfoundation\.org\/.*\?id=1\r\n/);
  assert.match(unfolded, /DESCRIPTION:Speakers: Ada Lovelace\\, Grace Hopper\\n/);
  assert.match(unfolded, /UID:kubecon-na-2026:1@switchback\.planner/);
});

test('planToText lists picks with Mountain Time ranges', () => {
  const text = planToText(samplePlan());
  assert.match(text, /TUESDAY, NOVEMBER 10/);
  assert.match(text, /11:30 AM–12:00 PM MT {2}Tracing, Metrics; and Logs\n/);
  assert.match(text, /Backups: Backup A \/ Backup B/);
  assert.match(text, /Free time/);
});

test('formatTimeRange shows Mountain Time', () => {
  assert.equal(formatTimeRange('2026-11-10T11:30:00-07:00', '2026-11-10T12:00:00-07:00', 'America/Denver'), '11:30 AM–12:00 PM MT');
  assert.equal(formatTimeRange('2026-11-10T14:00:00-07:00', '2026-11-10T14:30:00-07:00', 'America/Denver'), '2:00–2:30 PM MT');
});

test('dateRange and safeUrl', () => {
  assert.deepEqual(dateRange('2026-11-09', '2026-11-12'), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
});

test('swapSlot promotes a backup and applySwaps re-applies it to a new plan', () => {
  const plan = samplePlan();
  const slot = plan.days[0].slots[0];
  const rec = swapSlot(slot, 1);
  assert.equal(rec.session.title, 'Backup B');
  assert.equal(slot.pick.session.title, 'Backup B');
  assert.equal(slot.backups[1].session.title.startsWith('Tracing'), true);
  const swaps = new Map([[slotKey('2026-11-10', slot), rec.session.id]]);
  const fresh = applySwaps(samplePlan(), swaps);
  assert.equal(fresh.days[0].slots[0].pick.session.title, 'Backup B');
  assert.equal(fresh.days[0].slots[0].swapped, true);
});

test('planRequest adds pins and skips without touching the base request', () => {
  const base = { conferenceId: 'kubecon-na-2026', github: 'octocat', options: { firstTimer: true } };
  const body = planRequest(base, new Set(['kubecon-na-2026:1']), new Set());
  assert.deepEqual(body.options, { firstTimer: true, pinned: ['kubecon-na-2026:1'] });
  assert.equal(base.options.pinned, undefined);
});

test('warningMessages explains known warnings and drops the rest', () => {
  const [msg, ...rest] = warningMessages(['github_rate_limited', 'nope', 42, 'constructor']);
  assert.match(msg, /rate limiting/);
  assert.deepEqual(rest, []);
  assert.deepEqual(warningMessages(undefined), []);
});

test('formatDateSpan and cityOf describe a conference card', () => {
  assert.equal(formatDateSpan('2026-11-09', '2026-11-12'), 'Nov 9–12, 2026');
  assert.equal(formatDateSpan('2026-11-30', '2026-12-02'), 'Nov 30 – Dec 2, 2026');
  assert.equal(formatDateSpan('2026-12-30', '2027-01-02'), 'Dec 30, 2026 – Jan 2, 2027');
  assert.equal(formatDateSpan('2026-11-09', '2026-11-09'), 'Nov 9, 2026');
  assert.equal(cityOf('Salt Palace Convention Center, Salt Lake City, Utah'), 'Salt Lake City, Utah');
  assert.equal(cityOf('Amsterdam, Netherlands'), 'Amsterdam, Netherlands');
  assert.equal(cityOf(undefined), '');
});
