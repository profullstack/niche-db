import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
const { dumpItem, dumpRows, writeDumpParts, generateDump, findDump, latestDump, expireDumps } =
  await import('../packages/core/src/data-dumps.js');
const { entitlements, planFor } = await import('../packages/premium/src/index.js');
const { membershipTerm, grantMembership } = await import('../packages/payments/src/membership.js');
let db;
const executor =
  (connection) =>
  async (strings, ...values) => {
    const query = strings.reduce(
      (text, part, index) => text + (index ? `$${index}` : '') + part,
      '',
    );
    // PGlite has no competing connections; test the surrounding transaction and real SQL.
    if (query.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }];
    return (await connection.query(query, values)).rows;
  };
const execute = (strings, ...values) => executor(db)(strings, ...values);
execute.begin = (callback) => db.transaction(async (tx) => callback(executor(tx)));
const storage = () => {
  const objects = new Map();
  return {
    objects,
    put: async (key, bytes) => objects.set(key, bytes),
    remove: async (key) => objects.delete(key),
  };
};
beforeAll(async () => {
  db = new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
  for (const [slug, isPublic, early] of [
    ['export-public', true, false],
    ['export-private', false, false],
    ['export-early', true, true],
  ]) {
    const [collection] =
      await execute`insert into collections (slug, name, public, early_access) values (${slug}, ${slug}, ${isPublic}, ${early}) returning id`;
    const [source] =
      await execute`insert into sources (collection_id, slug, name, adapter, config) values (${collection.id}, ${slug}, ${slug}, 'test', '{"secret":"DO_NOT_EXPORT"}') returning id`;
    for (const n of [1, 2, 3])
      await execute`insert into items (collection_id, source_id, external_id, title, data) values (${collection.id}, ${source.id}, ${String(n)}, ${`${slug}-${n}`}, '{"public_value":42}')`;
  }
}, 60000);
afterAll(async () => db?.close());

describe('Data plan and dump boundaries', () => {
  test('Data includes Pro and only Data grants dump access', () => {
    const data = entitlements('data'),
      pro = entitlements('pro');
    for (const key of [
      'ads',
      'tracking',
      'crawlPass',
      'apiTier',
      'monthlyCredits',
      'lounge',
      'ownSources',
    ])
      expect(data[key]).toBe(pro[key]);
    expect(data.dataDumps).toBe(true);
    for (const plan of ['free', 'premium', 'pro']) expect(entitlements(plan).dataDumps).toBe(false);
    expect(membershipTerm({ plan: 'data', term_days: '30' }, 30)).toEqual({
      plan: 'data',
      days: 30,
    });
    expect(() => membershipTerm({ plan: 'data', term_days: '1' }, 30)).toThrow();
  });
  test('settlement grants a 30-day Data membership; expiry removes its access', async () => {
    const [user] =
      await execute`insert into users (email) values ('dump-buyer@example.test') returning id, role`;
    const term = await grantMembership(execute, {
      userId: user.id,
      priceCents: 199900,
      currency: 'USD',
      termDays: 30,
      plan: 'data',
    });
    expect(new Date(term.expires_at) - new Date(term.started_at)).toBe(30 * 86400000);
    expect(planFor({ user, terms: [term] })).toBe('data');
    expect(planFor({ user, terms: [term], now: new Date(Date.now() + 31 * 86400000) })).toBe(
      'free',
    );
  });
  test('keyset pages contain every public item once and omit private/early collections', async () => {
    const rows = [];
    for await (const row of dumpRows(execute, { batchSize: 2 })) rows.push(row);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows.every((r) => r.collection === 'export-public')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('DO_NOT_EXPORT');
    expect(
      dumpItem({
        id: 4,
        collection: 'unknown',
        password: 'secret',
        email: 'private',
        enrichment: { private: 'hidden' },
      }),
    ).not.toHaveProperty('email');
    expect(
      dumpItem({ id: 4, collection: 'unknown', enrichment: { private: 'hidden' } }).enrichment,
    ).toEqual({});
  });
});

describe('compressed snapshots', () => {
  test('every part decompresses to complete records and has a matching count and checksum', async () => {
    const store = storage();
    const input = Array.from({ length: 12 }, (_, id) => ({ id, title: 'A Unicode record é' }));
    const parts = await writeDumpParts({ rows: input, id: 'test', storage: store, partBytes: 90 });
    expect(parts.length).toBeGreaterThan(1);
    const actual = [];
    for (const part of parts) {
      const bytes = store.objects.get(part.key);
      expect(bytes.length).toBe(part.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(part.sha256);
      const rows = gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);
      expect(rows.length).toBe(part.rows);
      actual.push(...rows);
    }
    expect(actual).toEqual(input);
  });
  test('only a fully uploaded snapshot becomes the latest; duplicate hourly jobs skip', async () => {
    const store = storage();
    const manifest = await generateDump({ db: execute, storage: store, log: () => {} });
    expect(manifest.rows).toBe(3);
    expect((await latestDump(execute)).id).toBe(manifest.id);
    expect((await findDump(manifest.id, execute)).parts).toEqual(manifest.parts);
    const repeated = await generateDump({ db: execute, storage: store, log: () => {} });
    expect(repeated.skipped).toBe('this hour is already published');
    expect(store.objects.size).toBe(manifest.parts.length);
    await execute`delete from data_dumps`;
  });
  test('upload failure rolls back publication and removes staged files', async () => {
    const store = storage();
    const put = store.put;
    store.put = async (key, bytes) => {
      await put(key, bytes);
      throw new Error('upload failed');
    };
    await expect(generateDump({ db: execute, storage: store, log: () => {} })).rejects.toThrow(
      'upload failed',
    );
    expect(await latestDump(execute)).toBeNull();
    expect(store.objects.size).toBe(0);
  });
  test('old snapshots are expired without removing the last completed snapshot', async () => {
    const store = storage();
    for (const [id, hours, key] of [
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 50, 'old'],
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 30, 'last'],
    ]) {
      const manifest = { id, parts: [{ key }] };
      store.objects.set(key, Buffer.from('data'));
      await execute`insert into data_dumps (id,snapshot_at,completed_at,manifest) values (${id}::uuid,now()-make_interval(hours=>${hours}::int),now()-make_interval(hours=>${hours}::int),${JSON.stringify(manifest)}::jsonb)`;
    }
    await expireDumps({ db: execute, storage: store });
    expect(store.objects.has('old')).toBe(false);
    expect(store.objects.has('last')).toBe(true);
    expect(await findDump('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', execute)).toBeNull();
  });
});
