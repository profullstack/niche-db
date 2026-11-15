import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { toItem as cherryItem } from '../packages/adapters/src/cherry.js';
import {
  datacrunchItems,
  foldVast,
  runpodItems,
  tensordockItems,
  thunderItems,
} from '../packages/adapters/src/gpu-clouds.js';
import { parse as parseHetzner } from '../packages/adapters/src/hetzner-dedicated.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  availabilityByPlan,
  dcCountry,
  gpuOf,
  parseCatalog as parseOvh,
} from '../packages/adapters/src/ovh-dedicated.js';
import { cleanName, diffHosts } from '../packages/adapters/src/storefront.js';
import {
  discover,
  hostList,
  mergeDiscovered,
  providerDomain,
  providersInFeed,
} from '../packages/adapters/src/storefront-discovery.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await fixture(name));

const valid = (items) => {
  for (const i of items) {
    const n = normaliseItem(i);
    expect(n.externalId).toBeTruthy();
    expect(i.data.offer.price.amount).toBeGreaterThan(0);
    expect(['USD', 'EUR']).toContain(i.data.offer.price.currency);
  }
  expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);
};

describe('hetzner-dedicated', () => {
  test('line-up models and auction machines, priced monthly in EUR, GPUs named', async () => {
    const items = parseHetzner(
      await json('hetzner-dedicated-lineup.json'),
      await json('hetzner-auction.json'),
    );
    valid(items);
    expect(items.length).toBe(6);
    const ax = items.find((i) => i.externalId === 'hetzner:plan:dedicated:ax42');
    expect(ax.data.offer.price).toMatchObject({ amount: 99, currency: 'EUR', interval: 'month' });
    expect(ax.data.offer.compute.ram_mb).toBe(64 * 1024);
    expect(ax.data.offer.storage).toEqual([
      { type: 'nvme', size_gb: 512 },
      { type: 'nvme', size_gb: 512 },
    ]);
    const gex = items.find((i) => /gex/.test(i.externalId));
    expect(gex.data.offer.kind).toBe('gpu');
    expect(gex.data.offer.compute.gpu.model).toMatch(/NVIDIA RTX PRO/);
    expect(gex.data.offer.compute.gpu.model).not.toMatch(/™/);
    const auc = items.filter((i) => i.tags.includes('hetzner-auction'));
    expect(auc.length).toBe(3);
    expect(auc.every((i) => i.data.offer.stock === 'in_stock')).toBe(true);
    expect(auc.some((i) => i.data.offer.kind === 'gpu')).toBe(true);
    expect(auc[0].data.offer.location.countries.length).toBe(1);
  });
});

describe('ovh-dedicated', () => {
  test('plan plus default mandatory add-ons is the price; Kimsufi and So you Start keep their brand', async () => {
    const eco = await json('ovh-eco-us.json');
    const items = parseOvh(eco);
    valid(items);
    const providers = new Set(items.map((i) => i.data.provider));
    expect(providers.has('kimsufi')).toBe(true);
    expect(providers.has('soyoustart')).toBe(true);
    for (const i of items) {
      expect(i.data.offer.price.amount).toBeGreaterThanOrEqual(i.data.chassisMonthly);
      expect(i.data.offer.compute.ram_mb).toBeGreaterThan(0);
      expect(i.data.offer.storage.length).toBeGreaterThan(0);
      expect(i.data.offer.price.commitment).toBe(0);
    }
  });

  test('stock comes from the datacentre availabilities', async () => {
    const eco = await json('ovh-eco-us.json');
    const plan = eco.plans[0].planCode;
    const avail = availabilityByPlan([
      { planCode: plan, datacenters: [{ datacenter: 'bhs', availability: 'unavailable' }] },
    ]);
    const item = parseOvh(eco, avail).find((i) => i.data.planCode === plan);
    expect(item.data.offer.stock).toBe('out_of_stock');
    const item2 = parseOvh(
      eco,
      availabilityByPlan([
        { planCode: plan, datacenters: [{ datacenter: 'bhs', availability: '72H' }] },
      ]),
    ).find((i) => i.data.planCode === plan);
    expect(item2.data.offer.stock).toBe('in_stock');
    expect(item2.data.deliverableIn).toEqual(['bhs']);
  });

  test('a plan code listed twice is one row; GPU add-ons and datacentres read', async () => {
    const eco = await json('ovh-eco-us.json');
    const seen = new Set();
    const a = parseOvh(eco, null, seen);
    const b = parseOvh(eco, null, seen);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(0);
    expect(gpuOf('2x NVIDIA L40S 48GB')).toEqual({ model: 'NVIDIA L40S', count: 2, vramMb: 49152 });
    expect(dcCountry('vin')).toBe('US');
    expect(dcCountry('eu-west-par-a')).toBe('FR');
    expect(parseOvh(await json('ovh-baremetal-us.json')).length).toBeGreaterThan(0);
  });
});

