-- Lyrics for our own bands: Þrøngva, Velocity Vibe, Meine Mutter and whoever
-- comes next. The nixamp radio servers read them for what is playing and
-- write them back when they add an artist or a station.
--
-- Only words we wrote or hold the rights to: the recording's own tag
-- (`embedded`), what we wrote (`author`), or an AI transcription of our own
-- recording (`transcribed`). Nothing is ever imported from a lyrics site.
--
-- One row per song, keyed by the artist and title as written, NFC-normalised,
-- trimmed, single-spaced and lower-cased (packages/core/src/lyrics.js), so a
-- second post of the same song replaces the first. The slugs are what the
-- pages are addressed by; two names that slug alike share a URL and the older
-- row answers it.

create table if not exists lyrics (
  id           bigserial primary key,
  artist       text not null check (length(artist) between 1 and 300),
  title        text not null check (length(title) between 1 and 300),
  album        text check (album is null or length(album) <= 300),
  language     text check (language is null or length(language) <= 35),
  text         text not null check (length(text) between 1 and 20000),
  source       text not null check (source in ('embedded', 'author', 'transcribed')),
  source_note  text check (source_note is null or length(source_note) <= 1000),
  artist_key   text not null,
  title_key    text not null,
  artist_slug  text not null,
  title_slug   text not null,
  created_by   uuid references users(id) on delete set null,
  updated_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (artist_key, title_key)
);
create index if not exists lyrics_slugs on lyrics (artist_slug, title_slug);
