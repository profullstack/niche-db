import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * OpenListing sellers: one thing on offer, read from the file the seller
 * serves on its own origin.
 *
 * This is the reference directory for the spec (logicsrc, docs/openlisting.md),
 * which names nichedb for the purpose. A listing is a house, an apartment, a
 * car — anything offered on terms — and the point of the format is that the
 * seller stays its author. US real estate has 484 separate MLSs, each behind
 * its own licence and a broker; a seller who serves one file needs none of
 * that, and a directory that reads it is not redistributing anybody's
 * licensed database.
 *
 * ORIGIN IS THE PROOF
 *
 * The same rule OpenWebring established here. A listing is believed only when
 * fetched from the origin it claims: the URL it was read from must share a
 * host with its `id`. Without that, anyone could serve a document claiming to
 * be somebody else's listing and this would carry it. A seller's index is
 * read from wherever the seller's own origin points, because the seller
 * vouched for it.
 *
 * ABSENT IS UNSTATED
 *
 * A listing with no `deposit` has not said what the deposit is; it does not
 * have a deposit of zero. The one documented exception is `bedrooms: 0`,
 * which means a studio and is not the same as unstated — so it is carried
 * through rather than coalesced away.
 *
 * CLOSED IS WORTH MORE THAN GONE
 *
 * The spec asks sellers to keep a sold listing served for ninety days with
 * `status: "closed"` and `closed_at`, because a directory that learns from a
 * 404 cannot tell "sold" from "the server is down". So a closed listing is
 * ingested like any other and tagged `closed`; it is the outcome, which is
 * the part every listing site loses.
 *
 * IDS
 *
 * A listing is `openlisting:<id>`, its own canonical URL. A seller that moves
 * a listing to a new URL has published a new listing as far as this is
 * concerned, which is the spec's reading of `id` as canonical.
 */

export const WELL_KNOWN = '/.well-known/openlisting.json';

export const OFFER_TYPES = ['sale', 'rent', 'lease', 'auction', 'free', 'wanted'];
export const STATUSES = ['available', 'pending', 'closed', 'withdrawn'];
export const PRECISIONS = ['exact', 'street', 'postal_code', 'locality', 'region'];

/** How many listings one seller may contribute in a run. */
const PER_SELLER = 500;

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const str = (v) => (v == null || v === '' ? null : String(v).trim());

