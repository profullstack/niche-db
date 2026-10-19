import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Licensed cannabis dispensaries, from the weedforcrypto.com directory.
 *
 * weedforcrypto is a house directory filled from official regulator licence
 * lists (US state boards, Canadian provincial registries, Uruguay's IRCCA,
 * Amsterdam's permits, Thailand's DTAM), re-synced daily, and marks the stores
 * that take crypto through CoinPay. `/api/v1/dispensaries` is keyless and
 * CORS-open, paged up to 200 a page in a stable order, so a run walks it page
 * by page. The page number is the cursor: a run that reaches its deadline
 * resumes there a few minutes later, and a finished walk starts over the next
 * day. Each store is one `dispensary` row; coordinates land in data.lat/long
 * so /c/weed answers near= and sort=distance. Unknowns arrive as null and stay
 * null.
 */

const DEFAULT_URL = 'https://weedforcrypto.com/api/v1/dispensaries';
const PAGE = 200;

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};
const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const when = (s) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function point(d) {
  const lat = num(d.lat);
  const long = num(d.lng);
  if (lat === null || long === null || (lat === 0 && long === 0)) return null;
  if (Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
  return { lat, long };
}

function regime(d) {
  if (d.medical && d.adultUse) return 'medical and adult-use';
  if (d.medical) return 'medical';
  if (d.adultUse) return 'adult-use';
  return null;
}

/** One store as the directory serves it, or null without an id and name. */
export function toDispensary(d) {
  const id = clean(d?.id);
  const title = clean(d?.name);
  if (!id || !title) return null;
  const country = clean(d.country)?.toUpperCase() ?? null;
  const region = clean(d.region)?.toUpperCase() ?? null;
  const city = clean(d.city);
  const licenseType = clean(d.licenseType);
  const geo = point(d);
  const kind = regime(d);
  const place = [city, region && region !== country ? region : null, country]
    .filter(Boolean)
    .join(', ');
  const summary = [
    `Licensed ${kind ? `${kind} ` : ''}cannabis ${licenseType ? licenseType.toLowerCase() : 'retailer'}${place ? ` in ${place}` : ''}.`,
    clean(d.licenseNumber)
      ? `Licence ${clean(d.licenseNumber)} (${clean(d.licenseStatus) ?? 'active'}).`
      : null,
    d.coinpayCheckout
      ? 'Takes crypto through CoinPay.'
      : d.acceptsCrypto
        ? 'Accepts crypto.'
        : null,
    d.delivery ? 'Licensed delivery.' : null,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    externalId: `dispensary:${id}`,
    kind: 'dispensary',
    title,
    summary,
    url: urlOrNull(d.url),
    publishedAt: when(d.updatedAt),
    timeKnown: false,
    precision: 'day',
    tags: [
      'cannabis',
      country ? `country:${country.toLowerCase()}` : null,
      country && region && region !== country
        ? `region:${country.toLowerCase()}-${slugify(region)}`
        : null,
      d.medical ? 'medical' : null,
      d.adultUse ? 'adult-use' : null,
      d.delivery ? 'delivery' : null,
      d.acceptsCrypto ? 'crypto' : null,
      d.coinpayCheckout ? 'coinpay' : null,
      d.claimed ? 'claimed' : null,
      licenseType ? `license:${slugify(licenseType)}` : null,
      geo ? 'geo' : null,
    ].filter(Boolean),
    data: {
      slug: clean(d.slug),
      legalName: clean(d.legalName),
      licenseNumber: clean(d.licenseNumber),
      licenseType,
      licenseStatus: clean(d.licenseStatus),
      country,
      region,
      city,
      address: clean(d.address),
      postalCode: clean(d.postalCode),
      phone: clean(d.phone),
      website: urlOrNull(d.website),
      medical: d.medical === true,
      adultUse: d.adultUse === true,
      delivery: d.delivery === true,
      pickup: d.pickup === true,
      acceptsCrypto: d.acceptsCrypto === true,
      cryptoRails: Array.isArray(d.cryptoRails) ? d.cryptoRails.map(clean).filter(Boolean) : [],
      coinpayCheckout: d.coinpayCheckout === true,
      claimed: d.claimed === true,
      regulatorUrl: urlOrNull(d.sourceUrl),
      // Read by ndb_geo_shape, so /c/weed answers near= and sort=distance.
      ...(geo ?? {}),
      credit: 'weedforcrypto.com, from official regulator licence lists',
    },
  };
}

export const weedforcrypto = defineAdapter({
  name: 'weedforcrypto',
  title: 'weedforcrypto licensed dispensaries',
  collection: 'weed',
  description:
    'Every licensed cannabis dispensary in the weedforcrypto.com directory, from official regulator licence lists in the US, Canada, Uruguay, the Netherlands and Thailand: licence number, type and status, address and coordinates, medical or adult-use, delivery, and whether the store takes crypto through CoinPay, walked page by page from the keyless directory API once a day.',
  docs: 'https://weedforcrypto.com/api/v1/coverage',
  kinds: ['dispensary'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'url',
      label: 'Directory API URL',
      type: 'text',
      required: false,
      help: 'The paged directory endpoint. Filters in the URL (country=, region=, crypto=1) narrow the walk.',
    },
  ],
  defaults: { url: DEFAULT_URL },
  defaultSources: [
    {
      slug: 'weedforcrypto-dispensaries',
      name: 'Dispensaries: the weedforcrypto directory',
      config: { url: DEFAULT_URL },
    },
  ],
  async *pull({ config, cursor, http, log, deadline }) {
    const base = new URL(urlOrNull(config.url) ?? DEFAULT_URL);
    let page = Number.isInteger(cursor?.page) && cursor.page > 0 ? cursor.page : 1;
    let seen = 0;
    for (;;) {
      if (Date.now() > deadline) {
        log(`deadline at page ${page}; resuming there`);
        return {
          cursor: { page },
          note: `${seen} dispensaries, resuming at page ${page}`,
          nextInMinutes: 5,
        };
      }
      const url = new URL(base);
      url.searchParams.set('limit', String(PAGE));
      url.searchParams.set('page', String(page));
      const doc = await http.json(url.toString(), { timeoutMs: 60_000 });
      const rows = Array.isArray(doc?.dispensaries) ? doc.dispensaries : [];
      const items = rows.map(toDispensary).filter(Boolean);
      seen += items.length;
      const pages = Number(doc?.pages) || 0;
      const done = rows.length < PAGE || (pages > 0 && page >= pages);
      yield { items, cursor: done ? {} : { page: page + 1 } };
      if (done) break;
      page++;
    }
    const note = `${seen} dispensaries`;
    log(note);
    return { cursor: {}, note };
  },
});
