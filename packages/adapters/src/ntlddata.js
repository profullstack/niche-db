import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * The domain name industry, counted daily: nTLDData.
 *
 * Four things a person can actually follow, from one keyless CC-BY API:
 * how many domains exist and which way the number is moving, which strings
 * are entering the root or opening a sunrise, and when a TLD changes hands.
 *
 * The site publishes no RSS, so everything here is built from its JSON API.
 * It is aggregate-only by design -- ICANN's CZDS terms permit analysis but
 * prohibit redistributing zone data, so no endpoint returns domain names and
 * neither does this collection.
 *
 * TWO CLOCKS, and mixing them produces wrong statements. Domain counts, adds
 * and drops come from zone files and are a day old. Anything attributed to a
 * REGISTRAR comes from ICANN's monthly registry reports and runs about three
 * months in arrears, because zone files carry no registrar information at all.
 * Every figure of the second kind is carried with the month it describes and
 * is never presented as today's.
 *
 * TWO POPULATIONS, likewise never added together. `scope=new` is the ~1,100
 * generic TLDs delegated from the 2012 round; `scope=legacy` is .com, .net,
 * .org and the other pre-2012 generics, a population four times larger. A
 * source names one and says which in its rows.
 *
 * Three upstream traps, each covered by a test:
 *
 *  - `/overview` NEVER ANSWERS without an explicit scope, and never answers
 *    for `scope=all`: both hang until the client's timeout, while `new` and
 *    `legacy` return in under two seconds. So the scope is always sent, and
 *    the totals source refuses `all` rather than scheduling a guaranteed
 *    timeout every run.
 *  - `per` is floored at 10. Asking for three rows returns ten while the
 *    response's own `meta.per_page` says three, so a "top five movers" source
 *    that trusted the parameter would publish ten. The cap is applied here.
 *  - `detected_at` is `YYYY-MM-DD HH:MM:SS` with no zone. `new Date()` reads
 *    that as LOCAL time, which moves a midnight row into the previous day for
 *    every reader west of UTC. Parsed explicitly, and midnight -- which means
 *    "the day we noticed", not the stroke of twelve -- is kept as a date.
 */

const API = 'https://ntlddata.com/api/v1';
const SITE = 'https://ntlddata.com';
const ATTRIBUTION = 'nTLDData (ntlddata.com), CC-BY-4.0';

/** The three populations the API can be asked about. */
const SCOPES = ['new', 'legacy', 'all'];
const SCOPE_LABEL = { new: 'New gTLDs', legacy: 'Legacy gTLDs', all: 'All gTLDs' };
const SCOPE_NOUN = { new: 'new gTLDs', legacy: 'legacy gTLDs', all: 'gTLDs' };

/** New gTLDs unless a source says otherwise: it is what the site is about. */
export function scopeOf(config, { allowAll = true } = {}) {
  const s = String(config?.scope ?? '')
    .trim()
    .toLowerCase();
  if (!SCOPES.includes(s)) return 'new';
  if (s === 'all' && !allowAll) return 'new';
  return s;
}

const int = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Counts are read by people, so they are grouped. Null stays null. */
const fmt = (v) => {
  const n = int(v);
  return n === null ? null : n.toLocaleString('en-US');
};
/** A change is meaningless without its sign, including when it is zero. */
const signed = (v) => {
  const n = int(v);
  if (n === null) return null;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toLocaleString('en-US')}`;
};
const sentence = (parts) =>
  parts
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([.,])/g, '$1');
/**
 * ICANN's reporting month arrives as `202605`, which reads as a number rather
 * than a month. Rendered as `2026-05` so nobody has to parse six digits, and
 * kept raw in `data` for whoever wants to compare it.
 */
const ym = (v) => {
  const m = /^(\d{4})(\d{2})$/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${m[2]}` : null;
};
/** IDNs arrive as punycode with the Unicode form beside them; show both once. */
const tldLabel = (row) => {
  const ascii = String(row?.tld ?? '').trim();
  const uni = String(row?.unicode_name ?? '').trim();
  return uni && uni !== ascii ? `.${uni} (.${ascii})` : `.${ascii}`;
};
const tldUrl = (tld) => `${SITE}/tld/${encodeURIComponent(String(tld ?? ''))}`;

