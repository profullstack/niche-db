import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import {
  cleanEmail,
  looksLikeFeed,
  normaliseFeedUrl,
  titleOf,
} from '../apps/web/src/lib/feed-url.js';

/**
 * Feed suggestions: the rules a URL has to pass, and the table that holds the
 * queue -- against a real Postgres in-process, the way schema.test.js does it.
 */

describe('a suggested URL', () => {
  test('is normalised: scheme added, host lower-cased, fragment dropped', () => {
    expect(normaliseFeedUrl('Example.com/feed.xml#top')).toBe('https://example.com/feed.xml');
    expect(normaliseFeedUrl('  http://EXAMPLE.org/rss  ')).toBe('http://example.org/rss');
  });

  test('has to be something a crawler can fetch from a public host', () => {
    expect(normaliseFeedUrl('')).toBeNull();
    expect(normaliseFeedUrl('not a url')).toBeNull();
    expect(normaliseFeedUrl('ftp://example.com/feed')).toBeNull();
    expect(normaliseFeedUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseFeedUrl('http://localhost/feed')).toBeNull();
    expect(normaliseFeedUrl('http://127.0.0.1:3000/feed')).toBeNull();
    expect(normaliseFeedUrl('http://10.0.0.5/feed')).toBeNull();
    expect(normaliseFeedUrl('http://192.168.1.1/feed')).toBeNull();
    expect(normaliseFeedUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(normaliseFeedUrl('http://user:pw@example.com/feed')).toBeNull();
    expect(normaliseFeedUrl('http://intranet/feed')).toBeNull();
  });

  test('is capped in length', () => {
    expect(normaliseFeedUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('the probe', () => {
  test('recognises RSS, RDF and Atom from the first bytes and nothing else', () => {
    expect(looksLikeFeed('<?xml version="1.0"?>\n<rss version="2.0"><channel>')).toBe(true);
    expect(looksLikeFeed('<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(looksLikeFeed('<rdf:RDF xmlns="http://purl.org/rss/1.0/">')).toBe(true);
    expect(looksLikeFeed('<!doctype html><html><head><title>x</title>')).toBe(false);
    expect(looksLikeFeed('')).toBe(false);
  });

  test('pulls a title out, CDATA or entities and all', () => {
    expect(titleOf('<rss><channel><title>Daily &amp; Nightly</title>')).toBe('Daily & Nightly');
    expect(titleOf('<feed><title><![CDATA[The Show]]></title>')).toBe('The Show');
    expect(titleOf('<feed><title type="text">  Spaced  </title>')).toBe('Spaced');
    expect(titleOf('<rss><channel><link>x</link>')).toBeNull();
  });
});

describe('a reply address', () => {
  test('is optional and loose, never a validator of record', () => {
    expect(cleanEmail(' Someone@Example.com ')).toBe('someone@example.com');
    expect(cleanEmail('nope')).toBeNull();
    expect(cleanEmail('')).toBeNull();
    expect(cleanEmail(null)).toBeNull();
  });
});

describe('the queue table', () => {
  let db;
  beforeAll(async () => {
    db = await new PGlite({ extensions: { citext, pg_trgm } });
    const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
    for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(dir + f, 'utf8'));
    }
  }, 60_000);

  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await rows(sql, params))[0];

  test('holds one open suggestion per URL, and a new one once it is decided', async () => {
    const url = 'https://example.com/one.xml';
    const first = await one(
      `insert into source_submissions (feed_url) values ($1)
       on conflict (feed_url) where status = 'pending' do nothing returning id`,
      [url],
    );
    expect(first?.id).toBeGreaterThan(0);

    const dup = await one(
      `insert into source_submissions (feed_url) values ($1)
       on conflict (feed_url) where status = 'pending' do nothing returning id`,
      [url],
    );
    expect(dup).toBeUndefined();

    await db.query(
      `update source_submissions set status = 'rejected', decided_at = now() where id = $1`,
      [first.id],
    );
    const again = await one(
      `insert into source_submissions (feed_url) values ($1)
       on conflict (feed_url) where status = 'pending' do nothing returning id`,
      [url],
    );
    expect(again?.id).toBeGreaterThan(first.id);
  });

  test('refuses a status that is not one of the three', async () => {
    await expect(
      db.query(
        `insert into source_submissions (feed_url, status) values ('https://x.example/f', 'maybe')`,
      ),
    ).rejects.toThrow(/source_submissions_status/);
  });

  test('keeps the row when the source it became is deleted', async () => {
    const c = await one(
      `insert into collections (slug, name) values ('subs-test', 'T') returning id`,
    );
    const s = await one(
      `insert into sources (collection_id, adapter, slug, name) values ($1, 'newsfeed', 'subs-test-src', 'S') returning id`,
      [c.id],
    );
    const sub = await one(
      `insert into source_submissions (feed_url, collection_id, status, source_id)
       values ('https://example.com/two.xml', $1, 'approved', $2) returning id`,
      [c.id, s.id],
    );
    await db.query(`delete from sources where id = $1`, [s.id]);
    const after = await one(`select status, source_id from source_submissions where id = $1`, [
      sub.id,
    ]);
    expect(after.status).toBe('approved');
    expect(after.source_id).toBeNull();
  });
});
