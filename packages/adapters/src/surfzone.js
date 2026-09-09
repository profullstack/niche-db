import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The surf forecast, in the forecaster's own words.
 *
 * `ndbc-buoys` has the three numbers a surf report is made of. This has the
 * sentence a human wrote about them: which swell is filling in, which is
 * fading, whether the advisory is up, and what the shore looks like tomorrow.
 * The National Weather Service issues it as the Surf Zone Forecast (`SRF`)
 * from every coastal office, and api.weather.gov serves the full text keyless.
 *
 * The two belong in one collection for the same reason the aviation feeds do:
 * a measurement and the judgement made about it answer different questions. A
 * buoy off Oahu reading 2.4 m at 16 seconds is a fact. "Advisory level surf
 * along south facing shores through today" is what it means for anyone
 * standing on the beach, and no amount of arithmetic over the buoy produces it.
 *
 * WHAT AN ITEM IS
 *
 * One issuance, from one office. The NWS reissues the product several times a
 * day and each issuance supersedes the last, so the id is the product's own
 * uuid rather than the office: a reissue is a new row, and the previous
 * forecast stays in the record next to what actually happened. 851 issuances
 * were in the recent list when this was written.
 */

const BASE = 'https://api.weather.gov';

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/**
 * The offices that issue a surf forecast, with the coast each one covers.
 *
 * Kept as a lookup so a row can say "Honolulu" rather than "PHFO", and so a
 * reader can ask for one coast. The NWS identifier is the authority; this only
 * adds the words.
 */
export const OFFICES = {
  PHFO: { name: 'Honolulu', coast: 'hawaii' },
  KMTR: { name: 'San Francisco Bay Area', coast: 'pacific' },
  KLOX: { name: 'Los Angeles/Oxnard', coast: 'pacific' },
  KSGX: { name: 'San Diego', coast: 'pacific' },
  KEKA: { name: 'Eureka', coast: 'pacific' },
  KMFR: { name: 'Medford', coast: 'pacific' },
  KPQR: { name: 'Portland', coast: 'pacific' },
  KSEW: { name: 'Seattle', coast: 'pacific' },
  KGYX: { name: 'Gray/Portland ME', coast: 'atlantic' },
  KBOX: { name: 'Boston', coast: 'atlantic' },
  KOKX: { name: 'New York', coast: 'atlantic' },
  KPHI: { name: 'Philadelphia/Mount Holly', coast: 'atlantic' },
  KAKQ: { name: 'Wakefield', coast: 'atlantic' },
  KMHX: { name: 'Newport/Morehead City', coast: 'atlantic' },
  KILM: { name: 'Wilmington', coast: 'atlantic' },
  KCHS: { name: 'Charleston', coast: 'atlantic' },
  KJAX: { name: 'Jacksonville', coast: 'atlantic' },
  KMLB: { name: 'Melbourne', coast: 'atlantic' },
  KMFL: { name: 'Miami', coast: 'atlantic' },
  KKEY: { name: 'Key West', coast: 'atlantic' },
  KTBW: { name: 'Tampa Bay', coast: 'gulf' },
  KTAE: { name: 'Tallahassee', coast: 'gulf' },
  KMOB: { name: 'Mobile', coast: 'gulf' },
  KLIX: { name: 'New Orleans', coast: 'gulf' },
  KLCH: { name: 'Lake Charles', coast: 'gulf' },
  KHGX: { name: 'Houston/Galveston', coast: 'gulf' },
  KCRP: { name: 'Corpus Christi', coast: 'gulf' },
  KBRO: { name: 'Brownsville', coast: 'gulf' },
  TJSJ: { name: 'San Juan', coast: 'caribbean' },
  PAJK: { name: 'Juneau', coast: 'alaska' },
  PAFC: { name: 'Anchorage', coast: 'alaska' },
  PGUM: { name: 'Guam', coast: 'pacific-islands' },
};

/**
 * The risk the product is actually warning about, from its own wording.
 *
 * A surf zone forecast is prose, and the two phrases that change what someone
 * does are the rip current risk and whether a high surf advisory or warning is
 * up. Both are written in a stable vocabulary, so they can be lifted out
 * without pretending to parse the forecast.
 */
export function hazards(text) {
  const s = String(text ?? '');
  const found = [];
  if (/high surf warning/i.test(s)) found.push('high-surf-warning');
  else if (/high surf advisory/i.test(s)) found.push('high-surf-advisory');
  if (/rip current statement|high risk of rip/i.test(s)) found.push('rip-current-risk:high');
  else if (/moderate risk of rip/i.test(s)) found.push('rip-current-risk:moderate');
  else if (/low risk of rip/i.test(s)) found.push('rip-current-risk:low');
  if (/beach hazards statement/i.test(s)) found.push('beach-hazards');
  if (/sneaker wave/i.test(s)) found.push('sneaker-waves');
  return found;
}

