import { lyricKey, lyricOut, validateLyric } from '@nichedb/core/lyrics';
import * as store from '@nichedb/db/lyrics';
import { render } from '../lib/http.js';
import { isAdmin } from '../lib/service.js';
import { LyricsArtistPage, LyricsIndexPage, LyricsSongPage } from '../views/lyrics.jsx';

/**
 * Lyrics for Profullstack's own bands: /lyrics, /lyrics/<artist>,
 * /lyrics/<artist>/<title>, and /api/v1/lyrics, which the nixamp radio
 * servers read for what is playing and write to when they add an artist or a
 * station. The contract is docs/lyrics.md.
 *
 * Reading is public. Writing takes an API key whose permissions carry
 * `lyrics: true` (scripts/lyrics-key.js mints one), or an admin's own key or
 * session. Registered after the API middleware, so /api/v1/lyrics is metered
 * and answers CORS like the rest of /api/v1.
 */

/** May this caller write lyrics? */
export const canWriteLyrics = (user) =>
  Boolean(user && (isAdmin(user) || user.api_key_permissions?.lyrics === true));

function requireWriter(c) {
  const user = c.get('user');
  if (!user)
    return c.json(
      { error: 'Send an API key that may write lyrics: Authorization: Bearer ndb_…' },
      401,
    );
  if (!canWriteLyrics(user)) return c.json({ error: 'This key may not write lyrics.' }, 403);
  return null;
}

export function registerLyrics(app) {
  /* ----------------------------------------------------------------- API -- */

  app.get('/api/v1/lyrics', async (c) => {
    // Also set by the /api/v1 middleware; said here too because a radio page in
    // any browser reads this, and the contract promises it.
    c.header('access-control-allow-origin', '*');
    const artist = c.req.query('artist');
    const title = c.req.query('title');
    if (artist?.trim() && title?.trim()) {
      const row = await store.getLyric(lyricKey(artist), lyricKey(title));
      if (!row) return c.json({ error: 'not found' }, 404);
      return c.json({ lyrics: lyricOut(row) });
    }
    if (title?.trim()) return c.json({ error: 'title needs an artist' }, 400);
    if (artist?.trim()) {
      const rows = await store.listByArtist(lyricKey(artist));
      return c.json({ lyrics: rows.map((r) => lyricOut(r, { withText: false })) });
    }
    const artists = await store.listArtists();
    return c.json({ artists: artists.map((a) => ({ artist: a.artist, count: a.count })) });
  });

  app.post('/api/v1/lyrics', async (c) => {
    const denied = requireWriter(c);
    if (denied) return denied;
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Send a JSON body.' }, 400);
    }
    const { row, error } = validateLyric(body);
    if (error) return c.json({ error }, 400);
    const saved = await store.upsertLyric(row, { userId: c.get('user').id });
    return c.json({ lyrics: lyricOut(saved) }, saved.inserted ? 201 : 200);
  });

  app.delete('/api/v1/lyrics', async (c) => {
    const denied = requireWriter(c);
    if (denied) return denied;
    const artist = c.req.query('artist');
    const title = c.req.query('title');
    if (!artist?.trim() || !title?.trim())
      return c.json({ error: 'artist and title are required' }, 400);
    const gone = await store.deleteLyric(lyricKey(artist), lyricKey(title));
    if (!gone) return c.json({ error: 'not found' }, 404);
    return c.json({ deleted: true });
  });

  /* --------------------------------------------------------------- pages -- */

  app.get('/lyrics', async (c) => {
    const artists = await store.listArtists();
    return c.html(await render(<LyricsIndexPage user={c.get('user')} artists={artists} />));
  });

  app.get('/lyrics/:artist', async (c) => {
    const songs = await store.listByArtistSlug(c.req.param('artist'));
    if (!songs.length) return c.notFound();
    return c.html(
      await render(
        <LyricsArtistPage user={c.get('user')} artist={songs[0].artist} songs={songs} />,
      ),
    );
  });

  app.get('/lyrics/:artist/:title', async (c) => {
    const song = await store.getBySlugs(c.req.param('artist'), c.req.param('title'));
    if (!song) return c.notFound();
    return c.html(await render(<LyricsSongPage user={c.get('user')} song={song} />));
  });
}
