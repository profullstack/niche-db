# Lyrics

Lyrics for Profullstack's own AI bands (Þrøngva, Velocity Vibe, Meine Mutter, and whoever comes next). The nixamp radio servers read them for what is playing and write them back when they add an artist or a station.

**Only our own words.** A lyric is the recording's own tag (`embedded`), something we wrote (`author`), or an AI transcription of our own recording (`transcribed`). Nothing is ever scraped or imported from a lyrics site; the API refuses any other `source`.

## Pages

- `/lyrics`: every artist, with how many songs
- `/lyrics/<artist-slug>`: one artist's songs
- `/lyrics/<artist-slug>/<title-slug>`: the words, line breaks kept, Suno section tags (`[Verse 1]`) as written

Slugs drop accents and transliterate the letters ASCII has no form for (`Þrøngva` is `/lyrics/throngva`); letters from other scripts are kept.

## API

Matching is on the artist and title as written, Unicode NFC, trimmed, runs of whitespace as one space, case-insensitive. Nothing else is folded: `Song (Audio)` and `Song` are two songs.

Reading is public, metered like the rest of `/api/v1` (600 an hour per address without a key), and answers `access-control-allow-origin: *`.

| Call | Answer |
| --- | --- |
| `GET /api/v1/lyrics?artist=<a>&title=<t>` | 200 `{"lyrics":{"artist","title","album","language","text","source","sourceNote","updatedAt"}}`, or 404 `{"error":"not found"}` |
| `GET /api/v1/lyrics?artist=<a>` | 200 `{"lyrics":[…the same objects without text…]}` |
| `GET /api/v1/lyrics` | 200 `{"artists":[{"artist","count"}]}` |
| `POST /api/v1/lyrics` | upsert; 201 when new, 200 when it replaced the song, `{"lyrics":{…}}` |
| `DELETE /api/v1/lyrics?artist=<a>&title=<t>` | 200 `{"deleted":true}`, or 404 |

`POST` takes `{artist, title, album?, language?, text, source, sourceNote?}`. `text` is at most 20,000 characters, `artist`, `title` and `album` 300, `sourceNote` 1,000. A second post of the same song (same normalised artist and title) replaces the first, spelling included.

## Writing

`POST` and `DELETE` take `Authorization: Bearer ndb_…` from a key whose permissions carry `lyrics: true`, or an admin's key. An ordinary account's key is 403, no key is 401.

Mint a lyrics key where `DATABASE_URL` reaches the deployment (on dev2, inside the app container):

```sh
bun scripts/lyrics-key.js [email] [name]   # default nixamp@profullstack.com, "lyrics"
```

The key is printed once on stdout; only its hash is stored. The live one is `NICHEDB_LYRICS_KEY` in the vaults `profullstack/nichedb--prod` and `profullstack/nixamp--prod`.

## Storage

Table `lyrics` (migration `0037_lyrics.sql`), unique on `(artist_key, title_key)`. Pure rules in `packages/core/src/lyrics.js`, queries in `packages/db/src/lyrics.js`, routes in `apps/web/src/routes/lyrics.js`.
