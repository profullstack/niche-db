import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as q from '../packages/db/src/queries.js';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

const MIGRATION = new URL('../packages/db/migrations/0047_item_suppressions.sql', import.meta.url);
const heldUrl = 'https://courtlistener.example/opinion/held/';

test('removed URLs stay suppressed while unrelated items still ingest', async () => {
  const db = await migratedPglite();
  const sql = pgliteSql(db);
  try {
    const collections = await db.query("select id from collections where slug = 'law'");
    let collectionId;
    if (collections.rows.length) collectionId = collections.rows[0].id;
    else {
      const {
        rows: [{ id }],
      } = await db.query("insert into collections (slug, name) values ('law', 'Law') returning id");
      collectionId = id;
    }
    const sources = await db.query("select id from sources where slug = 'courtlistener-opinions'");
    let sourceId;
    if (sources.rows.length) sourceId = sources.rows[0].id;
    else {
      const {
        rows: [{ id }],
      } = await db.query(
        "insert into sources (collection_id, adapter, slug, name) values ($1, 'courtlistener', 'courtlistener-opinions', 'Court opinions') returning id",
        [collectionId],
      );
      sourceId = id;
    }

    await db.query(
      `insert into items (collection_id, source_id, external_id, title, url)
       values ($1, $2, '11061729', 'Sensitive item', $3)`,
      [collectionId, sourceId, heldUrl],
    );
    await db.query(
      `insert into items (collection_id, source_id, external_id, title, url)
       values ($1, $2, 'other', 'Unrelated item', 'https://courtlistener.example/opinion/other/')`,
      [collectionId, sourceId],
    );
    await db.exec(await readFile(MIGRATION, 'utf8'));

    const afterMigration = await db.query('select external_id from items order by external_id');
    expect(afterMigration.rows.map((row) => row.external_id)).toEqual(['other']);

    const urlSha256 = createHash('sha256').update(heldUrl).digest('hex');
    await db.query('insert into item_suppressions (url_sha256) values ($1)', [urlSha256]);
    const first = await q.upsertItems({
      collectionId,
      sourceId,
      items: [{ externalId: 'held-1', title: 'Held', url: heldUrl }],
      db: sql,
    });
    expect(first).toEqual({ added: 0, updated: 0 });

    const {
      rows: [{ id: secondSourceId }],
    } = await db.query(
      "insert into sources (collection_id, adapter, slug, name) values ($1, 'other', 'other-opinions', 'Other opinions') returning id",
      [collectionId],
    );
    const second = await q.upsertItems({
      collectionId,
      sourceId: secondSourceId,
      items: [{ externalId: 'held-2', title: 'Held again', url: heldUrl }],
      db: sql,
    });
    expect(second).toEqual({ added: 0, updated: 0 });

    const unrelated = await q.upsertItems({
      collectionId,
      sourceId,
      items: [
        {
          externalId: 'unrelated',
          title: 'Unrelated',
          url: 'https://courtlistener.example/opinion/unrelated/',
        },
      ],
      db: sql,
    });
    expect(unrelated).toEqual({ added: 1, updated: 0 });
    const count = await db.query('select count(*)::int as count from items');
    expect(count.rows[0].count).toBe(2);
  } finally {
    await db.close();
  }
});
