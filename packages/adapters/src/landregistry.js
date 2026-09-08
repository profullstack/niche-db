import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * HM Land Registry Price Paid: every property sold in England and Wales.
 *
 * Not a sample, not an index, not an estimate — the actual sale price of every
 * residential property that changed hands, published under the Open Government
 * Licence with the address attached. There is nothing comparable in the United
 * States, where sale prices are a county-by-county matter and several states
 * do not disclose them at all.
 *
 * It is the counterpart to the index series elsewhere in this collection. An
 * index tells you house prices in Bristol rose 4%; this tells you the terraced
 * house on that street went for £312,000 on the second of June, which is what
 * a person actually wants when they are buying one.
 *
 * The API is a Linked Data API over SPARQL, which shapes two things.
 *
 * Values are wrapped. A property type is not "Semi-detached", it is an object
 * with a `label` array of `{_value, _lang}` objects, and reading it as a
 * string yields "[object Object]" in a title without ever failing. Everything
 * goes through `unwrap`.
 *
 * And what comes back depends on what you ask for. The default view returns
 * little more than a URI, and `_view=all` still leaves the address as a link
 * to fetch separately — one request per sale, which for a hundred thousand
 * sales a month is not a plan. Naming the fields in `_properties` embeds the
 * address in the same response, and turns the whole thing into a single fast
 * query.
 */

const API = 'https://landregistry.data.gov.uk/data/ppi/transaction-record.json';

/**
 * The fields to embed. Naming the address sub-fields is what stops this
 * needing a second request per sale.
 */
const PROPERTIES = [
  'transactionId',
  'transactionDate',
  'pricePaid',
  'newBuild',
  'propertyType.label',
  'estateType.label',
  'transactionCategory.label',
  'propertyAddress.paon',
  'propertyAddress.saon',
  'propertyAddress.street',
  'propertyAddress.locality',
  'propertyAddress.town',
  'propertyAddress.district',
  'propertyAddress.county',
  'propertyAddress.postcode',
].join(',');

/**
 * A Linked Data value, unwrapped to a plain string.
 *
 * The API returns `{label: [{_value: 'Semi-detached', _lang: 'en'}]}` where a
 * reader wants "Semi-detached". Reading that as a string gives
 * "[object Object]", which renders in a title and never throws.
 */
export function unwrap(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const got = unwrap(v);
      if (got) return got;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (value._value !== undefined) return unwrap(value._value);
    if (value.label !== undefined) return unwrap(value.label);
    if (value.prefLabel !== undefined) return unwrap(value.prefLabel);
    return null;
  }
  return null;
}

/**
 * The API writes dates as "Tue, 02 Jun 2026" — RFC 1123 without a time.
 *
 * `new Date()` parses that, but it also parses a great many things that are
 * not dates into something plausible, so the shape is matched explicitly.
 */
const MONTHS = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

export function saleDate(raw) {
  const s = String(raw ?? '').trim();
  const m = /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]];
    return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}

/** The address as somebody would write it on an envelope. */
export function addressOf(a) {
  if (!a || typeof a !== 'object') return { line: null, town: null, postcode: null };
  const part = (k) => unwrap(a[k]);
  const line = [
    [part('saon'), part('paon')].filter(Boolean).join(' '),
    part('street'),
    part('locality'),
  ]
    .filter(Boolean)
    .join(', ');
  return {
    line: line || null,
    town: part('town'),
    district: part('district'),
    county: part('county'),
    postcode: part('postcode'),
  };
}

/** Sterling, the way a listing writes it. */
export function pounds(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1e6) return `£${(v / 1e6).toFixed(2)}m`;
  return `£${Math.round(v).toLocaleString('en-GB')}`;
}

