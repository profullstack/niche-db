import { beforeEach, describe, expect, test } from 'bun:test';
import { migratedPglite, pgliteSql } from './helpers/pglite.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const src = await import('../packages/core/src/tlds/sources.js');
const { syncTlds } = await import('../packages/core/src/tlds/sync.js');
const { buildRows, queryTlds, tldOut } = await import('../packages/core/src/tlds/query.js');
const rdap = await import('../packages/core/src/tlds/rdap.js');
const store = await import('../packages/db/src/tlds.js');

/* --------------------------------------------------------------- samples -- */

const LIST = (version, labels) =>
  `# Version ${version}, Last Updated Fri Sep 25 07:07:01 2026 UTC\n${labels.map((l) => l.toUpperCase()).join('\n')}\n`;

const ROOT_DB = `
<table id="tld-table"><tbody>
<tr><td><span class="domain tld"><a href="/domains/root/db/com.html">.com</a></span></td>
    <td>generic</td>
    <td>VeriSign Global Registry Services</td></tr>
<tr><td><span class="domain tld"><a href="/domains/root/db/watches.html">.watches</a></span></td>
    <td>generic</td>
    <td>Identity Digital Limited</td></tr>
<tr><td><span class="domain tld"><a href="/domains/root/db/xn--p1ai.html">.рф</a></span></td>
    <td>country-code</td>
    <td>Coordination Center for TLD RU</td></tr>
<tr><td><span class="domain tld"><a href="/domains/root/db/xn--retired.html">.retired</a></span></td>
    <td>generic</td>
    <td>Not assigned</td></tr>
<tr><td><span class="domain tld"><a href="/domains/root/db/ai.html">.ai</a></span></td>
    <td>country-code</td>
    <td>Government of Anguilla &amp; Co</td></tr>
</tbody></table>`;

const RDAP_BOOT = {
  publication: '2026-09-16T19:00:03Z',
  services: [
    [
      ['com', 'net'],
      ['http://rdap.verisign.com/com/v1/', 'https://rdap.verisign.com/com/v1/'],
    ],
    [['watches'], ['https://rdap.identitydigital.services/rdap']],
  ],
};

const PORKBUN = {
  status: 'SUCCESS',
  pricing: {
    com: { registration: '11.08', renewal: '11.08', transfer: '11.08', coupons: [] },
    watches: { registration: '52.01', renewal: '257.98', transfer: '257.98', coupons: [] },
    'xn--btc-6r6a': { registration: '5.00', renewal: '5.00', transfer: '5.00', coupons: [] },
  },
};

/** A devalue payload the way Nuxt serialises it: every value an index into the array. */
const nuxt = (rows) => {
  const arr = [['ShallowReactive', 1], { data: 2 }, []];
  for (const r of rows) {
    const obj = {};
    arr[2].push(arr.length);
    arr.push(obj);
    for (const [k, v] of Object.entries(r)) {
      obj[k] = arr.length;
      arr.push(v);
    }
  }
  return `<html><script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">${JSON.stringify(arr)}</script></html>`;
};
const DYNADOT = nuxt([
  {
    name: 'watches',
    reg_price: '$53.69',
    original_reg_price: '-1',
    renew_price: '$267.72',
    original_renew_price: '-1',
    tr_price: '$267.72',
    restore: '$580.40',
    privacy: 'Yes',
    idn: 'Yes',
    restrictions: '-',
    usage: 'Watch Websites',
    grace_period: '30',
  },
  {
    name: 'com',
    reg_price: '$6.99',
    original_reg_price: '$10.88',
    renew_price: '$10.88',
    original_renew_price: '-1',
    tr_price: '$10.88',
    restore: '$100.92',
    privacy: 'Yes',
    idn: 'Yes',
    restrictions: '-',
  },
]);

const CLOUDFLARE = {
  com: { registration: 10.44, renewal: 10.44, updatedAt: '2026-09-05' },
  watch: { registration: 34.2, renewal: 34.2, updatedAt: '2026-09-05' },
};