/**
 * `YYYY-MM-DD HH:MM:SS`, UTC, with the zone left off.
 *
 * A bare `new Date('2026-09-08 00:00:00')` is parsed in the reader's local
 * zone, so a midnight row lands on 7 September for anyone in the Americas.
 * Midnight in this API is a date rather than an instant -- the daily pipeline
 * stamps what it detected that day -- so it is kept as a day, and a real clock
 * time is anchored to UTC.
 */
export function apiTime(s) {
  const str = String(s ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (!m) return looseDate(str);
  if (m[2] === '00' && m[3] === '00' && m[4] === '00') return looseDate(m[1]);
  return {
    publishedAt: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`),
    timeKnown: true,
    precision: 'minute',
  };
}

/** Freshness, carried on every row so a reader never has to trust the fetch time. */
const provenance = (meta = {}) => ({
  zoneDataDate: meta.zone_data_date ?? null,
  registrarMonth: meta.registrar_month ?? null,
  dataVersion: meta.data_version ?? null,
  attribution: ATTRIBUTION,
  licence: 'CC-BY-4.0, attribution required',
});

/* ------------------------------------------------------------- daily totals -- */

/**
 * One row of the global daily series: the population and how it moved.
 *
 * The series is re-read every run and only the newest day is new, which the
 * content hash sorts out: an unchanged day costs no write. A revised day --
 * the pipeline does restate after a missed zone -- updates in place.
 */
export function toTotalsItem(row, { scope, meta }) {
  const date = String(row?.stat_date ?? '').trim();
  const domains = int(row?.domains);
  if (!date || domains === null) return null;
  const adds = int(row?.adds);
  const drops = int(row?.drops);
  /*
   * The first day of the series has adds 0, drops 0 and net 0, because there
   * was no day before it to difference against. Across a thousand registries
   * a day of literally zero registrations and zero deletions cannot happen,
   * so a flat zero on both sides is missing movement rather than a still day
   * -- and "+0 on the day" would read as the second when it is the first.
   */
  const moved = Boolean(adds) || Boolean(drops);
  const net = moved ? int(row?.net) : null;
  const label = SCOPE_LABEL[scope] ?? SCOPE_LABEL.new;
  const noun = SCOPE_NOUN[scope] ?? SCOPE_NOUN.new;
  const { publishedAt, timeKnown, precision } = looseDate(date);

  return {
    externalId: `totals-${scope}-${date}`,
    kind: 'domain-count',
    title: `${label}: ${fmt(domains)} domains${net === null ? '' : `, ${signed(net)} on the day`}`,
    summary: sentence([
      moved
        ? `${fmt(adds)} domains added and ${fmt(drops)} dropped across`
        : 'No daily movement is published for this day, across',
      `${fmt(row.tlds) ?? 'the'} ${noun} with zone data`,
      net === null ? '.' : `, a net ${net >= 0 ? 'gain' : 'loss'} of`,
      net === null ? null : `${Math.abs(net).toLocaleString('en-US')}.`,
      row.dnssec_domains ? `${fmt(row.dnssec_domains)} names are DNSSEC-signed.` : null,
      `Zone data for ${date}.`,
    ]),
    url: scope === 'new' ? `${SITE}/` : `${SITE}/?scope=${scope}`,
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'totals',
      scope === 'new' ? 'new-gtld' : scope,
      net === null ? null : net >= 0 ? 'growing' : 'shrinking',
    ].filter(Boolean),
    data: {
      scope,
      statDate: date,
      domains,
      adds: int(row.adds),
      drops: int(row.drops),
      net,
      tlds: int(row.tlds),
      dnssecDomains: int(row.dnssec_domains),
      ...provenance(meta),
    },
  };
}

export const ntldTotals = defineAdapter({
  name: 'ntld-totals',
  title: 'Domain totals, daily',
  collection: 'domains',
  description:
    'How many domains exist across the new gTLDs, and how that moved: adds, drops, net and DNSSEC signings for every day of the last four weeks. Legacy generics (.com, .net, .org) are a separate source and are never added to this one. Keyless, CC-BY.',
  docs: 'https://ntlddata.com/api',
  kinds: ['domain-count'],
  // Zone files refresh once a day; six-hourly is enough to pick the new day up
  // soon after it lands without asking for a number that cannot have changed.
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'scope',
      label: 'Population',
      type: 'select',
      // Deliberately not `all`: /overview never answers for it.
      options: ['new', 'legacy'],
      help: 'New gTLDs from the 2012 round, or the pre-2012 generics. Never both: the two are not addable.',
    },
  ],
  defaults: { scope: 'new' },
  defaultSources: [
    { slug: 'gtld-daily-totals', name: 'New gTLDs: domains, adds and drops' },
    {
      slug: 'legacy-gtld-totals',
      name: 'Legacy gTLDs: .com, .net, .org and the rest',
      config: { scope: 'legacy' },
      cadenceMinutes: 720,
    },
  ],
  async pull({ config, http, log }) {
    // `all` and a missing scope both hang this endpoint until the timeout, so
    // the parameter is always sent and never carries `all`.
    const scope = scopeOf(config, { allowAll: false });
    const res = await http.json(`${API}/overview?scope=${scope}`, { timeoutMs: 45_000 });
    const meta = res?.meta ?? {};
    const items = (res?.data?.series ?? [])
      .map((r) => toTotalsItem(r, { scope, meta }))
      .filter(Boolean);
    log(`${items.length} day(s) of ${scope} totals, zone data ${meta.zone_data_date ?? 'unknown'}`);
    return { items, note: `${items.length} days, ${scope}` };
  },
});

/* ------------------------------------------------ the register, and movement -- */

/** One TLD as a register entry: what it is, who runs it and how big it is. */
export function toTldItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  if (!tld) return null;
  const domains = int(row.domains);
  const reported = int(row.reported_domains);
  const { publishedAt, timeKnown, precision } = looseDate(row.delegated_at ?? '');

  return {
    externalId: `tld-${tld}`,
    kind: 'tld',
    title: `${tldLabel(row)}: ${domains === null ? 'no zone data' : `${fmt(domains)} domains`}`,
    summary: sentence([
      domains === null
        ? // A TLD with no CZDS approval files monthly reports and nothing else.
          `${tldLabel(row)} has no zone access, so it is not counted daily.`
        : `${tldLabel(row)} has ${fmt(domains)} domains in its zone,`,
      domains === null ? null : `${signed(row.change_1d) ?? 'no change published'} in a day`,
      domains === null ? null : `and ${signed(row.change_7d) ?? 'none published'} in a week.`,
      row.registry ? `Registry ${row.registry}.` : null,
      row.backend ? `Backend ${row.backend} (inferred).` : null,
      row.delegated_at ? `Delegated ${row.delegated_at}.` : null,
      row.root_signed ? 'Signed in the root zone.' : null,
      reported === null
        ? null
        : `ICANN's ${ym(row.reported_month) ?? 'monthly'} report puts it at ${fmt(reported)}.`,
    ]),
    url: tldUrl(tld),
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'tld',
      tld,
      row.type ?? null,
      row.is_new_gtld === false ? 'legacy' : 'new-gtld',
      row.root_signed ? 'dnssec' : null,
      // Slugified: a tag is a filter, and `backend:centralnic (team internet)`
      // is not one anybody can type.
      row.backend ? `backend:${slugify(row.backend)}` : null,
    ].filter(Boolean),
    data: {
      tld,
      unicodeName: row.unicode_name ?? tld,
      type: row.type ?? null,
      isNewGtld: row.is_new_gtld ?? null,
      domains,
      change1d: int(row.change_1d),
      change7d: int(row.change_7d),
      change30d: int(row.change_30d),
      registry: row.registry ?? null,
      backend: row.backend ?? null,
      rootSigned: row.root_signed ?? null,
      delegatedAt: row.delegated_at ?? null,
      // Never merged with `domains`: different source, different month.
      reportedDomains: reported,
      reportedMonth: row.reported_month ?? null,
      ...provenance(meta),
    },
  };
}

