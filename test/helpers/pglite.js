import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * A tagged template over PGlite with the shape of Bun's `sql`, so a query in
 * packages/db that takes a `db` runs against an in-memory Postgres in a test.
 * Fragments nest the way Bun's do; a value becomes a positional parameter.
 */
export function pgliteSql(db) {
  class Fragment {
    constructor(strings, values) {
      this.strings = strings;
      this.values = values;
    }
    compile(params) {
      let text = '';
      this.strings.forEach((s, i) => {
        text += s;
        if (i >= this.values.length) return;
        const v = this.values[i];
        if (v instanceof Fragment) text += v.compile(params);
        else {
          params.push(v);
          text += `$${params.length}`;
        }
      });
      return text;
    }
    // biome-ignore lint/suspicious/noThenProperty: a query is awaited, as Bun's is
    then(resolve, reject) {
      const params = [];
      const text = this.compile(params);
      return db
        .query(text, params)
        .then((r) => r.rows)
        .then(resolve, reject);
    }
  }
  return (strings, ...values) => new Fragment(strings, values);
}

/** A fresh in-memory database with every migration applied. */
export async function migratedPglite() {
  const db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../../packages/db/migrations/', import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort())
    await db.exec(await readFile(new URL(f, dir), 'utf8'));
  return db;
}
