import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Who the bank in the complaint actually is, and what has happened to it.
 *
 * The FDIC's BankFind API is the register of every US insured institution --
 * 4,235 active ones, their charter class, their regulator, their assets and
 * their address -- plus two event streams over it: 584,000 structure changes
 * (mergers, acquisitions, name changes, relocations, charter conversions) and
 * every bank failure since 1934. Keyless, JSON, and updated daily.
 *
 * It is here because `cfpb-complaints` names companies and identifies none of
 * them. A complaint against a bank that was absorbed eighteen months ago is a
 * complaint against whoever absorbed it, and the structure-change feed is the
 * only public record of that. Consolidation is also the story: roughly a
 * hundred and fifty US banks disappear into other banks every year, which is
 * why a directory of them is worth keeping rather than a snapshot.
 *
 * TWO ADAPTERS, ONE UPSTREAM
 *
 * The register and the events are different shapes and different cadences, so
 * they are separate adapters over the same host rather than one adapter with a
 * mode switch: an institution is a thing that exists, an acquisition is
 * something that happened on a date, and a feed of the first sorted by date
 * would be meaningless.
 */

const BASE = 'https://api.fdic.gov/banks';

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/**
 * A dollar figure from a field the API reports in thousands.
 *
 * Guarded before the cast, because `Number(null)` is 0 and a bank with no
 * assets reported would otherwise be published as a bank with no assets.
 */
export function thousands(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : null;
}

export function money(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}tn`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * The FDIC writes dates as `7/17/2026` in some fields and `20260717` in others.
 * Both, and an ISO one, reach here.
 */
export function fdicDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === '0') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const packed = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (packed) return `${packed[1]}-${packed[2]}-${packed[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const p = (n) => String(n).padStart(2, '0');
    return `${us[3]}-${p(us[1])}-${p(us[2])}`;
  }
  return null;
}

/* ----------------------------------------------------------- institutions */