/** One TLD's move in a day. A separate row per zone date, so it is a series. */
export function toMovementItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  const change = int(row?.change_1d);
  const date = meta?.zone_data_date ?? null;
  if (!tld || change === null || !date) return null;
  const gained = change > 0;
  const { publishedAt, timeKnown, precision } = looseDate(date);

  return {
    // One move per TLD per zone date. A restated day updates rather than
    // duplicates; tomorrow is a new row.
    externalId: `move-${tld}-${date}`,
    kind: 'tld-movement',
    title: `${tldLabel(row)} ${gained ? 'gained' : 'lost'} ${Math.abs(change).toLocaleString('en-US')} domains in a day`,
    summary: sentence([
      `${tldLabel(row)} ${gained ? 'grew by' : 'shrank by'} ${Math.abs(change).toLocaleString('en-US')} domains on ${date},`,
      `to ${fmt(row.domains) ?? 'an uncounted total'}.`,
      row.change_7d === null || row.change_7d === undefined
        ? null
        : `Over seven days: ${signed(row.change_7d)}.`,
      row.registry ? `Registry ${row.registry}.` : null,
    ]),
    url: tldUrl(tld),
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'movement',
      tld,
      gained ? 'growing' : 'shrinking',
      row.type ?? null,
      row.is_new_gtld === false ? 'legacy' : 'new-gtld',
    ].filter(Boolean),
    data: {
      tld,
      statDate: date,
      change1d: change,
      change7d: int(row.change_7d),
      domains: int(row.domains),
      registry: row.registry ?? null,
      backend: row.backend ?? null,
      ...provenance(meta),
    },
  };
}

