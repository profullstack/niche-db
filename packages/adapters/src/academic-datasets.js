import { defineAdapter } from '@nichedb/core/adapter';
import { humanSize } from './bittorrented.js';

/**
 * Academic Torrents datasets that are legal to resell, as bittorrented.com
 * publishes them.
 *
 * bittorrented.com mirrors the Academic Torrents catalogue
 * (academictorrents.com/database.xml) and checks every entry's licence before
 * listing it. `/api/public/datasets` is the result: one keyless JSON document
 * holding every dataset and course that passed, each with an OpenFile
 * (logicsrc.com/openfile) `attestation` naming the basis it is held on and,
 * for an open licence, the SPDX id. Some of them the site also mirrors
 * itself, which `mirrored` records.
 *
 * The attestation is the legal gate, and it is checked again here rather than
 * trusted: a record whose basis is not `public-domain` or `open-license` is
 * never imported, whatever else it says. Nor is one without a 40-hex
 * infohash, which is its identity on both sides.
 *
 * Where the endpoint knows them it also names who made a dataset (`creator`),
 * when it was published, and the organizations behind it, matched against
 * open company and institution registries (ROR, Wikidata, GLEIF LEI,
 * OpenCorporates). Each organization becomes an `org:` tag and its country a
 * `country:` tag; identifiers are checked against their own shapes and kept
 * in `data.organizations`. All of it is optional: an older document without
 * these fields still imports.
 *
 * The document is a full snapshot, a few hundred rows, so every run reads all
 * of it and the hashed upserts make an unchanged row cost nothing. The cursor
 * only remembers the snapshot's `updated` stamp for the run log.
 */

export const ENDPOINT = 'https://bittorrented.com/api/public/datasets';

const HEX40 = /^[0-9a-f]{40}$/;
const BASES = new Set(['public-domain', 'open-license']);
const VERDICTS = new Set(['public-domain', 'attribution', 'share-alike']);
const SPDX = /^[A-Za-z0-9.+-]+$/;

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);

/** Most organizations a dataset gets tags for; with countries and the five fixed tags this stays well under the 40-tag cap. */
const MAX_ORG_TAGS = 15;
const MAX_COUNTRY_TAGS = 10;
/** Most organizations kept in `data`. */
const MAX_ORGS = 50;

const VIA = new Set(['ror', 'wikidata']);
const WIKIDATA = /^Q\d+$/;
const LEI = /^[A-Z0-9]{20}$/;
const COUNTRY = /^[A-Z]{2}$/;
const ROR = 'https://ror.org/';

/** A tag-safe slug: lower case, diacritics stripped, anything else to '-', at most 60 characters. */
export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

const str = (v) => (typeof v === 'string' ? clean(v) || null : null);
const matching = (v, re) => {
  const s = str(v);
  return s && re.test(s) ? s : null;
};

/**
 * One organization from the endpoint, reduced to the keys this collection
 * stores, every identifier checked against its own shape; one that fails is
 * null rather than wrong. An organization without a name is dropped.
 */
export function cleanOrganization(o) {
  if (!o || typeof o !== 'object') return null;
  const name = str(o.name);
  if (!name) return null;
  const country = str(o.country)?.toUpperCase() ?? null;
  const ror = str(o.ror);
  return {
    name,
    domain: str(o.domain)?.toLowerCase() ?? null,
    type: str(o.type)?.toLowerCase() ?? null,
    country: country && COUNTRY.test(country) ? country : null,
    website: urlOrNull(o.website),
    wikidata: matching(o.wikidata, WIKIDATA),
    ror: ror?.startsWith(ROR) && ror.length > ROR.length ? ror : null,
    lei: matching(o.lei, LEI),
    opencorporates: str(o.opencorporates),
    via: VIA.has(o.via) ? o.via : null,
  };
}

const toDate = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Why a record cannot be imported, or null when it can. Kept apart from the
 * mapping so a skipped record can be logged with its reason.
 */
export function rejectReason(row) {
  if (!row || typeof row !== 'object') return 'not an object';
  const infohash = String(row.infohash ?? '').toLowerCase();
  if (!HEX40.test(infohash)) return 'infohash is not 40 hex';
  if (!clean(row.name)) return 'no name';
  const a = row.attestation;
  if (!a || typeof a !== 'object') return 'no attestation';
  if (!BASES.has(a.basis))
    return `attestation basis ${JSON.stringify(a.basis ?? null)} is not public-domain or open-license`;
  if (a.basis === 'open-license' && !(typeof a.license === 'string' && SPDX.test(a.license))) {
    return 'open-license attestation without an SPDX licence';
  }
  return null;
}

