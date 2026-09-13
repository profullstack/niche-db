import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../packages/db/src/index.js';
import { migrate } from '../packages/db/src/migrate.js';

const postgresTest = process.env.MIGRATION_TEST_DATABASE_URL ? test : test.skip;

postgresTest(
  'long migrations and concurrent boots retain one locked session',
  async () => {
    const url = new URL(process.env.MIGRATION_TEST_DATABASE_URL);
    const admin = connect({ url: url.href, max: 1, idleTimeout: 0 });
    const name = `ndb_migrate_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'ndb-migrate-'));
    let check;
    try {
      await admin.unsafe(`create database ${name}`);
      url.pathname = `/${name}`;
      await writeFile(
        join(directory, '0001_slow.sql'),
        `
      create table migration_probe (id integer primary key, backend integer);
      insert into migration_probe values (1, pg_backend_pid());
      -- Production failed at 30s. A query without messages must survive longer.
      select pg_sleep(35);
      do $$ begin
        if not exists (
          select 1 from pg_locks where pid=pg_backend_pid()
            and locktype='advisory' and objid=8675310 and granted
        ) then raise exception 'migration lost its session lock'; end if;
      end $$;
      insert into migration_probe values (2, pg_backend_pid());
    `,
      );
      const options = { url: url.href, directory, log: () => {} };
      const results = await Promise.all([migrate(options), migrate(options)]);
      expect(results.sort()).toEqual([0, 1]);
      check = connect({ url: url.href, max: 1, idleTimeout: 0 });
      const rows = await check`select * from migration_probe order by id`;
      expect(rows.map((row) => row.id)).toEqual([1, 2]);
      expect(rows[0].backend).toBe(rows[1].backend);
      expect(await check`select filename from schema_migrations`).toHaveLength(1);
      expect(await migrate(options)).toBe(0);
    } finally {
      await check?.end();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