/**
 * Which rows are a story: the biggest movers, at the size the operator set.
 *
 * `per` is floored at ten upstream, so the cap is applied here rather than
 * asked for -- a source configured for the top five otherwise publishes ten.
 */
export function pickMovers(rows, { direction, minChange, limit }) {
  const wanted = direction === 'droppers' ? -1 : 1;
  return rows
    .filter((r) => {
      const c = int(r?.change_1d);
      return c !== null && Math.sign(c) === wanted && Math.abs(c) >= minChange;
    })
    .slice(0, limit);
}

export const ntldTlds = defineAdapter({
  name: 'ntld-tlds',
  title: 'TLDs: the register and the movers',
  collection: 'domains',
  description:
    'Every generic top-level domain with its domain count, registry operator, inferred backend and root signing, plus the biggest daily gainers and fallers. Counts come from zone files and are a day old; any registrar figure is carried with the month it describes. Keyless, CC-BY.',
  docs: 'https://ntlddata.com/api',
  kinds: ['tld', 'tld-movement'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'mode',
      label: 'What to pull',
      type: 'select',
      options: ['register', 'gainers', 'droppers'],
      help: 'The whole register, or only the TLDs that moved most in the last day.',
    },
    {
      key: 'scope',
      label: 'Population',
      type: 'select',
      options: ['new', 'legacy', 'all'],
      help: 'New gTLDs, the pre-2012 generics, or both listed side by side.',
    },
    {
      key: 'minChange',
      label: 'Minimum daily change',
      type: 'number',
      placeholder: '100',
      help: 'Movers only: ignore anything that moved by less than this many domains.',
    },
    {
      key: 'limit',
      label: 'How many movers',
      type: 'number',
      placeholder: '25',
    },
  ],
  defaults: { mode: 'register', scope: 'new' },
  defaultSources: [
    {
      slug: 'tld-register',
      name: 'Every gTLD, with registry and backend',
      config: { mode: 'register' },
      // A register, not a wire: twice a day is plenty and the sweep is three
      // requests of five hundred rows.
      cadenceMinutes: 720,
    },
    {
      slug: 'fastest-growing-tlds',
      name: 'Fastest growing TLDs',
      config: { mode: 'gainers', minChange: '250', limit: '25' },
    },
    {
      slug: 'shrinking-tlds',
      name: 'TLDs losing the most domains',
      config: { mode: 'droppers', minChange: '250', limit: '25' },
    },
  ],
  async pull({ config, http, log }) {
    const scope = scopeOf(config);
    const mode = ['gainers', 'droppers'].includes(config.mode) ? config.mode : 'register';

    if (mode === 'register') {
      const items = [];
      let meta = {};
      // Five hundred at a time, as the API asks callers to do rather than
      // fetching eleven hundred single-TLD pages. The last page is short.
      for (let page = 1; page <= 4; page++) {
        const url = `${API}/tld?scope=${scope}&per=500&page=${page}&sort=latest_domains`;
        const res = await http.json(url, { timeoutMs: 60_000 });
        meta = res?.meta ?? meta;
        const rows = res?.data ?? [];
        for (const r of rows) {
          const item = toTldItem(r, { meta });
          if (item) items.push(item);
        }
        if (rows.length < 500 || items.length >= (int(meta.total) ?? 0)) break;
      }
      log(`${items.length} ${scope} TLD(s) in the register`);
      return { items, note: `${items.length} TLDs (${scope})` };
    }

    const minChange = Math.max(0, int(config.minChange) ?? 0);
    const limit = Math.min(Math.max(1, int(config.limit) ?? 25), 100);
    // Sorted at the end we want; `dir=asc` puts the biggest losers first.
    const dir = mode === 'droppers' ? 'asc' : 'desc';
    const res = await http.json(
      `${API}/tld?scope=${scope}&sort=change_1d&dir=${dir}&per=100&page=1`,
      { timeoutMs: 45_000 },
    );
    const meta = res?.meta ?? {};
    const items = pickMovers(res?.data ?? [], { direction: mode, minChange, limit })
      .map((r) => toMovementItem(r, { meta }))
      .filter(Boolean);
    log(`${items.length} ${mode} on ${meta.zone_data_date ?? 'an unstated date'}`);
    return { items, note: `${items.length} ${mode}` };
  },
});

