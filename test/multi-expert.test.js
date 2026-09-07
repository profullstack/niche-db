import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { splitShareBps } from '../packages/knowledge/src/index.js';

/**
 * More than one person can be expert on a niche.
 *
 * A niche is a subject, the way a Quora topic is: whoever actually knows the
 * trade can put their hand up, and the first arrival does not take the plot.
 * Nothing in the schema or the split may assume a single operator.
 */
let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

const niche = async () =>
  one(`insert into niches (slug, name) values ($1,'N') returning id`, [
    `m${Math.random()}`.replace('.', ''),
  ]);
const person = async () =>
  one(`insert into users (email) values ($1) returning id`, [`m${Math.random()}@e.com`]);
const apply = (nicheId, userId) =>
  rows(
    `insert into niche_claims (niche_id, user_id) values ($1, $2)
     on conflict (niche_id, user_id) where status = 'pending' do nothing returning id`,
    [nicheId, userId],
  );

describe('claiming', () => {
  test('two people can hold pending claims on the same niche at once', async () => {
    const n = await niche();
    const a = await person();
    const b = await person();
    expect((await apply(n.id, a.id)).length).toBe(1);
    expect((await apply(n.id, b.id)).length).toBe(1);
    // The one-open-claim rule is per person, not per niche.
    expect((await apply(n.id, a.id)).length).toBe(0);
  });

  test('both can be approved and both hold an active membership', async () => {
    const n = await niche();
    const a = await person();
    const b = await person();
    for (const u of [a, b]) {
      await db.query(
        `insert into niche_members (niche_id, user_id, role, status)
         values ($1, $2, 'operator', 'active')`,
        [n.id, u.id],
      );
    }
    const members = await rows(
      `select user_id from niche_members where niche_id = $1 and status = 'active'`,
      [n.id],
    );
    expect(members.length).toBe(2);
  });

  test('the same person still cannot join the same niche twice', async () => {
    const n = await niche();
    const u = await person();
    await db.query(`insert into niche_members (niche_id, user_id) values ($1, $2)`, [n.id, u.id]);
    let threw = null;
    try {
      await db.query(`insert into niche_members (niche_id, user_id) values ($1, $2)`, [n.id, u.id]);
    } catch (e) {
      threw = e.message;
    }
    expect(threw).toMatch(/duplicate key/i);
  });

  test('an approved claim leaves the opportunity open for the next expert', async () => {
    const n = await niche();
    await db.query(`insert into opportunities (niche_id) values ($1)`, [n.id]);
    // What approval does: the niche becomes operated, and the opportunity is
    // deliberately left alone so somebody else can still put their hand up.
    await db.query(`update niches set status = 'operated' where id = $1`, [n.id]);
    const o = await one(`select status from opportunities where niche_id = $1`, [n.id]);
    expect(o.status).toBe('open');
  });
});

describe('what the newcomer costs the incumbent', () => {
  test('a second expert who has contributed nothing takes nothing off the first', () => {
    const alone = splitShareBps([{ influencerId: 'a', score: 300 }]);
    const joined = splitShareBps([
      { influencerId: 'a', score: 300 },
      { influencerId: 'b', score: 0 },
    ]);
    // 4000 + 2000 is under the 8000 ceiling, so the first keeps their 40%.
    expect(alone[0].shareBps).toBe(4000);
    expect(joined[0].shareBps).toBe(4000);
    expect(joined[1].shareBps).toBe(2000);
  });

  test('only once the room is full does anyone give ground, and then in proportion', () => {
    const split = splitShareBps([
      { influencerId: 'a', score: 2500 },
      { influencerId: 'b', score: 2500 },
      { influencerId: 'c', score: 900 },
    ]);
    // Over the 80% ceiling everyone scales by the same factor, so relative
    // standing survives and the parts still sum to exactly 8000.
    expect(split.reduce((n, m) => n + m.shareBps, 0)).toBe(8000);
    expect(split[0].shareBps).toBe(split[1].shareBps);
    expect(split[0].shareBps).toBeGreaterThan(split[2].shareBps);
  });

  test('many experts still never hand out more than the programme maximum', () => {
    const crowd = Array.from({ length: 20 }, (_, i) => ({ influencerId: `u${i}`, score: 2500 }));
    const split = splitShareBps(crowd);
    expect(split.reduce((n, m) => n + m.shareBps, 0)).toBe(8000);
    for (const m of split) expect(m.shareBps).toBeGreaterThanOrEqual(0);
  });
});
