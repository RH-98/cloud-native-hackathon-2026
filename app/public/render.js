// Builds the profile card and the plan (day tabs + timeline) as DOM nodes.
// Everything from the API goes in as text nodes, never as HTML.
// Buttons carry data-action attributes; app.js handles the clicks.
import { cityOf, formatDateSpan, formatDay, formatTimeRange, minutesBetween, safeUrl, timeRangeParts, zoneLongName } from './format.js';

const MIN_GAP_MINUTES = 15;

// h('a', { href, class: 'x' }, 'text', child) -> element
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // CSSOM, not a style attribute: the CSP blocks inline style attributes.
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const srOnly = (text) => h('span', { class: 'sr-only' }, text);

function externalLink(href, text, attrs = {}) {
  const url = safeUrl(href);
  if (!url) return h('span', attrs, text);
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', ...attrs }, text, srOnly(' (opens in a new tab)'));
}

// <time>11:30</time>–<time>12:00 PM</time> <abbr>MT</abbr>
export function timeRange(start, end, timeZone, cls = 'when', fullStart = false) {
  const r = timeRangeParts(start, end, timeZone, { fullStart });
  const zone = h('abbr', { title: zoneLongName(timeZone, new Date(start)) }, r.zone);
  if (!r.end) return h('span', { class: cls }, h('time', { datetime: start }, r.start), ' ', zone);
  return h('span', { class: cls },
    h('time', { datetime: start }, r.start), '–', h('time', { datetime: end }, r.end), ' ', zone);
}

// ---------- Conference picker ----------

