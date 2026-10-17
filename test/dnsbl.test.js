/**
 * Live DNS blocklists. What would be embarrassing: a list that refused us
 * (or a public resolver that answers nothing) reported as "not listed",
 * Spamhaus asked when the operator turned it off, an IPv6 address sent to a
 * list that only knows IPv4, or every lookup re-asking the test entry.
 */
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { decodeZone, reputationZones, reverseName, ttlCache, zoneLookup, zonesLookup } =
  await import('../apps/web/src/lib/dnsbl.js');

const nx = () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
const zone =
  (answers, asked = []) =>
  async (n) => {
    asked.push(n);
    for (const [k, v] of Object.entries(answers)) if (n.startsWith(k)) return v;
    return nx();
  };

describe('decoding', () => {
  test('SpamCop and PSBL list with 127.0.0.2 only', () => {
    expect(decodeZone('spamcop', ['127.0.0.2']).reasons.length).toBe(1);
    expect(decodeZone('psbl', ['127.0.0.4']).reasons).toEqual([]);
  });
  test('Mailspike: the blocklist and the bad end of its reputation count, neutral does not', () => {
    const { reasons } = decodeZone('mailspike', ['127.0.0.2', '127.0.0.10', '127.0.0.14']);
    expect(reasons.map((r) => r.policy)).toEqual([false, false, true]);
    expect(decodeZone('mailspike', ['127.0.0.18']).reasons).toEqual([]);
  });
  test('ZEN SBL + CSS + XBL, as dev2 was listed', () => {
    const { reasons } = decodeZone('zen', ['127.0.0.2', '127.0.0.3', '127.0.0.4']);
    expect(reasons.map((r) => r.label.split(' ')[0])).toEqual(['SBL', 'SBL', 'XBL']);
  });
});

describe('names', () => {
  test('IPv4 reversed, IPv6 nibble-reversed, a domain as is', () => {
    expect(reverseName('23.95.228.174')).toBe('174.228.95.23');
    expect(reverseName('2001:db8::1')).toBe(
      '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2',
    );
    expect(reverseName('evil.example')).toBe('evil.example');
  });
});

describe('which lists', () => {
  const on = { dnsbl: true, spamhausDnsbl: true };
  test('addresses and domains go to their own lists', () => {
    expect(reputationZones('ip', { opts: on })).toEqual(['zen', 'spamcop', 'psbl', 'mailspike']);
    expect(reputationZones('domain', { opts: on })).toEqual(['dbl', 'uribl', 'surbl']);
  });
  test('the Spamhaus flag drops Spamhaus alone; the master flag drops everything', () => {
    const noSpamhaus = { dnsbl: true, spamhausDnsbl: false };
    expect(reputationZones('ip', { opts: noSpamhaus })).not.toContain('zen');
    expect(reputationZones('domain', { opts: noSpamhaus })).toEqual(['uribl', 'surbl']);
    expect(reputationZones('ip', { opts: { dnsbl: false, spamhausDnsbl: true } })).toEqual([]);
  });
  test('IPv6 only goes to lists that know IPv6', () => {
    expect(reputationZones('ip', { ipv6: true, opts: on })).toEqual(['zen']);
  });
});

describe('lookups', () => {
  test('a failed test entry is unknown, never clear', async () => {
    const [r] = await zonesLookup(['spamcop'], '23.95.228.174', {
      resolveFor: async () => zone({}),
    });
    expect(r.status).toBe('unknown');
  });
  test('a zone that cannot be reached at all is unknown, not missing', async () => {
    const [r] = await zonesLookup(['psbl'], '23.95.228.174', {
      resolveFor: async () => {
        throw new Error('no nameserver address for psbl.surriel.com');
      },
    });
    expect(r).toMatchObject({ list: 'PSBL', status: 'unknown' });
  });
  test('the test entry and the answer are held, so a repeat asks nothing', async () => {
    const asked = [];
    const resolve = zone({ '2.0.0.127.': ['127.0.0.2'], '174.228.95.23.': ['127.0.0.2'] }, asked);
    const cache = ttlCache();
    const a = await zoneLookup('zen', '23.95.228.174', { resolve, cache });
    expect(a.status).toBe('listed');
    expect((await zoneLookup('zen', '23.95.228.175', { resolve, cache })).status).toBe('clear');
    expect(await zoneLookup('zen', '23.95.228.174', { resolve, cache })).toBe(a);
    expect(asked.filter((n) => n.startsWith('2.0.0.127.')).length).toBe(1);
    expect(asked.length).toBe(3);
  });
  test('an entry expires', () => {
    let t = 0;
    const c = ttlCache({ now: () => t });
    c.set('k', 1, 1000);
    expect(c.get('k')).toBe(1);
    t = 1001;
    expect(c.get('k')).toBeUndefined();
  });
});
