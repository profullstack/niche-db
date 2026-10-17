/**
 * Lyrics for Profullstack's own bands (Þrøngva, Velocity Vibe, Meine Mutter,
 * and whoever comes next), read and written by the nixamp radio servers.
 *
 * Only words we wrote or hold the rights to belong here: a song's own tag,
 * what we wrote ourselves, or our transcription of our own recording. Nothing
 * here is ever fetched from a lyrics site.
 *
 * Pure: normalising, slugging and validating. The store is
 * packages/db/src/lyrics.js and the routes apps/web/src/routes/lyrics.js.
 */

export const LYRIC_SOURCES = Object.freeze({
  embedded: "From the recording's own tag",
  author: 'Written by us',
  transcribed: 'Transcribed by AI from the recording',
});

export const MAX_TEXT = 20_000;
export const MAX_FIELD = 300;
export const MAX_NOTE = 1000;

const clean = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();

/** What two spellings of one artist or title must agree on: NFC, trimmed, one space, lower case. */
export const lyricKey = (s) => clean(s).toLowerCase();

/** Letters ASCII has no accent-free form for, so Þrøngva is /lyrics/throngva. */
const TRANSLIT = {
  þ: 'th',
  ð: 'd',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ł: 'l',
  ı: 'i',
};

/**
 * The URL form of a name. Latin letters lose their accents; letters from other
 * scripts are kept as they are, so a name in Japanese still has a page.
 */
export function lyricSlug(s) {
  const slug = lyricKey(s)
    .replace(/[þðøæœßđłı]/g, (ch) => TRANSLIT[ch])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug || 'untitled';
}

/**
 * Check a posted lyric. Answers `{ error }` or `{ row }` with the keys and
 * slugs the store indexes on.
 */
export function validateLyric(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'Send a JSON object.' };
  const artist = clean(body.artist);
  const title = clean(body.title);
  if (!artist) return { error: 'artist is required.' };
  if (!title) return { error: 'title is required.' };
  if (artist.length > MAX_FIELD || title.length > MAX_FIELD)
    return { error: `artist and title are at most ${MAX_FIELD} characters.` };
  if (typeof body.text !== 'string') return { error: 'text is required.' };
  const text = body.text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: 'text is required.' };
  if (text.length > MAX_TEXT) return { error: `text is at most ${MAX_TEXT} characters.` };
  const source = String(body.source ?? '').trim();
  if (!Object.hasOwn(LYRIC_SOURCES, source))
    return { error: `source must be one of ${Object.keys(LYRIC_SOURCES).join(', ')}.` };
  const album = clean(body.album) || null;
  const language = clean(body.language) || null;
  const sourceNote = clean(body.sourceNote) || null;
  if (album && album.length > MAX_FIELD)
    return { error: `album is at most ${MAX_FIELD} characters.` };
  if (language && language.length > 35) return { error: 'language is at most 35 characters.' };
  if (sourceNote && sourceNote.length > MAX_NOTE)
    return { error: `sourceNote is at most ${MAX_NOTE} characters.` };
  return {
    row: {
      artist,
      title,
      album,
      language,
      text,
      source,
      source_note: sourceNote,
      artist_key: lyricKey(artist),
      title_key: lyricKey(title),
      artist_slug: lyricSlug(artist),
      title_slug: lyricSlug(title),
    },
  };
}

/** The public shape of one stored row; `withText: false` for listings. */
export function lyricOut(row, { withText = true } = {}) {
  const out = {
    artist: row.artist,
    title: row.title,
    album: row.album ?? null,
    language: row.language ?? null,
  };
  if (withText) out.text = row.text;
  out.source = row.source;
  out.sourceNote = row.source_note ?? null;
  out.updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  return out;
}
