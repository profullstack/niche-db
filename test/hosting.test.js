import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ATTRIBUTION, findhost, parseProviders } from '../packages/adapters/src/findhost.js';
import { OFFER_KINDS, offer, ovhCountry, priceBucket } from '../packages/adapters/src/hosting.js';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import { toItem as linodeItem, linodeTypes } from '../packages/adapters/src/linode.js';
import {
  kindOf,
  lowendbox,
  parseFeed as parseLowEndBox,
} from '../packages/adapters/src/lowendbox.js';
import {
  descriptorUrl,
  openserver,
  parseAliases,
  parseDescriptor,
  servedByProvider,
} from '../packages/adapters/src/openserver.js';
import { monthlyPrice, ovhVps, parseCatalog } from '../packages/adapters/src/ovh.js';
import { merge as mergeScaleway, scalewayInstances } from '../packages/adapters/src/scaleway.js';
import { toItem as vultrItem, vultrPlans } from '../packages/adapters/src/vultr.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { matchCompany } from '../packages/enrichers/src/company-ticker.js';
import { defaultEnrichers } from '../packages/enrichers/src/index.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');
const json = async (name) => JSON.parse(await fixture(name));

/** The fields an OpenServer offer always carries, so a reader can rely on them. */
const OFFER_FIELDS = [
  'id',
  'name',
  'url',
  'kind',
  'premises',
  'management',
  'tenancy',
  'model',
  'location',
  'compute',
  'storage',
  'network',
  'price',
  'stock',
  'updated',
];

describe('the FindHost register as provider rows', () => {
  test('every provider is a row carrying the credit, its facets as tags, and its id as the provider slug', async () => {
    const items = parseProviders(await json('findhost-providers.json'));
    expect(items.map((i) => i.externalId)).toEqual([
      'findhost:1984-hosting',
      'findhost:fortrabbit',
      'findhost:hetzner',
    ]);
    const h = items[2];
    expect(h.kind).toBe('provider');
    expect(h.title).toBe('Hetzner');
    expect(h.url).toBe('https://www.findhost.app/hetzner/');
    expect(h.data.provider).toBe('hetzner');
    expect(h.data.attribution).toBe(ATTRIBUTION);
    expect(h.data.licence).toBe('CC BY 4.0');
    expect(h.tags).toContain('provider');
    expect(h.tags).toContain('country:de');
    expect(h.tags).toContain('ownership:independent');
    expect(h.precision).toBe('day');
    expect(h.publishedAt).toBeTruthy();
    // The register's rule: absent means unknown, so a facet not recorded is not a tag.
    const green = items.filter((i) => i.tags.includes('green'));
    expect(green.map((i) => i.data.findhostId)).toContain('1984-hosting');
  });

  test('a bare list still parses, and the attribution is the register’s when meta has it', async () => {
    const doc = await json('findhost-providers.json');
    expect(parseProviders(doc.providers)).toHaveLength(3);
    expect(doc.meta.attribution).toBe(ATTRIBUTION);
    expect(parseProviders(doc)[0].data.licenceUrl).toBe(doc.meta.license);
  });

  test('declared daily, keyless, in the hosting collection, and the source carries the credit', () => {
    expect(findhost.collection).toBe('hosting');
    expect(findhost.cadenceMinutes).toBe(1440);
    expect(findhost.description).toContain('FindHost, findhost.app, CC BY 4.0');
    expect(findhost.defaultSources[0].description).toContain('CC BY 4.0');
  });
});

