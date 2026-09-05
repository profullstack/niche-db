/**
 * What a crawl pass costs the agent asking for it.
 *
 * The list price is a dollar a day for everything. A buyer that keeps coming
 * back pays less: lifetime spend here moves it down a loyalty ladder, so the
 * heaviest users of the database are the cheapest to serve and the most
 * likely to stay. The ladder is configuration (`CRAWL_LOYALTY`), read once.
 *
 * The gateway prices every request the same, so this builds one gateway per
 * price and picks the gateway for the request: the payer is read off the
 * payment proof when there is one (that is the price the settlement checks),
 * off an old pass otherwise, or off a `?payer=` hint on the sales page.
 */
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { createGateway, decodePayment } from '@profullstack/x402-gateway';

/** "1000:20,5000:40" → [{ spentCents: 1000, off: 0.2 }, …], ascending by spend. */
export function parseLoyalty(spec) {
  return String(spec ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [spent, off] = pair.split(':').map((n) => Number(n));
      return { spentCents: spent, off: Math.min(100, Math.max(0, off || 0)) / 100 };
    })
    .filter((tier) => Number.isFinite(tier.spentCents) && tier.spentCents > 0)
    .sort((a, b) => a.spentCents - b.spentCents);
}

/** Cents a day for a buyer that has spent `spentCents` here. */
export function crawlPriceCents(
  spentCents,
  {
    base = config.x402.priceCents,
    tiers = parseLoyalty(config.x402.loyalty),
    floor = config.x402.floorCents,
  } = {},
) {
  let off = 0;
  for (const tier of tiers) if (spentCents >= tier.spentCents) off = tier.off;
  return Math.max(floor, Math.round(base * (1 - off)));
}

/** The next step down the ladder, for the sales page and llms.txt. */
export function nextTier(spentCents, tiers = parseLoyalty(config.x402.loyalty)) {
  return tiers.find((tier) => spentCents < tier.spentCents) ?? null;
}

/** The pass a request carries, verified or not; its ref names the sale it came from. */
function passRefFrom(request) {
  const direct = request.headers.get('x-crawl-pass');
  const bearer = /^Bearer\s+(cp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
    request.headers.get('authorization') ?? '',
  );
  const token = (direct ?? bearer?.[1] ?? '').trim();
  if (!token.startsWith('cp_')) return null;
  try {
    const payload = token.slice(3, token.indexOf('.'));
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof json.ref === 'string' ? json.ref : null;
  } catch {
    return null;
  }
}

/**
 * Who is asking. The proof's own `from` when a payment is presented, so the
 * price the settlement checks is the payer's price; else the sale behind the
 * pass they hold; else a hint. Null for a stranger.
 */
export async function payerFor(request) {
  const proof = request.headers.get('x-payment');
  if (proof) {
    const payment = decodePayment(proof);
    const from = payment?.payload?.authorization?.from;
    if (typeof from === 'string' && from) return from;
  }
  const ref = passRefFrom(request);
  if (ref) {
    const sale = await q.crawlSaleByRef(ref).catch(() => null);
    if (sale?.payer) return sale.payer;
  }
  const hint = new URL(request.url).searchParams.get('payer');
  return hint && /^0x[0-9a-fA-F]{40}$/.test(hint) ? hint : null;
}

/** The options every gateway shares; only the price differs. */
export function gatewayOptions(priceCents) {
  return {
    siteUrl: config.siteUrl,
    siteName: config.siteName,
    coinpay: { apiKey: config.x402.coinpayKey },
    payTo: config.x402.payTo,
    priceCents,
    passMinutes: config.x402.passMinutes,
    maxDays: config.x402.maxDays,
    contact: config.x402.contact || undefined,
    openPaths: ['/llms.txt', '/mcp', '/api/', '/healthz', '/manifest.webmanifest'],
    onSale: async (sale) => {
      console.log('[x402] sold a pass', {
        payer: sale.payer,
        days: sale.days,
        cents: sale.totalCents,
      });
      await q.recordCrawlSale({
        payer: sale.payer,
        ref: sale.ref,
        days: sale.days,
        priceCents: sale.priceCents,
        totalCents: sale.totalCents,
        currency: sale.currency,
        userAgent: sale.userAgent,
        expiresAt: sale.expiresAt,
      });
    },
  };
}

const gateways = new Map();

/** The gateway that charges `priceCents` a day. One per price, built once. */
export function gatewayAt(priceCents) {
  let gateway = gateways.get(priceCents);
  if (!gateway) {
    gateway = createGateway(gatewayOptions(priceCents));
    gateways.set(priceCents, gateway);
  }
  return gateway;
}

/** The gateway for this request: list price for a stranger, its own price for a buyer we know. */
export async function gatewayFor(request) {
  const payer = await payerFor(request);
  const spent = payer ? await q.crawlSpendByPayer(payer).catch(() => 0) : 0;
  return { gateway: gatewayAt(crawlPriceCents(spent)), payer, spentCents: spent };
}

/** The list-price gateway, for robots.txt and the sales page mounted on a route. */
export const gateway = gatewayAt(config.x402.priceCents);