/** The first paragraph that reads like a forecast rather than like a header. */
export function firstParagraph(text) {
  const body = String(text ?? '').replace(/\r/g, '');
  const start = body.search(/\n\.[A-Z][A-Z ]{2,}\.\.\./);
  const from = start === -1 ? body : body.slice(start);
  for (const block of from.split(/\n\s*\n/)) {
    const t = block
      .replace(/^\.[A-Z][A-Z ]*\.\.\./, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 60) return t;
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 600);
}

export function toItem(product, text) {
  const id = clean(product?.id);
  const office = clean(product?.issuingOffice);
  const issued = clean(product?.issuanceTime);
  if (!id || !issued) return null;

  const where = OFFICES[office ?? ''] ?? null;
  const name = where?.name ?? office ?? 'the coast';
  const risks = hazards(text);
  const lead = firstParagraph(text);

  return {
    externalId: `srf-${id}`,
    kind: 'surf-forecast',
    title: `Surf forecast: ${name}${risks.includes('high-surf-warning') ? ' — high surf warning' : risks.includes('high-surf-advisory') ? ' — high surf advisory' : ''}`,
    summary: lead.slice(0, 1200),
    url: `${BASE}/products/${id}`,
    publishedAt: issued,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'water',
      'surf',
      'forecast',
      'us',
      office ? slugify(office) : null,
      where?.coast ?? null,
      ...risks,
    ].filter(Boolean),
    data: {
      productId: id,
      office,
      officeName: where?.name ?? null,
      coast: where?.coast ?? null,
      issuedAt: issued,
      hazards: risks,
      hazardBasis:
        'Lifted from the forecaster’s own wording. The full text is in `text`, and it is the authority; these tags exist so a coast under an advisory can be found without reading every product.',
      text: String(text ?? '').slice(0, 20_000),
      source: 'NWS Surf Zone Forecast (SRF)',
      dataset: `${BASE}/products/types/SRF`,
    },
  };
}

export const nwsSurfZone = defineAdapter({
  name: 'nws-surf-zone',
  title: 'Surf zone forecasts',
  collection: 'water',
  description:
    'The National Weather Service surf zone forecast from every coastal office, in full: which swell is filling in and which is fading, high surf advisories and warnings, and the rip current risk for the day. The forecaster’s words beside the buoy’s numbers. Keyless.',
  docs: 'https://www.weather.gov/documentation/services-web-api',
  kinds: ['surf-forecast'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'offices',
      label: 'Only these offices',
      type: 'list',
      help: 'NWS office ids, e.g. PHFO, KLOX.',
    },
    {
      key: 'coast',
      label: 'Only this coast',
      type: 'select',
      options: [
        '',
        'pacific',
        'atlantic',
        'gulf',
        'hawaii',
        'alaska',
        'caribbean',
        'pacific-islands',
      ],
    },
    { key: 'maxProducts', label: 'Forecasts per run', type: 'number', help: 'Default 40.' },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'surf-forecasts', name: 'Surf zone forecasts (all coasts)' },
    {
      slug: 'surf-forecasts-pacific',
      name: 'Surf forecasts: Pacific',
      config: { coast: 'pacific' },
    },
    { slug: 'surf-forecasts-hawaii', name: 'Surf forecasts: Hawaii', config: { coast: 'hawaii' } },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const max = Math.max(5, Math.min(Number(config.maxProducts) || 40, 100));
    const offices = (config.offices ?? [])
      .map((o) => String(o).trim().toUpperCase())
      .filter(Boolean);
    const coast = clean(config.coast);

    const list = await http.json(`${BASE}/products/types/SRF`, { timeoutMs: 60_000 });
    const all = Array.isArray(list?.['@graph']) ? list['@graph'] : [];
    if (!all.length) throw new Error('the weather API returned no surf forecasts');

    const wanted = all
      .filter(
        (p) => !offices.length || offices.includes(String(p.issuingOffice ?? '').toUpperCase()),
      )
      .filter((p) => !coast || OFFICES[String(p.issuingOffice ?? '')]?.coast === coast)
      /* Each issuance is its own product with its own uuid, so the watermark is
       * the issuance time: everything newer than the last run is new, and a
       * reissue of the same office is a new row rather than an overwrite. */
      .filter((p) => !cursor.since || String(p.issuanceTime ?? '') > cursor.since)
      .slice(0, max);

    const items = [];
    for (const p of wanted) {
      if (Date.now() > deadline) {
        log(`out of time after ${items.length} forecast(s)`);
        break;
      }
      const full = await http.jsonOrNull(p['@id'], { timeoutMs: 30_000 });
      const item = toItem(p, full?.productText ?? '');
      if (item) items.push(item);
    }

    const newest =
      all
        .map((p) => String(p.issuanceTime ?? ''))
        .filter(Boolean)
        .sort()
        .at(-1) ?? cursor.since;
    log(
      `${items.length} surf forecast(s) of ${all.length} listed${newest ? `, newest ${newest}` : ''}`,
    );
    return { items, cursor: { since: newest ?? null }, note: `${items.length} forecasts` };
  },
});
