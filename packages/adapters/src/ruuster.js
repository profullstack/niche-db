import { createHash } from 'node:crypto';
import { defineAdapter, looseDate, slugify, stripHtml } from '@nichedb/core/adapter';

// These are the saved search's values, including Ruuster's misleadingly named
// lotSizeAcresMin: the search accepts square feet, while records return acres.
const sanJoseParams = new URLSearchParams({
  address: JSON.stringify({
    value: 'ChIJ9T_5iuTKj4ARe3GfygqMnbk',
    label: 'San Jose, CA',
    data: [
      { offset: 0, value: 'San Jose' },
      { offset: 10, value: 'CA' },
    ],
    source: 'googleAutocomplete',
  }),
  priceMin: '0',
  priceMax: '0',
  type: 'house',
  bedroomsMin: '2',
  bathroomsMin: '1',
  squareMin: '750',
  lotSizeAcresMin: '4500',
  yearBuiltMin: '2000',
});
sanJoseParams.append('status', 'Active');
sanJoseParams.append('status', 'ComingSoon');
export const SAN_JOSE_SEARCH = `https://realestateexperts.ruuster.com/agent/talar-davoudi/listings?${sanJoseParams}`;

const UI_PARAMS = new Set([
  'timestamp',
  'view',
  'page',
  'slug',
  'hash',
  'forcedRegistration',
  'registrationPopupAfter',
  'redirectUrl',
  'customCrmTags',
  'isEmbedded',
  'isLikesView',
  'shouldFetchFilterOptions',
  'isNonBoundsAddressChanged',
  'isNeededSendToCRM',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
]);

const clean = (v) => (typeof v === 'string' ? stripHtml(v) || null : null);
const numeric = (v) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const bounded = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};
const digest = (v) => createHash('sha256').update(v).digest('hex');
const urlOrNull = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);

/** Turn an agent's browser search into the same public GET the page uses. */
export function parseSearch(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ruuster needs a savedSearchUrl from a Ruuster agent listing search');
  }
  const match = url.pathname.match(/^\/agent\/([a-z0-9-]+)\/listings\/?$/i);
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.ruuster\.com$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !match
  ) {
    throw new Error('savedSearchUrl must be https://<brokerage>.ruuster.com/agent/<slug>/listings');
  }
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (UI_PARAMS.has(key) || key.startsWith('utm_')) continue;
    if (!params.getAll(key).includes(value)) params.append(key, value);
  }
  params.sort();
  const searchUrl = `${url.origin}/agent/${match[1]}/listings?${params}`;
  params.set('slug', match[1]);
  params.set('shouldFetchFilterOptions', 'false');
  params.set('isNeededSendToCRM', 'false');
  return { origin: url.origin, agentSlug: match[1], params, searchUrl, key: digest(searchUrl) };
}

