// Importer for a plain sponsor page: tier headings followed by linked logos,
// e.g. <h2>Premier</h2> ... <a href="https://pwc.com"><img alt="PwC"></a>.
// Many conference sites (Convergence among them) list sponsors this way.
// Pure function: HTML in, sponsors in the common format out.
const cheerio = require('cheerio');

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {string} html - the sponsor page HTML
 * @param {{conferenceId: string, headings?: string, skipTiers?: string[]}} opts
 *   headings: selector for tier headings (default "h2"); skipTiers: tiers to leave out (e.g. "Media")
 * @returns {object[]} sponsors in the common format
 */
function parseSponsorLogos(html, { conferenceId, headings = 'h2', skipTiers = [] }) {
  const $ = cheerio.load(html);
  const byName = new Map();
  let tier = null;
  // cheerio returns a combined selection in document order.
  $(`${headings}, a:has(img[alt])`).each((_, el) => {
    const $el = $(el);
    if (!$el.is('a')) {
      tier = clean($el.text()) || null;
      return;
    }
    if (!tier || skipTiers.includes(tier)) return;
    const name = clean($el.find('img[alt]').first().attr('alt')).replace(/\s+logo$/i, '');
    const href = $el.attr('href') || null;
    if (!name || byName.has(name.toLowerCase())) return;
    byName.set(name.toLowerCase(), {
      id: `${conferenceId}:${slug(name)}`,
      conferenceId,
      name,
      tier,
      url: href && /^https?:\/\//.test(href) ? href : null,
    });
  });
  return [...byName.values()];
}

module.exports = { parseSponsorLogos };
