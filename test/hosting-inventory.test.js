import { describe, expect, test } from 'bun:test';
import { retireOffer, stockFrom } from '../packages/adapters/src/hosting.js';
import { availabilityByPlan, toItem as linodeItem } from '../packages/adapters/src/linode.js';
import {
  catalogRates,
  merge as mergeScaleway,
  stockOf as scalewayStock,
} from '../packages/adapters/src/scaleway.js';
import { toItem as vultrItem, stockOf as vultrStock } from '../packages/adapters/src/vultr.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { retireMissing } = await import('../packages/core/src/ingest.js');

/** A GPU offer as Scaleway's products endpoint sends it in 2026-11: priced at zero. */
const L4 = {
  monthly_price: 0,
  hourly_price: 0,
  ncpus: 8,
  ram: 51539607552,
  arch: 'x86_64',
  gpu: 1,
  gpu_info: { gpu_manufacturer: 'NVIDIA', gpu_name: 'L4', gpu_memory: 25769803776 },
  network: { sum_internet_bandwidth: 2500000000, ipv6_support: true },
  end_of_service: false,
};
const catalogRow = (product, zone, nanos, unit = 'minute', status = 'general_availability') => ({
  product,
  product_category: 'Instance',
  locality: { zone },
  price: { retail_price: { currency_code: 'EUR', units: 0, nanos } },
  unit_of_measure: { unit, size: 1 },
  status,
});

describe('Scaleway GPU prices and stock', () => {
  test('the catalogue gives the cheapest hourly rate per offer, minute rates times 60', () => {
    const rates = catalogRates([
      catalogRow('L4-1-24G', 'fr-par-1', 13125000),
      catalogRow('L4-1-24G', 'pl-waw-2', 14000000),
      catalogRow('DEV1-S', 'fr-par-1', 8976000, 'hour'),
      catalogRow('OLD-1', 'fr-par-1', 5000000, 'hour', 'retired'),
      catalogRow('FREE-1', 'fr-par-1', 0, 'hour'),
    ]);
    expect(rates.get('L4-1-24G')).toBeCloseTo(0.7875, 6);
    expect(rates.get('DEV1-S')).toBeCloseTo(0.008976, 6);
    expect(rates.has('OLD-1')).toBe(false);
    expect(rates.has('FREE-1')).toBe(false);
  });

  test('an offer the products endpoint prices at zero takes the catalogue hourly rate, never 0', () => {
    const rates = new Map([['L4-1-24G', 0.7875]]);
    const [item] = mergeScaleway([['fr-par-1', { 'L4-1-24G': L4 }]], { rates });
    const o = item.data.offer;
    expect(o.price.amount).toBe(0.7875);
    expect(o.price.interval).toBe('hour');
    expect(item.data.priceHourly).toBe(0.7875);
    expect(item.data.priceSource).toBe('catalog');
    expect(o.compute.gpu).toEqual({ model: 'NVIDIA L4', count: 1, vram_mb: 24576 });
  });

  test('without a catalogue rate a zero-priced offer stays null, not 0', () => {
    const [item] = mergeScaleway([['fr-par-1', { 'L4-1-24G': L4 }]]);
    expect(item.data.offer.price.amount).toBeNull();
  });

  test('a listed monthly price still wins', () => {
    const dev = { ...L4, gpu: 0, monthly_price: 6.42, hourly_price: 0.0088 };
    const [item] = mergeScaleway([['fr-par-1', { 'DEV1-S': dev }]], {
      rates: new Map([['DEV1-S', 0.009]]),
    });
    expect(item.data.offer.price).toMatchObject({ amount: 6.42, interval: 'month' });
  });

  test('availability: deployable in any zone is in stock, short everywhere is out', () => {
    expect(scalewayStock(['shortage', 'available'])).toBe('in_stock');
    expect(scalewayStock(['scarce'])).toBe('in_stock');
    expect(scalewayStock(['shortage', 'shortage'])).toBe('out_of_stock');
    expect(scalewayStock([null])).toBe('unknown');
    const availability = new Map([
      ['fr-par-1', { 'L4-1-24G': 'shortage' }],
      ['fr-par-2', { 'L4-1-24G': 'shortage' }],
    ]);
    const [item] = mergeScaleway(
      [
        ['fr-par-1', { 'L4-1-24G': L4 }],
        ['fr-par-2', { 'L4-1-24G': L4 }],
      ],
      { availability },
    );
    expect(item.data.offer.stock).toBe('out_of_stock');
    expect(item.data.availability).toEqual({ 'fr-par-1': 'shortage', 'fr-par-2': 'shortage' });
  });
});

describe('Vultr stock', () => {
  const plan = {
    id: 'vcg-l40s-16c-180g-48vram',
    vcpu_count: 16,
    ram: 184320,
    disk: 1200,
    bandwidth: 10240,
    monthly_cost: 1122.91,
    hourly_cost: 1.671,
    type: 'vcg',
    locations: [],
    gpu_brand: 'NVIDIA',
    gpu_type: 'L40S',
    gpu_count: 1,
    gpu_vram_gb: 48,
    deploy_ondemand: true,
  };

  test('availability decides when it was read; no locations is out of stock otherwise', () => {
    expect(vultrStock(plan, undefined)).toBe('out_of_stock');
    expect(vultrStock({ ...plan, locations: ['ewr'] }, undefined)).toBe('unknown');
    expect(vultrStock({ ...plan, locations: ['ewr'] }, ['ewr'])).toBe('in_stock');
    expect(vultrStock({ ...plan, locations: ['ewr'] }, [])).toBe('out_of_stock');
    expect(vultrStock({ ...plan, deploy_ondemand: false }, ['ewr'])).toBe('out_of_stock');
  });

  test('the regions that can deploy a plan now ride on the row', () => {
    const item = vultrItem({ ...plan, locations: ['ewr', 'ord'] }, { available: ['ewr'] });
    expect(item.data.offer.stock).toBe('in_stock');
    expect(item.data.availableIn).toEqual(['ewr']);
  });
});