const OVH = {
  locale: { currencyCode: 'EUR', subsidiary: 'IE' },
  plans: [
    {
      planCode: 'com',
      pricings: [
        { mode: 'create-default', phase: 0, price: 799000000 },
        { mode: 'create-default', phase: 1, price: 1349000000 },
        { mode: 'create-premium', phase: 0, price: 99999900000000 },
        { mode: 'transfer-default', phase: 0, price: 799000000 },
        { mode: 'restore-default', phase: 1, price: 5099000000 },
      ],
    },
    { planCode: 'co.uk', pricings: [{ mode: 'create-default', phase: 0, price: 599000000 }] },
  ],
};

/* --------------------------------------------------------------- parsers -- */

describe('IANA parsers', () => {
  test('the list: version from the header, lower-case labels, no comments', () => {
    const out = src.parseTldList(LIST('2026092500', ['AAA', 'COM', 'XN--P1AI']));
    expect(out.version).toBe('2026092500');
    expect(out.updated).toBe('Fri Sep 25 07:07:01 2026 UTC');
    expect(out.labels).toEqual(['aaa', 'com', 'xn--p1ai']);
  });

  test('an IDN label decodes; a plain one carries no copy', () => {
    expect(src.unicodeOf('xn--p1ai')).toBe('рф');
    expect(src.unicodeOf('com')).toBeNull();
  });

  test('the root zone database: the link carries the ASCII label, entities decoded', () => {
    const rows = src.parseRootDb(ROOT_DB);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.tld === 'xn--p1ai')).toEqual({
      tld: 'xn--p1ai',
      type: 'country-code',
      manager: 'Coordination Center for TLD RU',
    });
    expect(rows.find((r) => r.tld === 'ai').manager).toBe('Government of Anguilla & Co');
  });

  test('RDAP bootstrap: https wins, trailing slash added', () => {
    const rows = src.parseRdapBootstrap(RDAP_BOOT);
    expect(rows).toContainEqual({ tld: 'com', rdap: 'https://rdap.verisign.com/com/v1/' });
    expect(rows).toContainEqual({
      tld: 'watches',
      rdap: 'https://rdap.identitydigital.services/rdap/',
    });
  });

  test('the diff: added, returned, removed; a first read is a baseline', () => {
    expect(src.diffList([], ['a', 'b']).baseline).toBe(true);
    const held = [
      { tld: 'a', status: 'delegated' },
      { tld: 'b', status: 'delegated' },
      { tld: 'c', status: 'removed' },
      ...Array.from({ length: 20 }, (_, i) => ({ tld: `x${i}`, status: 'delegated' })),
    ];
    const labels = ['a', 'c', 'd', ...Array.from({ length: 20 }, (_, i) => `x${i}`)];
    expect(src.diffList(held, labels)).toEqual({
      added: ['d'],
      returned: ['c'],
      removed: ['b'],
      baseline: false,
    });
  });

  test('a list far shorter than what is held is refused, not applied', () => {
    const held = Array.from({ length: 100 }, (_, i) => ({ tld: `t${i}`, status: 'delegated' }));
    expect(() => src.diffList(held, ['t1', 't2'])).toThrow(/short download/);
  });
});