/* --------------------------------------------------------- root and pipeline -- */

/** A string that reached the root zone. Rare now, and the point of the round. */
export function toDelegationItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  const at = row?.delegated_at ?? row?.date ?? null;
  if (!tld || !at) return null;
  const { publishedAt, timeKnown, precision } = looseDate(at);

  return {
    externalId: `delegated-${tld}`,
    kind: 'delegation',
    title: `${tldLabel(row)} was delegated to the root zone`,
    summary: sentence([
      `${tldLabel(row)} entered the root zone on ${at}`,
      row.type ? `as a ${row.type} TLD.` : '.',
      row.latest_domains ? `It holds ${fmt(row.latest_domains)} domains today.` : null,
      row.monthly_domains && row.monthly_ym
        ? `ICANN's ${ym(row.monthly_ym)} report puts it at ${fmt(row.monthly_domains)}.`
        : null,
    ]),
    url: tldUrl(tld),
    publishedAt,
    timeKnown,
    precision,
    tags: ['delegation', tld, row.type ?? null].filter(Boolean),
    data: {
      tld,
      unicodeName: row.unicode_name ?? tld,
      type: row.type ?? null,
      delegatedAt: at,
      domains: int(row.latest_domains),
      reportedDomains: int(row.monthly_domains),
      reportedMonth: row.monthly_ym ?? null,
      ...provenance(meta),
    },
  };
}

