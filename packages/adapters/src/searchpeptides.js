import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Research-peptide vendors and every listing they sell, from search.peptides.
 *
 * search.peptides is a house comparison site on a Moshpit name (served to the
 * open web at search.peptides.pit.world). Its register is every vendor with
 * independent lab results (Finnrick's scores and pass/fail counts), how it takes
 * payment, where it ships from, how you order, its coupons, and a contact card
 * read from the vendor's own site (emails, phones, websites, WhatsApp, Telegram
 * and other socials); and every listing (vendor x peptide x size) with its price
 * as quoted, USD, USD per mg and stock.
 *
 * `/api/v1/export` is the whole register in one keyless, CORS-open document, so
 * a run reads it once. Each vendor becomes a `vendor` row and each listing a
 * `listing` row pointing back at it. Unknowns arrive as null and stay null.
 */

const DEFAULT_URL = 'https://search.peptides.pit.world/api/v1/export';
const SITE = 'https://search.peptides.pit.world';
const CREDIT = 'search.peptides register (lab results: Finnrick)';

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};
const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);
const fin = (n) => (Number.isFinite(n) ? n : null);
const strings = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, 40);
const urls = (v) => (Array.isArray(v) ? v : []).map(urlOrNull).filter(Boolean).slice(0, 20);
const day = (s) => {
  const d = s ? new Date(`${String(s).slice(0, 10)}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function contactOf(c) {
  const socials = {};
  for (const [k, list] of Object.entries(c?.socials ?? {})) {
    const kind = slugify(k);
    const u = urls(list);
    if (kind && u.length) socials[kind] = u;
  }
  return {
    emails: strings(c?.emails)
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      .map((e) => e.toLowerCase()),
    phones: strings(c?.phones).filter((p) => /^\+?\d{7,15}$/.test(p)),
    websites: urls(c?.websites),
    socials,
  };
}

/** One vendor as the register serves it, or null without a slug and name. */
export function toVendor(v) {
  const slug = clean(v?.slug);
  const title = clean(v?.name);
  if (!slug || !title) return null;
  const shipsFrom = strings(v.ships_from).map((c) => c.toUpperCase());
  const payments = strings(v.payments).map((p) => p.toLowerCase());
  const contact = contactOf(v.contact);
  const score = fin(v.score);
  const pass = fin(v.tests_pass) ?? 0;
  const fail = fin(v.tests_fail) ?? 0;
  const facts = [
    score !== null ? `score ${score}/100` : null,
    pass + fail ? `${pass} of ${pass + fail} lab tests passed` : null,
    fin(v.offers) ? `${v.offers} listings` : null,
    shipsFrom.length ? `ships from ${shipsFrom.join(', ')}` : null,
  ].filter(Boolean);
  return {
    externalId: `vendor:${slug}`,
    kind: 'vendor',
    title,
    summary: facts.join(', ') || null,
    // The register's page for the vendor; the vendor's own site is in data.contact.websites.
    url: urlOrNull(v.page) ?? `${SITE}/v/${slug}`,
    publishedAt: day(v.checked_at) ?? day(v.latest_test),
    timeKnown: false,
    precision: 'day',
    tags: [
      'peptide-vendor',
      ...shipsFrom.map((c) => `ships-from:${c.toLowerCase()}`),
      ...payments.map((p) => `pay:${slugify(p)}`),
      pass + fail ? 'lab-tested' : null,
      pass + fail && !fail ? 'all-tests-passed' : null,
      score !== null && score >= 80 ? 'score:80-plus' : null,
      fin(v.offers) ? 'priced' : null,
      Array.isArray(v.coupons) && v.coupons.length ? 'coupon' : null,
      clean(v.ordering) ? `ordering:${slugify(v.ordering)}` : null,
      contact.emails.length ? 'contact:email' : null,
      contact.phones.length ? 'contact:phone' : null,
      ...Object.keys(contact.socials).map((k) => `contact:${k}`),
      v.sponsored === true ? 'sponsored' : null,
    ].filter(Boolean),
    data: {
      slug,
      score,
      rank: fin(v.rank),
      labTests: fin(v.tests),
      testsPassed: pass,
      testsFailed: fail,
      passRate: fin(v.pass_rate),
      latestTest: clean(v.latest_test),
      location: clean(v.location),
      country: clean(v.country),
      shipsFrom,
      shipsTo: clean(v.ships_to),
      ordering: clean(v.ordering),
      payments,
      paymentsAsWritten: strings(v.payments_raw),
      coupons: (Array.isArray(v.coupons) ? v.coupons : [])
        .filter((c) => clean(c?.code))
        .map((c) => ({
          code: clean(c.code),
          discount: clean(c.discount),
          conditions: clean(c.conditions),
        })),
      listings: fin(v.offers),
      peptides: fin(v.peptides),
      fromUsdPerMg: fin(v.min_usd_per_mg),
      contact,
      shopUrl: urlOrNull(v.shop_url),
      checkedAt: clean(v.checked_at),
      sponsored: v.sponsored === true,
      credit: CREDIT,
    },
  };
}

/** One listing, or null when it has nothing to name it by. */
export function toListing(o, vendorsBySlug = new Map()) {
  const id = fin(o?.id);
  const vendor = clean(o?.vendor);
  const peptide = clean(o?.peptide);
  if (id === null || !vendor || !peptide) return null;
  const vendorName = clean(o.vendor_name) ?? vendor;
  const name = clean(o.name) ?? peptide;
  const unit = clean(o.unit)?.toLowerCase() ?? null;
  const amount = fin(o.amount);
  const pack = fin(o.pack_qty);
  const usd = fin(o.price_usd);
  const perMg = fin(o.usd_per_mg);
  const facts = [
    usd !== null ? `$${usd}` : 'price not published',
    perMg !== null ? `$${perMg}/${unit ?? 'mg'}` : null,
    amount !== null ? `${amount} ${unit ?? ''}${pack > 1 ? ` x ${pack}` : ''}`.trim() : null,
    vendorName,
    o.in_stock === false ? 'out of stock' : null,
  ].filter(Boolean);
  const v = vendorsBySlug.get(vendor);
  return {
    externalId: `listing:${id}`,
    kind: 'listing',
    title: `${name} (${vendorName})`,
    summary: facts.join(', '),
    url: urlOrNull(o.url) ?? `${SITE}/v/${vendor}`,
    publishedAt: day(v?.checked_at),
    timeKnown: false,
    precision: 'day',
    tags: [
      'peptide-listing',
      `peptide:${slugify(clean(o.peptide_slug) ?? peptide)}`,
      `vendor:${slugify(vendor)}`,
      clean(o.form) ? `form:${slugify(o.form)}` : null,
      o.in_stock === true ? 'in-stock' : o.in_stock === false ? 'out-of-stock' : null,
      o.passed_test === true ? 'passed-test' : null,
      fin(o.vendor_tests) ? 'lab-tested-vendor' : null,
      Array.isArray(o.blend) && o.blend.length ? 'blend' : null,
      usd === null ? 'unpriced' : null,
    ].filter(Boolean),
    data: {
      peptide,
      peptideSlug: clean(o.peptide_slug),
      vendor,
      vendorName,
      vendorScore: fin(o.vendor_score),
      name,
      form: clean(o.form),
      amount,
      unit,
      packQty: pack,
      price: fin(o.price),
      currency: clean(o.currency)?.toUpperCase() ?? null,
      priceUsd: usd,
      totalMg: fin(o.total_mg),
      usdPerMg: perMg,
      inStock: typeof o.in_stock === 'boolean' ? o.in_stock : null,
      passedTest: o.passed_test === true,
      blend: Array.isArray(o.blend)
        ? o.blend
            .map((b) => ({ peptide: clean(b?.peptide), mg: fin(b?.mg) }))
            .filter((b) => b.peptide)
        : null,
      orderUrl: urlOrNull(o.url),
      credit: CREDIT,
    },
  };
}

export const searchpeptides = defineAdapter({
  name: 'searchpeptides',
  title: 'search.peptides register',
  collection: 'peptides',
  description:
    'Every research-peptide vendor in the search.peptides register with its lab score and pass/fail counts, payment, shipping, ordering, coupons and a contact card (emails, phones, websites, WhatsApp, Telegram, socials), and every listing with its price, USD per mg and stock, read from the keyless register export once a day.',
  docs: 'https://search.peptides.pit.world/docs',
  kinds: ['vendor', 'listing'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'url',
      label: 'Export URL',
      type: 'text',
      required: false,
      help: 'The register export: every vendor and listing in one document.',
    },
  ],
  defaults: { url: DEFAULT_URL },
  defaultSources: [
    {
      slug: 'searchpeptides-register',
      name: 'Peptides: the search.peptides register',
      config: { url: DEFAULT_URL },
    },
  ],
  async pull({ config, http, log }) {
    const url = urlOrNull(config.url) ?? DEFAULT_URL;
    const doc = await http.json(url, { timeoutMs: 60_000 });
    const vendors = Array.isArray(doc?.vendors) ? doc.vendors : [];
    const listings = Array.isArray(doc?.listings) ? doc.listings : [];
    const bySlug = new Map(vendors.map((v) => [v?.slug, v]));
    const items = [];
    let nv = 0;
    for (const v of vendors) {
      const row = toVendor(v);
      if (row) {
        items.push(row);
        nv++;
      }
    }
    for (const o of listings) {
      const row = toListing(o, bySlug);
      if (row) items.push(row);
    }
    const note = `${nv} vendors, ${items.length - nv} listings`;
    log(note);
    return { items, note };
  },
});
