/**
 * The ladder: verified contribution in, revenue share out.
 *
 * Everyone starts at 20% and nobody passes 80%. What moves someone up is
 * score, and score comes only from contributions somebody verified — which is
 * the whole reason this is a table of thresholds rather than a formula over
 * activity. Activity is cheap to manufacture.
 *
 * Shares are basis points throughout: 2000 is 20%. Percent as a float turns
 * a share of a settlement into a rounding argument, and this program pays
 * real money on the answer.
 */

export const MAX_SHARE_BPS = 8000;
export const BASE_SHARE_BPS = 2000;

/**
 * Seeded into `contribution_tiers` by migration 0007 and read back from there
 * at runtime, so a deployment may tune its own thresholds. This array is the
 * shipped default and the fallback when the table has not been read yet.
 */
export const CONTRIBUTION_TIERS = [
  { slug: 'contributor', name: 'Contributor', minScore: 0, shareBps: 2000 },
  { slug: 'specialist', name: 'Specialist', minScore: 100, shareBps: 3000 },
  { slug: 'expert', name: 'Expert', minScore: 250, shareBps: 4000 },
  { slug: 'lead-expert', name: 'Lead Expert', minScore: 500, shareBps: 5000 },
  { slug: 'niche-operator', name: 'Niche Operator', minScore: 900, shareBps: 6000 },
  { slug: 'senior-operator', name: 'Senior Operator', minScore: 1500, shareBps: 7000 },
  {
    slug: 'top-knowledge-influencer',
    name: 'Top Knowledge Influencer',
    minScore: 2500,
    shareBps: 8000,
  },
];

/** Ascending by threshold, whatever order the caller's rows arrived in. */
const ordered = (tiers) => [...tiers].sort((a, b) => a.minScore - b.minScore);

/** The tier a score has reached. Never null: below the first threshold is the first tier. */
export function tierFor(score, tiers = CONTRIBUTION_TIERS) {
  const list = ordered(tiers);
  const n = Number.isFinite(Number(score)) ? Math.floor(Number(score)) : 0;
  let held = list[0];
  for (const tier of list) if (n >= tier.minScore) held = tier;
  return held;
}

/** The next tier up, and how much score is left to reach it. Null at the top. */
export function nextTierFor(score, tiers = CONTRIBUTION_TIERS) {
  const list = ordered(tiers);
  const n = Number.isFinite(Number(score)) ? Math.floor(Number(score)) : 0;
  const next = list.find((tier) => n < tier.minScore);
  if (!next) return null;
  return { ...next, remaining: next.minScore - n };
}

/**
 * What one member actually earns: their tier's share, held down by their own
 * cap. The cap is per member so a niche with several people in it can be
 * arranged without editing a global table, and the program maximum is the
 * ceiling over both.
 */
export function shareBpsFor(score, { capBps = MAX_SHARE_BPS, tiers = CONTRIBUTION_TIERS } = {}) {
  const tier = tierFor(score, tiers);
  return Math.max(0, Math.min(tier.shareBps, Number(capBps) || 0, MAX_SHARE_BPS));
}

/**
 * Divide one niche's influencer allocation between its members.
 *
 * Two rules make this safe to pay out. The total never exceeds 80%, because a
 * niche that hands out more than it holds is a loss booked as a payout. And
 * every share is a whole basis point, assigned by largest-remainder, so the
 * parts sum to the whole exactly rather than to 7999 through rounding.
 */
export function splitShareBps(members, { maxBps = MAX_SHARE_BPS } = {}) {
  const rows = (members ?? []).map((m) => ({
    ...m,
    wanted: shareBpsFor(m.score ?? 0, { capBps: m.capBps ?? MAX_SHARE_BPS }),
  }));
  const wanted = rows.reduce((n, r) => n + r.wanted, 0);
  if (wanted === 0) return rows.map((r) => ({ ...r, shareBps: 0 }));
  // Under the ceiling everyone gets what their tier says. Over it, each is
  // scaled by the same factor, so relative standing survives the squeeze.
  if (wanted <= maxBps) return rows.map((r) => ({ ...r, shareBps: r.wanted }));

  const exact = rows.map((r) => (r.wanted * maxBps) / wanted);
  const floors = exact.map((n) => Math.floor(n));
  let left = maxBps - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return rows.map((r, i) => ({ ...r, shareBps: out[i] }));
}

/** "40%" from 4000, for a page. One decimal only when the number needs it. */
export function formatBps(bps) {
  const pct = (Number(bps) || 0) / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/**
 * "$12.34" from 1234. For display only.
 *
 * The division happens here and nowhere else. Money is integer minor units
 * everywhere it is stored, compared or divided; the one place it becomes a
 * fraction is the moment it is about to be read by a person.
 */
export function formatMinor(minor, currency = 'USD') {
  const n = Number(minor) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n / 100);
  } catch {
    // An unknown currency code should not take a dashboard down.
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}
