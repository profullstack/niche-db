/**
 * Title normalisation for the screen collection.
 *
 * Ported from genrewatch's slug.js and imdb.js so that every `screen` adapter
 * fills `data.normTitle` through the SAME function the match endpoint uses.
 * The join key between an IMDb row, a TMDB row and a name in somebody's
 * playlist has to be produced identically on every side, or "WALL·E" and
 * "Amélie" become two things each.
 */

/** Latin-ish transliteration for the accents that actually show up in titles. */
const FOLD = {
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  ä: 'a',
  å: 'a',
  ā: 'a',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  ē: 'e',
  ì: 'i',
  í: 'i',
  î: 'i',
  ï: 'i',
  ī: 'i',
  ò: 'o',
  ó: 'o',
  ô: 'o',
  õ: 'o',
  ö: 'o',
  ø: 'o',
  ō: 'o',
  ù: 'u',
  ú: 'u',
  û: 'u',
  ü: 'u',
  ū: 'u',
  ñ: 'n',
  ç: 'c',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ð: 'd',
  þ: 'th',
};

/** Lower-case, accents folded, combining marks stripped. */
export function fold(s) {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[àáâãäåāèéêëēìíîïīòóôõöøōùúûüūñçßæœðþ]/g, (c) => FOLD[c] ?? c)
      // Strip combining marks left by anything the table above missed.
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
  );
}

/**
 * A title reduced to comparable words.
 *
 * Used for matching a title against a channel in someone's own playlist, where
 * the two strings come from different vendors and agree on nothing but the words:
 * "Dune: Part Three (2026) [4K]" and "DUNE PART THREE UHD" have to meet somewhere.
 * Punctuation, bracketed junk and quality tags all go; word order is preserved
 * because it is the only signal left.
 *
 * Returns '' for a title with no Latin characters at all, and callers store that
 * as null rather than as an empty key that matches every other empty key.
 */
export function normaliseTitle(text) {
  return (
    fold(text)
      // Bracketed suffixes are almost always provider furniture: [4K], (2026), (HD).
      .replace(/[[(][^\])]*[\])]/g, ' ')
      .replace(/\b(4k|uhd|fhd|hd|sd|hevc|h265|h264|multi|vip|raw|dub|sub)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/** `normaliseTitle`, but null when nothing survives, which is what `data` stores. */
export function normTitleOrNull(text) {
  return normaliseTitle(text) || null;
}

/**
 * The key both sides of a link agree on: normalised title and year, with the
 * category in front when the caller has one so a show and a film of the same
 * name in the same year stay two things. Ported from genrewatch's `matchKey`.
 */
export function titleKey({ normTitle, year, category } = {}) {
  return `${category ?? ''} ${normTitle ?? ''} ${year ?? ''}`.trim().replace(/\s+/g, ' ');
}