describe('plans as OpenServer offers', () => {
  test('a Vultr plan is an offer with every field, USD a month, and the FindHost id as provider', async () => {
    const { plans } = await json('vultr-plans.json');
    const item = vultrItem(plans[1]);
    expect(item.externalId).toBe('vultr:plan:vc2-1c-0.5gb-v6');
    expect(item.kind).toBe('plan');
    expect(item.data.provider).toBe('vultr');
    expect(Object.keys(item.data.offer)).toEqual(OFFER_FIELDS);
    const o = item.data.offer;
    expect(o.kind).toBe('vps');
    expect(o.premises).toBe('off-prem');
    expect(o.management).toBe('unmanaged');
    expect(o.tenancy).toBe('shared');
    expect(o.model).toBe('centralized');
    expect(o.compute.vcpu).toBe(1);
    expect(o.compute.ram_mb).toBe(512);
    expect(o.storage).toEqual([{ type: 'ssd', size_gb: 10 }]);
    expect(o.network.transfer_gb).toBe(512);
    expect(o.price).toEqual({
      amount: 2.5,
      currency: 'USD',
      interval: 'month',
      setup: null,
      commitment: null,
    });
    expect(o.location.countries).toContain('US');
    expect(item.data.priceHourly).toBe(0.003);
    expect(item.tags).toContain('price:under-5');
    expect(item.tags).toContain('provider:vultr');
    expect(item.tags).toContain('kind:vps');
    expect(item.tags).toContain('currency:usd');
    expect(item.summary).toContain('1 vCPU, 512 MB RAM, 10 GB ssd');
    // A free plan is a free plan, not a missing price.
    expect(vultrItem(plans[0]).tags).toContain('price:free');
  });

  test('a Vultr bare metal plan is dedicated tenancy, bare-metal kind, threads as vcpu', async () => {
    const { plans_metal } = await json('vultr-plans-metal.json');
    const item = vultrItem(plans_metal[0], { metal: true });
    expect(item.externalId).toBe('vultr:plan:vbm-4c-32gb');
    expect(item.data.offer.kind).toBe('bare-metal');
    expect(item.data.offer.tenancy).toBe('dedicated');
    expect(item.data.offer.compute.vcpu).toBe(8);
    expect(item.data.offer.compute.cores).toBe(4);
    expect(item.data.offer.storage).toHaveLength(2);
    expect(item.tags).toContain('kind:bare-metal');
  });

  test('a Linode type converts MB disk to GB and keeps region premiums apart from availability', async () => {
    const { data } = await json('linode-types.json');
    const nanode = linodeItem(data[0]);
    expect(nanode.externalId).toBe('linode:plan:g6-nanode-1');
    expect(nanode.data.provider).toBe('linode');
    expect(nanode.data.offer.storage[0].size_gb).toBe(25);
    expect(nanode.data.offer.location.regions).toEqual([]);
    expect(nanode.data.regionPrices.length).toBeGreaterThan(0);
    expect(nanode.data.offer.price.currency).toBe('USD');
    const gpu = linodeItem(data[2]);
    expect(gpu.data.offer.kind).toBe('gpu');
    // Billed by the hour only: the price says hour, and no monthly bucket is claimed.
    expect(gpu.data.offer.price.interval).toBe('hour');
    expect(gpu.data.offer.price.amount).toBe(1.5);
    expect(gpu.tags.some((t) => t.startsWith('price:'))).toBe(false);
    expect(gpu.tags).toContain('gpu');
    expect(gpu.tags).toContain('class:gpu');
  });

  test('a Scaleway offer sold in three zones is one row carrying the zones and their countries, EUR', async () => {
    const { servers } = await json('scaleway-servers.json');
    const items = mergeScaleway([
      ['fr-par-1', servers],
      ['nl-ams-1', { 'DEV1-S': servers['DEV1-S'] }],
      ['pl-waw-2', { 'DEV1-S': servers['DEV1-S'] }],
    ]);
    const dev = items.find((i) => i.externalId === 'scaleway:plan:DEV1-S');
    expect(dev.data.provider).toBe('scaleway');
    expect(dev.data.offer.location.regions).toEqual(['fr-par-1', 'nl-ams-1', 'pl-waw-2']);
    expect(dev.data.offer.location.countries).toEqual(['FR', 'NL', 'PL']);
    expect(dev.data.offer.price.currency).toBe('EUR');
    expect(dev.data.offer.compute.ram_mb).toBe(2048);
    expect(dev.data.offer.storage).toEqual([]);
    expect(dev.tags).toContain('region:nl-ams-1');
    expect(items.filter((i) => i.externalId === 'scaleway:plan:DEV1-S')).toHaveLength(1);
    const arm = items.find((i) => i.externalId === 'scaleway:plan:BASIC2-A12C-24G');
    expect(arm.data.offer.compute.arch).toBe('arm64');
    expect(arm.tags).toContain('arch:arm64');
  });

  test('the OVH catalogue keeps servers and drops options and commitment variants', async () => {
    const catalog = await json('ovh-vps.json');
    const items = parseCatalog(catalog);
    expect(items.map((i) => i.externalId).sort()).toEqual([
      'ovh:plan:US:vps-2025-model1',
      'ovh:plan:US:vps-starter-1-2-20',
    ]);
    const m1 = items.find((i) => i.externalId === 'ovh:plan:US:vps-2025-model1');
    expect(m1.data.provider).toBe('ovh');
    // The product sentence wins over the digits in the plan code.
    expect(m1.data.offer.compute.vcpu).toBe(4);
    expect(m1.data.offer.compute.ram_mb).toBe(8192);
    expect(m1.data.offer.storage).toEqual([{ type: 'ssd', size_gb: 75 }]);
    // Month-to-month is the price; the 12- and 24-month rates sit beside it.
    expect(m1.data.offer.price.amount).toBe(7.6);
    expect(m1.data.offer.price.commitment).toBe(0);
    expect(m1.data.commitmentPrices.map((p) => p.commitment)).toEqual([12, 6, 0]);
    expect(m1.data.commitmentPrices[0].amount).toBe(6.46);
    expect(m1.data.offer.price.currency).toBe('USD');
    expect(m1.data.offer.location.countries).toEqual(['US']);
    expect(m1.tags).toContain('subsidiary:us');
    const starter = items.find((i) => i.externalId === 'ovh:plan:US:vps-starter-1-2-20');
    expect(starter.tags).toContain('price:under-5');
    const storage = catalog.plans.find((p) => p.planCode === 'option-storage-remote-2027-ca');
    expect(monthlyPrice(storage)).toBeNull();
  });

  test('OVH datacentres map to countries, and unknown codes to nothing', () => {
    expect(ovhCountry('US-EAST-VA')).toBe('US');
    expect(ovhCountry('EU-WEST-LZ-AMS')).toBe('NL');
    expect(ovhCountry('GRA')).toBe('FR');
    expect(ovhCountry('BHS')).toBe('CA');
    expect(ovhCountry('XYZ')).toBeNull();
  });

  test('every plan item survives normalisation with a null date and the offer intact', async () => {
    const { plans } = await json('vultr-plans.json');
    const n = normaliseItem(vultrItem(plans[1]));
    expect(n.publishedAt).toBeNull();
    expect(n.timeKnown).toBe(false);
    expect(n.precision).toBe('day');
    expect(n.data.offer.id).toBe('vc2-1c-0.5gb-v6');
    expect(n.contentHash).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the price buckets and the offer builder’s defaults', () => {
    expect(priceBucket(0)).toBe('price:free');
    expect(priceBucket(4.99)).toBe('price:under-5');
    expect(priceBucket(5)).toBe('price:5-10');
    expect(priceBucket(250)).toBe('price:over-100');
    expect(priceBucket('n/a')).toBeNull();
    const o = offer({ id: 'x', url: 'https://x' });
    expect(Object.keys(o)).toEqual(OFFER_FIELDS);
    expect(OFFER_KINDS).toContain(o.kind);
    expect(o.compute.gpu).toBeNull();
    expect(o.price.amount).toBeNull();
  });
});

