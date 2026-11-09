// Date and time formatting, always in the conference's time zone (not the
// viewer's), with a short zone name such as "MT". No DOM here, so node:test
// can import it.

const LOCALE = 'en-US';
const cache = new Map();

function fmt(timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(LOCALE, { timeZone, ...options }));
  return cache.get(key);
}

// "MT" for America/Denver; falls back to "MST"-style or the IANA name.
export function zoneLabel(timeZone, at = new Date()) {
  for (const timeZoneName of ['shortGeneric', 'short']) {
    try {
      const part = fmt(timeZone, { timeZoneName }).formatToParts(at).find((p) => p.type === 'timeZoneName');
      if (part && !/^GMT/.test(part.value)) return part.value;
    } catch {
      // shortGeneric is not supported everywhere; try the next one.
    }
  }
  return timeZone;
}

// "Mountain Time" for screen readers and titles.
export function zoneLongName(timeZone, at = new Date()) {
  try {
    const part = fmt(timeZone, { timeZoneName: 'longGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    if (part) return part.value;
  } catch {
    // fall through
  }
  return timeZone;
}

function parts(iso, timeZone) {
  const p = {};
  for (const { type, value } of fmt(timeZone, { hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso))) {
    p[type] = value;
  }
  return { clock: `${p.hour}:${p.minute}`, period: (p.dayPeriod || '').toUpperCase() };
}

// "11:30 AM"
export function formatTime(iso, timeZone) {
  const { clock, period } = parts(iso, timeZone);
  return `${clock} ${period}`.trim();
}

// { start: "11:30", end: "12:00 PM", zone: "MT" } so the caller can wrap each
// end in its own <time>. The start keeps its AM/PM only when it differs,
// or always with fullStart.
export function timeRangeParts(startIso, endIso, timeZone, { fullStart = false } = {}) {
  const s = parts(startIso, timeZone);
  const zone = zoneLabel(timeZone, new Date(startIso));
  if (!endIso) return { start: `${s.clock} ${s.period}`, end: '', zone };
  const e = parts(endIso, timeZone);
  const start = s.period === e.period && !fullStart ? s.clock : `${s.clock} ${s.period}`;
  return { start, end: `${e.clock} ${e.period}`, zone };
}

// "11:30–12:00 PM MT"
export function formatTimeRange(startIso, endIso, timeZone) {
  const r = timeRangeParts(startIso, endIso, timeZone);
  return r.end ? `${r.start}–${r.end} ${r.zone}` : `${r.start} ${r.zone}`;
}

// "2026-11-10" -> "Tue, Nov 10" (short) or "Tuesday, November 10" (long).
// Dates are calendar dates, so format them at noon UTC in UTC.
export function formatDay(date, style = 'short') {
  const d = new Date(`${date}T12:00:00Z`);
  const options = style === 'long'
    ? { weekday: 'long', month: 'long', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' };
  return fmt('UTC', options).format(d);
}

// "Nov 9–12, 2026", "Nov 30 – Dec 2, 2026" or "Dec 30, 2026 – Jan 2, 2027"
// from "YYYY-MM-DD" dates.
export function formatDateSpan(startDate, endDate) {
  const d = (s) => new Date(`${s}T12:00:00Z`);
  if (!startDate) return '';
  const full = (s) => fmt('UTC', { month: 'short', day: 'numeric', year: 'numeric' }).format(d(s));
  if (!endDate || endDate === startDate) return full(startDate);
  const [sy, sm] = startDate.split('-');
  const [ey, em] = endDate.split('-');
  const monthDay = (s) => fmt('UTC', { month: 'short', day: 'numeric' }).format(d(s));
  if (sy !== ey) return `${full(startDate)} – ${full(endDate)}`;
  if (sm !== em) return `${monthDay(startDate)} – ${monthDay(endDate)}, ${sy}`;
  return `${monthDay(startDate)}–${Number(endDate.split('-')[2])}, ${sy}`;
}

// The city part of a venue address: "Salt Palace Convention Center, Salt
// Lake City, Utah" -> "Salt Lake City, Utah". Short addresses stay as they are.
export function cityOf(location) {
  const parts = String(location || '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(1).join(', ') : parts.join(', ');
}

// Every date from start to end inclusive, as "YYYY-MM-DD".
export function dateRange(startDate, endDate) {
  const out = [];
  if (!startDate || !endDate) return out;
  const d = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (d <= end && out.length < 31) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function minutesBetween(aIso, bIso) {
  return Math.round((new Date(bIso) - new Date(aIso)) / 60000);
}

// Only http(s) links from data make it into an href.
export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
