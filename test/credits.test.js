/**
 * Credit codes and invites end to end on a migrated Postgres (PGlite): the
 * stores over migration 0040's tables, and every grant landing as a Premium
 * term in `memberships`, the row a paid term writes.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { config } = await import('../packages/config/src/index.js');
const lib = await import('../apps/web/src/lib/credits.js');
const { creditsStore, affiliatesStore } = lib;

const DAY = 86_400_000;
let pg;
let sql;
let svc;
let alice;
let bob;
let carol;

async function user(email) {
  const [{ id }] = await sql`insert into users (email) values (${email}) returning id`;
  return id;
}
const terms = (userId) =>
  sql`select plan, price_cents, grant_ref, payment_id, started_at, expires_at
      from memberships where user_id = ${userId}::uuid order by started_at`;

beforeEach(async () => {
  pg = await migratedPglite();
  sql = pgliteSql(pg);
  const pool = { query: (text, params) => pg.query(text, params) };
  svc = lib.makeCredits({
    creditStore: creditsStore(pool),
    affiliateStore: affiliatesStore(pool),
    grant: ({ userId, days, ref }) => lib.grantPremiumDays({ userId, days, ref, db: sql }),
    externalCodes: async (code) =>
      (await sql`select 1 from referral_codes where code = ${String(code).toUpperCase()}`).length >
      0,
    quota: 3,
    bonusDays: 7,
    ttlDays: 30,
  });
  alice = await user('alice@nichedb.test');
  bob = await user('bob@nichedb.test');
  carol = await user('carol@nichedb.test');
});

describe('credit codes', () => {
  test('a code becomes a free Premium term through memberships, once', async () => {
    const made = await lib.mintPremiumCode({ days: 30, label: 'for alice' }, svc);
    expect(made.code).toMatch(/^CR-/);
    expect(made.days).toBe(30);

    const r = await lib.redeemCode(alice, made.code.toLowerCase().replaceAll('-', ' '), svc);
    expect(r).toMatchObject({ ok: true, days: 30 });
    const [term] = await terms(alice);
    expect(term).toMatchObject({ plan: 'premium', price_cents: 0, payment_id: null });
    expect(term.grant_ref).toBe(`code:${made.id}`);
    const length = new Date(term.expires_at) - new Date(term.started_at);
    expect(Math.round(length / DAY)).toBe(30);

    expect(await lib.redeemCode(alice, made.code, svc)).toMatchObject({
      ok: false,
      reason: 'already_redeemed',
    });
    expect(await lib.redeemCode(bob, made.code, svc)).toMatchObject({
      ok: false,
      reason: 'used_up',
    });
    expect(await terms(alice)).toHaveLength(1);
    expect(await terms(bob)).toHaveLength(0);
  });

  test('a second code stacks after the term already held', async () => {
    const a = await lib.mintPremiumCode({ days: 10 }, svc);
    const b = await lib.mintPremiumCode({ days: 5 }, svc);
    await lib.redeemCode(alice, a.code, svc);
    await lib.redeemCode(alice, b.code, svc);
    const [first, second] = await terms(alice);
    expect(new Date(second.started_at).getTime()).toBe(new Date(first.expires_at).getTime());
  });

  test('refusals carry words a person can act on', async () => {
    expect((await lib.redeemCode(alice, 'CR-AAAA-BBBB-CCCC-DDDD', svc)).error).toMatch(
      /not one we issued/,
    );
    expect((await lib.redeemCode(alice, '', svc)).ok).toBe(false);
    const gone = await lib.mintPremiumCode({ days: 3 }, svc);
    await svc.credits.revoke(gone.id);
    expect(await lib.redeemCode(alice, gone.code, svc)).toMatchObject({ reason: 'revoked' });
  });

  test('mint refuses nonsense', async () => {
    await expect(lib.mintPremiumCode({ days: 0 }, svc)).rejects.toThrow(/days/);
    await expect(lib.mintPremiumCode({ days: 2.5 }, svc)).rejects.toThrow(/days/);
    await expect(lib.mintPremiumCode({ days: 3, maxRedemptions: 0 }, svc)).rejects.toThrow(/max/);
  });

  test('the same grant ref never adds a second term', async () => {
    await lib.grantPremiumDays({ userId: alice, days: 3, ref: 'code:x', db: sql });
    await lib.grantPremiumDays({ userId: alice, days: 3, ref: 'code:x', db: sql });
    expect(await terms(alice)).toHaveLength(1);
  });
});

describe('invites', () => {
  test('accepting gives both people the bonus days, once', async () => {
    const { invite } = await lib.createInvite(alice, 'for bob', svc);
    expect(invite.url).toBe(`${config.siteUrl}/i/${invite.code}`);
    expect(await lib.inviteStatus(invite.code, svc)).toBe('ok');

    const r = await lib.acceptInvite({ userId: bob, code: invite.code }, svc);
    expect(r).toMatchObject({ ok: true, inviterId: alice, days: 7 });
    for (const who of [alice, bob]) {
      const [term] = await terms(who);
      expect(term.plan).toBe('premium');
      expect(Math.round((new Date(term.expires_at) - new Date(term.started_at)) / DAY)).toBe(7);
    }
    expect((await terms(alice))[0].grant_ref).toBe(`invite:${r.inviteId}:inviter`);
    expect((await terms(bob))[0].grant_ref).toBe(`invite:${r.inviteId}:invitee`);

    expect(await lib.inviteStatus(invite.code, svc)).toBe('used');
    expect(await lib.acceptInvite({ userId: carol, code: invite.code }, svc)).toMatchObject({
      ok: false,
      reason: 'used',
    });
    expect(await terms(carol)).toHaveLength(0);
  });

  test('scarce: three per account, a withdrawn unused one comes back', async () => {
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await lib.createInvite(alice, `${i}`, svc)).invite);
    expect((await lib.createInvite(alice, 'four', svc)).ok).toBe(false);
    expect((await lib.myInvites(alice, svc)).quota).toEqual({ total: 3, used: 3, left: 0 });

    expect((await lib.revokeInvite(bob, made[0].id, svc)).ok).toBe(false); // not bob's
    expect((await lib.revokeInvite(alice, made[0].id, svc)).ok).toBe(true);
    expect((await lib.myInvites(alice, svc)).quota.left).toBe(1);
    expect(await lib.inviteStatus(made[0].code, svc)).toBe('revoked');
  });

  test('your own invite does nothing for you', async () => {
    const { invite } = await lib.createInvite(alice, '', svc);
    expect(await lib.acceptInvite({ userId: alice, code: invite.code }, svc)).toMatchObject({
      ok: false,
      reason: 'self',
    });
    expect(await terms(alice)).toHaveLength(0);
  });

  test('junk is invalid without touching anything', async () => {
    expect(await lib.inviteStatus('INV-0000-0000-0000', svc)).toBe('invalid');
    expect(await lib.inviteStatus('<script>', svc)).toBe('invalid');
    expect((await lib.acceptInvite({ userId: bob, code: 'nope' }, svc)).ok).toBe(false);
  });
});

describe('referral attribution', () => {
  test('a referrals code goes to the existing programme, not to affiliates', async () => {
    await sql`insert into referral_codes (code, owner_id) values ('ABCD2345', ${alice}::uuid)`;
    const seen = [];
    const r = await lib.attributeReferral(
      { userId: bob, code: 'abcd2345', onExternal: (x) => seen.push(x) },
      svc,
    );
    expect(r).toMatchObject({ ok: false, external: true });
    expect(seen).toEqual([{ userId: bob, code: 'abcd2345' }]);
    expect((await pg.query('select count(*)::int as n from aff_attributions')).rows[0].n).toBe(0);
  });

  test('an unknown code is nobody', async () => {
    const seen = [];
    const r = await lib.attributeReferral(
      { userId: bob, code: 'ZZZZ9999', onExternal: (x) => seen.push(x) },
      svc,
    );
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe('an invited sign-up', () => {
  test('the signup form carries the invite and says what it is worth', async () => {
    const { SignIn } = await import('../apps/web/src/views/pages.jsx');
    const html = String(await SignIn({ mode: 'signup', invite: 'INV-AAAA-BBBB-CCCC' }).toString());
    expect(html).toContain('name="invite" value="INV-AAAA-BBBB-CCCC"');
    expect(html).toContain(`${config.invites.bonusDays} days of Premium`);
    const plain = String(await SignIn({ mode: 'signup' }).toString());
    expect(plain).not.toContain('name="invite"');
  });

  test('the invite rides on the emailed link (login_tokens.invite_code)', async () => {
    await sql`
      insert into login_tokens (token_hash, email, expires_at, invite_code, consumed_at)
      values ('h1', 'new@nichedb.test', now() + interval '20 minutes', 'INV-AAAA-BBBB-CCCC', now())
    `;
    const [row] = await sql`select invite_code from login_tokens where token_hash = 'h1'`;
    expect(row.invite_code).toBe('INV-AAAA-BBBB-CCCC');
  });
});