/**
 * A launch window: sunrise or claims, with the dates the registry filed.
 *
 * Dated in the future while it is still to open, which is what makes it worth
 * following -- a trademark holder acts before the window, not after it.
 */
export function toPhaseItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  const phase = String(row?.phase ?? '').trim();
  if (!tld || !phase) return null;
  const opens = row.opens_at ?? null;
  const closes = row.closes_at ?? null;
  const { publishedAt, timeKnown, precision } = looseDate(opens ?? closes ?? '');

  return {
    externalId: `phase-${tld}-${phase}-${opens ?? closes ?? 'undated'}`,
    kind: 'launch-phase',
    title: `${tldLabel(row)}: ${phase}${opens && closes ? `, ${opens} to ${closes}` : opens ? ` opens ${opens}` : ''}`,
    summary: sentence([
      `${tldLabel(row)} is in ${phase === 'claims' ? 'its claims period' : `a ${phase} period`}`,
      row.variant ? `(${row.variant})` : null,
      opens ? `from ${opens}` : null,
      closes ? `to ${closes}.` : '.',
      row.registry_name ? `Run by ${row.registry_name}.` : null,
      row.latest_domains !== null && row.latest_domains !== undefined
        ? `${fmt(row.latest_domains)} domains registered so far.`
        : null,
    ]),
    url: `${SITE}/upcoming`,
    publishedAt,
    timeKnown,
    precision,
    tags: ['launch', tld, phase.toLowerCase()].filter(Boolean),
    data: {
      tld,
      unicodeName: row.unicode_name ?? tld,
      phase,
      variant: row.variant ?? null,
      opensAt: opens,
      closesAt: closes,
      registry: row.registry_name ?? null,
      domains: int(row.latest_domains),
      ...provenance(meta),
    },
  };
}

/** A string under contract with ICANN that has not reached the root yet. */
export function toContractedItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  if (!tld) return null;
  const at = row.agreement_date ?? null;
  const { publishedAt, timeKnown, precision } = looseDate(at ?? '');
  const types = String(row.agreement_type ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    externalId: `contracted-${tld}`,
    kind: 'contracted',
    title: `${tldLabel(row)} is contracted but not yet delegated`,
    summary: sentence([
      `${tldLabel(row)} has a registry agreement with ICANN`,
      at ? `signed ${at}` : null,
      'but has not been delegated to the root zone.',
      types.length ? `Agreement: ${types.join(', ')}.` : null,
      row.registry_name ? `Registry ${row.registry_name}.` : null,
    ]),
    url: `${SITE}/upcoming`,
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'contracted',
      tld,
      row.is_brand === '1' || row.is_brand === 1 ? 'brand' : null,
      row.is_community === '1' || row.is_community === 1 ? 'community' : null,
    ].filter(Boolean),
    data: {
      tld,
      unicodeName: row.unicode_name ?? tld,
      agreementDate: at,
      agreementType: types,
      registry: row.registry_name ?? null,
      ...provenance(meta),
    },
  };
}

/** A TLD whose operator is being replaced, usually by ICANN's emergency operator. */
export function toTransitionItem(row, { meta } = {}) {
  const tld = String(row?.tld ?? '').trim();
  if (!tld) return null;
  const at = row.agreement_date ?? null;
  const { publishedAt, timeKnown, precision } = looseDate(at ?? '');

  return {
    externalId: `transition-${tld}`,
    kind: 'transition',
    title: `${tldLabel(row)} is in a registry transition`,
    summary: sentence([
      `${tldLabel(row)} is being run by ${row.registry_name ?? 'a transitional operator'}`,
      'while its registry changes hands.',
      row.latest_domains !== null && row.latest_domains !== undefined
        ? `${fmt(row.latest_domains)} domains are in the zone.`
        : null,
      at ? `Original agreement ${at}.` : null,
    ]),
    url: `${SITE}/upcoming`,
    publishedAt,
    timeKnown,
    precision,
    tags: ['transition', tld],
    data: {
      tld,
      unicodeName: row.unicode_name ?? tld,
      registry: row.registry_name ?? null,
      agreementDate: at,
      domains: int(row.latest_domains),
      reportedDomains: int(row.monthly_domains),
      reportedMonth: row.monthly_ym ?? null,
      ...provenance(meta),
    },
  };
}