describe('cherry-plans', () => {
  test('monthly EUR price, stock per region', async () => {
    const plans = await json('cherry-plans.json');
    const items = plans.map(cherryItem).filter(Boolean);
    valid(items);
    expect(items[0].data.offer).toMatchObject({ kind: 'dedicated', tenancy: 'dedicated' });
    expect(items[0].data.offer.price).toMatchObject({
      amount: 49,
      currency: 'EUR',
      interval: 'month',
    });
    const empty = items.find((i) => Object.values(i.data.stockByRegion).every((n) => n === 0));
    expect(empty.data.offer.stock).toBe('out_of_stock');
  });
});

describe('GPU sellers', () => {
  test('Vast folds offers to GPU x count x country, cheapest first', async () => {
    const { offers } = await json('vast-offers.json');
    const items = foldVast(offers);
    valid(items);
    for (const i of items) {
      expect(i.data.offer.kind).toBe('gpu');
      expect(i.data.offer.price.interval).toBe('hour');
      expect(i.data.offersAtLeast).toBeGreaterThan(0);
    }
    const twice = foldVast([...offers, ...offers]);
    expect(twice.length).toBe(items.length);
  });

  test('RunPod, DataCrunch, Thunder, TensorDock', async () => {
    const rp = runpodItems((await json('runpod-gputypes.json')).data.gpuTypes);
    valid(rp);
    expect(rp.every((i) => i.data.offer.kind === 'gpu')).toBe(true);
    const dc = datacrunchItems(await json('datacrunch-instance-types.json'));
    valid(dc);
    // CPU-only instance types are cloud, and left out.
    expect(dc.length).toBe(2);
    const th = thunderItems(
      (await json('thunder-pricing.json')).pricing,
      (await json('thunder-specs.json')).specs,
    );
    valid(th);
    expect(th.find((i) => i.data.offer.id === 'h100_x1').data.offer.price.amount).toBeGreaterThan(
      0,
    );
    const td = tensordockItems(await fixture('tensordock-cloud-gpus.html'));
    valid(td);
    expect(td.length).toBeGreaterThanOrEqual(3);
    expect(td.every((i) => i.data.offer.stock !== 'unknown')).toBe(true);
  });
});

describe('storefront names', () => {
  test('stock words leave the name and go to stock', () => {
    expect(cleanName('Virtual-3 0 Available')).toEqual({
      name: 'Virtual-3',
      stock: 'out_of_stock',
      quantity: 0,
    });
    expect(cleanName('KVM-1 (3 Available)')).toMatchObject({ name: 'KVM-1', stock: 'in_stock' });
    expect(cleanName('Ryzen 9 - Out of Stock')).toMatchObject({
      name: 'Ryzen 9',
      stock: 'out_of_stock',
    });
    expect(cleanName('Plain VPS')).toEqual({ name: 'Plain VPS', stock: null, quantity: null });
  });
});

const plan = (domain, id, group = 'vps') => ({
  externalId: `storefront:whmcs:${domain}:${id}`,
  tags: ['plan'],
  data: {
    domain,
    platform: 'whmcs',
    group,
    provider: domain,
    providerName: domain,
    offer: { id, name: id, stock: 'unknown', price: { amount: 5, currency: 'USD' } },
  },
});

