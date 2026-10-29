import { describe, expect, test } from 'bun:test';
import { adapterByName } from '../packages/adapters/src/index.js';
import { formatNumber, toItem } from '../packages/adapters/src/smshub-blacklist.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');
const { normaliseNumber } = await import('../apps/web/src/routes/blacklists.js');
const { isReservedNicheSlug } = await import('../packages/knowledge/src/index.js');

const TODAY = new Date('2026-10-29T04:00:00Z');

describe('smshub-blacklist', () => {
  test('is registered under the blacklists collection, which exists with its feeds', () => {
    const a = adapterByName('smshub-blacklist');
    expect(a.collection).toBe('blacklists');
    expect(COLLECTIONS.some((c) => c.slug === 'blacklists')).toBe(true);
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'blacklists').map((f) => f.slug);
    expect(feeds).toEqual(['sms-blacklist', 'sms-scam-numbers']);
    expect(isReservedNicheSlug('blacklists')).toBe(true);
  });

  test('one export row becomes one listed number', () => {
    const it = toItem(
      {
        number: '+18885551234',
        reasons: { spam: 1, scam: 2 },
        reporters: 3,
        firstFlaggedAt: '2026-10-28T20:00:00Z',
        lastFlaggedAt: '2026-10-29T03:00:00Z',
        blockedMessages: 7,
      },
      TODAY,
    );
    expect(it.externalId).toBe('sms:+18885551234');
    expect(it.title).toBe('+1 888-555-1234');
    expect(it.url).toBe('https://nichedb.dev/blacklists/sms/18885551234');
    expect(it.tags).toEqual([
      'sms',
      'smshub',
      'status:listed',
      'reason:spam',
      'reason:scam',
      'nanp',
    ]);
    expect(it.summary).toBe('Flagged as scam by 3 smshub users (1 spam, 2 scam).');
    expect(it.data.lastListed).toBe('2026-10-29');
    expect(it.data.reasons).toEqual({ spam: 1, scam: 2 });
    expect(normaliseItem(it)).not.toBeNull();
  });

  test('rows without an E.164 number or a reason are dropped', () => {
    expect(toItem({ number: '5551234', reasons: { spam: 1 } }, TODAY)).toBeNull();
    expect(toItem({ number: '+18885551234', reasons: {} }, TODAY)).toBeNull();
    expect(toItem({ number: '+18885551234', reasons: { other: 4 } }, TODAY)).toBeNull();
    expect(toItem(null, TODAY)).toBeNull();
  });

  test('pull reads the export and dedupes', async () => {
    const row = { number: '+447700900123', reasons: { spam: 1 }, reporters: 1 };
    const http = { json: async () => ({ numbers: [row, row, { number: 'x' }] }) };
    const { items } = await adapterByName('smshub-blacklist').pull({
      config: {},
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(items.map((i) => i.title)).toEqual(['+447700900123']);
    expect(formatNumber('+447700900123')).toBe('+447700900123');
  });
});

describe('normaliseNumber', () => {
  test('reads the shapes people type', () => {
    expect(normaliseNumber('(888) 555-1234')).toBe('+18885551234');
    expect(normaliseNumber('1 888 555 1234')).toBe('+18885551234');
    expect(normaliseNumber('+44 7700 900123')).toBe('+447700900123');
    expect(normaliseNumber('hello')).toBeNull();
    expect(normaliseNumber('+0123')).toBeNull();
  });
});