export const ntldLaunches = defineAdapter({
  name: 'ntld-launches',
  title: 'Root delegations and the launch pipeline',
  collection: 'domains',
  description:
    'Strings entering the root zone, and what is queued behind them: sunrise and claims windows with the dates registries filed with ICANN, TLDs contracted but not yet delegated, and registries being transitioned to another operator. Keyless, CC-BY.',
  docs: 'https://ntlddata.com/upcoming',
  kinds: ['delegation', 'launch-phase', 'contracted', 'transition'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'mode',
      label: 'What to pull',
      type: 'select',
      options: ['launches', 'delegations'],
      help: 'The forward pipeline, or the strings already delegated to the root.',
    },
    {
      key: 'scope',
      label: 'Population',
      type: 'select',
      options: ['new', 'legacy', 'all'],
    },
  ],
  defaults: { mode: 'launches', scope: 'new' },
  defaultSources: [
    { slug: 'tld-launch-calendar', name: 'Sunrise, claims and the launch pipeline' },
    {
      slug: 'tld-delegations',
      name: 'New TLDs in the root zone',
      config: { mode: 'delegations' },
      // Delegation all but stopped after the 2012 round -- the newest string
      // in the root is years old, and this wakes up again with the next round.
      cadenceMinutes: 720,
    },
  ],
  async pull({ config, http, log }) {
    const scope = scopeOf(config);
    const mode = config.mode === 'delegations' ? 'delegations' : 'launches';

    if (mode === 'delegations') {
      const res = await http.json(`${API}/calendar?scope=${scope}`, { timeoutMs: 45_000 });
      const meta = res?.meta ?? {};
      const data = res?.data ?? {};
      // `events` is the dated change log and `newest` the most recently
      // delegated strings. The first is empty in a year with no new round;
      // both are read so neither has to be the only one that works.
      const rows = [...(data.events ?? []), ...(data.newest ?? [])];
      const items = [];
      const seen = new Set();
      for (const r of rows) {
        const item = toDelegationItem(r, { meta });
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }
      log(`${items.length} delegation(s)`);
      return { items, note: `${items.length} delegations` };
    }

    const res = await http.json(`${API}/upcoming?scope=${scope}`, { timeoutMs: 45_000 });
    const meta = res?.meta ?? {};
    const data = res?.data ?? {};
    const items = [
      ...(data.phases ?? []).map((r) => toPhaseItem(r, { meta })),
      ...(data.contracted ?? []).map((r) => toContractedItem(r, { meta })),
      ...(data.transitions ?? []).map((r) => toTransitionItem(r, { meta })),
    ].filter(Boolean);
    log(
      `${data.phases?.length ?? 0} phase(s), ${data.contracted?.length ?? 0} contracted, ${data.transitions?.length ?? 0} transitioning`,
    );
    return { items, note: `${items.length} pipeline rows` };
  },
});

/* ------------------------------------------------------------------ changes -- */

/** What each detected change is, in words. Unknown kinds keep their raw name. */
const CHANGE_LABELS = {
  tld_operator_changed: 'changed registry operator',
  tld_backend_changed: 'changed registry backend',
  tld_renamed: 'was renamed',
  registrar_platform_moved: 'moved registry platform',
  registrar_status: 'changed accreditation status',
  registrar_renamed: 'was renamed',
  registrar_merged: 'was merged into another registrar',
};

/**
 * An observed change of hands.
 *
 * ICANN publishes no machine-readable record of mergers or reassignments, so
 * these are inferences from IANA's root database and registrar list rather
 * than announcements. Rows the upstream flags for review are tagged as such
 * instead of being dropped or presented as settled.
 */
