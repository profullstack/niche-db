import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './index.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Forward-only migrations, keyed by filename, one transaction each. No `down`:
 * the recovery path for a bad migration is a new forward one.
 *
 * Called on boot by every process; the advisory lock makes that safe when web
 * and worker boot at the same instant.
 */
export async function migrate({ log = console.log, directory = MIGRATIONS_DIR, url } = {}) {
  // A session advisory lock must stay on the connection doing the migration.
  // Bun also applies idleTimeout while a long statement produces no messages:
  // building an index over existing data can easily exceed the app pool's 30s.
  const sql = connect({ url, max: 1, idleTimeout: 0 });
  try {
    return await migrateOnConnection(sql, { log, directory });
  } finally {
    await sql.end();
  }
}

async function migrateOnConnection(sql, { log, directory }) {
  await sql`select pg_advisory_lock(8675310)`;
  try {
    await sql`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    const files = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set(
      (await sql`select filename from schema_migrations`).map((r) => r.filename),
    );
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(directory, file), 'utf8');
      log(`[migrate] applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations ${tx({ filename: file })}`;
      });
      ran++;
    }
    log(ran === 0 ? '[migrate] up to date' : `[migrate] applied ${ran} migration(s)`);
    return ran;
  } finally {
    await sql`select pg_advisory_unlock(8675310)`;
  }
}
