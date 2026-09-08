import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Public tenders and awards, in the standard several governments already publish.
 *
 * The Open Contracting Data Standard is the rare case of a shared schema that
 * was actually adopted: a release has an `ocid`, a `tag` saying which stage of
 * the process it is, a `tender`, an `awards` array and a `buyer`, and it means
 * the same thing whoever published it. So unlike the crime portals, which
 * needed a field map per city, one adapter reads every OCDS publisher.
 *
 * Two UK publishers are seeded, and they are not duplicates of each other.
 * Contracts Finder carries lower-value and below-threshold notices; Find a
 * Tender carries the higher-value ones that used to go to the EU's journal
 * before Brexit. Between them they are most of UK public procurement, and a
 * buyer appears in one or the other depending on what they are buying.
 *
 * The `tag` is the part worth understanding. A `tender` release is money about
 * to be spent and is the one a supplier wants; an `award` release is money
 * committed and names who won. They are different events about the same
 * procurement, they arrive weeks or months apart, and a feed that flattened
 * them into "contract" would lose the distinction that makes either useful.
 */

/** OCDS release tags, and what each one actually means to a reader. */
const TAGS = {
  planning: 'planned',
  tender: 'open for tender',
  tenderAmendment: 'tender amended',
  tenderUpdate: 'tender updated',
  tenderCancellation: 'tender cancelled',
  award: 'awarded',
  awardUpdate: 'award updated',
  awardCancellation: 'award cancelled',
  contract: 'contract signed',
  contractAmendment: 'contract amended',
  implementation: 'in progress',
  implementationUpdate: 'progress update',
  contractTermination: 'contract terminated',
};

/** The publishers seeded by default. Any other OCDS endpoint is a config away. */
export const PUBLISHERS = {
  'uk-contracts-finder': {
    name: 'UK Contracts Finder',
    country: 'GB',
    jurisdiction: 'United Kingdom',
    url: 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search',
    note: 'Lower-value and below-threshold UK public sector notices.',
  },
  'uk-find-a-tender': {
    name: 'UK Find a Tender',
    country: 'GB',
    jurisdiction: 'United Kingdom',
    url: 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages',
    note: 'Higher-value UK notices, above the procurement thresholds.',
  },
};

export const PUBLISHER_KEYS = Object.keys(PUBLISHERS);

/** The stage a release is about, from its tags, most advanced first. */
export function stageOf(tags) {
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
  for (const t of ['contract', 'award', 'tender', 'planning']) {
    const hit = list.find((x) => String(x).toLowerCase().startsWith(t));
    if (hit) return { tag: hit, stage: t, label: TAGS[hit] ?? t };
  }
  const first = list[0];
  return first ? { tag: first, stage: 'other', label: TAGS[first] ?? String(first) } : null;
}

/**
 * The money on a release: an award's value if it has one, else the tender's.
 *
 * Named `amountOf` rather than the obvious `valueOf`, which would shadow the
 * one on every object in the language.
 */
export function amountOf(release) {
  const award = (release.awards ?? []).find((a) => a?.value?.amount != null);
  if (award) {
    return {
      amount: Number(award.value.amount),
      currency: award.value.currency ?? null,
      of: 'award',
    };
  }
  const t = release.tender?.value ?? release.tender?.minValue;
  if (t?.amount != null) {
    return { amount: Number(t.amount), currency: t.currency ?? null, of: 'tender' };
  }
  return { amount: null, currency: null, of: null };
}

/** Who won, when anyone has. A tender release has no supplier and must not invent one. */
export function suppliersOf(release) {
  const names = (release.awards ?? [])
    .flatMap((a) => a.suppliers ?? [])
    .map((s) => s?.name)
    .filter(Boolean);
  return [...new Set(names)];
}

export function fmtMoney(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  const symbol = { GBP: '£', EUR: '€', USD: '$' }[currency] ?? '';
  const unit =
    Math.abs(amount) >= 1e9
      ? `${(amount / 1e9).toFixed(2)}bn`
      : Math.abs(amount) >= 1e6
        ? `${(amount / 1e6).toFixed(1)}m`
        : Math.abs(amount) >= 1e3
          ? `${Math.round(amount / 1e3)}k`
          : String(Math.round(amount));
  return `${symbol}${unit}${symbol ? '' : ` ${currency ?? ''}`}`.trim();
}

