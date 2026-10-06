import { describe, expect, test } from 'bun:test';
import { findPromo, parsePromoCodes, promoDiscountCents } from './promo.js';

describe('promo codes', () => {
  test('parses code, percent and an inclusive UTC end date, skipping junk', () => {
    const codes = parsePromoCodes(' 50off:50 , LAUNCH:20:2026-10-31, BAD:0, WORSE:150, :10, X:abc');
    expect([...codes.keys()]).toEqual(['50OFF', 'LAUNCH']);
    expect(codes.get('LAUNCH').ends.toISOString()).toBe('2026-10-31T23:59:59.999Z');
    expect(parsePromoCodes('').size).toBe(0);
  });
  test('lookup is case-insensitive and an ended code is gone', () => {
    const codes = parsePromoCodes('50OFF:50,OLD:30:2026-01-01');
    expect(findPromo(codes, ' 50off ')?.percent).toBe(50);
    expect(findPromo(codes, 'OLD', new Date('2026-01-01T12:00:00Z'))?.percent).toBe(30);
    expect(findPromo(codes, 'OLD', new Date('2026-01-02T00:00:00Z'))).toBeNull();
    expect(findPromo(codes, 'nope')).toBeNull();
  });
  test('discount is whole cents, rounded toward the buyer', () => {
    expect(promoDiscountCents(3000, { percent: 50 })).toBe(1500);
    expect(promoDiscountCents(99, { percent: 50 })).toBe(50);
    expect(promoDiscountCents(3000, null)).toBe(0);
  });
});