/** One dataset from the endpoint, or null when it fails the gate. */
export function toItem(row, publisher = null) {
  if (rejectReason(row)) return null;
  const infohash = String(row.infohash).toLowerCase();
  const { basis } = row.attestation;
  const license = basis === 'open-license' ? row.attestation.license : null;
  const attestation = license ? { basis, license } : { basis };
  const category = clean(row.category) || 'Dataset';
  const size = Number(row.size) > 0 ? Number(row.size) : null;
  const verdict = VERDICTS.has(row.verdict) ? row.verdict : null;
  const mirrored =
    row.mirrored && typeof row.mirrored === 'object'
      ? { id: row.mirrored.id ?? null, at: row.mirrored.at ?? null }
      : null;
  const webseeds = Array.isArray(row.webseeds) ? row.webseeds.map(urlOrNull).filter(Boolean) : [];
  const name = clean(row.name);
  const published = toDate(row.published);
  const organizations = Array.isArray(row.organizations)
    ? row.organizations.map(cleanOrganization).filter(Boolean).slice(0, MAX_ORGS)
    : [];
  const orgTags = [...new Set(organizations.map((o) => slugify(o.name)).filter(Boolean))]
    .slice(0, MAX_ORG_TAGS)
    .map((s) => `org:${s}`);
  const countryTags = [
    ...new Set(organizations.map((o) => o.country?.toLowerCase()).filter(Boolean)),
  ]
    .slice(0, MAX_COUNTRY_TAGS)
    .map((c) => `country:${c}`);

  const description = String(row.description ?? '').trim();
  const summary =
    description ||
    [category, humanSize(size), license ?? 'public domain'].filter(Boolean).join(', ');

  return {
    externalId: infohash,
    kind: 'dataset',
    title: name,
    summary: summary.slice(0, 4000),
    url: urlOrNull(row.url) ?? `https://academictorrents.com/details/${infohash}`,
    imageUrl: null,
    publishedAt: published,
    tags: [
      `license:${(license ?? 'public-domain').toLowerCase()}`,
      verdict ? `verdict:${verdict}` : null,
      `basis:${basis}`,
      `category:${category.toLowerCase()}`,
      mirrored ? 'mirrored' : null,
      ...orgTags,
      ...countryTags,
    ].filter(Boolean),
    data: {
      infohash,
      sizeBytes: size,
      magnet:
        typeof row.magnet === 'string' && row.magnet.startsWith('magnet:')
          ? row.magnet
          : `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(name)}`,
      webseeds,
      attestation,
      verdict,
      terms: clean(row.terms) || null,
      mirrored,
      creator: str(row.creator),
      published: published ? published.toISOString() : null,
      organizations,
      spec: 'openfile',
      publisher,
    },
  };
}

export const academicDatasets = defineAdapter({
  name: 'academic-datasets',
  title: 'Academic Torrents datasets (licence-checked)',
  collection: 'datasets',
  description:
    'Datasets and courses from Academic Torrents that are public domain or carry an open licence, as bittorrented.com checks and publishes them: infohash, size, magnet and web seeds, the OpenFile attestation (basis and SPDX licence), what the licence lets you do with it, whether bittorrented mirrors it, and where known its creator, publication date and the organizations behind it with their open registry ids (ROR, Wikidata, LEI, OpenCorporates). Anything without a public-domain or open-licence basis is never imported.',
  docs: 'https://logicsrc.com/openfile',
  kinds: ['dataset'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'url',
      label: 'Endpoint URL',
      type: 'text',
      help: 'The JSON document listing the datasets. Defaults to the bittorrented.com public endpoint.',
      placeholder: ENDPOINT,
    },
  ],
  defaults: { url: ENDPOINT },
  defaultSources: [
    {
      slug: 'academic-datasets',
      name: 'Academic Torrents (licence-checked, via bittorrented.com)',
      config: { url: ENDPOINT },
    },
  ],
  async pull({ config, http, log }) {
    const url = urlOrNull(config.url) ?? ENDPOINT;
    const doc = await http.json(url, { timeoutMs: 60_000 });
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.datasets)) {
      throw new Error(`${url} did not return { datasets: [...] }`);
    }
    const publisher =
      doc.publisher && typeof doc.publisher === 'object'
        ? { name: clean(doc.publisher.name) || null, web: urlOrNull(doc.publisher.web) }
        : null;

    const items = [];
    const seen = new Set();
    let skipped = 0;
    for (const row of doc.datasets) {
      const why = rejectReason(row);
      if (why) {
        skipped++;
        log(`skipped ${String(row?.infohash ?? '?').slice(0, 40)}: ${why}`);
        continue;
      }
      const item = toItem(row, publisher);
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      items.push(item);
    }

    const updated = typeof doc.updated === 'string' ? doc.updated : null;
    log(`${items.length} datasets of ${doc.datasets.length}, ${skipped} skipped`);
    return {
      items,
      cursor: { updated },
      note: `${items.length} datasets, ${skipped} skipped (failed the licence gate or malformed), snapshot ${updated ?? 'undated'}`,
    };
  },
});
