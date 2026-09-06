import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { createLeaderboard, projectionStore } from '@profullstack/leaderboard';

/**
 * The public board, over rows we already keep.
 *
 * Nothing here is written by the leaderboard. Crawl passes land in
 * `crawl_sales` because an agent paid the gateway, and referral commissions
 * land in `referral_usages` because someone's code was spent. Both are
 * ledgers. A board that copied them would be a second ledger that disagrees
 * with the first one the day a write fails, so we project instead.
 *
 * Badges are the exception. They are awarded at a moment rather than derived
 * from a sum, so they get a table (`leaderboard_badges`, migration 0005).
 */

const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/**
 * Two methods, written against the tagged-template client we already use, so
 * the board needs no second database handle and no string-built SQL.
 */
const badges = {
  async awardBadge(player, badge) {
    const rows = await sql`
      insert into leaderboard_badges (player, badge) values (${player}, ${badge})
      on conflict (player, badge) do nothing
      returning player`;
    return rows.length > 0;
  },
  async badges() {
    const rows = await sql`select player, badge, awarded_at from leaderboard_badges`;
    const out = {};
    for (const r of rows) (out[r.player] ??= {})[r.badge] = ms(r.awarded_at);
    return out;
  },
};

/**
 * A buyer's identity is the wallet that paid; its display name is the agent,
 * because "meta-externalagent" tells a reader something and `0x46E9…6C79`
 * does not. A sale with neither is skipped rather than pooled into one
 * "unknown" row, which would outrank every real buyer on the board.
 */
const KNOWN_AGENTS = ['meta-externalagent', 'GPTBot', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Bytespider', 'Applebot', 'FacebookBot', 'Lightpanda', 'PerplexityBot'];
function agentName(userAgent) {
  const ua = String(userAgent ?? '');
  const known = KNOWN_AGENTS.find((k) => ua.toLowerCase().includes(k.toLowerCase()));
  return known ?? (ua.slice(0, 40).trim() || null);
}

/** A wallet address is long and all of it is public; show the ends. */
const shortWallet = (p) => (p.length > 14 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p);

async function events({ since }) {
  const from = new Date(since || 0);
  const [sales, referrals] = await Promise.all([
    sql`select payer, user_agent, total_cents, days, created_at
        from crawl_sales
        where created_at >= ${from}`,
    // display_name or handle only. An email address is not a public name, and
    // this page is public.
    sql`select u.affiliate_id, u.commission_cents, u.applied_at,
               coalesce(a.display_name, a.handle::text) as name
        from referral_usages u
        join users a on a.id = u.affiliate_id
        where u.applied_at >= ${from}`,
  ]);

  const out = [];
  for (const s of sales) {
    const player = s.payer || agentName(s.user_agent);
    if (!player) continue;
    const at = ms(s.created_at);
    const name = agentName(s.user_agent) ?? shortWallet(String(player));
    const each = (metric, delta) => out.push({ player: String(player), name, metric, delta, at });
    each('spent', Number(s.total_cents) || 0);
    each('passes', 1);
    each('days', Number(s.days) || 1);
  }
  for (const r of referrals) {
    const at = ms(r.applied_at);
    // A partner who set no display name is shown by a stable short id, never
    // by the email they signed up with.
    const name = r.name || `Partner ${String(r.affiliate_id).slice(0, 8)}`;
    const each = (metric, delta) => out.push({ player: String(r.affiliate_id), name, metric, delta, at });
    each('earned', Number(r.commission_cents) || 0);
    each('referrals', 1);
  }
  return out;
}

export const leaderboard = createLeaderboard({
  siteName: config.siteName,
  siteUrl: config.siteUrl,
  basePath: '/leaderboard',
  store: projectionStore({ events, badges }),
  // Two sides of one marketplace, never in one list: a partner earning $209
  // and an agent spending $209 are not the same fact about NicheDB.
  sides: { sell: 'Partners earning', buy: 'Agents spending', use: 'Crawl usage' },
  boards: {
    earners: { label: 'Top earners', metric: 'earned', format: 'usd', unit: 'Earned', side: 'sell', actor: 'Partner' },
    referrers: { label: 'Most referrals', metric: 'referrals', format: 'integer', unit: 'Referrals', side: 'sell', actor: 'Partner' },
    spenders: { label: 'Biggest spenders', metric: 'spent', format: 'usd', unit: 'Spent', side: 'buy', actor: 'Agent' },
    passes: { label: 'Most passes bought', metric: 'passes', format: 'integer', unit: 'Passes', side: 'buy', actor: 'Agent' },
    days: { label: 'Most days of access', metric: 'days', format: 'integer', unit: 'Days', side: 'use', actor: 'Agent' },
  },
  ladder: true,
  cacheMs: 60_000,
});