describe('registrar readers', () => {
  test('Porkbun: renewal kept beside the first year', () => {
    const w = src.parsePorkbun(PORKBUN).find((r) => r.tld === 'watches');
    expect(w).toMatchObject({ currency: 'USD', register: 52.01, renew: 257.98, transfer: 257.98 });
  });

  test('Dynadot: the Nuxt payload resolves, and a sale price becomes promo beside the regular one', () => {
    const rows = src.parseDynadot(DYNADOT);
    const w = rows.find((r) => r.tld === 'watches');
    expect(w).toMatchObject({ register: 53.69, renew: 267.72, transfer: 267.72, restore: 580.4 });
    expect(w.privacy).toBe('included');
    expect(w.restrictions).toBeNull();
    expect(w.extra).toMatchObject({ usage: 'Watch Websites', grace_days: 30 });
    const com = rows.find((r) => r.tld === 'com');
    expect(com.register).toBe(10.88);
    expect(com.promo).toEqual({ register: 6.99 });
  });

  test('Dynadot: a page in yuan is stored in yuan, never as dollars; a mixed page is refused', () => {
    const cny = src.parseDynadot(
      nuxt([
        {
          name: 'com',
          reg_price: '¥73.80',
          original_reg_price: '-1',
          renew_price: '¥73.80',
          original_renew_price: '-1',
          tr_price: '¥73.80',
          restore: '¥684.10',
          google_data: { currency: 'CNY', brand: 'Verisign' },
        },
      ]),
    );
    expect(cny[0]).toMatchObject({ currency: 'CNY', register: 73.8, renew: 73.8 });
    expect(() =>
      src.parseDynadot(
        nuxt([
          { name: 'com', reg_price: '¥73.80', renew_price: '¥73.80' },
          { name: 'net', reg_price: '$12.00', renew_price: '$12.00' },
        ]),
      ),
    ).toThrow(/mixes currencies/);
  });

  test('Dynadot: a page without the payload is an error, not an empty list', () => {
    expect(() => src.parseDynadot('<html></html>')).toThrow(/__NUXT_DATA__/);
  });

  test('Cloudflare: at cost, so a transfer is a renewal', () => {
    const w = src.parseCloudflare(CLOUDFLARE).find((r) => r.tld === 'watch');
    expect(w).toMatchObject({ register: 34.2, renew: 34.2, transfer: 34.2 });
    expect(w.extra.mirrored_at).toBe('2026-09-05');
  });

  test('OVH: hundred-millionths, EUR, second-level plans skipped, premium ignored', () => {
    const rows = src.parseOvh(OVH);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tld: 'com',
      currency: 'EUR',
      register: 7.99,
      renew: 13.49,
      transfer: 7.99,
      restore: 50.99,
    });
  });

  test('OpenTLD: an expired promotion is dropped; currency is required', () => {
    const { registrar, rows } = src.parseOpenTld({
      registrar: { name: 'Northwind Names' },
      currency: 'usd',
      prices: [
        {
          tld: '.COM',
          register: 11,
          renew: 11,
          promo: { register: 5, ends: '2000-01-01T00:00:00Z' },
        },
        {
          tld: 'dev',
          register: 12,
          renew: 12,
          promo: { register: 6, ends: '2999-01-01T00:00:00Z' },
        },
      ],
    });
    expect(registrar.name).toBe('Northwind Names');
    expect(rows.find((r) => r.tld === 'com')).toMatchObject({ currency: 'USD', promo: null });
    expect(rows.find((r) => r.tld === 'dev').promo.register).toBe(6);
    expect(() => src.parseOpenTld({ registrar: { name: 'x' }, prices: [] })).toThrow();
  });
});

/* ------------------------------------------------------------------ sync -- */

