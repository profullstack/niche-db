import { describe, expect, test } from 'bun:test';
import { ipToBigInt, ownerOf, ownersList } from '../packages/core/src/traffic/owners.js';
import { parseRdap, rdapLookup } from '../packages/core/src/traffic/rdap.js';
import { isSharedIp } from '../packages/core/src/traffic/shared.js';

describe('ownerOf', () => {
  test('the most specific range wins: Applebot inside Apple', () => {
    expect(ownerOf('17.166.22.207')).toMatchObject({ slug: 'applebot', range: '17.166.22.0/24' });
    expect(ownerOf('17.1.2.3')).toMatchObject({ slug: 'apple', range: '17.0.0.0/8' });
  });

  test('CDNs, resolvers and crawlers, v4 and v6', () => {
    expect(ownerOf('172.71.183.86')?.slug).toBe('cloudflare');
    expect(ownerOf('2606:4700::6810:84e5')?.slug).toBe('cloudflare');
    expect(ownerOf('8.8.8.8')?.slug).toBe('google-dns');
    expect(ownerOf('2620:fe::fe')?.slug).toBe('quad9');
    expect(ownerOf('66.249.66.1')?.slug).toBe('googlebot');
    expect(ownerOf('157.55.39.1')?.slug).toBe('bingbot');
  });

  test('anyone else has no named owner and is not shared', () => {
    expect(ownerOf('45.148.10.7')).toBeNull();
    expect(ownerOf('2a01:4f8::1')).toBeNull();
    expect(ownerOf('not an ip')).toBeNull();
    expect(isSharedIp('45.148.10.7')).toBe(false);
    expect(isSharedIp('17.166.22.207')).toBe(true);
  });

  test('IPv6 parsing handles :: and embedded IPv4', () => {
    expect(ipToBigInt('::1')).toEqual([1n, 128]);
    expect(ipToBigInt('::ffff:1.2.3.4')).toEqual([0xffff01020304n, 128]);
  });

  test('the published list carries every owner with its ranges', () => {
    const list = ownersList();
    expect(list.map((o) => o.slug)).toContain('applebot');
    expect(list.every((o) => o.ranges.length && o.source && o.kind_name)).toBe(true);
  });
});

describe('rdap', () => {
  const ripe = {
    objectClassName: 'ip network',
    handle: '185.220.101.0 - 185.220.101.31',
    name: 'ARTIKEL10',
    country: 'DE',
    port43: 'whois.ripe.net',
    cidr0_cidrs: [{ v4prefix: '185.220.101.0', length: 27 }],
    links: [{ rel: 'self', href: 'https://rdap.db.ripe.net/ip/185.220.101.1' }],
    entities: [
      { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'ARTIKEL10-MNT']]] },
      {
        roles: ['registrant'],
        vcardArray: [
          'vcard',
          [
            ['fn', {}, 'text', 'Artikel10 e.V.'],
            ['kind', {}, 'text', 'org'],
          ],
        ],
      },
      {
        roles: ['abuse'],
        vcardArray: ['vcard', [['email', {}, 'text', 'abuse@artikel10.org']]],
      },
    ],
  };

  test('names the organisation, not the maintainer, with range and abuse contact', () => {
    expect(parseRdap(ripe)).toMatchObject({
      owner: 'Artikel10 e.V.',
      network: 'ARTIKEL10',
      range: '185.220.101.0/27',
      country: 'DE',
      abuse_email: 'abuse@artikel10.org',
      registry: 'whois.ripe.net',
    });
    expect(parseRdap({ objectClassName: 'domain' })).toBeNull();
  });

  test('a failed lookup answers null', async () => {
    const fail = async () => ({ ok: false });
    expect(await rdapLookup('203.0.113.250', { fetchImpl: fail })).toBeNull();
    expect(await rdapLookup('nope', { fetchImpl: fail })).toBeNull();
    const ok = async () => ({ ok: true, json: async () => ripe });
    expect((await rdapLookup('185.220.101.1', { fetchImpl: ok })).owner).toBe('Artikel10 e.V.');
  });
});