/** The first half of a postcode: the unit people mean by "the area". */
export function postcodeArea(postcode) {
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}$/i.exec(String(postcode ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}

export function toItem(row) {
  const id = unwrap(row.transactionId);
  const when = saleDate(row.transactionDate);
  // Guarded before the cast. `Number(null)` is 0 and 0 is finite, so a record
  // with no price would be published as a house that sold for £0 — which is
  // not "price withheld", it is a headline, and a false one.
  const price =
    row.pricePaid === null || row.pricePaid === undefined || row.pricePaid === ''
      ? null
      : Number(row.pricePaid);
  if (!id || !when || price === null || !Number.isFinite(price) || price <= 0) return null;

  const address = addressOf(row.propertyAddress);
  const type = unwrap(row.propertyType) ?? 'Property';
  const estate = unwrap(row.estateType);
  const category = unwrap(row.transactionCategory);
  const newBuild = row.newBuild === true || unwrap(row.newBuild) === 'true';
  const outward = postcodeArea(address.postcode);
  const where = [address.line, address.town, address.postcode].filter(Boolean).join(', ');

  return {
    externalId: `ppd-${id}`,
    kind: 'property-sale',
    title: `${pounds(price)} — ${type}${newBuild ? ', new build' : ''}, ${address.town ?? address.district ?? 'England and Wales'}`,
    summary: [
      `A ${type.toLowerCase()}${estate ? ` (${estate.toLowerCase()})` : ''}${where ? ` at ${where}` : ''}`,
      `sold for ${pounds(price)} on ${when}`,
      newBuild ? 'It was a new build' : null,
    ]
      .filter(Boolean)
      .join(' ')
      .concat('.'),
    // The postcode search on the public site, which is where a person would go
    // next: every other sale on the same street.
    url: address.postcode
      ? `https://landregistry.data.gov.uk/app/ppd/ppd_data?postcode=${encodeURIComponent(address.postcode)}`
      : 'https://landregistry.data.gov.uk/app/ppd',
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: [
      'housing',
      'gb',
      'property-sale',
      slugify(type).slice(0, 30),
      estate ? slugify(estate).slice(0, 20) : null,
      newBuild ? 'new-build' : null,
      address.town ? slugify(address.town).slice(0, 40) : null,
      address.county ? slugify(address.county).slice(0, 40) : null,
      outward ? outward.toLowerCase() : null,
      price >= 1_000_000 ? 'million-plus' : null,
    ].filter(Boolean),
    data: {
      place: {
        country: 'GB',
        state: address.county,
        city: address.town,
        area: address.district,
        address: address.line,
        postcode: address.postcode,
        postcodeArea: outward,
      },
      transactionId: id,
      price,
      currency: 'GBP',
      soldOn: when,
      propertyType: type,
      estateType: estate,
      newBuild,
      transactionCategory: category,
      // Said because the field is easy to over-read: standard means an
      // ordinary open-market sale, and the other category covers transfers
      // that are not comparable to one.
      categoryNote:
        'A standard price paid transaction is an ordinary open-market sale. Additional price paid transactions include repossessions, buy-to-lets and transfers between related parties, and are not comparable with open-market prices.',
      source: 'HM Land Registry Price Paid Data',
      licence: 'Open Government Licence v3.0. Contains HM Land Registry data © Crown copyright.',
    },
  };
}

export const landRegistrySales = defineAdapter({
  name: 'uk-land-registry',
  title: 'Property sales (England and Wales)',
  collection: 'housing',
  description:
    'Every residential property sold in England and Wales, with the address, the price paid, the property type and whether it was a new build. Not an index or an estimate: the actual sale price of the actual house. From HM Land Registry under the Open Government Licence. Keyless.',
  docs: 'https://landregistry.data.gov.uk/app/root/doc/ppd',
  kinds: ['property-sale'],
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'town',
      label: 'Town',
      placeholder: 'BRISTOL',
      help: 'Optional; empty for the whole of England and Wales. The register writes towns in capitals.',
    },
    {
      key: 'postcodeArea',
      label: 'Postcode district',
      placeholder: 'BS1',
      help: 'Optional, and narrower than a town.',
    },
    {
      key: 'minPrice',
      label: 'Minimum price',
      type: 'number',
      help: 'Optional floor, in pounds.',
    },
    {
      key: 'lagDays',
      label: 'Skip the most recent days',
      type: 'number',
      placeholder: '35',
      help: 'A sale reaches the register about six weeks after it completes, so the newest few weeks are always empty. Scanning starts this far back.',
    },
    {
      key: 'daysBack',
      label: 'Days to scan',
      type: 'number',
      placeholder: '21',
      help: 'How many days to walk from the lag point, oldest sales last.',
    },
    { key: 'limit', label: 'Sales per run', type: 'number', placeholder: '200' },
  ],
  defaults: { lagDays: 35, daysBack: 21, limit: 200 },
  defaultSources: [
    { slug: 'uk-property-sales', name: 'Property sales: England and Wales' },
    {
      slug: 'uk-million-pound-sales',
      name: 'Property sales over £1m',
      config: { minPrice: 1_000_000, daysBack: 45 },
    },
    {
      slug: 'uk-property-sales-london',
      name: 'Property sales: London',
      config: { town: 'LONDON' },
    },
  ],
  async pull({ config, http, log }) {
    const limit = Math.min(Math.max(Number(config.limit) || 200, 1), 500);
    const days = Math.min(Math.max(Number(config.daysBack) || 21, 1), 120);
    /* A sale reaches the register roughly six weeks after it completes, so
     * "yesterday" is reliably empty and a window anchored on today finds
     * nothing at all — which looks like a country that stopped buying houses.
     * Measured 2026-09-08: nothing at 14 or 30 days, sales from 45 days back.
     * So the scan starts at the lag point and walks backwards from there. */
    const lag = Math.min(Math.max(Number(config.lagDays) ?? 35, 0), 365);

    // Filtered by exact date rather than a range: the API's `min-`/`max-`
    // range syntax errors on this property, and a single-date query answers in
    // under half a second, so walking day by day is both dependable and quick.
    const dates = [];
    for (let i = 0; i < days; i++) {
      dates.push(new Date(Date.now() - (lag + i) * 86_400_000).toISOString().slice(0, 10));
    }

    const items = [];
    const seen = new Set();
    for (const date of dates) {
      const params = new URLSearchParams({
        _pageSize: String(limit),
        _properties: PROPERTIES,
        transactionDate: date,
      });
      if (config.town) params.set('propertyAddress.town', String(config.town).toUpperCase());
      if (config.postcodeArea) {
        params.set('propertyAddress.postcode', String(config.postcodeArea).toUpperCase());
      }
      if (config.minPrice) params.set('min-pricePaid', String(Number(config.minPrice)));

      const res = await http.json(`${API}?${params}`, { timeoutMs: 45_000 }).catch((err) => {
        log(`${date}: ${err.message}`);
        return null;
      });
      for (const row of res?.result?.items ?? []) {
        const item = toItem(row);
        // The register publishes corrections as new records against the same
        // transaction, so the same id can appear twice in one window.
        if (item && !seen.has(item.externalId)) {
          seen.add(item.externalId);
          items.push(item);
        }
      }
      if (items.length >= limit * 2) break;
    }

    log(`${items.length} sale(s) across ${dates.length} day(s)`);
    return { items, note: `${items.length} sales` };
  },
});
