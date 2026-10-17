import { Resolver } from 'node:dns/promises';
import { config } from '@nichedb/config';
import { authoritativeResolveFor, decodeZone, ZONES, zoneLookup } from './dnsbl.js';

export { decodeZone, ZONES, zoneLookup };

/**
 * The business standing report: one company, every list it could be on.
 *
 * A name, a domain, an EIN or a state entity number in; out comes where the
 * business stands with each authority that keeps a list a customer, a bank or
 * a mail server might check:
 *
 * - SANCTIONS. Every entry on the US Treasury's OFAC lists (the SDN list and
 *   the consolidated non-SDN lists), with every alias, matched by name. US
 *   public domain, downloaded whole and held a day.
 * - REGISTRY. The legal-entity record wherever one is public without a key:
 *   GLEIF (every LEI in the world, CC0) and SEC EDGAR (every filer, including
 *   the Form D a private raise leaves). OpenCorporates and SAM.gov exclusions
 *   are read when their keys are configured. State registries that refuse
 *   scripted lookups (California's bizfile and FTB among them) are linked for
 *   the reader to open, because a guessed status is worse than none.
 * - DOMAIN. Who holds the name over RDAP, and, when enabled, the domain and
 *   the address it serves from against the reputation lists mail filters use
 *   (Spamhaus DBL and ZEN, URIBL, SURBL) and Google Safe Browsing.
 *
 * The rule carried over from the VIN report: a check that did not run is never
 * a clean result. Every section says `checked`, `unconfigured` or `unknown`,
 * and the report's standing is `clear` only when every section was checked
 * and none of them found anything.
 *
 * TERMS. The reputation lists' free query services exclude products that
 * charge a fee, and Google's Safe Browsing lookup is for non-commercial use.
 * So they are off unless BUSINESS_BLOCKLISTS is set by an operator who has the
 * right to query them (a Spamhaus DQS key, a SURBL or URIBL licence, or a
 * deployment that does not charge), and when off the section links the free
 * self-service checks instead.
 *
 * Blocklist answers come from ./dnsbl.js, which asks each zone's own
 * nameservers and proves each zone with its test entry first.
 */

const UA = `nichedb.dev business (+${config.siteUrl ?? 'https://nichedb.dev'})`;
const TIMEOUT_MS = 12_000;

/* ------------------------------------------------------------------ input -- */

/** A bare host from a URL, an email address or a name, or null. */
export function normaliseDomain(raw) {
  let s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  if (s.includes('@')) s = s.split('@').pop();
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return s;
}

/** An EIN as NN-NNNNNNN, or null. */
export function normaliseEin(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : null;
}

/** A US state as its two-letter code, lower case, or null. */
export function normaliseState(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : null;
}

/** A state entity number without the C/LLC letter prefix California prints on old ones. */
export function normaliseEntityNumber(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^[A-Z]{0,3}(\d{5,12})$/);
  return m ? m[1] : /^[A-Z0-9-]{3,20}$/.test(s) ? s : null;
}

/** What a request asked about, cleaned. A name of one character is no name. */
export function normaliseInput(input = {}) {
  const name = String(input.name ?? input.q ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return {
    name: name.length >= 2 ? name : null,
    domain: normaliseDomain(input.domain),
    ein: normaliseEin(input.ein),
    state: normaliseState(input.state),
    number: normaliseEntityNumber(input.number),
  };
}

export const hasInput = (i) => Boolean(i.name || i.domain || i.ein || i.number);

/** A stable key for the cache: the same question asked twice is answered once. */
export const inputKey = (i) =>
  [i.name?.toLowerCase(), i.domain, i.ein, i.state, i.number].map((v) => v ?? '').join('|');

/* -------------------------------------------------------------- matching -- */

/** Words that say what kind of company it is, not which. */
const ENTITY_WORDS = new Set(
  'inc incorporated corp corporation co company companies llc l l c ltd limited plc lp llp pc pllc gmbh ag sa sas srl bv nv oy ab as kk the and of'.split(
    ' ',
  ),
);

/** A name reduced to the words that identify it: lower case, no punctuation, no Inc. */
export function nameTokens(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !ENTITY_WORDS.has(w));
}

export const normaliseName = (raw) => nameTokens(raw).join(' ');

/**
 * How well a listed name answers a query: `exact` when they reduce to the same
 * words, `possible` when every word of the shorter is in the longer and the
 * shorter still has two words (one shared word is a coincidence, not a match),
 * otherwise null.
 */
