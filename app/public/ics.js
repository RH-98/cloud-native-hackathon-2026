// Exports: an iCalendar (.ics, RFC 5545) file and a plain-text version of the
// plan. Pure functions, no DOM, so node:test imports them directly.
import { formatDay, formatTimeRange, safeUrl, zoneLongName } from './format.js';

const CRLF = '\r\n';

// TEXT values escape backslash, semicolon, comma and newlines.
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// "2026-11-10T11:30:00-07:00" -> "20261110T183000Z"
export function toUtcStamp(iso) {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Lines longer than 75 octets continue on the next line after CRLF + space.
// Never split a multi-byte character.
export function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (size + n > limit) {
      out.push(current);
      current = '';
      size = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

function describe(rec, slot, timeZone) {
  const s = rec.session;
  const lines = [];
  if (s.speakers?.length) lines.push(`Speakers: ${s.speakers.join(', ')}`);
  const facts = [s.track, s.level].filter(Boolean).join(' · ');
  if (facts) lines.push(facts);
  if (rec.reasons?.length) lines.push(`Why: ${rec.reasons.join('; ')}`);
  const backups = (slot.backups || []).filter((b) => b && b.session);
  if (backups.length) {
    lines.push('Backups:');
    for (const b of backups) {
      const where = b.session.room ? `, ${b.session.room}` : '';
      lines.push(`- ${b.session.title} (${formatTimeRange(b.session.start, b.session.end, timeZone)}${where})`);
    }
  }
  if (s.url) lines.push(s.url);
  return lines.join('\n');
}

// plan: the Plan from the API, with any local swaps already applied.
export function buildIcs(plan, { now = new Date() } = {}) {
  const timeZone = plan.conference?.timezone || 'UTC';
  const stamp = toUtcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Switchback//KubeCon day planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`Switchback: ${plan.conference?.name || plan.conferenceId}`)}`,
  ];
  for (const day of plan.days || []) {
    for (const slot of day.slots || []) {
      const rec = slot.pick;
      if (!rec || !rec.session) continue;
      const s = rec.session;
      const start = s.start || slot.start;
      const end = s.end || slot.end;
      if (!start || !end) continue;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${escapeText(String(s.id).replace(/[^A-Za-z0-9:._-]/g, '-'))}@switchback.planner`);
      lines.push(`DTSTAMP:${stamp}`);
      lines.push(`DTSTART:${toUtcStamp(start)}`);
      lines.push(`DTEND:${toUtcStamp(end)}`);
      lines.push(`SUMMARY:${escapeText(s.title)}`);
      if (s.room) lines.push(`LOCATION:${escapeText(s.room)}`);
      const url = safeUrl(s.url);
      if (url) lines.push(`URL:${url}`);
      lines.push(`DESCRIPTION:${escapeText(describe(rec, slot, timeZone))}`);
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

// One line of text: newlines and runs of spaces collapse to a space.
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// A readable plain-text plan for pasting into notes or chat.
export function planToText(plan) {
  const timeZone = plan.conference?.timezone || 'UTC';
  const out = [`Switchback route: ${plan.conference?.name || plan.conferenceId}`];
  out.push(`Times in ${zoneLongName(timeZone)} (${timeZone})`);
  for (const day of plan.days || []) {
    out.push('', formatDay(day.date, 'long').toUpperCase());
    for (const slot of day.slots || []) {
      const rec = slot.pick;
      if (!rec || !rec.session) {
        out.push(`  ${formatTimeRange(slot.start, slot.end, timeZone)}  Free time`);
        continue;
      }
      const s = rec.session;
      const pin = slot.pinned ? ' [pinned]' : '';
      out.push(`  ${formatTimeRange(s.start || slot.start, s.end || slot.end, timeZone)}  ${oneLine(s.title)}${pin}`);
      const where = oneLine([s.room, s.speakers?.length ? s.speakers.join(', ') : null].filter(Boolean).join(' | '));
      if (where) out.push(`      ${where}`);
      if (s.url) out.push(`      ${s.url}`);
      const backups = (slot.backups || []).filter((b) => b && b.session).map((b) => oneLine(b.session.title));
      if (backups.length) out.push(`      Backups: ${backups.join(' / ')}`);
    }
    const booths = (day.booths || []).filter((b) => b && b.sponsor);
    if (booths.length) out.push(`  Booths: ${booths.map((b) => b.sponsor.name).join(', ')}`);
  }
  return `${out.join('\n')}\n`;
}