describe('LowEndBox posts', () => {
  test('offers are deals and the desk’s own writing is a story, by category', async () => {
    const items = parseLowEndBox(await fixture('lowendbox.xml'), 'https://lowendbox.com/feed/');
    expect(items).toHaveLength(3);
    const deal = items.find((i) => /Servitro/.test(i.title));
    expect(deal.kind).toBe('deal');
    expect(deal.externalId).toMatch(/^lowendbox:https:\/\/lowendbox\.com\/\?p=\d+$/);
    expect(deal.tags).toContain('low-end-virtual');
    expect(deal.data.author).toBeTruthy();
    expect(deal.publishedAt).toBeTruthy();
    const story = items.find((i) => /SolusVM/.test(i.title));
    expect(story.kind).toBe('story');
    expect(story.summary).not.toMatch(/appeared first on/);
    expect(kindOf(['Special Offers', 'backup'])).toBe('deal');
    expect(kindOf(['Giveaways'])).toBe('story');
  });

  test('daily, in the hosting collection, with the front-page feed by default', () => {
    expect(lowendbox.cadenceMinutes).toBe(1440);
    expect(lowendbox.defaultSources[0].config.feeds).toEqual(['https://lowendbox.com/feed/']);
  });
});

describe('OpenServer descriptors', () => {
  const URL_ = 'https://www.example-host.com/.well-known/openserver.json';

  test('a bare origin is read at the well-known path; a full URL as given', () => {
    expect(descriptorUrl('example-host.com')).toBe(
      'https://example-host.com/.well-known/openserver.json',
    );
    expect(descriptorUrl('https://www.example-host.com/')).toBe(URL_);
    expect(descriptorUrl('https://cdn.example-host.com/x/openserver.json')).toBe(
      'https://cdn.example-host.com/x/openserver.json',
    );
    expect(descriptorUrl('not a url')).toBeNull();
  });

  test('a descriptor served from the provider’s own origin yields the provider and every offer, in its words', async () => {
    const doc = await json('openserver-descriptor.json');
    const { items, rejected } = parseDescriptor(doc, URL_);
    expect(rejected).toBeNull();
    expect(items.map((i) => i.externalId)).toEqual([
      'openserver:provider:example-host.com',
      'openserver:offer:example-host.com:vps-s',
      'openserver:offer:example-host.com:metal-ax41',
    ]);
    const provider = items[0];
    expect(provider.kind).toBe('provider');
    expect(provider.data.provider).toBe('example-host');
    expect(provider.data.operator).toBe('Example Host GmbH');
    expect(provider.data.attribution).toContain('Example Host (example-host.com)');
    expect(provider.tags).toContain('country:de');
    expect(provider.publishedAt).toBeTruthy();
    const vps = items[1];
    expect(vps.kind).toBe('plan');
    expect(vps.data.offer).toEqual(doc.offers[0]);
    expect(vps.tags).toContain('provider:example-host');
    expect(vps.tags).toContain('price:under-5');
    expect(vps.tags).toContain('stock:in_stock');
    expect(vps.tags).toContain('region:fsn1');
    expect(vps.summary).toContain('2 vCPU, 4 GB RAM, 40 GB nvme');
    const metal = items[2];
    expect(metal.tags).toContain('kind:bare-metal');
    expect(metal.tags).toContain('stock:out_of_stock');
  });

  test('a descriptor hosted on someone else’s origin is rejected', async () => {
    const doc = await json('openserver-descriptor.json');
    expect(servedByProvider('https://evil.example/openserver.json', doc)).toBe(false);
    expect(parseDescriptor(doc, 'https://evil.example/openserver.json')).toEqual({
      items: [],
      rejected: 'origin',
    });
    expect(servedByProvider('https://api.example-host.com/openserver.json', doc)).toBe(true);
  });

  test('a host alias maps the descriptor onto the register’s provider id', async () => {
    const doc = await json('openserver-descriptor.json');
    const aliases = parseAliases(['www.example-host.com=examplehost', 'x=y']);
    expect(aliases).toEqual({ 'example-host.com': 'examplehost', x: 'y' });
    const { items } = parseDescriptor(doc, URL_, aliases);
    expect(items[0].data.provider).toBe('examplehost');
    expect(items[1].tags).toContain('provider:examplehost');
  });

  test('seeded paused with no descriptors, daily, in the hosting collection', () => {
    expect(openserver.collection).toBe('hosting');
    expect(openserver.cadenceMinutes).toBe(1440);
    expect(openserver.defaultSources[0].enabled).toBe(false);
    expect(openserver.defaultSources[0].config.urls).toEqual([]);
  });
});