// A listing is syndicated through several MLS feeds with different Ruuster
// UUIDs. The MLS listing number plus address joins those copies without joining
// unrelated properties whose local MLS happens to reuse the same number.
export function listingKey(row) {
  const number = clean(row?.mlsRecordId);
  // Some feeds omit the street suffix ("1674 Husted" / "1674 Husted Ave").
  // Keep the street name, number and unit, and join only within the same MLS id.
  const street = clean(row?.firstAddress)
    ?.toLowerCase()
    .replace(
      /\b(?:avenue|ave|street|st|road|rd|drive|dr|court|ct|lane|ln|way|boulevard|blvd|place|pl|circle|cir|terrace|ter)\.?\b(?=\s*(?:#|unit\b|apt\b|$))/g,
      '',
    );
  const address = [street, clean(row?.secondAddress)].filter(Boolean).join(' ');
  if (number && address) {
    const normal = address.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `mls:${number}:${digest(normal).slice(0, 20)}`;
  }
  return clean(row?.id) ? `ruuster:${row.id}` : null;
}

export function toItem(row, { origin, agentSlug, currency = 'USD' }, externalId = listingKey(row)) {
  if (!row?.id || !externalId || row.isDeleted || row.isHideAddress) return null;
  const address = [clean(row.firstAddress), clean(row.secondAddress)].filter(Boolean).join(', ');
  if (!address) return null;
  const photos = [
    ...new Set(
      (Array.isArray(row.media) ? row.media : [])
        .map((m) => urlOrNull(typeof m === 'string' ? m : m?.imagePath))
        .filter(Boolean),
    ),
  ].slice(0, 100);
  const city = clean(row.city);
  const state = clean(row.state);
  const status = clean(row.status);
  const propertyType = clean(row.unifiedSubtype) ?? clean(row.subType) ?? clean(row.type);
  const lotSizeAcres = numeric(row.lotSizeAcres);
  const coordinates = row.location?.coordinates;
  // Ruuster's response uses [latitude, longitude], despite calling this a Point.
  const latitude = Array.isArray(coordinates) ? numeric(coordinates[0]) : null;
  const longitude = Array.isArray(coordinates) ? numeric(coordinates[1]) : null;
  const located =
    latitude !== null &&
    longitude !== null &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  const attribution = row.mlsComplianceInfo ?? {};
  const date = looseDate(row.onMarketTimestamp ?? row.originalEntryTimestamp ?? row.onMarketDate);

  return {
    externalId,
    kind: 'property-listing',
    title: address,
    summary: clean(row.description),
    url: `${origin}/agent/${agentSlug}/listings/${encodeURIComponent(row.id)}`,
    imageUrl: photos[0] ?? null,
    ...date,
    tags: [
      'housing',
      'ruuster',
      city ? `city:${slugify(city)}` : null,
      state ? `state:${slugify(state)}` : null,
      status ? `status:${slugify(status)}` : null,
      propertyType ? `property-type:${slugify(propertyType)}` : null,
    ].filter(Boolean),
    data: {
      provider: 'ruuster',
      ruusterId: row.id,
      mlsRecordId: clean(row.mlsRecordId),
      mlsId: clean(row.mlsId),
      address,
      city,
      state,
      postalCode: clean(row.postalCode),
      latitude: located ? latitude : null,
      longitude: located ? longitude : null,
      price: numeric(row.price),
      previousPrice: numeric(row.oldPrice),
      currency,
      bedrooms: numeric(row.bedrooms),
      bathrooms: numeric(row.bathrooms),
      squareFeet: numeric(row.square),
      lotSizeAcres,
      lotSizeSquareFeet: lotSizeAcres === null ? null : Math.round(lotSizeAcres * 43560),
      yearBuilt: numeric(row.yearBuilt),
      propertyType,
      status,
      mlsStatus: clean(row.mlsStatus),
      photos,
      isRental: row.isRental === true,
      newConstruction: row.newConstruction === true,
      garageSpaces: numeric(row.garageSpaces),
      parkingSpaces: numeric(row.parkingSpaces),
      associationFee: numeric(row.associationFee),
      daysOnMarket: numeric(row.daysOnMarket),
      updatedAt: clean(row.modificationTimestamp),
      statusChangedAt: clean(row.statusChangeTimestamp),
      priceChangedAt: clean(row.priceChangeTimestamp),
      openHouses: (Array.isArray(row.openHouse) ? row.openHouse : []).map((h) => ({
        startsAt: clean(h.OpenHouseStartTime),
        endsAt: clean(h.OpenHouseEndTime),
      })),
      attribution: {
        agent: clean(attribution.agentName),
        brokerage: clean(attribution.brokerage) ?? clean(row.listOfficeName),
        mls: clean(attribution.mlsName) ?? clean(row.mls?.originalName),
        source: clean(attribution.mlsSource),
        listingNumber: clean(attribution.listingNumber) ?? clean(row.mlsRecordId),
        contact: clean(attribution.attributionContact) ?? clean(row.AttributionContact),
      },
    },
  };
}

export const ruuster = defineAdapter({
  name: 'ruuster',
  title: 'Ruuster property listings',
  collection: 'housing',
  description:
    'Properties matching a Ruuster agent saved search, with prices, addresses, photos, property details and MLS attribution. Syndicated copies are combined by MLS listing number and address.',
  docs: 'https://realestateexperts.ruuster.com/agent/talar-davoudi/listings',
  kinds: ['property-listing'],
  cadenceMinutes: 60,
  configFields: [
    { key: 'savedSearchUrl', label: 'Saved search URL', type: 'text', required: true },
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      help: 'Ten upstream records per page. Interrupted walks resume next run.',
    },
    { key: 'currency', label: 'Listing currency', type: 'select', options: ['USD', 'CAD'] },
  ],
  defaults: { pages: 20, currency: 'USD' },
  defaultSources: [
    {
      slug: 'ruuster-san-jose-homes',
      name: 'San Jose homes: Ruuster saved search',
      config: { savedSearchUrl: SAN_JOSE_SEARCH, pages: 20, currency: 'USD' },
    },
  ],
  async pull({ config, cursor = {}, http, budget = 150, deadline = Infinity, log = () => {} }) {
    const search = parseSearch(config.savedSearchUrl);
    const currency = config.currency ?? 'USD';
    if (!['USD', 'CAD'].includes(currency)) throw new Error('ruuster currency must be USD or CAD');
    const pages = bounded(config.pages ?? 20, 20, 1, 100);
    const detailBudget = bounded(budget, 150, 0, 1000);
    const resume = cursor.searchKey === search.key;
    let page = resume ? bounded(cursor.page ?? 1, 1, 1, 100000) : 1;
    let offset = resume ? bounded(cursor.offset ?? 0, 0, 0, 10) : 0;
    const seen = new Set(resume && Array.isArray(cursor.seen) ? cursor.seen : []);
    const items = [];
    let total = null;
    let details = 0;
    let lastRequest = 0;
    let complete = false;

    const get = async (url) => {
      const wait = Math.max(0, lastRequest + 250 - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequest = Date.now();
      return http.json(url, { timeoutMs: Math.min(20000, Math.max(1, deadline - Date.now())) });
    };
    const hasTime = () => Date.now() + 1000 < deadline;

    for (let n = 0; n < pages && hasTime(); n++) {
      if (details >= detailBudget) break;
      search.params.set('page', String(page));
      const doc = await get(`${search.origin}/api/listings?${search.params}`);
      if (!Array.isArray(doc?.records) || !Number.isInteger(doc.totalCount) || doc.totalCount < 0) {
        throw new Error('ruuster returned an invalid listing page');
      }
      total = doc.totalCount;
      const rows = doc.records;
      // Ruuster currently fixes the page size at ten; failing explicitly is
      // safer than silently skipping inventory if its pagination changes.
      if (rows.length > 10 || (rows.length < 10 && (page - 1) * 10 + rows.length < total)) {
        throw new Error('ruuster returned an inconsistent listing page');
      }
      while (offset < rows.length) {
        const card = rows[offset];
        const key = listingKey(card);
        if (!card?.id || !key) throw new Error('ruuster returned a listing without an identity');
        if (!seen.has(key)) {
          if (details >= detailBudget || !hasTime()) break;
          const detail = await get(`${search.origin}/api/listings/${encodeURIComponent(card.id)}`);
          if (!detail || detail.id !== card.id)
            throw new Error('ruuster returned invalid listing details');
          details++;
          const item = toItem({ ...card, ...detail }, { ...search, currency }, key);
          if (item) items.push(item);
          seen.add(key);
        }
        offset++;
      }
      if (offset < rows.length) break;
      complete = rows.length === 0 || (page - 1) * 10 + rows.length >= total;
      page++;
      offset = 0;
      if (complete) break;
    }
    const note = `${items.length} properties fetched; ${seen.size} distinct listings in this walk${total === null ? '' : ` / ${total} upstream records`}; ${complete ? 'complete' : `resume page ${page}, row ${offset + 1}`}`;
    log(note);
    return {
      items,
      cursor: complete ? {} : { searchKey: search.key, page, offset, seen: [...seen] },
      note,
      ...(complete ? {} : { nextInMinutes: 1 }),
    };
  },
});
