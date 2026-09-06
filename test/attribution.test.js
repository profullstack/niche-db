import { describe, expect, test } from 'bun:test';
import { apportion, splitSaleAcrossNiches } from '../packages/knowledge/src/index.js';

/**
 * Dividing a crawl sale. A pass buys the whole index for a day, so the
 * question these answer is "whose data did it pay for", and the invariant
 * under all of them is that every cent lands somewhere.
 */

describe('apportion', () => {
  test('the parts always sum to exactly the whole', () => {
    for (const [total, weights] of [
      [100, [1, 1, 1]],
      [1, [1, 1, 1]],
      [7, [5, 3, 1]],
      [9999, [103822, 9421, 1654]],
      [3, [1]],
      [1000, [1, 0, 0]],
    ]) {
      const parts = apportion(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      for (const p of parts) expect(Number.isInteger(p)).toBe(true);
      for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  test('a cent that cannot divide goes to whoever was cut hardest, deterministically', () => {
    // One cent, three equal claimants: the first by index takes it, and takes
    // it again on a re-run rather than moving around.
    expect(apportion(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(apportion(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(apportion(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  test('weight is respected, not just count', () => {
    expect(apportion(100, [90, 10])).toEqual([90, 10]);
    expect(apportion(100, [1, 99])).toEqual([1, 99]);
  });

  test('nothing to divide, or nobody to divide between, divides to nothing', () => {
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(100, [0, 0])).toEqual([0, 0]);
    expect(apportion(100, [])).toEqual([]);
  });

  test('rubbish in does not produce NaN out', () => {
    expect(apportion(null, [1])).toEqual([0]);
    expect(apportion(100, [null, 'x', 1])).toEqual([0, 0, 100]);
  });
});

describe('splitting a crawl sale across niches', () => {
  // The real shape of the index at the time of writing.
  const index = 119_824;

  test('an operated niche gets its share of the index, not the whole sale', () => {
    const out = splitSaleAcrossNiches({
      totalCents: 100,
      totalItems: index,
      operated: [{ slug: 'packages', items: 103_822 }],
    });
    // 103822/119824 is about 87%, so the operator's niche books 87c and the
    // rest of the index keeps 13c. Being the only niche with an operator does
    // not entitle it to the whole dollar.
    expect(out.niches[0].cents).toBe(87);
    expect(out.remainderCents).toBe(13);
    expect(out.niches[0].cents + out.remainderCents).toBe(100);
  });

  test('several operated niches divide against the whole index', () => {
    const out = splitSaleAcrossNiches({
      totalCents: 1000,
      totalItems: index,
      operated: [
        { slug: 'packages', items: 103_822 },
        { slug: 'research', items: 1654 },
      ],
    });
    const total = out.niches.reduce((n, x) => n + x.cents, 0) + out.remainderCents;
    expect(total).toBe(1000);
    expect(out.niches[0].cents).toBeGreaterThan(out.niches[1].cents);
  });

  test('with nobody operating anything, the whole sale is the platform remainder', () => {
    const out = splitSaleAcrossNiches({ totalCents: 100, totalItems: index, operated: [] });
    expect(out.niches).toEqual([]);
    expect(out.remainderCents).toBe(100);
  });

  test('an empty index attributes nothing rather than dividing by zero', () => {
    const out = splitSaleAcrossNiches({
      totalCents: 100,
      totalItems: 0,
      operated: [{ slug: 'x', items: 0 }],
    });
    expect(out.niches).toEqual([]);
    expect(out.remainderCents).toBe(100);
  });

  test('a niche too small to earn a cent is dropped, and its cent is not lost', () => {
    const out = splitSaleAcrossNiches({
      totalCents: 1,
      totalItems: 1_000_000,
      operated: [{ slug: 'tiny', items: 1 }],
    });
    expect(out.niches).toEqual([]);
    expect(out.remainderCents).toBe(1);
  });

  test('every cent of the sale is always accounted for', () => {
    for (const total of [1, 2, 3, 99, 100, 333, 1000, 9999]) {
      const out = splitSaleAcrossNiches({
        totalCents: total,
        totalItems: index,
        operated: [
          { slug: 'a', items: 103_822 },
          { slug: 'b', items: 9421 },
          { slug: 'c', items: 1654 },
        ],
      });
      const sum = out.niches.reduce((n, x) => n + x.cents, 0) + out.remainderCents;
      expect(sum).toBe(total);
    }
  });

  test('a sale of nothing books nothing', () => {
    const out = splitSaleAcrossNiches({
      totalCents: 0,
      totalItems: index,
      operated: [{ slug: 'a', items: 100 }],
    });
    expect(out.niches).toEqual([]);
    expect(out.remainderCents).toBe(0);
  });
});