describe('the listed-company enrichment', () => {
  const rows = [
    { cik_str: 1, ticker: 'DOCN', title: 'DigitalOcean Holdings, Inc.' },
    { cik_str: 2, ticker: 'DLR', title: 'DIGITAL REALTY TRUST, INC.' },
    { cik_str: 2, ticker: 'DLR-PK', title: 'DIGITAL REALTY TRUST, INC.' },
    { cik_str: 3, ticker: 'WIX', title: 'Wix.com Ltd.' },
    { cik_str: 4, ticker: 'GDDY', title: 'GoDaddy Inc.' },
  ];
  test('matches a provider to the registrant whose title begins with its whole name', () => {
    expect(matchCompany('DigitalOcean', rows)?.ticker).toBe('DOCN');
    expect(matchCompany('GoDaddy', rows)?.ticker).toBe('GDDY');
    expect(matchCompany('Digital Realty', rows)?.ticker).toBe('DLR');
    expect(matchCompany('Wix', rows)).toBeNull(); // too short to trust
    expect(matchCompany('Wixel', rows)).toBeNull();
    expect(matchCompany('Digital', rows)).toBeNull();
    expect(matchCompany('Hetzner', rows)).toBeNull();
  });
  test('hosting turns on wikipedia, opengraph, the ticker lookup and the developer tools by default', () => {
    expect(defaultEnrichers('hosting').sort()).toEqual([
      'company-ticker',
      'developer',
      'opengraph',
      'wikipedia',
    ]);
  });
});

