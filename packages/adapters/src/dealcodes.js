import { slugify, stripHtml } from '@nichedb/core/adapter';

/**
 * What every deal feed has in common, pulled out so the five adapters in the
 * deals collection say the same thing about a store, a code and a discount.
 *
 * WHY THIS EXISTS
 *
 * The site a coupon feed is for does not want a post, it wants a row: which
 * store, which code, how much off, until when. None of the deal communities
 * publish that as fields. Slickdeals puts the store in a `data-store-slug`
 * attribute on the outbound link and the code in the running text; DealNews
 * names the retailer in its own namespace and the code, when there is one, in
 * the summary; Ben's Bargains writes "at Amazon" at the end of the title and
 * bolds the code; Dealcatcher prefixes the title with "Amazon - ". So each
 * adapter finds the store its own way, and everything after that is here.
 *
 * `data.store` is the display name, `data.storeKey` the slug a consumer joins
 * on across sources -- `slugify('Best Buy')` and `slugify('BEST BUY')` are the
 * same key, which is the point -- and `data.storeDomain` is the host when the
 * feed says which one, which only Slickdeals does.
 */

/**
 * Words that follow "code" in prose and are not codes.
 *
 * Case-sensitive: a code is written in capitals, so "with code SAVE20" matches
 * and "with code at checkout" never reaches this list. These are the capitals
 * that do turn up after the cue in feed titles, which shout.
 */
const NOT_CODES = new Set([
  'AND',
  'FOR',
  'FREE',
  'FROM',
  'HERE',
  'ONLY',
  'REQUIRED',
  'SALE',
  'SHIPPING',
  'THAT',
  'THIS',
  'WHEN',
  'WITH',
  'YOUR',
]);

/** Where a code is announced: "promo code", "w/ code", "code:", "coupon code". */
const CUE = /\b(?:promo|coupon|discount|checkout|voucher|offer|use|w\/|with)?\s*codes?\b/gi;

/**
 * The code the text announces, or null.
 *
 * Reads the token after each "code" cue and keeps the first one that looks like
 * a code: written in capitals or digits, at least four characters or carrying a
 * digit, not a word from the list above and not a bare number, which is a
 * price or a percentage that happened to follow the word.
 */
export function extractCode(text) {
  const s = stripHtml(text);
  if (!s) return null;
  for (const m of s.matchAll(CUE)) {
    const rest = s.slice(m.index + m[0].length);
    const t = rest.match(/^[\s:=\-–"'“”«]*([A-Z0-9][A-Z0-9-]{2,24})(?![a-z])/);
    if (!t) continue;
    const code = t[1].replace(/-+$/, '');
    if (code.length < 3) continue;
    if (NOT_CODES.has(code)) continue;
    if (/^\d+$/.test(code)) continue;
    if (code.length < 4 && !/\d/.test(code)) continue;
    return code;
  }
  return null;
}

/**
 * How much off, when the title says so as a percentage or a dollar amount.
 * "45% off" and "$22 off" are the two ways deal desks write it; "$18" alone is
 * a price, not a discount, and is left to the price field.
 */
export function extractDiscount(text) {
  const s = stripHtml(text);
  let m = s.match(/(\d{1,3})\s*%\s*off/i);
  if (m) return { type: 'percent', value: Number(m[1]) };
  m = s.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*off/i);
  if (m) return { type: 'fixed', value: Number(m[1]) };
  return null;
}

/** The first "$12.34" in the text, as a number, or null. */
export function extractPrice(text) {
  const m = stripHtml(text).match(/\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** The same store fields every adapter in the collection writes. */
export function storeFields(name, { domain = null, slug = null } = {}) {
  const store = String(name ?? '').trim() || null;
  const storeKey = slug ? slugify(slug) : store ? slugify(store) : null;
  return {
    store,
    storeKey: storeKey || null,
    storeDomain: domain
      ? String(domain)
          .toLowerCase()
          .replace(/^www\./, '')
      : null,
  };
}

/** The tags a deal carries, so one feed query reads across all five sources. */
export function dealTags(source, { storeKey, code, discount, extra = [] }) {
  const tags = [source];
  if (storeKey) tags.push(storeKey);
  if (code) tags.push('coupon-code');
  if (discount?.type === 'percent') tags.push('percent-off');
  if (discount?.type === 'fixed') tags.push('dollars-off');
  return [...tags, ...extra].filter(Boolean);
}

/** Strip the tracking a feed appends to its own links, so two feeds of the same post dedupe. */
export function cleanUrl(url) {
  try {
    const u = new URL(String(url));
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_|^iref$|^src$/.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return url || null;
  }
}