export function toItem(release, publisher) {
  const stage = stageOf(release.tag);
  const title = release.tender?.title ?? release.awards?.[0]?.title ?? null;
  const buyer = release.buyer?.name ?? null;
  if (!release.ocid || !title) return null;

  const { amount, currency, of } = amountOf(release);
  const suppliers = suppliersOf(release);
  const when = release.date ?? release.awards?.[0]?.datePublished ?? null;
  const priced = fmtMoney(amount, currency);

  return {
    // The ocid identifies the procurement across its whole life; the release
    // id identifies this statement about it. Both are needed: an award and a
    // later amendment share an ocid and are different events.
    externalId: `ocds-${slugify(publisher.key)}-${release.id ?? release.ocid}`,
    kind: stage?.stage === 'tender' || stage?.stage === 'planning' ? 'tender' : 'contract-award',
    // A framework awarded to a dozen suppliers publishes a release each, all
    // sharing one tender title. Without the supplier they read as a dozen
    // copies of the same row.
    title: [
      title,
      priced ? ` — ${priced}` : '',
      suppliers.length === 1 ? ` to ${suppliers[0]}` : '',
      buyer ? `, ${buyer}` : '',
    ].join(''),
    summary: [
      `${buyer ?? 'A public body'} ${stage?.label === 'awarded' || stage?.stage === 'award' ? 'awarded' : (stage?.label ?? 'published')}`,
      priced ? `a ${priced} ${of === 'award' ? 'contract' : 'tender'}` : 'a contract',
      suppliers.length ? `to ${suppliers.join(', ')}` : null,
      `via ${publisher.name}`,
    ]
      .filter(Boolean)
      .join(' ')
      .concat('.')
      .concat(
        release.tender?.description
          ? ` ${String(release.tender.description).replace(/\s+/g, ' ').trim().slice(0, 600)}`
          : '',
      ),
    url:
      release.tender?.documents?.[0]?.url ??
      (publisher.key === 'uk-contracts-finder'
        ? `https://www.contractsfinder.service.gov.uk/notice/${encodeURIComponent(release.tender?.id ?? '')}`
        : 'https://www.find-tender.service.gov.uk/Search'),
    publishedAt: when,
    tags: [
      'public-money',
      publisher.country.toLowerCase(),
      publisher.key,
      stage?.stage ?? 'other',
      stage?.tag ? slugify(stage.tag) : null,
      suppliers.length ? 'has-supplier' : null,
      Number.isFinite(amount) && amount >= 1e6 ? 'million-plus' : null,
      ...(release.tender?.items ?? [])
        .map((i) => i.classification?.description)
        .filter(Boolean)
        .slice(0, 3)
        .map((d) => slugify(d).slice(0, 40)),
    ].filter(Boolean),
    data: {
      award: {
        country: publisher.country,
        jurisdiction: publisher.jurisdiction,
        id: release.tender?.id ?? release.ocid,
        buyer,
        buyerUnit: null,
        // A tender has no winner yet, and saying so is the point of the stage.
        supplier: suppliers[0] ?? null,
        amount: Number.isFinite(amount) ? amount : null,
        currency,
        startDate: release.awards?.[0]?.date ?? release.tender?.tenderPeriod?.startDate ?? null,
        endDate: release.tender?.contractPeriod?.endDate ?? null,
        stage: stage?.stage ?? 'other',
      },
      ocid: release.ocid,
      releaseId: release.id ?? null,
      tags: Array.isArray(release.tag) ? release.tag : [release.tag].filter(Boolean),
      stageLabel: stage?.label ?? null,
      suppliers,
      valueOf: of,
      buyerId: release.buyer?.id ?? null,
      parties: (release.parties ?? []).map((p) => ({
        id: p.id ?? null,
        name: p.name ?? null,
        roles: p.roles ?? [],
      })),
      publisher: publisher.name,
      source: publisher.url,
      standard: 'OCDS 1.1',
      raw: release,
    },
  };
}

export const ocdsTenders = defineAdapter({
  name: 'ocds-tenders',
  title: 'Public tenders and awards (OCDS)',
  collection: 'public-money',
  description:
    'Public procurement in the Open Contracting Data Standard: tenders being advertised and contracts being awarded, with the buyer, the winning supplier, the value and the stage of the process. Seeded with the two UK portals, and reads any other OCDS publisher by URL. Keyless.',
  docs: 'https://standard.open-contracting.org/latest/en/',
  kinds: ['tender', 'contract-award'],
  cadenceMinutes: 60 * 3,
  configFields: [
    {
      key: 'publisher',
      label: 'Publisher',
      type: 'select',
      options: ['', ...PUBLISHER_KEYS],
      help: 'One of the built-in publishers, or fill in the fields below for any other OCDS endpoint.',
    },
    { key: 'url', label: 'OCDS search URL' },
    { key: 'publisherName', label: 'Publisher name' },
    { key: 'country', label: 'Country code', placeholder: 'GB' },
    { key: 'jurisdiction', label: 'Jurisdiction', placeholder: 'United Kingdom' },
    { key: 'limit', label: 'Releases per run', type: 'number', placeholder: '100' },
  ],
  defaults: { limit: 100 },
  defaultSources: PUBLISHER_KEYS.map((key) => ({
    slug: `tenders-${key}`,
    name: `${PUBLISHERS[key].name}: tenders and awards`,
    config: { publisher: key },
  })),
  async pull({ config, http, log }) {
    const preset = PUBLISHERS[config.publisher] ?? null;
    const publisher = {
      key: config.publisher || slugify(config.publisherName ?? 'ocds'),
      name: config.publisherName || preset?.name || 'An OCDS publisher',
      country: (config.country || preset?.country || 'ZZ').toUpperCase(),
      jurisdiction: config.jurisdiction || preset?.jurisdiction || 'Unknown',
      url: config.url || preset?.url,
    };
    if (!publisher.url) throw new Error('ocds-tenders needs a publisher or an OCDS URL');

    const limit = Math.min(Math.max(Number(config.limit) || 100, 1), 500);
    const url = new URL(publisher.url);
    url.searchParams.set('limit', String(limit));

    const res = await http.json(url.toString(), {
      headers: { accept: 'application/json' },
      timeoutMs: 60_000,
    });
    // An OCDS release package puts them under `releases`; some publishers
    // return a list of packages instead.
    const releases = Array.isArray(res?.releases)
      ? res.releases
      : Array.isArray(res)
        ? res.flatMap((p) => p?.releases ?? [])
        : (res?.packages ?? []).flatMap((p) => p?.releases ?? []);

    const items = releases.map((r) => toItem(r, publisher)).filter(Boolean);
    log(`${items.length} release(s) from ${publisher.name}`);
    return { items, note: `${items.length} from ${publisher.name}` };
  },
});
