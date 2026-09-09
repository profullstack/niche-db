import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  apiTime,
  pickMovers,
  scopeOf,
  toChangeItem,
  toContractedItem,
  toDelegationItem,
  toMovementItem,
  toPhaseItem,
  toTldItem,
  toTotalsItem,
  toTransitionItem,
} from '../packages/adapters/src/ntlddata.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

// The seed module reaches the database package, which reads the environment at
// import. It needs the variable to exist, not to connect: nothing here queries.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS, DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

/* Rows exactly as ntlddata.com returned them on 2026-09-09. */
const meta = {
  scope: 'new',
  zone_data_date: '2026-09-09',
  registrar_month: 202605,
  data_version: 34,
};
const tldRow = (over = {}) => ({
  tld: 'xyz',
  type: 'generic',
  is_new_gtld: true,
  domains: 9704439,
  reported_domains: 8557020,
  reported_month: 202605,
  change_1d: 50849,
  change_7d: 226431,
  change_30d: null,
  registry: 'XYZ.COM LLC',
  backend: 'CentralNic (Team Internet)',
  root_signed: true,
  delegated_at: '2014-02-19',
  ...over,
  // The API always sends the Unicode name beside the punycode one; an ASCII
  // TLD sends the same string twice.
  unicode_name: over.unicode_name ?? over.tld ?? 'xyz',
});