describe('the hosting collection is registered', () => {
  test('twelve adapters, all daily, all in the collection, with the seeded feeds', () => {
    const names = [
      'findhost',
      'buyvps',
      'vultr-plans',
      'linode-types',
      'scaleway-instances',
      'ovh-vps',
      'hetzner-plans',
      'digitalocean-sizes',
      'upcloud-plans',
      'storefront',
      'lowendbox',
      'openserver',
    ];
    for (const n of names) {
      const a = adapterByName(n);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('hosting');
      expect(a.cadenceMinutes).toBe(1440);
    }
    expect(ADAPTERS.filter((a) => a.collection === 'hosting')).toHaveLength(12);
    // The keyed three are seeded paused until their credential exists.
    expect(adapterByName('hetzner-plans').needsEnv).toEqual(['hetznerApiToken']);
    expect(adapterByName('digitalocean-sizes').needsEnv).toEqual(['digitaloceanToken']);
    expect(adapterByName('upcloud-plans').needsEnv).toEqual(['upcloudUsername', 'upcloudPassword']);
    expect(
      [vultrPlans, linodeTypes, scalewayInstances, ovhVps].every((a) => a.kinds[0] === 'plan'),
    ).toBe(true);
    const c = COLLECTIONS.find((c) => c.slug === 'hosting');
    expect(c.description).toContain('FindHost, findhost.app');
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'hosting').map((f) => f.slug);
    expect(feeds).toEqual([
      'hosting-providers',
      'hosting-cli',
      'vps-plans',
      'vps-under-5',
      'bare-metal-plans',
      'hosting-deals',
    ]);
  });
});
