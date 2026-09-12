/**
 * Pricing and modules: the loyalty ladder, who a request is, and which
 * modules a response carries. No database: the pure parts.
 */
import { describe, expect, test } from 'bun:test';

// The config reads the environment once at import; these modules need it to exist, not to work.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { sponsoredItem } = await import('../apps/web/src/lib/ads.js');
const { ALL_ON, decideModules, parseDisable } = await import('../apps/web/src/lib/modules.js');
const { crawlPriceCents, nextTier, parseLoyalty, payerFor } = await import(
  '../apps/web/src/lib/pricing.js'
);

const TIERS = parseLoyalty('1000:20,5000:40,10000:60');

describe('the loyalty ladder', () => {
  test('parses ascending, ignores garbage', () => {
    expect(TIERS).toEqual([
      { spentCents: 1000, off: 0.2 },
      { spentCents: 5000, off: 0.4 },
      { spentCents: 10000, off: 0.6 },
    ]);
    expect(parseLoyalty('5000:40, 1000:20, nope, :5, 0:9')).toEqual([
      { spentCents: 1000, off: 0.2 },
      { spentCents: 5000, off: 0.4 },
    ]);
    expect(parseLoyalty('')).toEqual([]);
  });

  test('a stranger pays list; a regular pays less; the floor holds', () => {
    const at = (spent) => crawlPriceCents(spent, { base: 100, tiers: TIERS, floor: 10 });
    expect(at(0)).toBe(100);
    expect(at(999)).toBe(100);
    expect(at(1000)).toBe(80);
    expect(at(5000)).toBe(60);
    expect(at(10000)).toBe(40);
    expect(at(1_000_000)).toBe(40);
    expect(crawlPriceCents(10000, { base: 20, tiers: TIERS, floor: 10 })).toBe(10);
    expect(crawlPriceCents(0, { base: 100, tiers: [], floor: 10 })).toBe(100);
  });

  test('the next step down is what to tell a buyer', () => {
    expect(nextTier(0, TIERS)).toEqual({ spentCents: 1000, off: 0.2 });
    expect(nextTier(1000, TIERS)).toEqual({ spentCents: 5000, off: 0.4 });
    expect(nextTier(50_000, TIERS)).toBeNull();
  });
});

describe('who is asking', () => {
  const proof = (from) =>
    Buffer.from(
      JSON.stringify({ x402Version: 2, payload: { authorization: { from, value: '1000000' } } }),
    ).toString('base64');

  test('the proof names the payer; a hint is only taken when it looks like an address', async () => {
    const req = new Request('https://nichedb.dev/crawl', {
      headers: { 'x-payment': proof('0xabc0000000000000000000000000000000000001') },
    });
    expect(await payerFor(req)).toBe('0xabc0000000000000000000000000000000000001');
    expect(
      await payerFor(
        new Request('https://nichedb.dev/crawl?payer=0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5'),
      ),
    ).toBe('0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5');
    expect(await payerFor(new Request('https://nichedb.dev/crawl?payer=me'))).toBeNull();
    expect(await payerFor(new Request('https://nichedb.dev/'))).toBeNull();
  });
});

describe('modules', () => {
  test('disable= names modules, case-insensitively, and "all" means both', () => {
    expect([...parseDisable('ads')]).toEqual(['ads']);
    expect([...parseDisable('Ads, TRACKING ,x')]).toEqual(['ads', 'tracking']);
    expect([...parseDisable('all')]).toEqual(['ads', 'tracking']);
    expect([...parseDisable(undefined)]).toEqual([]);
  });

  test('free gets everything, a member gets nothing, a pass gets its choice', () => {
    expect(decideModules({ plan: 'free', paid: false, disable: 'ads,tracking' })).toBe(ALL_ON);
    expect(decideModules({ plan: 'pro', paid: true, disable: undefined })).toEqual({
      ads: false,
      tracking: false,
      paid: true,
      pro: true,
      premium: true,
      plan: 'pro',
    });
    // Premium buys the same silence Pro does; the tiers differ in limits.
    expect(decideModules({ plan: 'premium', paid: true, disable: undefined })).toEqual({
      ads: false,
      tracking: false,
      paid: true,
      pro: false,
      premium: true,
      plan: 'premium',
    });
    expect(decideModules({ plan: 'free', paid: true, disable: 'ads' })).toEqual({
      ads: false,
      tracking: true,
      paid: true,
      pro: false,
      premium: false,
      plan: 'free',
    });
    expect(decideModules({ plan: 'free', paid: true, disable: undefined })).toEqual({
      ads: true,
      tracking: true,
      paid: true,
      pro: false,
      premium: false,
      plan: 'free',
    });
  });
});

describe('the sponsored feed item', () => {
  test('is built from CrawlProof fields, labelled, and never from a failed fill', () => {
    const item = sponsoredItem(
      {
        ok: true,
        guid: 'wk-2026-36',
        headline: 'Ship faster',
        body: 'One line of benefit.',
        url: 'https://crawlproof.com/a/abc123',
        label: 'Sponsored',
        attribution: 'Ads by CrawlProof',
        publishedAt: '2026-09-05T00:00:00.000Z',
        imageUrl: null,
      },
      new Date('2026-09-05T12:00:00Z'),
    );
    expect(item.id).toBe('sponsored-wk-2026-36');
    expect(item.title).toBe('Sponsored: Ship faster');
    expect(item.url).toBe('https://crawlproof.com/a/abc123');
    expect(item.summary).toBe('One line of benefit.\n\nSponsored · Ads by CrawlProof');
    expect(item.tags).toEqual(['sponsored']);
    expect(sponsoredItem({ ok: false })).toBeNull();
    expect(sponsoredItem(null)).toBeNull();
    // The live answer wraps the fill in `items`.
    const wrapped = sponsoredItem({
      ok: true,
      count: 1,
      items: [
        {
          ok: true,
          sponsored: true,
          guid: 'g',
          headline: 'Wrapped',
          body: 'b',
          url: 'https://x.y/a',
          label: 'Sponsored',
        },
      ],
    });
    expect(wrapped.title).toBe('Sponsored: Wrapped');
    expect(sponsoredItem({ ok: true, count: 0, items: [] })).toBeNull();
  });
});