// One radio card per conference: a real (visually hidden) radio, so arrow
// keys move between cards, and a label card with the full name and details.
export function renderConferenceCards(container, conferences, selectedId) {
  container.replaceChildren(...conferences.map((conf) => {
    const id = `conf-${conf.id}`;
    const n = Number(conf.sessionCount);
    const meta = [
      formatDateSpan(conf.startDate, conf.endDate),
      cityOf(conf.location),
      Number.isFinite(n) && n > 0 ? `${n} session${n === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return h('div', { class: 'conf' },
      h('input', { class: 'conf__input', type: 'radio', name: 'conference', id, value: conf.id, checked: conf.id === selectedId }),
      h('label', { class: 'conf__card', for: id },
        h('span', { class: 'conf__check', 'aria-hidden': 'true' }),
        h('span', { class: 'conf__name' }, conf.name),
        h('span', { class: 'conf__meta' }, meta.map((m) => h('span', {}, m)))));
  }));
}

// ---------- Profile ----------

let tipCount = 0;

function toolChip(tool) {
  const evidence = (tool.evidence || []).filter(Boolean);
  if (!evidence.length) return h('li', { class: 'chip chip--tool' }, tool.name);
  const id = `tip-${++tipCount}`;
  const shown = evidence.slice(0, 4).join(', ') + (evidence.length > 4 ? ` and ${evidence.length - 4} more` : '');
  return h('li', { class: 'chip chip--tool chip--has-tip' },
    h('span', { class: 'chip__label', tabindex: '0', 'aria-describedby': id }, tool.name),
    h('span', { class: 'tip', role: 'tooltip', id }, `Seen in ${shown}`));
}

function chips(items, cls = 'chip') {
  return h('ul', { class: 'chips' }, items.map((t) => h('li', { class: cls }, t)));
}

// notes: warning messages to show above the card (state.warningMessages).
export function renderProfile(section, profile, notes = []) {
  section.replaceChildren();
  const blended = profile.source === 'github+interests';
  const isGithub = profile.source === 'github' || blended;
  // A pasted LinkedIn profile: we never show a name from it (we don't parse one).
  const linkedin = profile.pastedFrom === 'linkedin';
  const avatarUrl = safeUrl(profile.avatarUrl);
  const name = profile.displayName || profile.username || 'You';
  const avatar = avatarUrl
    ? h('img', { class: 'profile__avatar', src: avatarUrl, alt: `GitHub avatar of ${name}`, width: 72, height: 72 })
    : h('span', { class: 'profile__avatar profile__avatar--mono', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase());

  const who = h('div', { class: 'profile__who' },
    h('p', { class: 'profile__name' }, name),
    isGithub && profile.username
      ? h('p', { class: 'profile__sub' },
        externalLink(`https://github.com/${encodeURIComponent(profile.username)}`, `@${profile.username}`),
        ` · scanned ${profile.repoCount ?? 0} public repo${profile.repoCount === 1 ? '' : 's'}${blended ? (linkedin ? ', plus skills from a pasted LinkedIn profile' : ', plus the interests you typed') : ''}`)
      : h('p', { class: 'profile__sub' }, linkedin ? 'From pasted LinkedIn profile' : 'From the interests you typed'));

  const blocks = [];
  const tools = profile.tools || [];
  if (isGithub) {
    if (tools.length) {
      blocks.push(h('div', { class: 'profile__block' },
        h('h3', {}, 'Tools we spotted'),
        h('p', { class: 'hint' }, blended
          ? `Focus or hover a tool to see which repos it came from. Tools without repos are ${linkedin ? 'from LinkedIn' : 'ones you typed'}.`
          : 'Focus or hover a tool to see which repos it came from.'),
        h('ul', { class: 'chips' }, tools.map(toolChip))));
    }
    const langs = profile.languages || [];
    if (langs.length) {
      blocks.push(h('div', { class: 'profile__block' },
        h('h3', {}, 'Languages'),
        h('ul', { class: 'langs' }, langs.slice(0, 6).map((l) => {
          const pct = Math.round((l.weight || 0) * 100);
          return h('li', { class: 'lang' },
            h('span', { class: 'lang__name' }, l.name),
            h('span', { class: 'lang__bar', 'aria-hidden': 'true' }, h('span', { class: 'lang__fill', style: { width: `${pct}%` } })),
            h('span', { class: 'lang__pct' }, `${pct}%`));
        }))));
    }
    const words = [...new Set([...(profile.topics || []), ...(profile.keywords || [])])];
    if (words.length) {
      blocks.push(h('div', { class: 'profile__block' }, h('h3', {}, 'Topics and keywords'), chips(words.slice(0, 20))));
    }
  } else if (linkedin) {
    const langs = (profile.languages || []).map((l) => l.name);
    const skills = [...new Set([...tools.map((t) => t.label || t.name), ...langs])];
    if (skills.length) {
      blocks.push(h('div', { class: 'profile__block' }, h('h3', {}, 'Skills and tools from LinkedIn'), chips(skills.slice(0, 20), 'chip chip--tool')));
    }
    const words = [...new Set([...(profile.topics || []), ...(profile.keywords || [])])];
    if (words.length) {
      blocks.push(h('div', { class: 'profile__block' }, h('h3', {}, 'Roles and topics from LinkedIn'), chips(words.slice(0, 20))));
    }
    blocks.push(h('p', { class: 'hint' }, 'We kept only these signals, not the text you pasted. Not quite right? Paste the Skills section too, or type interests instead.'));
  } else {
    const words = [...new Set([...tools.map((t) => t.name), ...(profile.keywords || []), ...(profile.topics || [])])];
    blocks.push(h('div', { class: 'profile__block' },
      h('h3', {}, 'What we understood'),
      words.length ? chips(words.slice(0, 24), 'chip chip--tool') : h('p', {}, 'Nothing specific yet. Try naming tools or projects.'),
      h('p', { class: 'hint' }, 'Not quite right? Edit your interests and map again.')));
  }
  if (!blocks.length) blocks.push(h('p', { class: 'hint' }, 'We found no strong signals in the public repos, so the plan leans on popular sessions.'));

  section.append(
    h('h2', { id: 'profile-heading', class: 'section-title' }, h('span', { class: 'section-title__step' }, '02'), ' Field notes'),
    ...notes.map((note) => h('p', { class: 'notice' }, h('strong', {}, 'Heads up: '), note)),
    h('div', { class: 'profile__card' }, h('div', { class: 'profile__head' }, avatar, who), ...blocks));
}

// ---------- Plan ----------

function badge(text, cls) {
  return h('span', { class: `badge ${cls}` }, text);
}

function reasonChips(reasons, label) {
  if (!reasons?.length) return null;
  return h('ul', { class: 'chips chips--reasons', 'aria-label': label }, reasons.map((r) => h('li', { class: 'chip chip--reason' }, r)));
}

function facts(session) {
  const rows = [];
  if (session.room) rows.push(['Room', session.room]);
  if (session.speakers?.length) rows.push([session.speakers.length > 1 ? 'Speakers' : 'Speaker', session.speakers.join(', ')]);
  if (session.level) rows.push(['Level', session.level]);
  if (session.track) rows.push(['Track', session.track]);
  if (!rows.length) return null;
  return h('dl', { class: 'facts' }, rows.map(([k, v]) => h('div', { class: 'facts__row' }, h('dt', {}, k), h('dd', {}, v))));
}

function slotActions(date, index, slot) {
  const title = slot.pick.session.title;
  const pinned = Boolean(slot.pinned);
  return h('div', { class: 'actions' },
    slot.backups?.length
      ? h('button', { type: 'button', class: 'btn btn--small', dataset: { action: 'swap', day: date, slot: index, backup: 0, focusKey: `swap-${date}-${index}` } },
        'Swap', srOnly(` ${title} for the first backup`))
      : null,
    h('button', { type: 'button', class: 'btn btn--small btn--pin', 'aria-pressed': pinned ? 'true' : 'false', dataset: { action: 'pin', day: date, slot: index, focusKey: `pin-${date}-${index}` } },
      pinned ? 'Pinned' : 'Pin', srOnly(` ${title}`)),
    h('button', { type: 'button', class: 'btn btn--small btn--quiet', dataset: { action: 'skip', day: date, slot: index, focusKey: `skip-${date}-${index}` } },
      'Skip', srOnly(` ${title}`)));
}

function backupList(date, index, slot, timeZone) {
  const backups = (slot.backups || []).filter((b) => b && b.session);
  if (!backups.length) return null;
  return h('details', { class: 'backups' },
    h('summary', {}, `Backups (${backups.length})`),
    h('ol', { class: 'backups__list' }, backups.map((b, bi) => h('li', { class: 'backup' },
      h('p', { class: 'backup__title' }, externalLink(b.session.url, b.session.title)),
      h('p', { class: 'backup__meta' },
        timeRange(b.session.start, b.session.end, timeZone),
        b.session.room ? ` · ${b.session.room}` : '',
        b.session.level ? ` · ${b.session.level}` : ''),
      reasonChips(b.reasons, 'Why this backup'),
      h('button', { type: 'button', class: 'btn btn--small', dataset: { action: 'swap', day: date, slot: index, backup: bi } },
        'Use this one', srOnly(`: ${b.session.title}`))))));
}

function slotItem(date, index, slot, timeZone, booths = []) {
  const rec = slot.pick;
  if (!rec || !rec.session) {
    // Free time: booths that fit here, and any backups the planner offered.
    return h('li', { class: 'stop stop--gap' },
      h('div', { class: 'stop__time' }, timeRange(slot.start, slot.end, timeZone, 'when', true)),
      h('div', { class: 'gap' },
        h('h4', { class: 'gap__title' }, freeFor(slot.start, slot.end), booths.length ? ' \u00b7 booth stops on the way' : ''),
        booths.length
          ? h('ul', { class: 'booths' }, booths.map(boothItem))
          : h('p', { class: 'hint' }, 'Nothing here matched you. Rest, refill your water, or wander the hallway track.'),
        backupList(date, index, slot, timeZone)));
  }
  const s = rec.session;
  const titleId = `pick-${date}-${index}`;
  const flags = [
    slot.pinned ? badge('Pinned', 'badge--pinned') : null,
    slot.swapped ? badge('Swapped in', 'badge--swapped') : null,
    s.sponsored ? badge('Sponsored', 'badge--sponsored') : null,
  ].filter(Boolean);
  return h('li', { class: `stop${slot.pinned ? ' stop--pinned' : ''}` },
    h('div', { class: 'stop__time' }, timeRange(s.start || slot.start, s.end || slot.end, timeZone, 'when', true)),
    h('article', { class: 'stop__card', 'aria-labelledby': titleId },
      flags.length ? h('p', { class: 'badges' }, flags) : null,
      h('h4', { class: 'stop__title', id: titleId },
        externalLink(s.url, s.title, { dataset: { focusKey: `pick-${date}-${index}` } })),
      facts(s),
      reasonChips(rec.reasons, 'Why this session'),
      slotActions(date, index, slot),
      backupList(date, index, slot, timeZone)));
}

function boothItem(booth) {
  const sp = booth.sponsor;
  return h('li', { class: 'booth' },
    h('p', { class: 'booth__name' }, externalLink(sp.url, sp.name), sp.tier ? h('span', { class: 'booth__tier' }, ` ${sp.tier}`) : null),
    reasonChips(booth.reasons, `Why visit ${sp.name}`));
}

function freeFor(start, end) {
  const mins = minutesBetween(start, end);
  if (mins < 60) return `Free for ${mins} min`;
  return `Free for ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}

function gapItem(gap, timeZone) {
  return h('li', { class: 'stop stop--gap' },
    h('div', { class: 'stop__time' }, timeRange(gap.start, gap.end, timeZone, 'when', true)),
    h('div', { class: 'gap' },
      h('h4', { class: 'gap__title' }, freeFor(gap.start, gap.end), gap.booths.length ? ' \u00b7 booth stops on the way' : ''),
      gap.booths.length ? h('ul', { class: 'booths' }, gap.booths.map(boothItem)) : null));
}

// Interleaves slots with free gaps, and puts each booth in the free time
// (a slot with no pick, or a gap between slots) its own gap overlaps.
export function timelineEntries(day) {
  const slots = (day.slots || []).map((slot, index) => ({ slot, index, booths: [] }))
    .sort((a, b) => new Date(a.slot.start) - new Date(b.slot.start));
  const overlaps = (x, g) => new Date(x.start) < new Date(g.end) && new Date(x.end) > new Date(g.start);
  const gaps = [];
  let lastEnd = null;
  for (const { slot } of slots) {
    const start = slot.pick?.session?.start || slot.start;
    const end = slot.pick?.session?.end || slot.end || start;
    if (lastEnd && minutesBetween(lastEnd, start) >= MIN_GAP_MINUTES) gaps.push({ start: lastEnd, end: start, booths: [] });
    if (!lastEnd || new Date(end) > new Date(lastEnd)) lastEnd = end;
  }
  const loose = [];
  for (const booth of day.booths || []) {
    if (!booth?.sponsor) continue;
    const g = booth.gap;
    if (!g?.start || !g?.end) { loose.push(booth); continue; }
    const open = slots.find((x) => !x.slot.pick && overlaps(x.slot, g));
    const hit = open || gaps.find((x) => overlaps(x, g));
    if (hit) hit.booths.push(booth);
    else gaps.push({ start: g.start, end: g.end, booths: [booth] });
  }
  const entries = [
    ...slots.map(({ slot, index, booths }) => ({ kind: 'slot', at: slot.start, slot, index, booths })),
    ...gaps.map((gap) => ({ kind: 'gap', at: gap.start, gap })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at) || (a.kind === 'gap' ? -1 : 1));
  return { entries, loose };
}

function dayPanel(day, timeZone, active) {
  const { entries, loose } = timelineEntries(day);
  const panel = h('div', {
    class: 'day', role: 'tabpanel', id: `panel-${day.date}`, 'aria-labelledby': `tab-${day.date}`, tabindex: '0', hidden: !active,
  });
  panel.append(h('h3', { class: 'day__title' }, formatDay(day.date, 'long')));
  if (!entries.length) {
    panel.append(h('p', { class: 'empty-day' }, 'No sessions matched this day with your options. Try more levels or include sponsored sessions.'));
  } else {
    panel.append(h('ol', { class: 'timeline' }, entries.map((e) => (e.kind === 'slot'
      ? slotItem(day.date, e.index, e.slot, timeZone, e.booths)
      : gapItem(e.gap, timeZone)))));
  }
  if (loose.length) {
    panel.append(h('div', { class: 'detour' },
      h('h4', {}, 'Booths worth a detour'),
      h('ul', { class: 'booths' }, loose.map(boothItem))));
  }
  return panel;
}

export function renderPlan(container, plan, activeDay) {
  const timeZone = plan.conference?.timezone || 'UTC';
  const days = plan.days || [];
  container.replaceChildren();
  if (!days.length) {
    container.append(h('p', { class: 'empty-day' }, 'No sessions matched. Try checking more days or levels, or broaden your interests.'));
    return null;
  }
  // Keep the open tab; otherwise open the first day that has a pick.
  const firstWithPicks = days.find((d) => (d.slots || []).some((s) => s.pick)) || days[0];
  const active = days.some((d) => d.date === activeDay) ? activeDay : firstWithPicks.date;
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Conference days' }, days.map((d) => {
    const picks = (d.slots || []).filter((s) => s.pick).length;
    const selected = d.date === active;
    return h('button', {
      type: 'button', role: 'tab', id: `tab-${d.date}`, class: 'tab',
      'aria-selected': selected ? 'true' : 'false', 'aria-controls': `panel-${d.date}`, tabindex: selected ? '0' : '-1',
      dataset: { action: 'tab', day: d.date },
    }, h('span', { class: 'tab__day' }, formatDay(d.date)), srOnly(', '), h('span', { class: 'tab__count' }, `${picks} stop${picks === 1 ? '' : 's'}`));
  }));
  container.append(tabs, ...days.map((d) => dayPanel(d, timeZone, d.date === active)));
  return active;
}

export function planMeta(plan) {
  const timeZone = plan.conference?.timezone || 'UTC';
  const backend = plan.searchBackend === 'elasticsearch' ? 'Elasticsearch' : 'the bundled schedule snapshot';
  return `${plan.conference?.name || plan.conferenceId}. All times in ${zoneLongName(timeZone)}. Matched with ${backend}.`;
}

// ---------- People to meet ----------

// data: { connections: [{ attendee, score, shared, why, commonSessions }], demoData }
export function renderConnections(section, data, timeZone) {
  section.replaceChildren();
  const people = (data?.connections || []).filter((c) => c && c.attendee);
  if (!people.length) return false;
  section.append(
    h('h2', { id: 'people-heading', class: 'section-title' }, h('span', { class: 'section-title__step' }, '04'), ' People to meet'),
    h('p', { class: 'note' },
      data.demoData === false ? null : [h('strong', {}, people.some((c) => c.attendee.demo === false)
        ? 'Fictional demo attendees, plus real attendees who signed in with GitHub and opted in.'
        : 'Fictional demo attendees.'), ' '],
      'Matching is opt-in: only attendees who chose to be found are shown, and only shared public topics.'),
    h('ul', { class: 'people__list' }, people.map((c, i) => {
      const a = c.attendee;
      const id = `person-${i}`;
      const sessions = (c.commonSessions || []).filter((s) => s && s.title);
      return h('li', { class: 'person' },
        h('article', { 'aria-labelledby': id },
          h('h3', { class: 'person__name', id }, a.displayName || a.handle || 'Attendee'),
          a.role || a.handle ? h('p', { class: 'person__role' }, [a.role, a.handle ? `@${a.handle}` : null].filter(Boolean).join(' · ')) : null,
          c.why ? h('p', { class: 'person__why' }, c.why) : null,
          c.shared?.length ? h('ul', { class: 'chips', 'aria-label': 'In common' }, c.shared.map((t) => h('li', { class: 'chip chip--reason' }, t))) : null,
          sessions.length ? h('ul', { class: 'person__also' }, sessions.slice(0, 3).map((s) => h('li', {},
            h('span', { class: 'person__also-label' }, 'Also going to: '),
            s.title,
            s.start ? [' (', h('time', { datetime: s.start }, formatTimeRange(s.start, null, timeZone)), ')'] : null))) : null));
    })));
  return true;
}

export { formatTimeRange };