describe('Linode stock', () => {
  test('availability rows fold into deployable regions per plan', () => {
    const by = availabilityByPlan([
      { region: 'us-east', plan: 'g6-nanode-1', available: true },
      { region: 'us-west', plan: 'g6-nanode-1', available: false },
      { region: 'us-east', plan: 'g2-gpu-rtx4000a1-s', available: false },
    ]);
    expect(by.get('g6-nanode-1')).toEqual(['us-east']);
    expect(by.get('g2-gpu-rtx4000a1-s')).toEqual([]);
    expect(by.has('g1-gpu-rtx6000-1')).toBe(false);
  });

  test('a type no region can take is out of stock; one never mentioned is unknown', () => {
    const t = {
      id: 'g2-gpu-rtx4000a1-s',
      vcpus: 4,
      memory: 16384,
      gpus: 1,
      price: { hourly: 0.52, monthly: null },
    };
    expect(linodeItem(t, { available: [] }).data.offer.stock).toBe('out_of_stock');
    expect(linodeItem(t).data.offer.stock).toBe('unknown');
    const ok = linodeItem(t, { available: ['us-east'], countryOf: () => 'US' });
    expect(ok.data.offer.stock).toBe('in_stock');
    expect(ok.data.offer.location).toEqual({ regions: ['us-east'], countries: ['US'] });
  });
});

describe('retiring offers a complete pull no longer lists', () => {
  test('retireOffer marks the offer discontinued once, and stockFrom reads availability', () => {
    const item = vultrItem({
      id: 'vcg-a16-2c-8g-2vram',
      vcpu_count: 2,
      ram: 8192,
      monthly_cost: 43,
      locations: ['ewr'],
    });
    const gone = retireOffer(item);
    expect(gone.data.offer.stock).toBe('discontinued');
    expect(gone.data.discontinued).toBe(true);
    expect(gone.tags).toContain('discontinued');
    expect(gone.data.offer.price.amount).toBe(43);
    expect(retireOffer(gone)).toBeNull();
    expect(stockFrom(null)).toBe('unknown');
    expect(stockFrom([])).toBe('out_of_stock');
    expect(stockFrom(['ewr'])).toBe('in_stock');
  });

  const stored = (p) => {
    const it = normaliseItem(vultrItem(p));
    return {
      external_id: it.externalId,
      kind: it.kind,
      title: it.title,
      summary: it.summary,
      url: it.url,
      image_url: null,
      published_at: null,
      time_known: false,
      precision: 'day',
      tags: it.tags,
      data: JSON.stringify(it.data),
    };
  };
  const a16 = { id: 'vcg-a16-2c-8g-2vram', vcpu_count: 2, ram: 8192, monthly_cost: 43 };
  const live = (n) =>
    Array.from({ length: n }, (_, i) => vultrItem({ id: `vc2-${i}`, vcpu_count: 1, ram: 1024 }));
  const adapter = { retire: retireOffer };
  const source = { id: 7, collection_id: 3 };

  test('rows missing from the pull are rewritten as discontinued, nothing deleted', async () => {
    const writes = [];
    let askedKeep = null;
    const query = {
      sourceItemsExcept: async ({ sourceId, keep }) => {
        expect(sourceId).toBe(7);
        askedKeep = keep;
        return [stored(a16)];
      },
      upsertItems: async (args) => {
        writes.push(args);
        return { added: 0, updated: args.items.length };
      },
    };
    const n = await retireMissing({ source, adapter, items: live(3), query });
    expect(n).toBe(1);
    expect(askedKeep).toEqual(['vultr:plan:vc2-0', 'vultr:plan:vc2-1', 'vultr:plan:vc2-2']);
    expect(writes).toHaveLength(1);
    expect(writes[0].collectionId).toBe(3);
    const [row] = writes[0].items;
    expect(row.externalId).toBe('vultr:plan:vcg-a16-2c-8g-2vram');
    expect(row.data.offer.stock).toBe('discontinued');
    expect(row.contentHash).toBeString();
  });

  test('a pull smaller than what would be retired retires nothing', async () => {
    const query = {
      sourceItemsExcept: async () => [stored(a16), stored({ ...a16, id: 'vcg-a40-1c' })],
      upsertItems: async () => {
        throw new Error('must not write');
      },
    };
    expect(await retireMissing({ source, adapter, items: live(1), query })).toBe(0);
  });

  test('already-discontinued rows are not written again', async () => {
    const gone = stored(a16);
    gone.data = JSON.stringify(retireOffer(vultrItem(a16)).data);
    const query = {
      sourceItemsExcept: async () => [gone],
      upsertItems: async () => {
        throw new Error('must not write');
      },
    };
    expect(await retireMissing({ source, adapter, items: live(3), query })).toBe(0);
  });
});
