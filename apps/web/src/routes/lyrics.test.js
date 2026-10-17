/**
 * /lyrics and /api/v1/lyrics, rendered and routed, over an in-memory store.
 *
 * The API shapes are a contract the nixamp radio servers are built against
 * (docs/lyrics.md), so they are asserted key for key. What would be
 * embarrassing: an anonymous or ordinary key writing, a case or Unicode
 * spelling missing the row, the 404 body not being {"error":"not found"}.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const realStore = await import('@nichedb/db/lyrics');

let rows = [];
let nextId = 1;
const pick = (r) => {
  const { text: _text, ...rest } = r;
  return rest;
};
mock.module('@nichedb/db/lyrics', () => ({
  ...realStore,
  upsertLyric: async (row, { userId }) => {
    const at = new Date('2026-10-17T12:00:00Z');
    const old = rows.find((r) => r.artist_key === row.artist_key && r.title_key === row.title_key);
    if (old) {
      Object.assign(old, row, { updated_at: at, updated_by: userId });
      return { ...old, inserted: false };
    }
    const fresh = { id: nextId++, ...row, created_at: at, updated_at: at, created_by: userId };
    rows.push(fresh);
    return { ...fresh, inserted: true };
  },
  getLyric: async (a, t) => rows.find((r) => r.artist_key === a && r.title_key === t) ?? null,
  listByArtist: async (a) => rows.filter((r) => r.artist_key === a).map(pick),
  listByArtistSlug: async (s) => rows.filter((r) => r.artist_slug === s).map(pick),
  getBySlugs: async (a, t) => rows.find((r) => r.artist_slug === a && r.title_slug === t) ?? null,
  listArtists: async () => {
    const by = new Map();
    for (const r of rows) {
      const e = by.get(r.artist_key) ?? { artist: r.artist, artist_slug: r.artist_slug, count: 0 };
      e.count++;
      e.updated_at = r.updated_at;
      by.set(r.artist_key, e);
    }
    return [...by.values()];
  },
  deleteLyric: async (a, t) => {
    const before = rows.length;
    rows = rows.filter((r) => !(r.artist_key === a && r.title_key === t));
    return rows.length < before;
  },
}));

const { registerLyrics, canWriteLyrics } = await import('./lyrics.js');
const { withModules, decideModules } = await import('../lib/modules.js');

const WRITER = { id: 'u-nixamp', role: 'user', api_key_permissions: { read: true, lyrics: true } };
const READER = { id: 'u-reader', role: 'user', api_key_permissions: { read: true, write: true } };
const ADMIN = { id: 'u-admin', role: 'admin' };

function app(user = null) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('user', user);
    await withModules(decideModules({ plan: 'free', paid: false }), next);
  });
  registerLyrics(a);
  return a;
}

const post = (user, body) =>
  app(user).request('/api/v1/lyrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ndb_test' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const SONG = {
  artist: 'Þrøngva',
  title: 'Kaldur Vindur',
  album: 'Frost',
  language: 'is',
  text: '[Verse 1]\nKaldur vindur <blæs>\n\n[Chorus]\nÞrøngva',
  source: 'author',
  sourceNote: 'written for the album',
};

beforeEach(() => {
  rows = [];
  nextId = 1;
});

describe('who may write', () => {
  test('a lyrics key or an admin; nobody else', () => {
    expect(canWriteLyrics(WRITER)).toBe(true);
    expect(canWriteLyrics(ADMIN)).toBe(true);
    expect(canWriteLyrics(READER)).toBe(false);
    expect(canWriteLyrics(null)).toBe(false);
  });

  test('anonymous is 401, an ordinary key is 403, and nothing is stored', async () => {
    expect((await post(null, SONG)).status).toBe(401);
    expect((await post(READER, SONG)).status).toBe(403);
    const del = await app(READER).request('/api/v1/lyrics?artist=a&title=b', { method: 'DELETE' });
    expect(del.status).toBe(403);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /api/v1/lyrics', () => {
  test('201 on a new song, 200 when the same song comes again in another spelling', async () => {
    const first = await post(WRITER, SONG);
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(Object.keys(body.lyrics)).toEqual([
      'artist',
      'title',
      'album',
      'language',
      'text',
      'source',
      'sourceNote',
      'updatedAt',
    ]);
    expect(body.lyrics).toMatchObject({ artist: 'Þrøngva', source: 'author', album: 'Frost' });

    const again = await post(WRITER, {
      ...SONG,
      artist: '  þrøngva '.normalize('NFD'),
      title: 'KALDUR VINDUR',
      text: 'v2',
      source: 'transcribed',
    });
    expect(again.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'v2', source: 'transcribed' });
  });

  test('400 for a bad body, an unknown source, a text over 20000', async () => {
    expect((await post(WRITER, 'not json')).status).toBe(400);
    const bad = await post(WRITER, { ...SONG, source: 'genius' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/source/);
    expect((await post(WRITER, { ...SONG, text: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await post(ADMIN, { ...SONG, text: 'x'.repeat(20_000) })).status).toBe(201);
  });
});

describe('GET /api/v1/lyrics', () => {
  test('one song, matched case- and Unicode-insensitively, with CORS', async () => {
    await post(WRITER, SONG);
    const r = await app().request(
      `/api/v1/lyrics?artist=${encodeURIComponent('ÞRØNGVA'.normalize('NFD'))}&title=kaldur%20vindur`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const { lyrics } = await r.json();
    expect(lyrics.text).toBe(SONG.text);
    expect(lyrics.updatedAt).toBe('2026-10-17T12:00:00.000Z');
  });

  test('404 is exactly {"error":"not found"}', async () => {
    const r = await app().request('/api/v1/lyrics?artist=nobody&title=nothing');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
  });

  test('an artist lists songs without text; no parameters lists artists with counts', async () => {
    await post(WRITER, SONG);
    await post(WRITER, { ...SONG, title: 'Ís' });
    await post(WRITER, { ...SONG, artist: 'Velocity Vibe', title: 'Overdrive' });
    const list = await (await app().request('/api/v1/lyrics?artist=%C3%BEr%C3%B8ngva')).json();
    expect(list.lyrics.map((l) => l.title)).toEqual(['Kaldur Vindur', 'Ís']);
    expect('text' in list.lyrics[0]).toBe(false);
    const all = await (await app().request('/api/v1/lyrics')).json();
    expect(all).toEqual({
      artists: [
        { artist: 'Þrøngva', count: 2 },
        { artist: 'Velocity Vibe', count: 1 },
      ],
    });
    expect((await app().request('/api/v1/lyrics?title=x')).status).toBe(400);
  });
});

describe('DELETE /api/v1/lyrics', () => {
  test('removes the song, then 404s', async () => {
    await post(WRITER, SONG);
    const url = `/api/v1/lyrics?artist=${encodeURIComponent('þrøngva')}&title=Kaldur%20Vindur`;
    const r = await app(WRITER).request(url, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ deleted: true });
    expect(rows).toHaveLength(0);
    expect((await app(WRITER).request(url, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('pages', () => {
  test('artists, one artist, one song with the words escaped and line breaks kept', async () => {
    await post(WRITER, SONG);
    const index = await (await app().request('/lyrics')).text();
    expect(index).toContain('href="/lyrics/throngva"');
    expect(index).toContain('Þrøngva');

    const artist = await (await app().request('/lyrics/throngva')).text();
    expect(artist).toContain('href="/lyrics/throngva/kaldur-vindur"');
    expect(artist).toContain('Written by us');

    const page = await app().request('/lyrics/throngva/kaldur-vindur');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<pre class="lyrics" lang="is">');
    expect(html).toContain('[Verse 1]\nKaldur vindur &lt;blæs&gt;\n\n[Chorus]');
    expect(html).not.toContain('<blæs>');

    expect((await app().request('/lyrics/nobody')).status).toBe(404);
    expect((await app().request('/lyrics/throngva/nothing')).status).toBe(404);
  });
});
