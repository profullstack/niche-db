import { sql } from './index.js';

/**
 * Reads and writes for lyrics (migration 0037). Rows arrive validated and
 * keyed by @nichedb/core/lyrics; every function takes `{ db }` so a test can
 * hand it PGlite.
 */

const columns = (db) => db`
  id, artist, title, album, language, text, source, source_note, artist_key, title_key,
  artist_slug, title_slug, created_at, updated_at
`;

/** Insert or replace by (artist_key, title_key). Answers the row and whether it was new. */
export async function upsertLyric(row, { userId = null, db = sql } = {}) {
  const [saved] = await db`
    insert into lyrics as l
      (artist, title, album, language, text, source, source_note, artist_key, title_key,
       artist_slug, title_slug, created_by, updated_by)
    values (${row.artist}, ${row.title}, ${row.album}, ${row.language}, ${row.text}, ${row.source},
            ${row.source_note}, ${row.artist_key}, ${row.title_key}, ${row.artist_slug},
            ${row.title_slug}, ${userId}::uuid, ${userId}::uuid)
    on conflict (artist_key, title_key) do update set
      artist = excluded.artist, title = excluded.title, album = excluded.album,
      language = excluded.language, text = excluded.text, source = excluded.source,
      source_note = excluded.source_note, artist_slug = excluded.artist_slug,
      title_slug = excluded.title_slug, updated_by = excluded.updated_by, updated_at = now()
    returning ${columns(db)}, (xmax = 0) as inserted
  `;
  return saved;
}

export async function getLyric(artistKey, titleKey, { db = sql } = {}) {
  const [row] = await db`
    select ${columns(db)} from lyrics where artist_key = ${artistKey} and title_key = ${titleKey}
  `;
  return row ?? null;
}

/** Every song by one artist (by key), title order, without the text. */
export async function listByArtist(artistKey, { db = sql } = {}) {
  return db`
    select id, artist, title, album, language, source, source_note, artist_slug, title_slug,
           created_at, updated_at
    from lyrics where artist_key = ${artistKey} order by title_key
  `;
}

/** Every artist with how many songs, the spelling of the newest row naming them. */
export async function listArtists({ db = sql } = {}) {
  return db`
    select distinct on (artist_key) artist, artist_slug, count(*) over (partition by artist_key)::int as count,
           max(updated_at) over (partition by artist_key) as updated_at
    from lyrics order by artist_key, updated_at desc
  `;
}

/** An artist's songs by URL slug; several keys may share a slug. */
export async function listByArtistSlug(slug, { db = sql } = {}) {
  return db`
    select id, artist, title, album, language, source, source_note, artist_slug, title_slug,
           created_at, updated_at
    from lyrics where artist_slug = ${slug} order by title_key, id
  `;
}

/** One song by its URL; the oldest row wins a shared slug. */
export async function getBySlugs(artistSlug, titleSlug, { db = sql } = {}) {
  const [row] = await db`
    select ${columns(db)} from lyrics
    where artist_slug = ${artistSlug} and title_slug = ${titleSlug}
    order by id limit 1
  `;
  return row ?? null;
}

export async function deleteLyric(artistKey, titleKey, { db = sql } = {}) {
  const rows = await db`
    delete from lyrics where artist_key = ${artistKey} and title_key = ${titleKey} returning id
  `;
  return rows.length > 0;
}