export function toChangeItem(row, { meta } = {}) {
  const type = String(row?.entity_type ?? '').trim();
  const key = String(row?.entity_key ?? '').trim();
  const kind = String(row?.change_kind ?? '').trim();
  const at = row?.detected_at ?? null;
  if (!type || !key || !kind || !at) return null;

  const label = type === 'tld' ? `.${row.entity_label ?? key}` : (row.entity_label ?? key);
  const what = CHANGE_LABELS[kind] ?? kind.replace(/_/g, ' ');
  const from = row.old_value ?? null;
  const to = row.new_value ?? null;
  const needsReview =
    row.needs_review === '1' || row.needs_review === 1 || row.needs_review === true;
  const { publishedAt, timeKnown, precision } = apiTime(at);

  return {
    // Detected date included: the same registrar can move platform twice.
    externalId: `change-${type}-${key}-${kind}-${row.field ?? 'field'}-${String(at).slice(0, 10)}`,
    kind: 'registry-change',
    title: `${label} ${what}${from || to ? `: ${from ?? 'nothing'} → ${to ?? 'nothing'}` : ''}`,
    summary: sentence([
      `${label} ${what} on ${String(at).slice(0, 10)},`,
      `observed in ${row.source ?? 'a public register'}`,
      row.field ? `as a change to ${row.field}` : null,
      from || to ? `from ${from ?? 'nothing'} to ${to ?? 'nothing'}.` : '.',
      row.note ? String(row.note) : null,
      needsReview ? 'Flagged for review: this is an observation, not an announcement.' : null,
    ]),
    url: type === 'tld' ? tldUrl(key) : `${SITE}/changes`,
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'change',
      type,
      kind.replace(/_/g, '-'),
      type === 'tld' ? key : `registrar-${key}`,
      needsReview ? 'needs-review' : null,
    ].filter(Boolean),
    data: {
      entityType: type,
      entityKey: key,
      entityLabel: row.entity_label ?? null,
      changeKind: kind,
      field: row.field ?? null,
      oldValue: from,
      newValue: to,
      detectedAt: at,
      observedIn: row.source ?? null,
      needsReview,
      note: row.note ?? null,
      ...provenance(meta),
    },
  };
}

export const ntldChanges = defineAdapter({
  name: 'ntld-changes',
  title: 'Registry and registrar changes',
  collection: 'domains',
  description:
    'TLDs changing operator, registrars moving platform, accreditations granted and terminated: identity changes detected in IANA’s root database and registrar list. Observations rather than announcements, and the uncertain ones say so. Keyless, CC-BY.',
  docs: 'https://ntlddata.com/changes',
  kinds: ['registry-change'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'entityType',
      label: 'Only',
      type: 'select',
      options: ['', 'tld', 'registrar'],
      help: 'Restrict to TLD operator changes, or to registrar changes.',
    },
    {
      key: 'reviewedOnly',
      label: 'Exclude flagged rows',
      type: 'select',
      options: ['', 'yes'],
      help: 'Drop the changes the upstream marks as needing human review.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'registry-changes', name: 'Registries and registrars changing hands' },
    {
      slug: 'tld-operator-changes',
      name: 'TLDs changing operator',
      config: { entityType: 'tld' },
      cadenceMinutes: 720,
    },
  ],
  async pull({ config, http, log }) {
    const res = await http.json(`${API}/changes`, { timeoutMs: 45_000 });
    const meta = res?.meta ?? {};
    let items = (res?.data ?? []).map((r) => toChangeItem(r, { meta })).filter(Boolean);
    if (config.entityType) items = items.filter((i) => i.data.entityType === config.entityType);
    if (config.reviewedOnly === 'yes') items = items.filter((i) => !i.data.needsReview);
    log(`${items.length} change(s)`);
    return { items, note: `${items.length} changes` };
  },
});