export function nameMatch(query, listed) {
  const a = nameTokens(query);
  const b = nameTokens(listed);
  if (!a.length || !b.length) return null;
  if (a.join(' ') === b.join(' ')) return 'exact';
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2) return null;
  const set = new Set(long);
  return short.every((w) => set.has(w)) ? 'possible' : null;
}

/* ------------------------------------------------------------- sanctions -- */

const OFAC_BASE = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports';
export const OFAC_FILES = {
  sdn: `${OFAC_BASE}/SDN.CSV`,
  alt: `${OFAC_BASE}/ALT.CSV`,
  cons: `${OFAC_BASE}/CONS_PRIM.CSV`,
  consAlt: `${OFAC_BASE}/CONS_ALT.CSV`,
};
export const OFAC_SEARCH = 'https://sanctionssearch.ofac.treas.gov/';

/** RFC 4180 CSV, which is what OFAC publishes: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** OFAC writes "-0-" for an empty field. */
const ofacField = (v) => {
  const t = String(v ?? '').trim();
  return t && t !== '-0-' ? t : null;
};

/**
 * One searchable list from the four OFAC files. The SDN and consolidated files
 * share a layout: ent_num, name, type, programs, title, … remarks; the alias
 * files are ent_num, alt_num, alt_type, alt_name, remarks. ent_num is unique
 * only within its own pair, so the list travels in the key.
 */
export function sanctionsIndex({ sdn = '', alt = '', cons = '', consAlt = '' }) {
  const entries = new Map();
  const add = (list, text) => {
    for (const r of parseCsv(text)) {
      const id = ofacField(r[0]);
      const name = ofacField(r[1]);
      if (!id || !name || !/^\d+$/.test(id)) continue;
      entries.set(`${list}:${id}`, {
        uid: `${list}:${id}`,
        list,
        name,
        type: ofacField(r[2]) ?? 'entity',
        programs: (ofacField(r[3]) ?? '')
          .split(/\]\s*\[|[[\]]/)
          .map((p) => p.trim())
          .filter(Boolean),
        remarks: ofacField(r[11]),
        aliases: [],
      });
    }
  };
  const alias = (list, text) => {
    for (const r of parseCsv(text)) {
      const e = entries.get(`${list}:${ofacField(r[0])}`);
      const name = ofacField(r[3]);
      if (e && name) e.aliases.push(name);
    }
  };
  add('sdn', sdn);
  add('cons', cons);
  alias('sdn', alt);
  alias('cons', consAlt);
  return [...entries.values()];
}

/** The entries a name matches, best first, each saying which of its names did. */
export function matchSanctions(index, name, { limit = 10 } = {}) {
  if (!name) return [];
  const hits = [];
  for (const e of index) {
    let best = null;
    let on = null;
    for (const n of [e.name, ...e.aliases]) {
      const m = nameMatch(name, n);
      if (m === 'exact') {
        best = m;
        on = n;
        break;
      }
      if (m && !best) {
        best = m;
        on = n;
      }
    }
    if (best) hits.push({ ...e, match: best, matchedName: on });
  }
  hits.sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1));
  return hits.slice(0, limit);
}

let sanctionsCache = null;

/** The OFAC index, downloaded once and held for BUSINESS_SANCTIONS_TTL_HOURS. */
export async function loadSanctions({ fetchImpl = fetch, now = Date.now() } = {}) {
  const ttl = (config.business?.sanctionsTtlHours ?? 24) * 3_600_000;
  if (sanctionsCache && now - sanctionsCache.at < ttl) return sanctionsCache.promise;
  const promise = (async () => {
    const texts = await Promise.all(
      Object.entries(OFAC_FILES).map(async ([k, url]) => {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`OFAC ${k} answered ${res.status}`);
        return [k, await res.text()];
      }),
    );
    const index = sanctionsIndex(Object.fromEntries(texts));
    // A download that parsed to almost nothing is a changed format or an
    // error page, not a world with no sanctioned parties in it.
    if (index.length < 1000) throw new Error(`OFAC lists parsed to only ${index.length} entries`);
    return { index, fetchedAt: new Date(now).toISOString() };
  })();
  sanctionsCache = { at: now, promise };
  promise.catch(() => {
    if (sanctionsCache?.promise === promise) sanctionsCache = null;
  });
  return promise;
}

