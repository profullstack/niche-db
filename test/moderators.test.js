/**
 * Moderators: the schema that admits the role and refuses others, and the
 * statements decideClaim runs for a moderator claim, against the real SQL
 * in an in-process Postgres. What would be embarrassing: a moderator who
 * earns a share, a moderator claim that makes an operator, a niche marked
 * operated by its moderators, a role the constraint lets through.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

let db;
beforeAll(async () => {
  db = await new PGlite({ extensions: { citext, pg_trgm } });
  const dir = new URL('../packages/db/migrations/', import.meta.url).pathname;
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(await readFile(dir + f, 'utf8'));
  }
}, 60_000);

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

let n = 0;
async function person() {
  n += 1;
  return (await one(`insert into users (email) values ($1) returning id`, [`mod${n}@example.com`]))
    .id;
}
async function niche() {
  n += 1;
  const c = await one(`insert into collections (slug, name) values ($1, 'T') returning id`, [
    `mod-c${n}`,
  ]);
  return one(
    `insert into niches (slug, name, status, collection_id) values ($1, 'Roofing', 'open', $2) returning id`,
    [`mod-n${n}`, c.id],
  );
}

/* The statements decideClaim runs for an approved moderator claim, kept identical to the query. */
const APPROVE = `update niche_claims set status = 'approved', decided_at = now(), decided_by = $2::uuid where id = $1`;
const MAKE_MODERATOR = `
  insert into niche_members (niche_id, user_id, role, status, share_cap_bps)
  values ($1, $2::uuid, 'moderator', 'active', 0)
  on conflict (niche_id, user_id) do update
    set status = 'active', role = 'moderator', share_cap_bps = 0, updated_at = now()`;

describe('the schema', () => {
  test('moderator is a member role and a claim role; anything else is refused', async () => {
    const { id: nicheId } = await niche();
    const uid = await person();
    await rows(MAKE_MODERATOR, [nicheId, uid]);
    const m = await one(
      `select role, share_cap_bps from niche_members where niche_id = $1 and user_id = $2::uuid`,
      [nicheId, uid],
    );
    expect(m).toEqual({ role: 'moderator', share_cap_bps: 0 });
    await expect(
      rows(`insert into niche_members (niche_id, user_id, role) values ($1, $2::uuid, 'janitor')`, [
        nicheId,
        await person(),
      ]),
    ).rejects.toThrow();
    const claim = await one(
      `insert into niche_claims (niche_id, user_id, role) values ($1, $2::uuid, 'moderator') returning role, status`,
      [nicheId, await person()],
    );
    expect(claim).toEqual({ role: 'moderator', status: 'pending' });
    await expect(
      rows(`insert into niche_claims (niche_id, user_id, role) values ($1, $2::uuid, 'janitor')`, [
        nicheId,
        await person(),
      ]),
    ).rejects.toThrow();
    // A claim without a role is an operator's, as every claim was before.
    const plain = await one(
      `insert into niche_claims (niche_id, user_id) values ($1, $2::uuid) returning role`,
      [nicheId, await person()],
    );
    expect(plain.role).toBe('operator');
  });

  test('one open application per person per niche, whatever the role', async () => {
    const { id: nicheId } = await niche();
    const uid = await person();
    await rows(
      `insert into niche_claims (niche_id, user_id, role) values ($1, $2::uuid, 'moderator')`,
      [nicheId, uid],
    );
    await expect(
      rows(`insert into niche_claims (niche_id, user_id, role) values ($1, $2::uuid, 'operator')`, [
        nicheId,
        uid,
      ]),
    ).rejects.toThrow();
  });
});

describe('approving a moderator claim', () => {
  test('makes a moderator with no share, no score row, and leaves the niche open', async () => {
    const { id: nicheId } = await niche();
    const uid = await person();
    const admin = await person();
    const claim = await one(
      `insert into niche_claims (niche_id, user_id, role) values ($1, $2::uuid, 'moderator') returning id`,
      [nicheId, uid],
    );
    await rows(APPROVE, [claim.id, admin]);
    await rows(MAKE_MODERATOR, [nicheId, uid]);
    const m = await one(
      `select role, status, share_cap_bps from niche_members where niche_id = $1 and user_id = $2::uuid`,
      [nicheId, uid],
    );
    expect(m).toEqual({ role: 'moderator', status: 'active', share_cap_bps: 0 });
    const score = await one(
      `select count(*)::int as c from contribution_scores where niche_id = $1 and influencer_id = $2::uuid`,
      [nicheId, uid],
    );
    expect(score.c).toBe(0);
    expect((await one(`select status from niches where id = $1`, [nicheId])).status).toBe('open');
    // The moderated-niches lookup finds it with the collection it feeds.
    const mod = await one(
      `select n.slug, c.slug as collection_slug from niche_members m join niches n on n.id = m.niche_id left join collections c on c.id = n.collection_id where m.user_id = $1::uuid and m.role = 'moderator' and m.status = 'active'`,
      [uid],
    );
    expect(mod.collection_slug).toStartWith('mod-c');
  });
});