function fakeHttp(routes) {
  const text = async (url) => {
    const v = typeof routes[url] === 'function' ? routes[url]() : routes[url];
    if (v === undefined) throw new Error(`no route for ${url}`);
    if (v instanceof Error) throw v;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  return { text, json: async (url, o) => JSON.parse(await text(url, o)) };
}

/** Enough labels that the sync's sanity floors (1,000 root rows, 500 RDAP labels) hold. */
const filler = Array.from({ length: 1200 }, (_, i) => `f${i}`);
const bigRoot = `${ROOT_DB}${filler.map((f) => `<tr><td><a href="/domains/root/db/${f}.html">.${f}</a></span></td><td>generic</td><td>Filler Registry</td></tr>`).join('\n')}`;
const bigBoot = {
  ...RDAP_BOOT,
  services: [...RDAP_BOOT.services, [filler, ['https://rdap.filler.example/']]],
};

describe('syncTlds against PGlite', () => {
  let db;
  let sql;
  let list;
  const reg = (slug, body, parse, currency = 'USD') => ({
    slug,
    name: slug,
    currency,
    read: async () => parse(typeof body === 'function' ? body() : body),
  });

  beforeEach(async () => {
    db = await migratedPglite();
    sql = pgliteSql(db);
    rdap.clearRdapCache();
    list = LIST('2026092500', ['com', 'watches', 'xn--p1ai', 'ai', 'removedlater', ...filler]);
  }, 30_000);

  const http = () =>
    fakeHttp({
      [src.IANA_LIST_URL]: () => list,
      [src.IANA_ROOT_DB_URL]: bigRoot,
      [src.IANA_RDAP_URL]: bigBoot,
    });
  const registrars = () => [
    reg('porkbun', PORKBUN, src.parsePorkbun),
    reg('dynadot', DYNADOT, src.parseDynadot),
    reg('ovh', OVH, src.parseOvh, 'EUR'),
  ];

  test('first run is a baseline: every label, no change rows, records filled in', async () => {
    const out = await syncTlds({ db: sql, http: http(), registrars: registrars(), log: () => {} });
    expect(out.list).toMatchObject({ version: '2026092500', baseline: true });
    const [n] = await sql`select count(*)::int as n from tlds`;
    expect(n.n).toBe(1206);
    // Retired before tracking began: kept, as removed, from the root zone database.
    expect(await store.getTld('xn--retired', { db: sql })).toMatchObject({
      status: 'removed',
      manager: 'Not assigned',
    });
    expect(out.root.retired).toBe(1);
    const [ch] = await sql`select count(*)::int as n from tld_changes`;
    expect(ch.n).toBe(0);
    const t = await store.getTld('xn--p1ai', { db: sql });
    expect(t).toMatchObject({ unicode: 'рф', type: 'country-code', status: 'delegated' });
    const w = await store.getTld('watches', { db: sql });
    expect(w.rdap).toBe('https://rdap.identitydigital.services/rdap/');
    expect(w.manager).toBe('Identity Digital Limited');
    expect(w.prices.map((p) => p.registrar).sort()).toEqual(['dynadot', 'porkbun']);
    // Porkbun's Handshake label is not in the root and is not stored.
    const [hns] = await sql`select count(*)::int as n from tld_prices where tld = 'xn--btc-6r6a'`;
    expect(hns.n).toBe(0);
    expect(out.registrars.porkbun.outside).toBe(1);
  }, 30_000);

  test('an unchanged version is skipped; a new one writes the diff to the change log', async () => {
    await syncTlds({ db: sql, http: http(), registrars: [], log: () => {} });
    const again = await syncTlds({ db: sql, http: http(), registrars: [], log: () => {} });
    expect(again.list).toEqual({ version: '2026092500', unchanged: true });

    list = LIST('2026092600', ['com', 'watches', 'xn--p1ai', 'ai', 'newone', ...filler]);
    const next = await syncTlds({ db: sql, http: http(), registrars: [], log: () => {} });
    expect(next.list).toMatchObject({ added: 1, removed: 1, returned: 0 });
    const changes = await store.listChanges({}, { db: sql });
    expect(changes.map((c) => [c.tld, c.change, c.list_version]).sort()).toEqual([
      ['newone', 'added', '2026092600'],
      ['removedlater', 'removed', '2026092600'],
    ]);
    const gone = await store.getTld('removedlater', { db: sql });
    expect(gone).toMatchObject({ status: 'removed', removed: '2026092600' });
  }, 30_000);

  test('a registrar that drops a label marks it gone; a broken read keeps the last good list', async () => {
    const pb = { ...PORKBUN, pricing: { ...PORKBUN.pricing } };
    const many = Object.fromEntries(
      filler.slice(0, 80).map((f) => [f, { registration: '1', renewal: '2', transfer: '2' }]),
    );
    Object.assign(pb.pricing, many);
    let body = pb;
    const r = [reg('porkbun', () => body, src.parsePorkbun)];
    await syncTlds({ db: sql, http: http(), registrars: r, log: () => {} });

    body = { ...pb, pricing: { ...pb.pricing } };
    delete body.pricing.watches;
    const second = await syncTlds({ db: sql, http: http(), registrars: r, log: () => {} });
    expect(second.registrars.porkbun.gone).toBe(1);
    const w = await store.getTld('watches', { db: sql });
    expect(w.prices[0].gone_at).toBeTruthy();

    body = { status: 'SUCCESS', pricing: { com: PORKBUN.pricing.com } };
    const broken = await syncTlds({ db: sql, http: http(), registrars: r, log: () => {} });
    expect(broken.registrars.porkbun.error).toMatch(/last good list/);
    const [live] = await sql`select count(*)::int as n from tld_prices where gone_at is null`;
    expect(live.n).toBeGreaterThan(50);
  }, 30_000);

  test('one failing upstream does not stop the others', async () => {
    const h = fakeHttp({
      [src.IANA_LIST_URL]: list,
      [src.IANA_ROOT_DB_URL]: new Error('503'),
      [src.IANA_RDAP_URL]: bigBoot,
    });
    const out = await syncTlds({ db: sql, http: h, registrars: registrars(), log: () => {} });
    expect(out.root.error).toBe('503');
    expect(out.list.baseline).toBe(true);
    expect(out.registrars.porkbun.written).toBeGreaterThan(0);
  }, 30_000);
});

/* ----------------------------------------------------------------- query -- */

describe('queryTlds', () => {
  const p = (registrar, tld, currency, register, renew, transfer = renew) => ({
    registrar,
    registrar_name: registrar,
    tld,
    currency,
    register,
    renew,
    transfer,
  });
  const rows = buildRows({
    tlds: [
      {
        tld: 'com',
        type: 'generic',
        manager: 'VeriSign',
        status: 'delegated',
        first_seen_at: '2026-09-25',
      },
      { tld: 'watches', type: 'generic', manager: 'Identity Digital', status: 'delegated' },
      { tld: 'ai', type: 'country-code', manager: 'Anguilla', status: 'delegated' },
      { tld: 'xn--p1ai', unicode: 'рф', type: 'country-code', manager: 'RU', status: 'delegated' },
      { tld: 'old', type: 'generic', manager: 'Gone', status: 'removed' },
    ],
    prices: [
      p('porkbun', 'com', 'USD', 11.08, 11.08),
      p('cloudflare', 'com', 'USD', 10.44, 10.44),
      p('ovh', 'com', 'EUR', 7.99, 13.49),
      p('porkbun', 'watches', 'USD', 52.01, 257.98),
      p('dynadot', 'watches', 'USD', 53.69, 267.72),
      p('dynadot', 'ai', 'USD', 85.6, 85.6, 171.2),
    ],
  });

  test('default: delegated only, cheapest USD renewal first, unpriced last', () => {
    const out = queryTlds(rows, {});
    expect(out.total).toBe(4);
    expect(out.rows.map((r) => r.tld)).toEqual(['com', 'ai', 'watches', 'xn--p1ai']);
    expect(out.rows[0].view.renew).toMatchObject({ amount: 10.44, registrar: 'cloudflare' });
  });

  test('EUR never competes with USD for "best", but shows under its own registrar', () => {
    const com = queryTlds(rows, {}).rows.find((r) => r.tld === 'com');
    expect(com.view.register.amount).toBe(10.44);
    const ovh = queryTlds(rows, { registrar: 'ovh' });
    expect(ovh.rows.map((r) => r.tld)).toEqual(['com']);
    expect(ovh.rows[0].view.renew).toMatchObject({ amount: 13.49, currency: 'EUR' });
  });

  test('the renewal trap: renew at least twice the first year', () => {
    const out = queryTlds(rows, { trap: '1' });
    expect(out.rows.map((r) => r.tld)).toEqual(['watches']);
    expect(out.rows[0].ratio).toBeCloseTo(4.96, 2);
    expect(out.facets.trap).toBe(1);
  });

  test('facets count everything but their own filter', () => {
    const out = queryTlds(rows, { type: 'country-code' });
    expect(out.total).toBe(2);
    expect(out.facets.type).toEqual(
      expect.arrayContaining([
        { value: 'generic', count: 2 },
        { value: 'country-code', count: 2 },
      ]),
    );
    expect(out.facets.registrar).toEqual([{ value: 'dynadot', count: 1 }]);
  });

  test('search matches the label, its unicode form and the manager', () => {
    expect(queryTlds(rows, { q: 'рф' }).rows.map((r) => r.tld)).toEqual(['xn--p1ai']);
    expect(queryTlds(rows, { q: '.wat' }).rows.map((r) => r.tld)).toEqual(['watches']);
    expect(queryTlds(rows, { q: 'identity' }).rows.map((r) => r.tld)).toEqual(['watches']);
  });

  test('price band, max renew, sort by label descending, removed on request', () => {
    expect(queryTlds(rows, { band: '100-plus' }).rows.map((r) => r.tld)).toEqual(['watches']);
    expect(queryTlds(rows, { max_renew: '50' }).rows.map((r) => r.tld)).toEqual(['com']);
    expect(queryTlds(rows, { sort: 'tld', order: 'desc' }).rows[0].tld).toBe('xn--p1ai');
    expect(queryTlds(rows, { status: 'removed' }).rows.map((r) => r.tld)).toEqual(['old']);
  });

  test('tldOut carries the page and every price', () => {
    const out = tldOut(queryTlds(rows, { q: 'watches' }).rows[0], 'https://nichedb.dev');
    expect(out.page).toBe('https://nichedb.dev/tlds/watches');
    expect(out.prices).toHaveLength(2);
    expect(out.renewal_trap).toBe(true);
  });
});

/* ------------------------------------------------------------------ RDAP -- */

describe('RDAP check', () => {
  beforeEach(() => rdap.clearRdapCache());
  const rdapFor = async (t) =>
    ({ com: 'https://rdap.test/com/', watches: 'https://rdap.test/w/' })[t] ?? null;

  test('names normalise: scheme, path, case, www, IDN', () => {
    expect(rdap.normaliseName('https://www.Example.COM/path?x=1')).toBe('example.com');
    expect(rdap.normaliseName('bücher.de')).toBe('xn--bcher-kva.de');
    expect(rdap.normaliseName('nodot')).toBeNull();
  });

  test('200 is registered with the registrar and dates; 404 is not registered, never "available"', async () => {
    const fetchImpl = async (url) =>
      url.endsWith('taken.com')
        ? new Response(
            JSON.stringify({
              status: ['client transfer prohibited'],
              events: [
                { eventAction: 'registration', eventDate: '2001-01-01T00:00:00Z' },
                { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' },
              ],
              entities: [
                {
                  roles: ['registrar'],
                  vcardArray: [
                    'vcard',
                    [
                      ['version', {}, 'text', '4.0'],
                      ['fn', {}, 'text', 'Porkbun LLC'],
                    ],
                  ],
                  publicIds: [{ type: 'IANA Registrar ID', identifier: '1861' }],
                },
              ],
              nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }],
            }),
            { status: 200 },
          )
        : new Response('', { status: 404 });
    const taken = await rdap.checkName('taken.com', { rdapFor, fetchImpl });
    expect(taken).toMatchObject({
      status: 'registered',
      registrar: 'Porkbun LLC',
      registrar_iana_id: '1861',
      expires: '2027-01-01T00:00:00Z',
      nameservers: ['ns1.example.com'],
    });
    const free = await rdap.checkName('free.watches', { rdapFor, fetchImpl });
    expect(free.status).toBe('not_registered');
    expect(free.status).not.toBe('available');
  });

  test('no server, an error status or a throw is unknown, and unknown is not cached', async () => {
    expect((await rdap.checkName('x.zz', { rdapFor })).status).toBe('unknown');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      return new Response('', { status: 429 });
    };
    expect((await rdap.checkName('a.com', { rdapFor, fetchImpl: flaky })).reason).toMatch(/429/);
    await rdap.checkName('a.com', { rdapFor, fetchImpl: flaky });
    expect(calls).toBe(2);
    const boom = async () => {
      throw new Error('socket hang up');
    };
    expect((await rdap.checkName('b.com', { rdapFor, fetchImpl: boom })).status).toBe('unknown');
  });

  test('a definite answer is cached', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('', { status: 404 });
    };
    await rdap.checkName('c.com', { rdapFor, fetchImpl });
    const second = await rdap.checkName('c.com', { rdapFor, fetchImpl });
    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  test('checkNames keeps order', async () => {
    const fetchImpl = async (url) => new Response('', { status: url.includes('/w/') ? 404 : 200 });
    const out = await rdap.checkNames(['a.com', 'a.watches', 'a.zz'], { rdapFor, fetchImpl });
    expect(out.map((r) => r.status)).toEqual(['registered', 'not_registered', 'unknown']);
  });
});