export async function sanctionsSection(name, deps = {}) {
  const base = {
    source: 'US Treasury OFAC: SDN and consolidated sanctions lists',
    licence: 'US public domain',
    selfCheck: OFAC_SEARCH,
  };
  if (!name) return { ...base, status: 'skipped', note: 'Needs a name to match.' };
  try {
    const { index, fetchedAt } = await (deps.loadSanctions ?? loadSanctions)(deps);
    const hits = matchSanctions(index, name);
    return {
      ...base,
      status: 'checked',
      listedEntries: index.length,
      fetchedAt,
      found: hits.some((h) => h.match === 'exact') ? 'match' : hits.length ? 'possible' : 'none',
      hits: hits.map(({ aliases, ...h }) => ({ ...h, aliases: aliases.slice(0, 10) })),
    };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/* --------------------------------------------------------------- registry -- */

const getJson = async (fetchImpl, url, headers = {}) => {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

/** GLEIF: every legal entity identifier issued anywhere, by name. CC0. */
export async function gleifSection(name, { fetchImpl = fetch } = {}) {
  const base = { source: 'GLEIF legal entity identifiers', licence: 'CC0' };
  if (!name) return { ...base, status: 'skipped', note: 'Needs a name to match.' };
  try {
    const url = `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(name)}&page[size]=10`;
    const body = await getJson(fetchImpl, url, { accept: 'application/vnd.api+json' });
    const records = (body?.data ?? [])
      .map((d) => {
        const e = d.attributes?.entity ?? {};
        const r = d.attributes?.registration ?? {};
        return {
          lei: d.attributes?.lei ?? d.id,
          name: e.legalName?.name ?? null,
          match: nameMatch(name, e.legalName?.name),
          entityStatus: e.status ?? null,
          registrationStatus: r.status ?? null,
          jurisdiction: e.jurisdiction ?? null,
          registeredAs: e.registeredAs ?? null,
          nextRenewal: r.nextRenewalDate ?? null,
          url: `https://search.gleif.org/#/record/${d.attributes?.lei ?? d.id}`,
        };
      })
      .filter((r) => r.match);
    return { ...base, status: 'checked', records };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/** SEC EDGAR: every company that has filed, by name; a private raise files a Form D. */
export async function edgarSection(name, { fetchImpl = fetch } = {}) {
  const base = { source: 'SEC EDGAR filers', licence: 'US public domain' };
  if (!name) return { ...base, status: 'skipped', note: 'Needs a name to match.' };
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(name)}`;
    // The SEC asks every automated client to name a contact in its user agent.
    const contact = config.adminEmails?.[0] ?? 'admin@profullstack.com';
    const body = await getJson(fetchImpl, url, { 'user-agent': `${UA} ${contact}` });
    const filers = (body?.hits?.hits ?? [])
      .map((h) => {
        const s = h._source ?? {};
        // _id is the CIK; the entity name carries its tickers in brackets.
        const cik = String(h._id ?? '').replace(/^0+/, '');
        const entity = String(s.entity ?? '').replace(/\s*\([^)]*\)\s*$/, '');
        return {
          cik,
          name: entity,
          match: nameMatch(name, entity),
          url: cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` : null,
        };
      })
      .filter((f) => f.cik && f.match);
    return { ...base, status: 'checked', filers };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/** OpenCorporates: state registry records, by number when we have one. Keyed. */
export async function openCorporatesSection(
  { name, state, number },
  { fetchImpl = fetch, token = config.business?.openCorporatesToken } = {},
) {
  const base = {
    source: 'OpenCorporates (state registries)',
    licence: 'ODbL, attribution required',
  };
  if (!token)
    return {
      ...base,
      status: 'unconfigured',
      note: 'OPENCORPORATES_API_TOKEN is not set, so no registry status was read.',
    };
  if (!name && !number)
    return { ...base, status: 'skipped', note: 'Needs a name or entity number.' };
  try {
    const api = 'https://api.opencorporates.com/v0.4';
    const jur = state ? `us_${state}` : null;
    const rows = [];
    if (number && jur) {
      const b = await getJson(
        fetchImpl,
        `${api}/companies/${jur}/${encodeURIComponent(number)}?api_token=${token}`,
      ).catch(() => null);
      if (b?.results?.company) rows.push(b.results.company);
    }
    if (!rows.length && name) {
      const qs = new URLSearchParams({ q: name, api_token: token, per_page: '10' });
      if (jur) qs.set('jurisdiction_code', jur);
      const b = await getJson(fetchImpl, `${api}/companies/search?${qs}`);
      for (const r of b?.results?.companies ?? []) rows.push(r.company);
    }
    const companies = rows
      .map((c) => ({
        name: c.name,
        number: c.company_number,
        jurisdiction: c.jurisdiction_code,
        status: c.current_status ?? null,
        inactive: Boolean(c.inactive),
        incorporated: c.incorporation_date ?? null,
        dissolved: c.dissolution_date ?? null,
        type: c.company_type ?? null,
        address: c.registered_address_in_full ?? null,
        url: c.opencorporates_url ?? null,
        match: number && c.company_number === number ? 'exact' : nameMatch(name, c.name),
      }))
      .filter((c) => c.match);
    return { ...base, status: 'checked', companies };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/** SAM.gov exclusions: who the federal government may not contract with. Keyed. */
export async function samSection(
  name,
  { fetchImpl = fetch, key = config.business?.samApiKey } = {},
) {
  const base = {
    source: 'SAM.gov exclusions (federal debarment and suspension)',
    licence: 'US public domain',
    selfCheck: 'https://sam.gov/search/?index=ex',
  };
  if (!key)
    return {
      ...base,
      status: 'unconfigured',
      note: 'SAM_API_KEY is not set, so exclusions were not read.',
    };
  if (!name) return { ...base, status: 'skipped', note: 'Needs a name to match.' };
  try {
    const qs = new URLSearchParams({ api_key: key, exclusionName: name });
    const b = await getJson(
      fetchImpl,
      `https://api.sam.gov/entity-information/v4/exclusions?${qs}`,
    );
    const exclusions = (b?.excludedEntity ?? [])
      .map((x) => {
        const n = x.exclusionIdentification?.entityName ?? x.exclusionIdentification?.name ?? null;
        return {
          name: n,
          match: nameMatch(name, n),
          type: x.exclusionDetails?.exclusionType ?? null,
          agency: x.exclusionDetails?.excludingAgencyName ?? null,
          activeDate: x.exclusionActions?.listOfActions?.[0]?.activateDate ?? null,
        };
      })
      .filter((x) => x.match);
    return { ...base, status: 'checked', exclusions };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/** Where a reader can look the company up by hand when the state will not be scripted. */
export function registryLinks({ name, state, number }) {
  const links = [];
  if (state === 'ca') {
    links.push({
      name: 'California Secretary of State (bizfile)',
      url: 'https://bizfileonline.sos.ca.gov/search/business',
      what: 'Active, suspended or forfeited, and when the last Statement of Information was filed.',
    });
    links.push({
      name: 'California Franchise Tax Board entity status',
      url: 'https://webapp.ftb.ca.gov/eletter/',
      what: `Good standing with the FTB${number ? ` (entity ${number})` : ''}.`,
    });
  } else if (state) {
    links.push({
      name: `${state.toUpperCase()} business registry via OpenCorporates`,
      url: `https://opencorporates.com/companies/us_${state}${number ? `/${encodeURIComponent(number)}` : name ? `?q=${encodeURIComponent(name)}` : ''}`,
      what: 'The state record and its status.',
    });
  }
  if (name)
    links.push({
      name: 'OpenCorporates',
      url: `https://opencorporates.com/companies?q=${encodeURIComponent(name)}`,
      what: 'Registry records in every jurisdiction it covers.',
    });
  links.push({
    name: 'SAM.gov exclusions',
    url: 'https://sam.gov/search/?index=ex',
    what: 'Federal debarments and suspensions.',
  });
  return links;
}

/* ----------------------------------------------------------------- domain -- */

/** Google Safe Browsing's public status for a site, as the Transparency Report shows it. */
export async function safeBrowsing(domain, { fetchImpl = fetch } = {}) {
  const base = { list: 'Google Safe Browsing', subject: domain };
  try {
    const res = await fetchImpl(
      `https://transparencyreport.google.com/transparencyreport/api/v3/safebrowsing/status?site=${encodeURIComponent(domain)}`,
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { ...base, status: 'unknown', error: `answered ${res.status}` };
    const text = (await res.text()).replace(/^\)\]\}'\s*/, '');
    const row = JSON.parse(text)?.[0];
    const code = Number(row?.[1]);
    if (code === 1) return { ...base, status: 'clear' };
    if (code === 2 || code === 3)
      return {
        ...base,
        status: 'listed',
        reasons: [{ label: code === 2 ? 'unsafe site' : 'some pages unsafe', policy: false }],
      };
    if (code === 6) return { ...base, status: 'clear', note: 'Google has no data on this site.' };
    return { ...base, status: 'unknown', note: `status ${code}` };
  } catch (err) {
    return { ...base, status: 'unknown', error: String(err?.message ?? err) };
  }
}

/** Free pages a person can use to check the same lists by hand. */
export const BLOCKLIST_SELF_CHECKS = [
  { name: 'Spamhaus', url: 'https://check.spamhaus.org/' },
  { name: 'URIBL', url: 'https://admin.uribl.com/' },
  { name: 'SURBL', url: 'https://surbl.org/surbl-analysis' },
  {
    name: 'Google Safe Browsing',
    url: 'https://transparencyreport.google.com/safe-browsing/search',
  },
];

export async function domainSection(domain, deps = {}) {
  const base = { source: 'RDAP, and reputation lists when enabled' };
  if (!domain) return { ...base, status: 'skipped', note: 'Needs a domain.' };
  const {
    rdap = null,
    blocklists = config.business?.blocklists ?? false,
    dqsKey = config.business?.spamhausDqsKey ?? null,
    resolveFor = authoritativeResolveFor(dqsKey),
    resolveA = (d) => new Resolver({ timeout: 5000, tries: 2 }).resolve4(d),
    fetchImpl = fetch,
  } = deps;

  const registration = rdap
    ? await rdap(domain).catch((e) => ({ status: 'unknown', reason: e.message }))
    : null;
  const addresses = await resolveA(domain).catch(() => []);

  if (!blocklists)
    return {
      ...base,
      status: 'unconfigured',
      domain,
      registration,
      addresses,
      note: 'Reputation lists are not queried on this deployment: their free services exclude paid products. Check them yourself below.',
      selfChecks: BLOCKLIST_SELF_CHECKS,
    };

  const lookups = [
    ...['dbl', 'uribl', 'surbl'].map(async (k) => {
      try {
        return await zoneLookup(k, domain, { resolve: await resolveFor(k), dqsKey });
      } catch (err) {
        return {
          list: ZONES[k].name,
          subject: domain,
          status: 'unknown',
          error: String(err?.message ?? err),
        };
      }
    }),
    ...addresses.slice(0, 2).map(async (ip) => {
      try {
        return await zoneLookup('zen', ip, { resolve: await resolveFor('zen'), dqsKey });
      } catch (err) {
        return {
          list: ZONES.zen.name,
          subject: ip,
          status: 'unknown',
          error: String(err?.message ?? err),
        };
      }
    }),
    safeBrowsing(domain, { fetchImpl }),
  ];
  const lists = await Promise.all(lookups);
  return {
    ...base,
    status: lists.every((l) => l.status === 'unknown') ? 'unknown' : 'checked',
    domain,
    registration,
    addresses,
    lists,
    selfChecks: BLOCKLIST_SELF_CHECKS,
  };
}

/**
 * Who holds a domain, asked of its registry over RDAP through the /tlds
 * catalogue. Imported lazily so the report's pure parts load without a database.
 */
export async function rdapLookup(domain) {
  const [{ checkNames }, { catalogueRows }] = await Promise.all([
    import('@nichedb/core/tlds'),
    import('./tlds.js'),
  ]);
  const byTld = new Map((await catalogueRows()).map((r) => [r.tld, r]));
  const [r] = await checkNames([domain], {
    rdapFor: async (t) => byTld.get(t)?.rdap ?? null,
    userAgent: `niche-db/0.1 (+${config.siteUrl})`,
  });
  return r ?? null;
}

/* ---------------------------------------------------------------- verdict -- */

/**
 * The findings a reader should see first, and the overall standing.
 *
 * `flagged` when any authority lists the business; `incomplete` when nothing
 * was found but some check could not run (unconfigured, unknown) — never
 * `clear` on the strength of a check that did not happen; `clear` only when
 * every check ran and found nothing.
 */
export function verdictOf(sections) {
  const findings = [];
  const { sanctions, gleif, edgar, opencorporates, sam, domain } = sections;

  if (sanctions?.found === 'match')
    findings.push({
      severity: 'serious',
      text: `Exact name match on the OFAC ${sanctions.hits[0].list === 'sdn' ? 'SDN' : 'consolidated'} list: ${sanctions.hits[0].name}. Confirm by address and identifiers before acting; a name alone is not an identity.`,
    });
  else if (sanctions?.found === 'possible')
    findings.push({
      severity: 'warning',
      text: `${sanctions.hits.length} partial name match${sanctions.hits.length === 1 ? '' : 'es'} on the OFAC lists. Most partial matches are different parties with similar names.`,
    });

  for (const x of sam?.exclusions ?? [])
    findings.push({
      severity: x.match === 'exact' ? 'serious' : 'warning',
      text: `SAM.gov exclusion${x.match === 'exact' ? '' : ' (partial name match)'}: ${x.name}${x.agency ? `, by ${x.agency}` : ''}.`,
    });

  for (const c of opencorporates?.companies ?? []) {
    if (c.match !== 'exact') continue;
    const s = String(c.status ?? '').toLowerCase();
    if (c.inactive || /suspend|forfeit|dissolv|revok|cancel|inactive/.test(s))
      findings.push({
        severity: 'serious',
        text: `Registry status ${c.status ?? 'inactive'} for ${c.name} (${c.jurisdiction} ${c.number}).`,
      });
  }
  for (const r of gleif?.records ?? [])
    if (r.match === 'exact' && r.registrationStatus === 'LAPSED')
      findings.push({ severity: 'info', text: `LEI ${r.lei} has lapsed (not renewed).` });

  for (const l of domain?.lists ?? [])
    if (l.status === 'listed' && l.list === ZONES.zen.name)
      findings.push({
        severity: /DROP/.test(l.reasons.map((r) => r.label).join(' ')) ? 'serious' : 'warning',
        text: `The address ${domain.domain} is served from, ${l.subject}, is on ${l.list}: ${l.reasons
          .filter((r) => !r.policy)
          .map((r) => r.label)
          .join(
            ', ',
          )}. An address listing often covers a whole hosting range, not this business alone.`,
      });
    else if (l.status === 'listed')
      findings.push({
        severity: /malware|phish|botnet|DROP|unsafe/i.test(l.reasons?.map((r) => r.label).join(' '))
          ? 'serious'
          : 'warning',
        text: `${l.subject} is on ${l.list}: ${l.reasons
          .filter((r) => !r.policy)
          .map((r) => r.label)
          .join(', ')}.`,
      });
  if (domain?.registration?.status === 'not_registered')
    findings.push({ severity: 'warning', text: `${domain.domain} is not registered to anyone.` });

  const all = [sanctions, gleif, edgar, opencorporates, sam, domain].filter(
    (s) => s && s.status !== 'skipped',
  );
  const notRun = [
    ...all.filter((s) => s.status !== 'checked').map((s) => s.source),
    ...(domain?.status === 'checked' ? domain.lists : [])
      .filter((l) => l.status === 'unknown')
      .map((l) => `${l.list} (${l.subject})`),
  ];
  const standing = findings.some((f) => f.severity !== 'info')
    ? 'flagged'
    : notRun.length
      ? 'incomplete'
      : 'clear';
  return { standing, findings, notChecked: notRun };
}

/* ----------------------------------------------------------------- report -- */

const reportCache = new Map();
const REPORT_TTL_MS = 60 * 60_000;

/** Whether this exact question has a report less than an hour old (it costs nothing to re-read). */
export const cachedReport = (input) => {
  const hit = reportCache.get(inputKey(input));
  return hit && Date.now() - hit.at < REPORT_TTL_MS ? hit.report : null;
};

/**
 * The whole report. Every section runs at once and none can fail the others;
 * `deps` replaces the network in tests.
 */
export async function businessReport(raw, deps = {}) {
  const input = normaliseInput(raw);
  if (!hasInput(input))
    throw new Error('Give a business name, a domain, an EIN or an entity number.');
  if (!deps.noCache) {
    const hit = cachedReport(input);
    if (hit) return hit;
  }
  const [sanctions, gleif, edgar, opencorporates, sam, domain] = await Promise.all([
    sanctionsSection(input.name, deps),
    gleifSection(input.name, deps),
    edgarSection(input.name, deps),
    openCorporatesSection(input, deps),
    samSection(input.name, deps),
    domainSection(input.domain, deps),
  ]);
  const sections = { sanctions, gleif, edgar, opencorporates, sam, domain };
  const report = {
    query: input,
    checkedAt: new Date().toISOString(),
    ...verdictOf(sections),
    ein: input.ein
      ? {
          ein: input.ein,
          note: 'There is no public register of EINs; the IRS confirms one only to its holder. It is kept here to identify the business, not checked.',
        }
      : null,
    sections,
    lookUpYourself: registryLinks(input),
    disclaimer:
      'A summary of public lists at the moment it was asked. A name match is not an identity, a clear result covers only the lists that were checked, and nothing here is a legal or compliance opinion.',
  };
  reportCache.set(inputKey(input), { at: Date.now(), report });
  if (reportCache.size > 500) reportCache.delete(reportCache.keys().next().value);
  return report;
}