export function institutionItem(row) {
  const d = row?.data ?? row;
  const cert = clean(d?.CERT);
  const name = clean(d?.NAME);
  if (!cert || !name) return null;

  const assets = thousands(d.ASSET);
  const established = fdicDate(d.ESTYMD);
  const active = String(d.ACTIVE ?? '') === '1';
  const city = clean(d.CITY);
  const state = clean(d.STALP);
  const regulator = clean(d.REGAGNT);
  /* The charter class is `BKCLASS`, not `CLASS`: BankFind's institution
   * endpoint has no `CLASS` field at all, so a reader that asked for one would
   * quietly file every bank in the country as unclassified. */
  const bankClass = clean(d.BKCLASS);
  const changed = fdicDate(d.RUNDATE) ?? fdicDate(d.PROCDATE) ?? established;

  return {
    externalId: `fdic-cert-${cert}`,
    kind: 'institution',
    title:
      `${name}${city ? ` — ${city}, ${state ?? ''}` : ''}${assets ? ` (${money(assets)})` : ''}`.trim(),
    summary: [
      `${name} is an FDIC-insured ${bankClass ? `${bankClass} ` : ''}institution`,
      city ? ` in ${city}${state ? `, ${state}` : ''}` : '',
      assets ? `, holding ${money(assets)} in assets` : '',
      established ? `, established ${established}` : '',
      regulator ? `, regulated by ${regulator}` : '',
      active ? '.' : '. It is no longer active.',
    ].join(''),
    url: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${cert}`,
    publishedAt: changed ?? established,
    timeKnown: false,
    precision: 'day',
    tags: [
      'consumer-finance',
      'bank',
      'us',
      slugify(name).slice(0, 60),
      state ? state.toLowerCase() : null,
      bankClass ? `class:${slugify(bankClass)}` : null,
      regulator ? `regulator:${slugify(regulator)}` : null,
      active ? 'active' : 'inactive',
      assets && assets >= 1e11 ? 'assets:100bn-plus' : null,
      assets && assets >= 1e10 && assets < 1e11 ? 'assets:10bn-plus' : null,
    ].filter(Boolean),
    data: {
      cert,
      name,
      nameKey: slugify(name),
      active,
      class: bankClass,
      specialisation: clean(d.SPECGRPN),
      regulator,
      charterClass: clean(d.CHARTER),
      assets,
      deposits: thousands(d.DEP),
      equity: thousands(d.EQ),
      offices: Number(d.OFFICES) || null,
      establishedOn: established,
      insuredOn: fdicDate(d.EFFDATE),
      website: clean(d.WEBADDR),
      holdingCompany: clean(d.NAMEHCR),
      place: {
        country: 'US',
        state,
        stateName: clean(d.STNAME),
        city,
        address: clean(d.ADDRESS),
        zip: clean(d.ZIP),
        county: clean(d.COUNTY),
      },
      source: 'FDIC BankFind',
      dataset: `${BASE}/institutions`,
    },
  };
}

export const fdicInstitutions = defineAdapter({
  name: 'fdic-institutions',
  title: 'FDIC insured institutions',
  collection: 'consumer-finance',
  description:
    'Every FDIC-insured bank and thrift: charter class, regulator, assets, deposits, holding company and address, keyed on the certificate number the FDIC identifies it by. The register that turns a company name in a complaint into an institution. Keyless.',
  docs: 'https://api.fdic.gov/banks/docs/',
  kinds: ['institution'],
  cadenceMinutes: 60 * 24,
  configFields: [
    {
      key: 'activeOnly',
      label: 'Active only',
      type: 'select',
      options: ['yes', ''],
      help: 'Empty includes institutions that have closed.',
    },
    { key: 'state', label: 'Only this state', help: 'Two-letter code.' },
    { key: 'maxPages', label: 'Pages per run', type: 'number', help: '1,000 a page. Default 6.' },
  ],
  defaults: { activeOnly: 'yes' },
  defaultSources: [{ slug: 'fdic-institutions', name: 'FDIC insured institutions' }],
  async pull({ config, cursor, http, log, deadline }) {
    const limit = 1000;
    const maxPages = Math.max(1, Math.min(Number(config.maxPages) || 6, 20));
    const filters = [];
    if (String(config.activeOnly ?? 'yes') === 'yes') filters.push('ACTIVE:1');
    if (config.state) filters.push(`STALP:${String(config.state).toUpperCase()}`);

    const items = [];
    let total = 0;
    for (let page = 0; page < maxPages; page += 1) {
      if (Date.now() > deadline) break;
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        format: 'json',
        sort_by: 'CERT',
        sort_order: 'ASC',
      });
      if (filters.length) params.set('filters', filters.join(' AND '));
      const body = await http.json(`${BASE}/institutions?${params}`, { timeoutMs: 60_000 });
      const rows = body?.data;
      if (!Array.isArray(rows)) throw new Error('BankFind did not return a data array');
      total = Number(body?.meta?.total) || total;
      for (const row of rows) {
        const item = institutionItem(row);
        if (item) items.push(item);
      }
      if (rows.length < limit) break;
    }

    log(`${items.length} institution(s) of ${total || 'unknown'} in the register`);
    return {
      items,
      cursor: { ...cursor, readAt: new Date().toISOString() },
      note: `${items.length} banks`,
    };
  },
});

/* ------------------------------------------------------ structure changes */

/**
 * What the FDIC calls the event, coarsened into something a feed can be
 * filtered on.
 *
 * The register does publish a "what happened" field -- `CHANGECODE` with a
 * `CHANGECODE_DESC` beside it -- and it is the field to read. The boolean
 * flags that also ride along on every row (`RELOCATE_FLAG`, `NEW_CHARTER_FLAG`
 * and twenty more) are all zero on the great majority of transactions,
 * including on mergers, so a reader built on them would report almost nothing
 * happening while the register recorded five thousand events a year.
 *
 * The leading digit is the family: 2xx a merger or absorption, 3xx and 4xx a
 * change of membership, charter or regulator, 5xx a change of name or address,
 * 7xx something happening to a branch, 8xx participation in someone else's
 * reorganisation. Most of the volume is 7xx, which is the interesting part:
 * branch openings and closings are where a bank's retreat from a town is
 * visible years before anything is written about it.
 */
export const CHANGE_FAMILIES = [
  [/^1/, 'establishment'],
  [/^2/, 'merger'],
  [/^3/, 'membership'],
  [/^4/, 'charter'],
  [/^5/, 'name-or-location'],
  [/^6/, 'closing'],
  [/^7/, 'branch'],
  [/^8/, 'reorganisation'],
];

/** The handful of codes worth their own tag, because they are the ones people search for. */
export const NOTABLE_CODES = {
  711: 'branch-opening',
  712: 'branch-purchased',
  713: 'branch-acquired-in-merger',
  721: 'branch-closing',
  722: 'branch-sold',
  223: 'merger-without-assistance',
  224: 'affiliated-merger',
  510: 'name-change',
  520: 'relocation',
  430: 'class-change',
  470: 'regulator-change',
  810: 'absorbed',
  820: 'corporate-reorganisation',
};

export function familyOf(code) {
  const s = String(code ?? '').trim();
  for (const [re, name] of CHANGE_FAMILIES) if (re.test(s)) return name;
  return 'other';
}

export function changeItem(row) {
  const d = row?.data ?? row;
  const trans = clean(d?.TRANSNUM);
  const name = clean(d?.INSTNAME);
  const when = fdicDate(d?.PROCDATE) ?? fdicDate(d?.EFFDATE);
  if (!trans || !name || !when) return null;

  /* A transaction number is NOT a row: one merger writes a row for every
   * institution and every office it touches, and 1,702 changes read in one run
   * carried only 1,169 distinct transaction numbers. Keyed on TRANSNUM alone, a
   * third of the register would overwrite the other two thirds and the loss
   * would look exactly like a quiet quarter. `ID` is the row, and where the
   * register omits it the office and institution numbers rebuild one. */
  const rowId =
    clean(d?.ID) ??
    [trans, clean(d?.UNINUM), clean(d?.OFF_NUM), clean(d?.CHANGECODE)].filter(Boolean).join('_');

  const code = clean(d.CHANGECODE);
  const what = clean(d.CHANGECODE_DESC) ?? 'Change on the FDIC register';
  const family = familyOf(code);
  const branch = clean(d.OFF_NAME);
  const formerBranch = clean(d.FRM_OFF_NAME);
  const city = clean(d.OFF_PCITY) ?? clean(d.PCITY);
  const state = clean(d.OFF_PSTALP) ?? clean(d.PSTALP);
  const where = [city, state].filter(Boolean).join(', ');
  // A branch event is about the branch; an institution event is about the bank.
  const subject = family === 'branch' && branch ? `${name} — ${branch}` : name;

  return {
    externalId: `fdic-change-${rowId}`,
    kind: 'structure-change',
    title: `${subject}${where ? `, ${where}` : ''}: ${what}`,
    summary: [
      `${what} recorded by the FDIC for ${name}`,
      branch ? `, ${branch}` : '',
      where ? ` in ${where}` : '',
      `. Effective ${fdicDate(d.EFFDATE) ?? when}, processed ${when}.`,
      formerBranch && formerBranch !== branch ? ` Previously ${formerBranch}.` : '',
    ].join(''),
    url: clean(d.CERT)
      ? `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${clean(d.CERT)}`
      : 'https://banks.data.fdic.gov/bankfind-suite/',
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: [
      'consumer-finance',
      'bank',
      'us',
      'structure-change',
      slugify(name).slice(0, 60),
      state ? state.toLowerCase() : null,
      city ? slugify(city).slice(0, 40) : null,
      family,
      code && NOTABLE_CODES[code] ? NOTABLE_CODES[code] : null,
      code ? `code:${code}` : null,
    ].filter(Boolean),
    data: {
      rowId,
      transactionNumber: trans,
      cert: clean(d.CERT),
      name,
      nameKey: slugify(name),
      changeCode: code,
      change: what,
      changeFamily: family,
      changeBasis:
        'CHANGECODE and CHANGECODE_DESC are the FDIC’s own classification; changeFamily is a coarsening of the code’s leading digit so a family can be filtered on.',
      branch,
      formerBranch,
      effectiveOn: fdicDate(d.EFFDATE),
      processedOn: fdicDate(d.PROCDATE),
      endedOn: fdicDate(d.ENDDATE),
      class: clean(d.CLASS_TYPE_DESC),
      formerClass: clean(d.FRM_CLASS_TYPE_DESC),
      regulator: clean(d.REGAGENT),
      formerRegulator: clean(d.FRM_REGAGENT),
      place: {
        country: 'US',
        state,
        city,
        county: clean(d.OFF_CNTYNAME) ?? clean(d.CNTYNAME),
        address: clean(d.OFF_PADDR) ?? clean(d.PADDR),
        zip: clean(d.OFF_PZIP5) ?? clean(d.PZIP5),
        lat: Number(d.OFF_LATITUDE) || Number(d.LATITUDE) || null,
        lon: Number(d.OFF_LONGITUDE) || Number(d.LONGITUDE) || null,
      },
      source: 'FDIC BankFind structure changes',
      dataset: `${BASE}/history`,
    },
  };
}

export const fdicStructureChanges = defineAdapter({
  name: 'fdic-structure-changes',
  title: 'FDIC bank structure changes',
  collection: 'consumer-finance',
  description:
    'Mergers, acquisitions, failures, charter conversions, name changes and relocations on the FDIC register, as they are processed — the public record of American bank consolidation, and the only way to know which institution a complaint about a bank that no longer exists now belongs to. Keyless.',
  docs: 'https://api.fdic.gov/banks/docs/',
  kinds: ['structure-change'],
  cadenceMinutes: 60 * 6,
  configFields: [
    { key: 'state', label: 'Only this state', help: 'Two-letter code.' },
    { key: 'maxPages', label: 'Pages per run', type: 'number', help: '1,000 a page. Default 3.' },
    { key: 'days', label: 'Days to read on a first run', type: 'number', help: 'Default 90.' },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'fdic-structure-changes', name: 'FDIC bank mergers, failures and conversions' },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const limit = 1000;
    const maxPages = Math.max(1, Math.min(Number(config.maxPages) || 3, 20));
    const days = Math.max(1, Math.min(Number(config.days) || 90, 3650));
    const since =
      cursor.since ?? new Date(Date.now() - days * 24 * 3_600_000).toISOString().slice(0, 10);

    /* PROCDATE is when the FDIC recorded the change and is the only field that
     * moves monotonically -- EFFDATE is when it took effect and can be
     * backdated by months, so a feed keyed on it would miss transactions that
     * arrive late. The filter is a range because BankFind has no ">" operator. */
    const filters = [`PROCDATE:[${since.replace(/-/g, '')} TO 99991231]`];
    if (config.state) filters.push(`PSTALP:${String(config.state).toUpperCase()}`);

    const items = [];
    let newest = since;
    for (let page = 0; page < maxPages; page += 1) {
      if (Date.now() > deadline) break;
      const params = new URLSearchParams({
        filters: filters.join(' AND '),
        limit: String(limit),
        offset: String(page * limit),
        format: 'json',
        sort_by: 'PROCDATE',
        sort_order: 'DESC',
      });
      const body = await http.json(`${BASE}/history?${params}`, { timeoutMs: 60_000 });
      const rows = body?.data;
      if (!Array.isArray(rows)) throw new Error('BankFind history did not return a data array');
      for (const row of rows) {
        const item = changeItem(row);
        if (!item) continue;
        if (item.publishedAt > newest) newest = item.publishedAt;
        items.push(item);
      }
      if (rows.length < limit) break;
    }

    log(`${items.length} structure change(s) since ${since}, newest ${newest}`);
    return { items, cursor: { since: newest }, note: `${items.length} changes` };
  },
});
