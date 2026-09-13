import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  digitaloceanSizes,
  toItem as doItem,
  regionCountry,
} from '../packages/adapters/src/digitalocean.js';
import { toItem as hetznerItem, hetznerPlans } from '../packages/adapters/src/hetzner.js';
import {
  monthlyFromHourlyCents,
  pricesByPlan,
  toItem as upcloudItem,
  upcloudPlans,
} from '../packages/adapters/src/upcloud.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await fixture(name));

/**
 * The three keyed catalogues, written from their documented response
 * shapes: no credential existed on the box that built them, so these
 * fixtures ARE the shape, and the first live run is the check that the
 * documentation was right.
 */
describe('Hetzner server types', () => {
  test('one row per type, cheapest net EUR price, countries from locations, deprecation as stock', async () => {
    const doc = await json('hetzner-server-types.json');
    const items = doc.server_types.map(hetznerItem).filter(Boolean);
    expect(items.map((i) => i.externalId)).toEqual([
      'hetzner:plan:cx22',
      'hetzner:plan:cax11',
      'hetzner:plan:ccx13',
      'hetzner:plan:cx11',
    ]);
    const cx22 = items[0];
    expect(cx22.data.provider).toBe('hetzner');
    expect(cx22.data.offer.price).toEqual({
      amount: 3.79,
      currency: 'EUR',
      interval: 'month',
      setup: null,
      commitment: null,
    });
    expect(cx22.data.priceHourly).toBe(0.006);
    expect(cx22.data.offer.compute).toEqual({
      vcpu: 2,
      cores: null,
      ram_mb: 4096,
      arch: 'x86_64',
      gpu: null,
    });
    expect(cx22.data.offer.location).toEqual({ regions: ['fsn1', 'ash'], countries: ['DE', 'US'] });
    // Included traffic differs by location; the offer carries the smallest, every location keeps its own.
    expect(cx22.data.offer.network.transfer_gb).toBe(1024);
    expect(cx22.data.pricesByLocation.fsn1.includedTrafficGb).toBe(20480);
    expect(cx22.tags).toContain('price:under-5');
    expect(cx22.tags).toContain('country:de');
    expect(items[1].data.offer.compute.arch).toBe('arm64');
    expect(items[2].data.offer.tenancy).toBe('dedicated');
    expect(items[2].data.offer.compute.cores).toBe(2);
    expect(items[3].data.offer.stock).toBe('out_of_stock');
    expect(items[3].tags).toContain('deprecated');
    for (const i of items) expect(normaliseItem(i)).not.toBeNull();
  });

  test('refuses to run without the token and is seeded paused', async () => {
    expect(hetznerPlans.needsEnv).toEqual(['hetznerApiToken']);
    await expect(hetznerPlans.pull({ env: {}, http: {}, log() {} })).rejects.toThrow(
      'HETZNER_API_TOKEN',
    );
  });

  test('pages on meta.pagination.next_page with the bearer header', async () => {
    const calls = [];
    const doc = await json('hetzner-server-types.json');
    const http = {
      async json(url, opts) {
        calls.push({ url, auth: opts.headers.authorization });
        if (url.endsWith('page=1')) return { ...doc, meta: { pagination: { next_page: 2 } } };
        return { server_types: [], meta: { pagination: { next_page: null } } };
      },
    };
    const r = await hetznerPlans.pull({ env: { hetznerApiToken: 't0k' }, http, log() {} });
    expect(r.items).toHaveLength(4);
    expect(calls.map((c) => c.auth)).toEqual(['Bearer t0k', 'Bearer t0k']);
    expect(calls[1].url).toContain('page=2');
  });
});

