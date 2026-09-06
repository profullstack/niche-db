import * as auth from '@nichedb/auth';
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { createPartners, sqlStore } from '@profullstack/partners';

/**
 * The seller side of NicheDB.
 *
 * Everything in this index is somebody's writing, and training crawlers are
 * most of what reads it. This is how the people whose work is here get paid
 * for that: prove you own a site, say what you publish about, and take a share
 * of what a crawler pays for access.
 *
 * The module owns none of the authentication. It asks who is here and we
 * answer from the same session cookie the rest of the site uses, so a partner
 * signs in once, the ordinary way.
 */

const execute = async ({ sql: text, args = [] }) => ({ rows: await sql.unsafe(text, args) });
const store = sqlStore({ execute, dialect: 'postgres' });

// The three tables arrive through migration 0006, the same way as every other
// schema change on this database, rather than through the package's own
// migrate() at boot. The tables therefore exist whether or not the program is
// switched on, so enabling it later needs no migration.

/** The session cookie, read off a bare Request rather than a Hono context. */
function sessionCookie(request) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === config.session.cookie) return part.slice(eq + 1).trim();
  }
  return null;
}

async function currentUser(request) {
  const sid = sessionCookie(request);
  if (!sid) return null;
  const user = await auth.userFromRequest(sid);
  if (!user) return null;
  return { id: user.id, name: user.display_name ?? user.handle ?? null, email: user.email ?? null };
}

/**
 * The niches a partner may claim: this site's own public collections, which is
 * the vocabulary the directory is already organised by. A free-text field
 * would collect forty spellings of "machine learning" and nothing to group on.
 * Resolved per request, so a collection added today is claimable today.
 */
async function niches() {
  const rows = await sql`select slug from collections where public = true order by slug limit 60`;
  return rows.map((r) => String(r.slug));
}

/**
 * The program, or null when PARTNER_VERIFY_SECRET is unset.
 *
 * The module refuses to start without a secret, and it is right to: a
 * guessable verification token pays the wrong person for someone else's work.
 * But that refusal must not take the whole site down on a deploy where the
 * variable was forgotten, so it is caught here and /sell simply does not
 * exist until the secret does.
 */
export const partners = (() => {
  if (!config.partnerSecret) {
    console.warn('[partners] PARTNER_VERIFY_SECRET is unset, so /sell is off');
    return null;
  }
  return createPartners({
    siteName: config.siteName,
    siteUrl: config.siteUrl,
    basePath: '/sell',
    store,
    secret: config.partnerSecret,
    loginUrl: '/login?next=/sell',
    currentUser,
    niches,
  });
})();

/**
 * Split one crawl sale across the partners whose properties are in the index.
 *
 * Attribution is ours to decide, because only this side knows whose rows were
 * in the crawl that got paid for. The rule: every partner with a verified
 * property that has a source in the index shares the sale, each at their own
 * rate, pro-rata by how many items they contributed. A sale nobody contributed
 * to is simply not split.
 *
 * `ref` makes it idempotent, so a settlement delivered twice pays once.
 */
export async function splitSale(sale) {
  if (!partners || !sale?.ref || !Number(sale.totalCents)) return 0;

  const rows = await sql`
    select p.id as partner_id, count(i.id)::int as items
    from partner_properties pp
    join partner_accounts p on p.id::text = pp.partner_id
    join sources s on s.owner_id::text = p.user_id
    join items i on i.source_id = s.id
    where pp.verified_at is not null
    group by p.id
    having count(i.id) > 0`;
  if (!rows.length) return 0;

  const total = rows.reduce((n, r) => n + Number(r.items), 0);
  let paid = 0;
  for (const row of rows) {
    const partner = await store.getPartnerById(String(row.partner_id));
    if (!partner) continue;
    const properties = await store.listProperties(partner.id);
    const rate = partners.rateFor(partner, properties);
    const share = Math.floor((Number(sale.totalCents) * (Number(row.items) / total) * rate) / 100);
    if (share <= 0) continue;
    if (
      await partners.credit({
        partnerId: partner.id,
        cents: share,
        ref: `${sale.ref}:${partner.id}`,
      })
    )
      paid += share;
  }
  return paid;
}