describe('storefront new offerings', () => {
  test('first read: nothing is new; second read: the new id and new group are flagged, the gone id retired', async () => {
    const known = {};
    const first = await diffHosts([{ items: [plan('a.com', 'pid-1'), plan('a.com', 'pid-2')] }], {
      known,
      previous: async () => new Map(),
      now: '2026-11-15T00:00:00.000Z',
    });
    expect(first.newOfferings).toBe(0);
    expect(first.items.every((i) => !i.tags.includes('new-offering'))).toBe(true);
    expect(known['a.com'].ids).toEqual(['pid-1', 'pid-2']);

    const stored = new Map([
      [
        'storefront:whmcs:a.com:pid-1',
        { ...plan('a.com', 'pid-1').data, firstSeenAt: '2026-11-15T00:00:00.000Z' },
      ],
      [
        'storefront:whmcs:a.com:pid-2',
        { ...plan('a.com', 'pid-2').data, firstSeenAt: '2026-11-15T00:00:00.000Z' },
      ],
    ]);
    const second = await diffHosts(
      [{ items: [plan('a.com', 'pid-1'), plan('a.com', 'pid-3', 'gpu')] }],
      { known, previous: async () => stored, now: '2026-11-16T00:00:00.000Z' },
    );
    expect(second.newOfferings).toBe(1);
    expect(second.newGroups).toBe(1);
    expect(second.retired).toBe(1);
    const fresh = second.items.find((i) => i.externalId.endsWith('pid-3'));
    expect(fresh.tags).toContain('new-offering');
    expect(fresh.tags).toContain('new-group');
    expect(fresh.data.newOffering.detectedAt).toBe('2026-11-16T00:00:00.000Z');
    const kept = second.items.find((i) => i.externalId.endsWith('pid-1'));
    expect(kept.data.firstSeenAt).toBe('2026-11-15T00:00:00.000Z');
    expect(kept.tags).not.toContain('new-offering');
    const gone = second.items.find((i) => i.externalId.endsWith('pid-2'));
    expect(gone.data.offer.stock).toBe('discontinued');
    expect(gone.tags).toContain('discontinued');
  });
});

describe('forum discovery', () => {
  test('LowEndSpirit posts give one host each, never a forum or a social link', async () => {
    const found = providersInFeed(await fixture('les-offers-p1.xml'));
    const hosts = found.filter((f) => f.domain);
    expect(hosts.length).toBeGreaterThan(3);
    for (const h of hosts) {
      expect(h.domain).not.toMatch(/lowendspirit|lowendtalk|github|twitter|discord/);
      expect(h.start).toMatch(/^https:\/\//);
      expect(h.publishedAt).toMatch(/^\d{4}-/);
    }
    expect(providerDomain('https://my.servitro.com/cart.php')).toBe('servitro.com');
    expect(providerDomain('https://billing.example.co.uk/store/x')).toBe('example.co.uk');
    expect(providerDomain('https://t.me/somehost')).toBeNull();
    expect(providerDomain('https://lowendtalk.com/discussion/1')).toBeNull();
  });

  test('LowEndBox posts count only when they link an order page', async () => {
    const found = providersInFeed(await fixture('lowendbox.xml'), { needsOrderLink: true });
    for (const f of found.filter((x) => x.domain)) expect(f.start).toBeTruthy();
  });

  test('one host per registrable domain, across the survey, the seeds and discovery', () => {
    const { list } = mergeDiscovered(
      [{ domain: 'servitro.com', start: 'https://my.servitro.com/' }],
      [
        { domain: 'servitro.com', start: 'https://servitro.com/' },
        { domain: 'new.host', start: 'https://new.host/' },
      ],
      'les',
    );
    expect(list.map((h) => h.domain)).toEqual(['servitro.com', 'new.host']);
    const hosts = hostList(['https://www.servitro.com/'], list, ['https://billing.new.host/']);
    expect(hosts).toEqual(['https://www.servitro.com/', 'https://billing.new.host/']);
  });

  test('a second pass reads one page per feed and finds 0 new threads', async () => {
    const xml = await fixture('les-offers-p1.xml');
    const pages = [];
    const http = {
      request: async (url) => {
        pages.push(url);
        const p = Number(url.match(/\/p(\d+)\//)?.[1] ?? 1);
        return p <= 2 ? new Response(xml) : new Response('', { status: 404 });
      },
    };
    const sleep = async () => {};
    const first = await discover({ http, feeds: ['les'], sleep, maxRequests: 10 });
    expect(first.fresh.les).toBeGreaterThan(0);
    expect(first.marks.les).toMatch(/^\d{4}-/);
    expect(first.done.les).toBe(true);
    pages.length = 0;
    const second = await discover({ http, state: first, feeds: ['les'], sleep, maxRequests: 10 });
    expect(second.fresh.les).toBe(0);
    expect(second.added).toBe(0);
    expect(pages.length).toBe(1);
  });
});

describe('registered', () => {
  test('the new hosting adapters are in the collection', () => {
    for (const n of [
      'hetzner-dedicated',
      'ovh-dedicated',
      'cherry-plans',
      'vast-offers',
      'runpod-gpus',
      'datacrunch-instances',
      'thunder-gpus',
      'tensordock-gpus',
    ]) {
      const a = adapterByName(n);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('hosting');
      expect(typeof a.retire).toBe('function');
    }
    expect(ADAPTERS.filter((a) => a.collection === 'hosting')).toHaveLength(20);
  });
});
