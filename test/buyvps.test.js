/**
 * BuyVPS: the comparison table read into OpenServer offers. What would be
 * embarrassing: a plan missed, a TB read as GB, a dollar trial folded into
 * the price, EUR taken for USD, a dedicated tier sold as shared.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  buyvps,
  gigabytes,
  PLANS_URL,
  parsePlans,
  toItem,
} from '../packages/adapters/src/buyvps.js';
import { adapterByName } from '../packages/adapters/src/index.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const html = await readFile(
  new URL('../packages/adapters/test/fixtures/buyvps-plans.html', import.meta.url),
  'utf8',
);

describe('the comparison table', () => {
  test('fourteen plans, three tiers, sizes as the page states them', () => {
    const plans = parsePlans(html);
    expect(plans.map((p) => p.id)).toEqual([
      'S-2',
      'S-4',
      'S-8',
      'S-16',
      'S-32',
      'S-64',
      'D-4',
      'D-8',
      'D-16',
      'D-32',
      'D-64',
      'H-64',
      'H-128',
      'H-192',
    ]);
    const s2 = plans[0];
    expect(s2).toMatchObject({
      tier: 'standard',
      vcpu: 1,
      ramGb: 2,
      diskGb: 30,
      bandwidth: 'Unlimited',
      usd: 7.99,
      eur: 6.99,
      trial: true,
    });
    expect(s2.pid).toBe('32');
    expect(s2.description).toMatch(/^Shared vCPU on EPYC Milan/);
    const d64 = plans.find((p) => p.id === 'D-64');
    expect(d64).toMatchObject({
      tier: 'dedicated',
      vcpu: 10,
      ramGb: 64,
      diskGb: 400,
      usd: 377,
      eur: 349,
      trial: false,
    });
    const h192 = plans.find((p) => p.id === 'H-192');
    expect(h192).toMatchObject({
      tier: 'high-memory',
      vcpu: 24,
      ramGb: 192,
      diskGb: 1400,
      usd: 669,
      eur: 616,
    });
    expect(gigabytes('1.4 TB')).toBe(1400);
    expect(gigabytes('30 GB')).toBe(30);
    expect(gigabytes('Unlimited')).toBeNull();
  });

  test('a plan is an OpenServer offer with the tier, both currencies and the trial kept apart', () => {
    const [s2] = parsePlans(html);
    const item = normaliseItem(toItem(s2, new Date('2026-09-13T06:00:00Z')));
    expect(item.externalId).toBe('buyvps:plan:S-2');
    expect(item.kind).toBe('plan');
    expect(item.title).toBe('BuyVPS S-2 standard (S-2)');
    expect(item.url).toBe(`${PLANS_URL}#compare`);
    const o = item.data.offer;
    expect(o.kind).toBe('vps');
    expect(o.tenancy).toBe('shared');
    expect(o.compute.vcpu).toBe(1);
    expect(o.memory?.ram_mb ?? o.compute.ram_mb).toBe(2048);
    expect(o.storage[0]).toMatchObject({ type: 'nvme', size_gb: 30 });
    expect(o.location.regions).toEqual(['ams', 'nyc']);
    expect(o.location.countries).toEqual(['nl', 'us']);
    expect(o.price).toMatchObject({ amount: 7.99, currency: 'USD', interval: 'month' });
    expect(item.data.priceEur).toBe(6.99);
    expect(item.data.trial).toMatchObject({ amount: 1, months: 1 });
    expect(item.data.order).toBe('https://order.buyvps.com/trial?pid=32');
    expect(item.tags).toContain('provider:buyvps');
    expect(item.tags).toContain('tier:standard');
    expect(item.tags).toContain('transfer:unmetered');
    expect(item.tags).toContain('trial');
    expect(item.tags).toContain('country:nl');
    // Dedicated cores are dedicated tenancy, and no trial where the page offers none.
    const d64 = normaliseItem(toItem(parsePlans(html).find((p) => p.id === 'D-64')));
    expect(d64.data.offer.tenancy).toBe('dedicated');
    expect(d64.data.offer.compute.cores).toBe(10);
    expect(d64.data.trial).toBeNull();
    expect(d64.tags).not.toContain('trial');
  });

  test('is registered against hosting, keyless, with one seeded source', () => {
    const a = adapterByName('buyvps');
    expect(a).toBe(buyvps);
    expect(a.collection).toBe('hosting');
    expect(a.needsEnv ?? []).toEqual([]);
    expect(a.defaultSources.map((s) => s.slug)).toEqual(['buyvps-plans']);
    for (const k of Object.keys(a.defaultSources[0].config))
      expect(a.configFields.map((f) => f.key)).toContain(k);
  });

  test('a run reads the page as served when no Obscura is configured', async () => {
    const http = { text: async () => html };
    const out = await buyvps.pull({ config: { url: PLANS_URL }, env: {}, http, log: () => {} });
    expect(out.items).toHaveLength(14);
    expect(out.note).toBe('14 plans via fetch');
    expect(normaliseItem(out.items[13]).externalId).toBe('buyvps:plan:H-192');
  });
});
