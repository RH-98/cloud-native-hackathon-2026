// Importer for Linux Foundation event pages (events.linuxfoundation.org).
// Converts the schedule page (rendered from Sessionize) and the sponsor list
// page into the planner's common conference format (see conference-format.md).
// Pure functions: no network access here, so they're easy to test.
const cheerio = require('cheerio');

const LEVELS = new Set(['Beginner', 'Intermediate', 'Advanced', 'Any Level']);

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

const decodeCfEmail = (hex) => {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
};

// The schedule page gives local times without an offset ("2026-11-10T11:30:00").
// Attach the conference's UTC offset so every timestamp is unambiguous.
function withOffset(localDateTime, utcOffset) {
  if (!localDateTime) return null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(localDateTime)) return localDateTime;
  return `${localDateTime}${utcOffset}`;
}

/**
 * Parse an LF schedule page into sessions.
 * @param {string} html - the schedule page HTML
 * @param {{conferenceId: string, utcOffset: string, pageUrl: string}} opts
 * @returns {object[]} sessions in the common format
 */
function parseSchedule(html, { conferenceId, utcOffset, pageUrl }) {
  const $ = cheerio.load(html);
  const byId = new Map();

  $('a.sess-link[data-session-id]').each((_, link) => {
    const $link = $(link);
    const sourceId = $link.attr('data-session-id');
    if (byId.has(sourceId)) return;

    const $wrap = $link.closest('.sess-wrap');
    const tags = [];
    let track = null;
    let slidesAvailable = false;
    $link.find('.sess__tags .tag').each((__, tag) => {
      const $tag = $(tag);
      if ($tag.hasClass('tag--asset')) {
        slidesAvailable = true;
        return;
      }
      const text = clean($tag.text());
      if (!text) return;
      if ($tag.hasClass('tag--primary')) track = text;
      tags.push(text);
    });

    const times = $wrap.find('.sess__seo time');
    const speakers = clean($link.find('.sess__speakers').text())
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Separate paragraphs and list items with a space so words don't run together.
    const $desc = $wrap.find('.sess__seodesc');
    $desc.find('[data-cfemail]').each((__, el) => {
      $(el).replaceWith(decodeCfEmail($(el).attr('data-cfemail')));
    });
    $desc.find('p, li, br').each((__, el) => {
      $(el).append(' ');
    });
    const description = clean($desc.text());

    byId.set(sourceId, {
      id: `${conferenceId}:${sourceId}`,
      conferenceId,
      sourceId,
      title: clean($link.find('.sess__title').text()),
      description,
      start: withOffset(times.eq(0).attr('datetime'), utcOffset),
      end: withOffset(times.eq(1).attr('datetime'), utcOffset),
      room: clean($link.find('.sess__room').text()) || null,
      speakers,
      track,
      level: tags.find((t) => LEVELS.has(t)) || null,
      tags,
      sponsored: tags.includes('Sponsored'),
      // Coat check, registration, meals: no speakers and no tags (some carry an info description).
      kind: speakers.length || tags.length ? 'session' : 'logistics',
      slidesAvailable,
      url: $link.attr('href') || `${pageUrl}?id=${sourceId}`,
    });
  });

  return [...byId.values()];
}

/**
 * Parse an LF sponsor list page into sponsors with their tier.
 * @param {string} html - the sponsor list page HTML
 * @param {{conferenceId: string}} opts
 * @returns {object[]} sponsors in the common format
 */
function parseSponsors(html, { conferenceId }) {
  const $ = cheerio.load(html);
  const byName = new Map();

  $('.wp-block-cgb-sponsors-block').each((_, block) => {
    const tier = clean($(block).find('.sponsors-logos--header').first().text()) || null;
    $(block)
      .find('.sponsors-logo-item a')
      .each((__, a) => {
        const $a = $(a);
        const name =
          clean(($a.attr('title') || '').replace(/^Go to\s+/i, '')) ||
          clean(($a.find('img').attr('alt') || '').replace(/\s+logo$/i, ''));
        if (!name || byName.has(name.toLowerCase())) return;
        byName.set(name.toLowerCase(), {
          id: `${conferenceId}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          conferenceId,
          name,
          tier,
          url: $a.attr('href') || null,
        });
      });
  });

  return [...byName.values()];
}

module.exports = { parseSchedule, parseSponsors, withOffset };