describe('DigitalOcean sizes', () => {
  test('one row per size, USD monthly and hourly, family tag, GPU sizes as gpu, unavailable as out of stock', async () => {
    const doc = await json('digitalocean-sizes.json');
    const items = doc.sizes.map(doItem).filter(Boolean);
    expect(items.map((i) => i.externalId)).toEqual([
      'digitalocean:plan:s-1vcpu-1gb',
      'digitalocean:plan:c-2',
      'digitalocean:plan:gpu-h100x1-80gb',
      'digitalocean:plan:s-1vcpu-512mb-10gb',
    ]);
    const basic = items[0];
    expect(basic.data.provider).toBe('digitalocean');
    expect(basic.data.offer.price.amount).toBe(6);
    expect(basic.data.offer.price.currency).toBe('USD');
    expect(basic.data.priceHourly).toBe(0.00893);
    expect(basic.data.offer.network.transfer_gb).toBe(1024);
    expect(basic.data.offer.location.countries).toEqual([
      'NL',
      'IN',
      'DE',
      'GB',
      'US',
      'SG',
      'AU',
      'CA',
    ]);
    expect(basic.tags).toContain('family:s');
    expect(basic.tags).toContain('price:5-10');
    expect(items[2].data.offer.kind).toBe('gpu');
    expect(items[2].data.offer.compute.gpu.count).toBe(1);
    expect(items[2].tags).toContain('gpu');
    expect(items[3].data.offer.stock).toBe('out_of_stock');
    expect(regionCountry('nyc3')).toBe('US');
    expect(regionCountry('mars1')).toBeNull();
    for (const i of items) expect(normaliseItem(i)).not.toBeNull();
  });

  test('follows links.pages.next and refuses without a token', async () => {
    expect(digitaloceanSizes.needsEnv).toEqual(['digitaloceanToken']);
    await expect(digitaloceanSizes.pull({ env: {}, http: {}, log() {} })).rejects.toThrow(
      'DIGITALOCEAN_TOKEN',
    );
    const doc = await json('digitalocean-sizes.json');
    const urls = [];
    const http = {
      async json(url) {
        urls.push(url);
        if (urls.length === 1)
          return {
            ...doc,
            links: { pages: { next: 'https://api.digitalocean.com/v2/sizes?page=2' } },
          };
        return { sizes: [], links: { pages: {} } };
      },
    };
    const r = await digitaloceanSizes.pull({ env: { digitaloceanToken: 't' }, http, log() {} });
    expect(r.items).toHaveLength(4);
    expect(urls[1]).toContain('page=2');
  });
});

describe('UpCloud plans', () => {
  test('the price list is read per zone and the cheapest zone prices the offer', async () => {
    const prices = pricesByPlan(await json('upcloud-price.json'));
    expect(prices['1xCPU-1GB']).toEqual({ 'fi-hel1': 1.488, 'us-chi1': 1.6 });
    expect(prices['HICPU-8xCPU-16GB']).toEqual({ 'fi-hel1': 25 });
    // 1.488 cents an hour, 730 hours: $10.86.
    expect(monthlyFromHourlyCents(1.488)).toBe(10.86);
    const plans = (await json('upcloud-plans.json')).plans.plan;
    const items = plans.map((p) => upcloudItem(p, prices)).filter(Boolean);
    expect(items.map((i) => i.externalId)).toEqual([
      'upcloud:plan:1xCPU-1GB',
      'upcloud:plan:2xCPU-4GB',
      'upcloud:plan:HICPU-8xCPU-16GB',
    ]);
    const small = items[0];
    expect(small.data.provider).toBe('upcloud');
    expect(small.data.offer.price).toEqual({
      amount: 10.86,
      currency: 'USD',
      interval: 'month',
      setup: null,
      commitment: null,
    });
    expect(small.data.offer.location).toEqual({
      regions: ['fi-hel1', 'us-chi1'],
      countries: ['FI', 'US'],
    });
    expect(small.data.offer.compute.ram_mb).toBe(1024);
    expect(small.data.offer.storage).toEqual([{ type: 'block', size_gb: 25 }]);
    expect(small.data.pricesByZone['us-chi1'].monthly).toBe(11.68);
    expect(small.data.priceUnit).toContain('unconfirmed');
    // A plan the price list does not mention is still a row, with no price.
    expect(items[2].data.offer.price.amount).toBe(25 * 7.3);
    for (const i of items) expect(normaliseItem(i)).not.toBeNull();
  });

  test('needs both halves of the credential and sends them as Basic', async () => {
    expect(upcloudPlans.needsEnv).toEqual(['upcloudUsername', 'upcloudPassword']);
    await expect(
      upcloudPlans.pull({ env: { upcloudUsername: 'u' }, http: {}, log() {} }),
    ).rejects.toThrow('UPCLOUD_USERNAME');
    const seen = [];
    const http = {
      async json(url, opts) {
        seen.push(opts.headers.authorization);
        if (url.endsWith('/plan')) return await json('upcloud-plans.json');
        return await json('upcloud-price.json');
      },
    };
    const r = await upcloudPlans.pull({
      env: { upcloudUsername: 'user', upcloudPassword: 'pass' },
      http,
      log() {},
    });
    expect(r.items).toHaveLength(3);
    expect(new Set(seen)).toEqual(
      new Set([`Basic ${Buffer.from('user:pass').toString('base64')}`]),
    );
  });
});
