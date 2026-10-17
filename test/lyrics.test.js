/**
 * Lyrics: the pure half (keys, slugs, validation) and the store over PGlite.
 *
 * What would be embarrassing: two spellings of one song stored twice, a
 * decomposed "ø" that misses the row an NFC one wrote, Þrøngva with no URL,
 * a third-party `source` let in, a 20,001-character text accepted.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const core = await import('../packages/core/src/lyrics.js');
const store = await import('../packages/db/src/lyrics.js');

const song = (extra = {}) => ({
  artist: 'Þrøngva',
  title: 'Kaldur Vindur',
  text: '[Verse 1]\nKaldur vindur\n\n[Chorus]\nÞrøngva',
  source: 'author',
  ...extra,
});

describe('keys and slugs', () => {
  test('NFC, trimmed, single-spaced, lower case', () => {
    const decomposed = 'Þröngva'.normalize('NFD');
    expect(core.lyricKey('  Velocity   Vibe ')).toBe('velocity vibe');
    expect(core.lyricKey('ÞRØNGVA')).toBe(core.lyricKey('þrøngva'));
    expect(core.lyricKey(decomposed)).toBe(core.lyricKey('Þröngva'));
  });

  test('slugs transliterate Latin letters and keep other scripts', () => {
    expect(core.lyricSlug('Þrøngva')).toBe('throngva');
    expect(core.lyricSlug('Meine Mutter')).toBe('meine-mutter');
    expect(core.lyricSlug("Don't Stop (Live)")).toBe('dont-stop-live');
    expect(core.lyricSlug('Größe')).toBe('grosse');
    expect(core.lyricSlug('東京')).toBe('東京');
    expect(core.lyricSlug('!!!')).toBe('untitled');
  });
});

describe('validateLyric', () => {
  test('a good lyric becomes a keyed row', () => {
    const { row, error } = core.validateLyric(song({ album: ' Frost ', sourceNote: 'v2' }));
    expect(error).toBeUndefined();
    expect(row).toMatchObject({
      artist: 'Þrøngva',
      album: 'Frost',
      source_note: 'v2',
      artist_key: 'þrøngva',
      title_key: 'kaldur vindur',
      artist_slug: 'throngva',
      title_slug: 'kaldur-vindur',
    });
  });

  test('refuses what is missing, too long, or not ours', () => {
    expect(core.validateLyric(null).error).toBeTruthy();
    expect(core.validateLyric(song({ artist: ' ' })).error).toMatch(/artist/);
    expect(core.validateLyric(song({ title: undefined })).error).toMatch(/title/);
    expect(core.validateLyric(song({ text: '' })).error).toMatch(/text/);
    expect(core.validateLyric(song({ text: 'x'.repeat(20_001) })).error).toMatch(/20000/);
    expect(core.validateLyric(song({ text: 'x'.repeat(20_000) })).row).toBeTruthy();
    expect(core.validateLyric(song({ source: 'genius' })).error).toMatch(/embedded/);
    expect(core.validateLyric(song({ source: undefined })).error).toMatch(/source/);
  });

  test('lyricOut is the contract shape', () => {
    const out = core.lyricOut({
      ...core.validateLyric(song()).row,
      updated_at: new Date('2026-10-17T00:00:00Z'),
    });
    expect(Object.keys(out)).toEqual([
      'artist',
      'title',
      'album',
      'language',
      'text',
      'source',
      'sourceNote',
      'updatedAt',
    ]);
    expect(out.updatedAt).toBe('2026-10-17T00:00:00.000Z');
    expect('text' in core.lyricOut({ artist: 'a' }, { withText: false })).toBe(false);
  });
});

describe('the store', () => {
  let sql;
  beforeEach(async () => {
    sql = pgliteSql(await migratedPglite());
  }, 30_000);

  const put = (extra) => store.upsertLyric(core.validateLyric(song(extra)).row, { db: sql });

  test('a second post of the same song replaces the first', async () => {
    const first = await put();
    expect(first.inserted).toBe(true);
    const second = await put({ artist: 'ÞRØNGVA', title: 'kaldur  vindur', text: 'new words' });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    const got = await store.getLyric('þrøngva', 'kaldur vindur', { db: sql });
    expect(got).toMatchObject({ text: 'new words', artist: 'ÞRØNGVA' });
  });

  test('artists, songs by slug, and delete', async () => {
    await put();
    await put({ title: 'Ís' });
    await put({ artist: 'Velocity Vibe', title: 'Overdrive' });
    const artists = await store.listArtists({ db: sql });
    expect(artists.map((a) => [a.artist, a.count])).toEqual([
      ['Velocity Vibe', 1],
      ['Þrøngva', 2],
    ]);
    expect((await store.listByArtist('þrøngva', { db: sql })).map((r) => r.title)).toEqual([
      'Kaldur Vindur',
      'Ís',
    ]);
    expect((await store.listByArtistSlug('throngva', { db: sql })).length).toBe(2);
    expect((await store.getBySlugs('throngva', 'is', { db: sql }))?.title).toBe('Ís');
    expect(await store.deleteLyric('þrøngva', 'ís', { db: sql })).toBe(true);
    expect(await store.deleteLyric('þrøngva', 'ís', { db: sql })).toBe(false);
    expect(await store.getBySlugs('throngva', 'is', { db: sql })).toBeNull();
  });

  test('the database refuses an unknown source and an oversized text', async () => {
    const row = core.validateLyric(song()).row;
    await expect(store.upsertLyric({ ...row, source: 'scraped' }, { db: sql })).rejects.toThrow();
    await expect(
      store.upsertLyric({ ...row, text: 'x'.repeat(20_001) }, { db: sql }),
    ).rejects.toThrow();
  });
});
