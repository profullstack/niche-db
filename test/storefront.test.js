import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  findhostIdFor,
  productItem,
  providerNameOf,
  readHost,
  storefront,
  surveyedHosts,
} from '../packages/adapters/src/storefront.js';
import {
  blestaGroups,
  CYCLES,
  kindOf,
  normalisePrice,
  parseBlesta,
  parseCountries,
  parseCycle,
  parsePrice,
  parseSpecs,
  parseWhmcs,
  parseWoocommerce,
  whmcsGroups,
  woocommerceGroups,
} from '../packages/adapters/src/storefront-parsers.js';
import {
  fingerprint,
  guessedShopOrigins,
  isChallenge,
  isListing,
  PLATFORMS,
  registrableDomain,
  robotsAllows,
  shopLinks,
  shopOrigins,
} from '../packages/adapters/src/storefront-platforms.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = (name) =>
  readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8');

describe('fingerprinting a storefront platform', () => {
  test('WHMCS is known by its cart paths and templates, and a bare weak mark decides nothing', () => {
    expect(fingerprint('<a href="/cart.php?gid=1">Order</a>').platform).toBe('whmcs');
    expect(fingerprint('<link href="/templates/six/css/all.min.css">').platform).toBe('whmcs');
    expect(fingerprint('<a href="/store/vps">VPS</a>').platform).toBeNull();
    // Two weak marks never decide; a strong one with a weak one does.
    expect(
      fingerprint('<a href="/store/vps">VPS</a><a href="/submitticket.php">Help</a>').platform,
    ).toBeNull();
    expect(
      fingerprint('<a href="/store/vps">VPS</a><a href="/clientarea.php">Login</a>').platform,
    ).toBe('whmcs');
    expect(
      fingerprint('<html></html>', 'https://x.example/', ['WHMCSabc123=1; path=/']).platform,
    ).toBe('whmcs');
  });

  test('Blesta, HostBill, FOSSBilling and ClientExec each by their own path', () => {
    expect(fingerprint('<a href="/order/main/index/vps/">Order</a>').platform).toBe('blesta');
    expect(fingerprint('<script src="/hostbillapp.js"></script>').platform).toBe('hostbill');
    // Phalcon's `_url=/order` alone is a hint, not FOSSBilling; the product's own name is.
    expect(fingerprint('<a href="/index.php?_url=/order">Order</a>').platform).toBeNull();
    expect(
      fingerprint('<a href="/index.php?_url=/order">Order</a><p>Powered by FOSSBilling</p>')
        .platform,
    ).toBe('fossbilling');
    expect(fingerprint('<a href="/index.php?fuse=home">Home</a>').platform).toBe('clientexec');
    expect(fingerprint('<p>Plain marketing page</p>').platform).toBeNull();
  });

  test('a listing URL is recognised per platform', () => {
    expect(isListing('whmcs', 'https://my.host.example/cart.php?gid=3')).toBe(true);
    expect(isListing('whmcs', 'https://my.host.example/store/kvm-vps')).toBe(true);
    expect(isListing('whmcs', 'https://my.host.example/clientarea.php')).toBe(false);
    expect(isListing('blesta', 'https://host.example/order/main/index/vps')).toBe(true);
    expect(isListing('hostbill', 'https://host.example/cart/vps/')).toBe(true);
    expect(isListing('nothing', 'https://host.example/')).toBe(false);
    for (const p of Object.values(PLATFORMS)) expect(p.probes.length).toBeGreaterThan(0);
  });

  test('shop links stay on the same registrable domain and billing subdomains are guessed in order', () => {
    const html =
      '<a href="https://my.host.example/cart.php">Order</a><a href="/pricing/">Pricing</a><a href="https://other.example/cart.php">No</a><a href="/about/">About</a>';
    expect(shopLinks(html, 'https://www.host.example/')).toEqual([
      'https://my.host.example/cart.php',
      'https://www.host.example/pricing/',
    ]);
    expect(shopOrigins(html, 'https://www.host.example/')).toEqual([
      'https://www.host.example',
      'https://my.host.example',
    ]);
    expect(guessedShopOrigins('https://www.host.co.uk/')[0]).toBe('https://my.host.co.uk');
    expect(registrableDomain('billing.host.co.uk')).toBe('host.co.uk');
    expect(registrableDomain('www.host.example')).toBe('host.example');
  });

  test('a bot challenge is recognised and never mistaken for a site', () => {
    expect(isChallenge('<title>Just a moment...</title>', 403)).toBe(true);
    expect(isChallenge('<title>Just a moment...</title>', 200)).toBe(false);
    expect(isChallenge('<title>Shop</title>', 403)).toBe(false);
  });

  test('robots.txt: longest match wins, allow beats disallow on a tie, our token picks its own group', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /cart',
      'Allow: /cart.php',
      '',
      'User-agent: niche-db',
      'Disallow: /',
    ].join('\n');
    expect(robotsAllows(robots, '/cart.php', 'SomeBot/1.0')).toBe(true);
    expect(robotsAllows(robots, '/cart/', 'SomeBot/1.0')).toBe(false);
    expect(robotsAllows(robots, '/cart.php', 'niche-db/0.1 (+https://nichedb.dev)')).toBe(false);
    expect(robotsAllows('', '/anything')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /*.php$', '/cart.php')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.php$', '/cart.php?gid=1')).toBe(true);
  });
});

describe('reading prices, cycles and specs', () => {
  test('prices in the ways shops write them', () => {
    expect(parsePrice('$24.00 USD')).toEqual({ amount: 24, currency: 'USD' });
    expect(parsePrice('€3,49')).toEqual({ amount: 3.49, currency: 'EUR' });
    expect(parsePrice('1.234,56 EUR')).toEqual({ amount: 1234.56, currency: 'EUR' });
    expect(parsePrice('$1,234.56')).toEqual({ amount: 1234.56, currency: 'USD' });
    expect(parsePrice('Rs. 199')).toEqual({ amount: 199, currency: 'INR' });
    expect(parsePrice('Free')).toBeNull();
  });

  test('cycles to OpenServer intervals, dividing the quote to the nearest one', () => {
    expect(parseCycle('Annually')).toMatchObject({ interval: 'year', divisor: 1 });
    expect(parseCycle('Semi-Annually')).toMatchObject({ interval: 'month', divisor: 6 });
    expect(parseCycle('Starting from $2 /mo')).toMatchObject({ interval: 'month' });
    expect(parseCycle('One Time')).toMatchObject({ interval: 'once' });
    expect(parseCycle('whenever')).toBeNull();
    expect(normalisePrice({ amount: 30, currency: 'USD' }, CYCLES.quarterly)).toEqual({
      amount: 10,
      interval: 'month',
      billing: { amount: 30, cycle: null },
    });
    expect(normalisePrice({ amount: 24, currency: 'USD' }, parseCycle('Annually'))).toEqual({
      amount: 24,
      interval: 'year',
      billing: { amount: 24, cycle: 'annually' },
    });
    expect(normalisePrice(null, null).amount).toBeNull();
  });

  test('specs out of a description, and nothing where the host wrote nothing', () => {
    const s = parseSpecs(
      '2 vCores\n8 GB DDR4 RAM\n50 GB NVMe\n10Gbps Port\n2 TB Traffic\n1x IPv4\n1x IPv6 /64',
    );
    expect(s).toMatchObject({
      vcpu: 2,
      ramMb: 8192,
      disk: { size_gb: 50, type: 'nvme' },
      transferGb: 2048,
      bandwidthMbps: 10000,
      ipv4: 1,
      ipv6: true,
    });
    expect(
      parseSpecs(
        '✅ 256 MB RAM + 256 vSWAP ✅ 10 GB RAID10 Storage ✅ Unmetered Bandwidth ✅ 1 x vCPU Core',
      ),
    ).toMatchObject({
      vcpu: 1,
      ramMb: 256,
      disk: { size_gb: 10, type: null },
      transferGb: null,
      transfer: 'unmetered',
    });
    expect(parseSpecs('A lovely plan')).toMatchObject({ vcpu: null, ramMb: null, disk: null });
    expect(parseCountries('Frankfurt, Germany and Los Angeles')).toEqual(['DE', 'US']);
    expect(kindOf('epyc-dedicated-servers-frankfurt')).toBe('dedicated');
    expect(kindOf('linux-shared-hosting')).toBe('shared');
    expect(kindOf('kvm-vps', 'KVM-2')).toBe('vps');
    expect(kindOf('cpanel-fully-managed-vps')).toBe('vps');
  });
});

describe('the WHMCS parser on real order forms', () => {
  test('Servitro: the store page, products with cycles and specs, groups from the sidebar', async () => {
    const html = await fixture('whmcs-servitro-store.html');
    const url = 'https://my.servitro.com/store/virtual-servers';
    const products = parseWhmcs(html, url);
    expect(products.map((p) => p.id)).toEqual(['usd1-server', 'virtual-1', 'virtual-2']);
    expect(products[0]).toMatchObject({
      name: '$1 Server',
      group: 'virtual-servers',
      price: { amount: 12, currency: 'USD' },
      cycle: { cycle: 'annually', interval: 'year' },
      stock: 'unknown',
      url: 'https://my.servitro.com/store/virtual-servers/usd1-server',
    });
    expect(products[0].description).toContain('1 vCores');
    expect(products[2].cycle.cycle).toBe('monthly');
    expect(whmcsGroups(html, url)).toEqual(['https://my.servitro.com/store/bgp/']);
  });

  test('Hostnamaste: product ids from the order button, "starting from", locations in the text', async () => {
    const html = await fixture('whmcs-hostnamaste-cart.html');
    const url = 'https://www.hostnamaste.com/clients/store/openvz-vps';
    const products = parseWhmcs(html, url);
    expect(products.map((p) => p.id)).toEqual(['pid-42', 'pid-43', 'pid-590']);
    expect(products[0]).toMatchObject({
      name: 'OpenVZ-256',
      group: 'openvz-vps',
      startingFrom: true,
      price: { amount: 24, currency: 'USD' },
      url: 'https://www.hostnamaste.com/clients/cart.php?a=add&pid=42',
    });
    expect(products[1].price.amount).toBe(3.49);
    const groups = whmcsGroups(html, url);
    // The fixture keeps two of the sidebar's twenty-eight group links.
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((g) => g.startsWith('https://www.hostnamaste.com/clients/store/'))).toBe(
      true,
    );
    expect(groups.some((g) => /ssl|domain/.test(g))).toBe(false);
  });

  test('a product becomes a hosting item with a stable id, the provider slug and an OpenServer offer', async () => {
    const html = await fixture('whmcs-hostnamaste-cart.html');
    const [p] = parseWhmcs(html, 'https://www.hostnamaste.com/clients/store/openvz-vps');
    const item = productItem(p, {
      platform: 'whmcs',
      domain: 'hostnamaste.com',
      provider: 'hostnamaste.com',
      providerName: 'HostNamaste',
      fetchedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(item.externalId).toBe('storefront:whmcs:hostnamaste.com:pid-42');
    expect(item.title).toBe('HostNamaste OpenVZ-256 (pid-42)');
    expect(item.data.provider).toBe('hostnamaste.com');
    expect(item.data.offer).toMatchObject({
      id: 'pid-42',
      kind: 'vps',
      premises: 'off-prem',
      management: 'unmanaged',
      tenancy: 'shared',
      model: 'centralized',
      price: { amount: 24, currency: 'USD', interval: 'year' },
      updated: '2026-09-13T00:00:00.000Z',
    });
    expect(item.data.offer.compute.ram_mb).toBe(256);
    expect(item.data.offer.location.countries).toContain('US');
    expect(item.data.billing).toEqual({ amount: 24, cycle: 'annually' });
    expect(item.data.attribution).toContain('from its own order form');
    expect(item.tags).toEqual(
      expect.arrayContaining([
        'plan',
        'platform:whmcs',
        'provider:hostnamaste.com',
        'starting-from',
      ]),
    );
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('Blesta (KnownHost): cards with a starting price, a spec list, no cycle on the listing', async () => {
    const html = await fixture('blesta-knownhost-packages.html');
    const url = 'https://my.knownhost.com/order/main/packages/managed-nvme-vps/?group_id=49';
    const products = parseBlesta(html, url);
    expect(products).toHaveLength(3);
    expect(products[0]).toMatchObject({
      id: 'pricing-999',
      name: 'Entry VPS',
      group: 'managed-nvme-vps/49',
      price: { amount: 5, currency: 'USD' },
      cycle: null,
      startingFrom: true,
      url,
    });
    expect(products[0].description).toContain('1 Core');
    expect(parseSpecs(products[0].description)).toMatchObject({
      vcpu: 1,
      ramMb: 1024,
      disk: { size_gb: 25, type: 'nvme' },
      transferGb: 2048,
      ipv4: 2,
    });
    expect(products[1].id).toBe('pricing-1003');
    const groups = blestaGroups(html, url);
    // The fixture keeps two of the order form's eight group links.
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((g) => g.includes('/order/main/index/'))).toBe(true);
    expect(groups.some((g) => /domain|workspace/.test(g))).toBe(false);
    // No interval is assumed for a price whose cycle the listing does not state.
    const item = productItem(products[0], {
      platform: 'blesta',
      domain: 'knownhost.com',
      provider: 'knownhost',
      providerName: 'KnownHost',
      fetchedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(item.externalId).toBe('storefront:blesta:knownhost.com:pricing-999');
    expect(item.data.offer.price).toMatchObject({ amount: 5, currency: 'USD', interval: null });
    expect(item.tags).not.toContain('price:5-10');
  });

  test('WooCommerce (WPServeur): loop products, euro prices, French cycle suffixes, variable products as "from"', async () => {
    const html = await fixture('woocommerce-wpserveur-shop.html');
    const url = 'https://www.wpserveur.net/shop/';
    const products = parseWoocommerce(html, url);
    expect(products).toHaveLength(4);
    expect(products[0]).toMatchObject({
      id: 'post-79695',
      name: 'Assistance ponctuelle unique',
      price: { amount: 69, currency: 'EUR' },
      cycle: null,
      startingFrom: false,
      stock: 'in_stock',
      url: 'https://www.wpserveur.net/produit/assistance-ponctuelle/',
    });
    expect(products[1].cycle).toMatchObject({ interval: 'year' });
    expect(products[3]).toMatchObject({
      name: 'Hébergement WordPress',
      price: { amount: 21.5, currency: 'EUR' },
      cycle: { interval: 'month' },
      startingFrom: true,
    });
    expect(products[3].categories.length).toBeGreaterThan(0);
    expect(
      woocommerceGroups(
        '<a href="/product-category/vps/">VPS</a><a href="https://x.example/product-category/vps">VPS</a>',
        'https://x.example/shop/',
      ),
    ).toEqual(['https://x.example/product-category/vps/']);
    expect(normalisePrice(products[3].price, products[3].cycle)).toMatchObject({
      amount: 21.5,
      interval: 'month',
    });
  });

  test('the provider name is read off the shop title, never off a challenge page', () => {
    expect(providerNameOf('<title>Shopping Cart - Servitro</title>', 'servitro.com')).toBe(
      'Servitro',
    );
    expect(providerNameOf('<title>Security Verification</title>', 'servitro.com')).toBe(
      'servitro.com',
    );
    expect(providerNameOf('', 'x.example')).toBe('x.example');
    expect(findhostIdFor('https://www.vultr.com/x', { vultr: 'https://www.vultr.com' })).toBe(
      'vultr',
    );
    expect(findhostIdFor('https://nobody.example/', { vultr: 'https://www.vultr.com' })).toBeNull();
  });
});

describe('reading a host end to end, with no network', () => {
  const pages = {};
  const http = {
    async request(url) {
      const hit = pages[url];
      return {
        ok: Boolean(hit),
        status: hit ? 200 : 404,
        url,
        headers: { getSetCookie: () => [] },
        async text() {
          return hit ?? '';
        },
      };
    },
  };
  const ctx = { http, env: {}, log() {}, deadline: Date.now() + 60_000, sleep: async () => {} };

  test('home page, then the shop it links to, then every group; robots.txt is honoured', async () => {
    const store = await fixture('whmcs-servitro-store.html');
    pages['https://servitro.example/'] =
      '<title>Servitro</title><a href="https://my.servitro.example/cart.php">Order</a>';
    pages['https://my.servitro.example/robots.txt'] = 'User-agent: *\nDisallow: /store/bgp/';
    pages['https://my.servitro.example/cart.php'] = store;
    pages['https://my.servitro.example/store/bgp/'] = store.replace('$1 Server', 'BGP Session');
    const r = await readHost('https://servitro.example/', ctx);
    expect(r.note).toBe('servitro.example: whmcs, 2 groups, 3 products');
    expect(r.items.map((i) => i.externalId)).toEqual([
      'storefront:whmcs:servitro.example:usd1-server',
      'storefront:whmcs:servitro.example:virtual-1',
      'storefront:whmcs:servitro.example:virtual-2',
    ]);
    expect(r.items[0].data.providerName).toBe('Servitro');
  });

  test('a challenged host and a host with no storefront are left alone with a note', async () => {
    pages['https://walled.example/'] = '<title>Just a moment...</title>';
    const walled = {
      ...ctx,
      http: {
        async request(url) {
          return { ...(await http.request(url)), status: 403 };
        },
      },
    };
    expect((await readHost('https://walled.example/', walled)).note).toContain('bot challenge');
    pages['https://plain.example/'] = '<title>Plain</title><p>We sell nothing here.</p>';
    expect((await readHost('https://plain.example/', ctx)).note).toContain('no storefront found');
    expect((await readHost('https://gone.example/', ctx)).note).toContain('unreachable');
  });

  test('the adapter rotates through its hosts across runs and keeps a cursor', async () => {
    const store = await fixture('whmcs-servitro-store.html');
    const hosts = ['a', 'b', 'c'].map((h) => `https://${h}.example/cart.php`);
    for (const h of hosts) pages[h] = store;
    const run = (cursor) =>
      storefront.pull({
        config: { hosts, maxHosts: 2 },
        cursor,
        env: {},
        http,
        log() {},
        deadline: Date.now() + 60_000,
        sleep: async () => {},
      });
    const r1 = await run({});
    expect(r1.cursor).toEqual({ next: 2 });
    expect(r1.items.length).toBe(6);
    expect(r1.note).toBe('6 products from 2 of 2 hosts');
    const r2 = await run(r1.cursor);
    expect(r2.cursor).toEqual({ next: 1 });
  });

  test('the default host list comes from the survey and skips challenged hosts', () => {
    const survey = {
      hosts: [
        {
          domain: 'a.example',
          platform: 'whmcs',
          listing: 'https://my.a.example/cart.php',
          challenged: false,
        },
        { domain: 'b.example', platform: 'whmcs', origin: 'https://b.example', challenged: true },
        {
          domain: 'c.example',
          platform: 'woocommerce',
          listing: 'https://c.example/shop/',
          challenged: false,
        },
        { domain: 'd.example', platform: null, home: 'https://d.example/' },
      ],
    };
    expect(surveyedHosts(survey)).toEqual([
      'https://my.a.example/cart.php',
      'https://c.example/shop/',
    ]);
    expect(surveyedHosts(null)).toEqual([]);
  });
});
