import { LYRIC_SOURCES } from '@nichedb/core/lyrics';
import { Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Lyrics for our own bands: /lyrics, /lyrics/<artist>, /lyrics/<artist>/<title>.
 * Only words we wrote or hold the rights to, so every page says where its
 * words came from.
 */

/** A `lang` attribute only when the language was given as a code (is, de, en-GB). */
const langCode = (l) => (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l ?? '') ? l : undefined);

const Provenance = () => (
  <p class="muted">
    Only our own bands' words are here: taken from the recording's own tag, written by us, or
    transcribed from our own recording. Nothing is copied from a lyrics site. The same data is{' '}
    <a href="/api/v1/lyrics">/api/v1/lyrics</a> (JSON, open to any origin).
  </p>
);

export function LyricsIndexPage({ user, artists }) {
  const songs = artists.reduce((n, a) => n + a.count, 0);
  return (
    <Layout
      user={user}
      canonical="/lyrics"
      title="Lyrics"
      description="Lyrics for Profullstack's own bands, as the nixamp radio stations play them. Our own words only."
    >
      <section class="hero">
        <h1>Lyrics</h1>
        <p class="lede">
          The words to our own bands' songs, as the nixamp radio stations play them.
        </p>
        <p class="stats">
          <Num n={artists.length} /> artist{artists.length === 1 ? '' : 's'} · <Num n={songs} />{' '}
          song{songs === 1 ? '' : 's'}
        </p>
      </section>
      <section>
        {artists.length === 0 ? (
          <p class="muted">No lyrics yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Artist</th>
                <th class="num">Songs</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {artists.map((a) => (
                <tr>
                  <td>
                    <a href={`/lyrics/${encodeURIComponent(a.artist_slug)}`}>{a.artist}</a>
                  </td>
                  <td class="num">{a.count}</td>
                  <td>
                    <Relative at={a.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <Provenance />
    </Layout>
  );
}

export function LyricsArtistPage({ user, artist, songs }) {
  const slug = songs[0].artist_slug;
  return (
    <Layout
      user={user}
      canonical={`/lyrics/${encodeURIComponent(slug)}`}
      title={`${artist} lyrics`}
      description={`Lyrics to ${songs.length} song${songs.length === 1 ? '' : 's'} by ${artist}.`}
    >
      <p class="muted">
        <a href="/lyrics">Lyrics</a> /
      </p>
      <h1>{artist}</h1>
      <table>
        <thead>
          <tr>
            <th>Song</th>
            <th>Album</th>
            <th>Words</th>
          </tr>
        </thead>
        <tbody>
          {songs.map((s) => (
            <tr>
              <td>
                <a href={`/lyrics/${encodeURIComponent(slug)}/${encodeURIComponent(s.title_slug)}`}>
                  {s.title}
                </a>
              </td>
              <td>{s.album ?? ''}</td>
              <td class="muted">{LYRIC_SOURCES[s.source] ?? s.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Provenance />
    </Layout>
  );
}

export function LyricsSongPage({ user, song }) {
  const artistUrl = `/lyrics/${encodeURIComponent(song.artist_slug)}`;
  const api = `/api/v1/lyrics?artist=${encodeURIComponent(song.artist)}&title=${encodeURIComponent(song.title)}`;
  return (
    <Layout
      user={user}
      canonical={`${artistUrl}/${encodeURIComponent(song.title_slug)}`}
      title={`${song.title} by ${song.artist}: lyrics`}
      description={`The lyrics to ${song.title} by ${song.artist}${song.album ? `, from ${song.album}` : ''}.`}
    >
      <p class="muted">
        <a href="/lyrics">Lyrics</a> / <a href={artistUrl}>{song.artist}</a> /
      </p>
      <h1>{song.title}</h1>
      <p class="muted">
        {song.artist}
        {song.album ? ` · ${song.album}` : ''}
        {song.language ? ` · ${song.language}` : ''}
      </p>
      <pre class="lyrics" lang={langCode(song.language)}>
        {song.text}
      </pre>
      <p class="muted">
        {LYRIC_SOURCES[song.source] ?? song.source}
        {song.source_note ? `: ${song.source_note}` : ''}. Updated <Relative at={song.updated_at} />
        . <a href={api}>JSON</a>
      </p>
    </Layout>
  );
}