describe('the domains collection', () => {
  test('exists, and every ntlddata adapter is registered in it', () => {
    expect(COLLECTIONS.map((c) => c.slug)).toContain('domains');
    for (const name of ['ntld-totals', 'ntld-tlds', 'ntld-launches', 'ntld-changes']) {
      const a = adapterByName(name);
      expect(a).not.toBeNull();
      expect(a.collection).toBe('domains');
    }
  });

  test('every domains feed queries a kind or a source that exists', () => {
    const adapters = ADAPTERS.filter((a) => a.collection === 'domains');
    const kinds = new Set(adapters.flatMap((a) => a.kinds));
    const sources = new Set(adapters.flatMap((a) => a.defaultSources.map((s) => s.slug)));
    const feeds = DEFAULT_FEEDS.filter((f) => f.collection === 'domains');
    expect(feeds.length).toBeGreaterThan(5);
    for (const f of feeds) {
      for (const kind of f.query.kinds ?? []) expect(kinds).toContain(kind);
      for (const slug of f.query.sources ?? []) expect(sources).toContain(slug);
    }
  });

  test('no two feeds share a slug, which the schema requires globally', () => {
    const slugs = DEFAULT_FEEDS.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('no two sources share a slug either, across every adapter', () => {
    const slugs = ADAPTERS.flatMap((a) => (a.defaultSources ?? []).map((s) => s.slug));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('scope, which is never guessed', () => {
  test('new gTLDs unless a source says otherwise', () => {
    expect(scopeOf({})).toBe('new');
    expect(scopeOf({ scope: 'legacy' })).toBe('legacy');
    expect(scopeOf({ scope: 'ALL' })).toBe('all');
    expect(scopeOf({ scope: 'nonsense' })).toBe('new');
  });

  test('the totals source refuses `all`, because /overview never answers for it', () => {
    // Measured: /overview and /overview?scope=all both hang until the client
    // gives up, while ?scope=new answers in under a second. A source that
    // passed `all` through would time out on every single run.
    expect(scopeOf({ scope: 'all' }, { allowAll: false })).toBe('new');
    expect(adapterByName('ntld-totals').configFields[0].options).toEqual(['new', 'legacy']);
  });
});

describe('daily totals', () => {
  const row = {
    stat_date: '2026-09-09',
    tlds: 1077,
    domains: 55274273,
    adds: 164150,
    drops: 80070,
    net: 84080,
    dnssec_domains: 2811887,
  };

  test('a day reads as a population and a direction', () => {
    const it = toTotalsItem(row, { scope: 'new', meta });
    expect(it.externalId).toBe('totals-new-2026-09-09');
    expect(it.title).toBe('New gTLDs: 55,274,273 domains, +84,080 on the day');
    expect(it.summary).toContain('164,150 domains added');
    expect(it.summary).toContain('a net gain of 84,080.');
    expect(it.tags).toContain('growing');
    // A day, not an instant: the zone is a snapshot, and noon UTC keeps it
    // inside the right calendar day everywhere.
    expect(it.precision).toBe('day');
    expect(it.publishedAt.toISOString()).toBe('2026-09-09T12:00:00.000Z');
    expect(it.data.registrarMonth).toBe(202605);
  });

  test('a losing day says so, and legacy is labelled as its own population', () => {
    const it = toTotalsItem({ ...row, net: -12000 }, { scope: 'legacy', meta });
    expect(it.title).toStartWith('Legacy gTLDs:');
    expect(it.title).toContain('-12,000');
    expect(it.summary).toContain('a net loss of 12,000.');
    expect(it.tags).toContain('shrinking');
    expect(it.externalId).toBe('totals-legacy-2026-09-09');
  });

  test('the first day of the series is not published as a still day', () => {
    // adds 0 / drops 0 / net 0 is the first row, which had no day before it to
    // difference against. Across a thousand registries a day with no
    // registrations and no deletions cannot happen, so it is missing movement
    // rather than a flat day, and the row says so instead of claiming "+0".
    const it = toTotalsItem({ ...row, adds: 0, drops: 0, net: 0 }, { scope: 'new', meta });
    expect(it.title).toBe('New gTLDs: 55,274,273 domains');
    expect(it.title).not.toContain('+0');
    expect(it.summary).toContain('No daily movement is published for this day');
    expect(it.tags).not.toContain('growing');
  });

  test('a day with no count is not published as zero', () => {
    expect(toTotalsItem({ ...row, domains: null }, { scope: 'new', meta })).toBeNull();
    expect(toTotalsItem({ ...row, stat_date: '' }, { scope: 'new', meta })).toBeNull();
  });
});

describe('the TLD register', () => {
  test('a TLD carries its operator, its backend and both counts, unmerged', () => {
    const it = toTldItem(tldRow(), { meta });
    expect(it.externalId).toBe('tld-xyz');
    expect(it.title).toBe('.xyz: 9,704,439 domains');
    expect(it.summary).toContain('+50,849 in a day');
    expect(it.summary).toContain('Backend CentralNic (Team Internet) (inferred).');
    // The zone count and ICANN's monthly report are different facts from
    // different sources: both are kept, neither is added to the other.
    expect(it.data.domains).toBe(9704439);
    expect(it.data.reportedDomains).toBe(8557020);
    expect(it.data.reportedMonth).toBe(202605);
    // The reporting month is six digits upstream and a month to a reader.
    expect(it.summary).toContain("ICANN's 2026-05 report puts it at 8,557,020.");
    // A tag is a filter, so the backend is slugified rather than printed.
    expect(it.tags).toContain('backend:centralnic-team-internet');
    // Dated by delegation, so the register does not re-date itself every day.
    expect(it.publishedAt.toISOString()).toBe('2014-02-19T12:00:00.000Z');
    expect(it.tags).toContain('dnssec');
    expect(it.tags).toContain('new-gtld');
  });

  test('a TLD with no zone access says so rather than reading as empty', () => {
    // No CZDS approval means no daily count at all. Publishing "0 domains"
    // for .com-sized registries would be a lie the row can avoid telling.
    const it = toTldItem(tldRow({ tld: 'com', domains: null, is_new_gtld: false }), { meta });
    expect(it.title).toBe('.com: no zone data');
    expect(it.summary).toContain('has no zone access');
    expect(it.tags).toContain('legacy');
  });

  test('an IDN shows the Unicode name and the punycode it is filed under', () => {
    const it = toTldItem(tldRow({ tld: 'xn--otu796d', unicode_name: '嘉里' }), { meta });
    expect(it.title).toStartWith('.嘉里 (.xn--otu796d):');
    expect(it.url).toBe('https://ntlddata.com/tld/xn--otu796d');
    expect(it.data.tld).toBe('xn--otu796d');
  });
});

describe('daily movers', () => {
  test('a gainer and a faller each read as a day of movement', () => {
    const up = toMovementItem(tldRow(), { meta });
    expect(up.externalId).toBe('move-xyz-2026-09-09');
    expect(up.title).toBe('.xyz gained 50,849 domains in a day');
    expect(up.tags).toContain('growing');

    const down = toMovementItem(tldRow({ tld: 'yachts', change_1d: -2483, domains: 33000 }), {
      meta,
    });
    expect(down.title).toBe('.yachts lost 2,483 domains in a day');
    expect(down.summary).toContain('shrank by 2,483 domains on 2026-09-09');
    expect(down.tags).toContain('shrinking');
  });

  test('a mover needs a zone date: without one there is no day to attach it to', () => {
    expect(toMovementItem(tldRow(), { meta: {} })).toBeNull();
    expect(toMovementItem(tldRow({ change_1d: null }), { meta })).toBeNull();
  });

  test('the cap is applied here, because upstream floors `per` at ten', () => {
    // Measured: ?per=3 returns ten rows while the response's own meta says
    // per_page 3. A source asking for the top five would otherwise publish ten.
    const rows = Array.from({ length: 10 }, (_, i) => tldRow({ tld: `t${i}`, change_1d: 900 - i }));
    expect(pickMovers(rows, { direction: 'gainers', minChange: 0, limit: 5 })).toHaveLength(5);
  });

  test('movers are filtered by direction and by size, not just sorted', () => {
    const rows = [
      tldRow({ tld: 'a', change_1d: 5000 }),
      tldRow({ tld: 'b', change_1d: 40 }),
      tldRow({ tld: 'c', change_1d: -5000 }),
      tldRow({ tld: 'd', change_1d: 0 }),
      tldRow({ tld: 'e', change_1d: null }),
    ];
    expect(
      pickMovers(rows, { direction: 'gainers', minChange: 250, limit: 25 }).map((r) => r.tld),
    ).toEqual(['a']);
    expect(
      pickMovers(rows, { direction: 'droppers', minChange: 250, limit: 25 }).map((r) => r.tld),
    ).toEqual(['c']);
  });
});

describe('the root and the pipeline', () => {
  test('a delegation is dated by when the string entered the root', () => {
    const it = toDelegationItem(
      {
        tld: 'kids',
        unicode_name: 'kids',
        type: 'generic',
        delegated_at: '2022-04-04',
        latest_domains: '7241',
        monthly_domains: '7030',
        monthly_ym: '202605',
      },
      { meta },
    );
    expect(it.externalId).toBe('delegated-kids');
    expect(it.title).toBe('.kids was delegated to the root zone');
    expect(it.publishedAt.toISOString()).toBe('2022-04-04T12:00:00.000Z');
    expect(it.summary).toContain('It holds 7,241 domains today.');
  });

  test('a launch window carries both ends of the window and is dated at the open', () => {
    const it = toPhaseItem(
      {
        tld: 'latino',
        unicode_name: 'latino',
        phase: 'claims',
        variant: null,
        opens_at: '2026-06-12',
        closes_at: '2026-09-10',
        latest_domains: 842,
        registry_name: 'Dish DBS Corporation',
      },
      { meta },
    );
    expect(it.externalId).toBe('phase-latino-claims-2026-06-12');
    expect(it.title).toBe('.latino: claims, 2026-06-12 to 2026-09-10');
    expect(it.data.closesAt).toBe('2026-09-10');
    expect(it.publishedAt.toISOString()).toBe('2026-06-12T12:00:00.000Z');
  });

  test('contracted and transitioning strings are different rows with different kinds', () => {
    const c = toContractedItem(
      {
        tld: 'hotel',
        unicode_name: 'hotel',
        agreement_date: '2025-06-06',
        agreement_type: 'Base,Community (Spec 12),Non-Sponsored',
        is_brand: '0',
        is_community: '1',
        registry_name: null,
      },
      { meta },
    );
    expect(c.kind).toBe('contracted');
    expect(c.title).toBe('.hotel is contracted but not yet delegated');
    expect(c.data.agreementType).toEqual(['Base', 'Community (Spec 12)', 'Non-Sponsored']);
    expect(c.tags).toContain('community');
    expect(c.tags).not.toContain('brand');

    const t = toTransitionItem(
      {
        tld: 'desi',
        unicode_name: 'desi',
        latest_domains: 1851,
        agreement_date: '2013-11-14',
        registry_name: 'Emergency Back-End Registry Operator Program - ICANN',
      },
      { meta },
    );
    expect(t.kind).toBe('transition');
    expect(t.summary).toContain('Emergency Back-End Registry Operator Program - ICANN');
  });
});

describe('detected changes', () => {
  const change = (over = {}) => ({
    entity_type: 'tld',
    entity_key: 'ne',
    entity_label: 'ne',
    change_kind: 'tld_operator_changed',
    field: 'registry_id',
    old_value: 'SONITEL',
    new_value: 'Niger Télécoms SA (NIGERTELECOMS)',
    source: 'iana.rootdb',
    detected_at: '2026-09-08 00:00:00',
    needs_review: '0',
    note: null,
    ...over,
  });

  test('an operator change names both sides and links the TLD', () => {
    const it = toChangeItem(change(), { meta });
    expect(it.title).toBe(
      '.ne changed registry operator: SONITEL → Niger Télécoms SA (NIGERTELECOMS)',
    );
    expect(it.url).toBe('https://ntlddata.com/tld/ne');
    expect(it.data.oldValue).toBe('SONITEL');
    expect(it.externalId).toBe('change-tld-ne-tld_operator_changed-registry_id-2026-09-08');
  });

  test('midnight is a date, not an instant an hour west of here', () => {
    // `new Date('2026-09-08 00:00:00')` is LOCAL time, which files this row
    // under 7 September for every reader in the Americas.
    const it = toChangeItem(change(), { meta });
    expect(it.precision).toBe('day');
    expect(it.timeKnown).toBe(false);
    expect(it.publishedAt.toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });

  test('a real clock time is read as UTC rather than as the reader’s zone', () => {
    const it = toChangeItem(change({ detected_at: '2026-09-08 14:30:00' }), { meta });
    expect(it.publishedAt.toISOString()).toBe('2026-09-08T14:30:00.000Z');
    expect(it.timeKnown).toBe(true);
  });

  test('an inference the upstream is unsure of says so instead of being dropped', () => {
    const it = toChangeItem(
      change({
        entity_type: 'registrar',
        entity_key: '3765',
        entity_label: 'NICENIC INTERNATIONAL GROUP CO., LIMITED',
        change_kind: 'registrar_platform_moved',
        field: 'rdap_host',
        old_value: 'rdap.nicenic.net',
        new_value: 'rdap.nicenic.com',
        needs_review: '1',
        note: 'RDAP platform change often follows an acquisition.',
      }),
      { meta },
    );
    expect(it.title).toStartWith(
      'NICENIC INTERNATIONAL GROUP CO., LIMITED moved registry platform',
    );
    expect(it.tags).toContain('needs-review');
    expect(it.summary).toContain('observation, not an announcement');
    expect(it.url).toBe('https://ntlddata.com/changes');
  });

  test('a value dropping to nothing is stated, not silently omitted', () => {
    const it = toChangeItem(change({ new_value: null }), { meta });
    expect(it.title).toContain('→ nothing');
  });

  test('a row missing what identifies it is not published', () => {
    expect(toChangeItem(change({ detected_at: null }), { meta })).toBeNull();
    expect(toChangeItem(change({ change_kind: '' }), { meta })).toBeNull();
  });
});

describe('apiTime', () => {
  test('parses the API’s zoneless timestamps and falls back to a bare date', () => {
    expect(apiTime('2026-09-08 00:00:00').precision).toBe('day');
    expect(apiTime('2026-09-08T14:30:00').publishedAt.toISOString()).toBe(
      '2026-09-08T14:30:00.000Z',
    );
    expect(apiTime('2026-09-08').precision).toBe('day');
    expect(apiTime(null).publishedAt).toBeNull();
  });
});

describe('everything survives the item normaliser', () => {
  test('every builder produces a row the store accepts, with a unique id', () => {
    const built = [
      toTotalsItem(
        { stat_date: '2026-09-09', domains: 1, adds: 1, drops: 0, net: 1 },
        {
          scope: 'new',
          meta,
        },
      ),
      toTldItem(tldRow(), { meta }),
      toMovementItem(tldRow(), { meta }),
      toDelegationItem({ tld: 'kids', delegated_at: '2022-04-04' }, { meta }),
      toPhaseItem({ tld: 'dot', phase: 'sunrise', opens_at: '2026-07-21' }, { meta }),
      toContractedItem({ tld: 'hotel', agreement_date: '2025-06-06' }, { meta }),
      toTransitionItem({ tld: 'desi', agreement_date: '2013-11-14' }, { meta }),
      toChangeItem(
        {
          entity_type: 'tld',
          entity_key: 'bo',
          change_kind: 'tld_operator_changed',
          detected_at: '2026-08-18 00:00:00',
        },
        { meta },
      ),
    ];
    const ids = new Set();
    for (const raw of built) {
      const item = normaliseItem(raw);
      expect(item).not.toBeNull();
      expect(item.title.length).toBeGreaterThan(0);
      expect(ids.has(item.externalId)).toBe(false);
      ids.add(item.externalId);
      // Every row says where it came from and under what licence, because the
      // upstream is CC-BY and attribution is a condition of using it.
      expect(raw.data.attribution).toBe('nTLDData (ntlddata.com), CC-BY-4.0');
    }
  });

  test('each kind a domains adapter declares is one some builder emits', () => {
    const declared = new Set(
      ADAPTERS.filter((a) => a.collection === 'domains').flatMap((a) => a.kinds),
    );
    expect(declared).toEqual(
      new Set([
        'domain-count',
        'tld',
        'tld-movement',
        'delegation',
        'launch-phase',
        'contracted',
        'transition',
        'registry-change',
      ]),
    );
  });
});
