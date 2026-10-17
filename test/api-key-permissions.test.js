/**
 * API key permissions must read back as an object. They were stored as a
 * jsonb string (of a string), so the lyrics key's `lyrics: true` read as
 * undefined and every lyrics write was refused in production.
 */
import { describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { jsonObject } = await import('../packages/auth/src/api-keys.js');

describe('jsonObject', () => {
  test('unwraps strings of strings, keeps objects, refuses junk', () => {
    const obj = { read: true, lyrics: true };
    expect(jsonObject(obj)).toEqual(obj);
    expect(jsonObject(JSON.stringify(obj))).toEqual(obj);
    expect(jsonObject(JSON.stringify(JSON.stringify(JSON.stringify(obj))))).toEqual(obj);
    expect(jsonObject(null)).toEqual({});
    expect(jsonObject('not json')).toEqual({});
    expect(jsonObject('[1]')).toEqual({});
  });
});

describe('migration 0038', () => {
  test('repairs a triple-encoded row and leaves a good one alone', async () => {
    const pg = await migratedPglite();
    const sql = pgliteSql(pg);
    const [{ id: userId }] =
      await sql`insert into users (email) values ('k@nichedb.test') returning id`;
    const perms = { read: true, write: true, lyrics: true };
    const triple = JSON.stringify(JSON.stringify(JSON.stringify(perms)));
    await sql`
      insert into api_keys (id, user_id, prefix, key_hash, permissions, metadata)
      values ('bad', ${userId}::uuid, 'ndb_bad', '\\x01'::bytea, ${triple}::jsonb, ${JSON.stringify('{}')}::jsonb),
             ('good', ${userId}::uuid, 'ndb_good', '\\x02'::bytea, ${JSON.stringify(perms)}::jsonb, '{}'::jsonb)
    `;
    const [before] =
      await sql`select jsonb_typeof(permissions) as t from api_keys where id = 'bad'`;
    expect(before.t).toBe('string');
    const { readFile } = await import('node:fs/promises');
    await pg.exec(
      await readFile(
        new URL('../packages/db/migrations/0038_api_key_permissions_jsonb.sql', import.meta.url),
        'utf8',
      ),
    );
    const rows = await sql`select id, permissions, metadata from api_keys order by id`;
    expect(rows).toEqual([
      { id: 'bad', permissions: perms, metadata: {} },
      { id: 'good', permissions: perms, metadata: {} },
    ]);
  });
});