/** A configured entry to the URL actually fetched. */
export function descriptorUrl(entry) {
  const raw = str(entry);
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // A bare origin means the well-known index; a path is taken as given.
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}${WELL_KNOWN}`;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Is this document served from the origin it claims?
 *
 * `id` is the listing's canonical URL. Read from anywhere else, the document
 * is a claim about somebody else's listing and is refused.
 */
export function servedFromOwnOrigin(id, readFrom) {
  const claimed = hostOf(id);
  const actual = hostOf(readFrom);
  if (!claimed || !actual) return false;
  return claimed === actual;
}

/** A price as the spec writes it: a decimal string, never a float. */
export function priceOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const amount = str(raw.amount);
  const currency = str(raw.currency);
  if (!amount || !currency) return null;
  // Kept as the string it was published as. Comparing prices by parsing them
  // into a float is exactly what the spec tells readers not to do; a consumer
  // that wants to sort uses a decimal type.
  return {
    amount,
    currency: currency.toUpperCase(),
    ...(str(raw.per) ? { per: str(raw.per).toLowerCase() } : {}),
  };
}

/** A coordinate, or null. */
function coord(v, limit) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** Where it is, at the precision the seller chose to state. */
export function locationOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const precision = str(raw.precision)?.toLowerCase();
  const lat = coord(raw.lat ?? raw.latitude, 90);
  const lon = coord(raw.lon ?? raw.lng ?? raw.longitude, 180);
  /*
   * Carried under `lat`/`lon` on `data.location` because that is exactly where
   * the database's ndb_geo_shape() looks, so a listing with coordinates is
   * findable by the geographic queries and can be enriched with street-level
   * imagery without any further plumbing.
   *
   * (0, 0) is in the Atlantic and is a missing coordinate rather than a place,
   * so it is dropped rather than put on a map.
   */
  const point = lat !== null && lon !== null && !(lat === 0 && lon === 0) ? { lat, lon } : null;
  return {
    ...(point ?? {}),
    locality: str(raw.locality),
    region: str(raw.region),
    country: str(raw.country)?.toUpperCase() ?? null,
    postalCode: str(raw.postal_code),
    // Only carried when the seller said it was exact enough to mean a place.
    ...(str(raw.street) && (precision === 'exact' || precision === 'street')
      ? { street: str(raw.street) }
      : {}),
    precision: PRECISIONS.includes(precision) ? precision : null,
  };
}

/** A one-line human summary: what it is, what it costs, where. */
export function summarise(offer, subject, location) {
  const bits = [];
  const kind = str(subject?.property?.kind) ?? str(subject?.car?.kind) ?? str(subject?.type);
  if (kind) bits.push(kind);
  if (offer?.price) {
    const per = offer.price.per ? `/${offer.price.per}` : '';
    bits.push(`${offer.price.currency} ${offer.price.amount}${per}`);
  }
  const where = [location?.locality, location?.region].filter(Boolean).join(', ');
  if (where) bits.push(where);
  return bits.join(' · ');
}

/** Tags a reader can browse by, without inventing any. */
export function tagsFor(doc, offer, subject, location) {
  const tags = ['listing', `offer:${offer.type}`, `subject:${subject.type}`];
  if (offer.status && offer.status !== 'available') tags.push(offer.status);
  const sub = subject.property ?? subject.car ?? null;
  if (str(sub?.kind)) tags.push(slugify(str(sub.kind)));
  if (location?.region) tags.push(slugify(location.region));
  if (location?.country) tags.push(slugify(location.country));
  if (str(doc.seller?.kind)) tags.push(`seller:${slugify(str(doc.seller.kind))}`);
  return tags;
}

/**
 * One descriptor to an item, or null with the reason.
 *
 * Returns `{ item }` or `{ rejected }` rather than throwing, because one bad
 * listing in a seller's index must not lose the rest.
 */
export function toItem(doc, readFrom) {
  if (!doc || typeof doc !== 'object') return { rejected: 'not an object' };
  if (str(doc.type) !== 'logicsrc.openlisting') return { rejected: 'not an openlisting document' };

  const id = str(doc.id);
  if (!id) return { rejected: 'no id' };
  if (!servedFromOwnOrigin(id, readFrom)) {
    return { rejected: `id ${hostOf(id)} does not match the origin it was read from` };
  }

  const offerRaw = doc.offer ?? {};
  const offerType = str(offerRaw.type)?.toLowerCase();
  if (!OFFER_TYPES.includes(offerType)) return { rejected: `offer.type ${offerType ?? 'absent'}` };
  const status = str(offerRaw.status)?.toLowerCase();
  if (!STATUSES.includes(status)) return { rejected: `offer.status ${status ?? 'absent'}` };

  const subjectRaw = doc.subject ?? {};
  const subjectType = str(subjectRaw.type)?.toLowerCase();
  const title = str(subjectRaw.title);
  if (!subjectType || !title) return { rejected: 'subject needs a type and a title' };

  const offer = {
    type: offerType,
    status,
    price: priceOf(offerRaw.price),
    deposit: priceOf(offerRaw.deposit),
    availableFrom: looseDate(offerRaw.available_from),
    closedAt: looseDate(offerRaw.closed_at),
    termsUrl: str(offerRaw.terms_url),
  };

  // The profile block, carried through as published. A reader that does not
  // know a profile still gets the listing; it simply does not know the
  // bedroom count, which is the whole point of the two-axis design.
  const subject = {
    type: subjectType,
    title,
    description: str(subjectRaw.description),
    ...(subjectRaw.property && typeof subjectRaw.property === 'object'
      ? { property: subjectRaw.property }
      : {}),
    ...(subjectRaw.car && typeof subjectRaw.car === 'object' ? { car: subjectRaw.car } : {}),
  };

  const location = locationOf(doc.location);
  const media = Array.isArray(doc.media)
    ? doc.media.filter((m) => str(m?.url)).map((m) => ({ url: str(m.url), kind: str(m.kind) }))
    : [];

  return {
    item: {
      externalId: `openlisting:${id}`,
      kind: 'listing',
      title,
      summary: summarise(offer, subject, location) || title,
      url: id,
      imageUrl: media.find((m) => m.kind === 'photo' || !m.kind)?.url ?? null,
      // What a directory sorts on is when the seller last changed it.
      publishedAt: looseDate(doc.updated_at),
      tags: tagsFor(doc, offer, subject, location),
      data: {
        id,
        seller: {
          name: str(doc.seller?.name),
          web: str(doc.seller?.web),
          kind: str(doc.seller?.kind),
          contact: str(doc.seller?.contact),
        },
        offer,
        subject,
        location,
        media,
        showings: Array.isArray(doc.showings) ? doc.showings : [],
        license: str(doc.license),
        // Provenance, as the spec requires of a republisher.
        source: { id, retrievedAt: new Date().toISOString(), readFrom },
        spec: 'https://logicsrc.com/docs/openlisting',
      },
    },
  };
}

/** The listing URLs a seller's index points at. */
export function indexEntries(doc, readFrom) {
  if (str(doc?.type) !== 'logicsrc.openlisting.index') return null;
  const host = hostOf(readFrom);
  const out = [];
  for (const row of Array.isArray(doc.listings) ? doc.listings : []) {
    const id = str(row?.id);
    if (!id) continue;
    // A seller's index may only point at the seller's own listings.
    if (hostOf(id) !== host) continue;
    out.push({ id, updatedAt: looseDate(row?.updated_at) });
  }
  return { entries: out, next: str(doc.next) };
}

export const openlisting = defineAdapter({
  name: 'openlisting',
  title: 'OpenListing sellers',
  collection: 'listings',
  description:
    'Things on offer, read from the OpenListing file a seller serves on its own origin: a house for sale, an apartment to rent, a car, with the price as published, the offer type, where it is at the precision the seller chose, and the outcome when it closes. A listing counts only when served from the origin its id claims. The reference directory for the spec. Keyless.',
  docs: 'https://logicsrc.com/docs/openlisting',
  kinds: ['listing'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'urls',
      label: 'Sellers',
      type: 'list',
      help: 'Seller origins (read at /.well-known/openlisting.json) or a full listing or index URL.',
      placeholder: 'https://northwind.example',
    },
  ],
  defaults: { urls: [] },
  // No default source: the spec published today and nobody serves a
  // descriptor yet. A source with a made-up origin would fail every run and
  // read as the adapter being broken.
  defaultSources: [],

  async pull({ config, http, log, deadline }) {
    const entries = (
      Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(',')
    )
      .map(descriptorUrl)
      .filter(Boolean)
      .slice(0, 50);

    if (!entries.length) {
      log('no sellers configured');
      return { items: [], note: 'no sellers configured' };
    }

    const items = [];
    const failed = [];
    const rejected = [];

    for (const url of entries) {
      if (Date.now() > deadline) break;

      let doc;
      try {
        doc = await http.json(url, { timeoutMs: 20_000 });
      } catch (err) {
        failed.push(`${hostOf(url) ?? url} (${String(err.message).slice(0, 40)})`);
        continue;
      }

      // An index fans out to listings; a single document is a listing.
      const index = indexEntries(doc, url);
      if (index) {
        let seen = 0;
        for (const entry of index.entries) {
          if (Date.now() > deadline || seen >= PER_SELLER) break;
          seen += 1;
          let listing;
          try {
            listing = await http.json(entry.id, { timeoutMs: 20_000 });
          } catch (err) {
            failed.push(`${entry.id} (${String(err.message).slice(0, 30)})`);
            continue;
          }
          const out = toItem(listing, entry.id);
          if (out.item) items.push(out.item);
          else rejected.push(`${entry.id}: ${out.rejected}`);
        }
        continue;
      }

      const out = toItem(doc, url);
      if (out.item) items.push(out.item);
      else rejected.push(`${url}: ${out.rejected}`);
    }

    for (const r of rejected.slice(0, 5)) log(`rejected ${r}`, 'warn');
    if (failed.length)
      log(`${failed.length} fetch failure(s): ${failed.slice(0, 3).join('; ')}`, 'warn');

    return {
      items,
      note: `${items.length} listing(s)${rejected.length ? `, ${rejected.length} rejected` : ''}`,
    };
  },
});
