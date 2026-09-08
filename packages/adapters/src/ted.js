import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * TED: every public tender in the European Union, above threshold.
 *
 * Tenders Electronic Daily is the EU's official procurement journal, and
 * publication in it is a legal requirement rather than a courtesy — above the
 * thresholds, a contracting authority in any member state must advertise here.
 * That makes it the most complete single view of public buying anywhere, and
 * it runs at roughly twenty thousand notices a week.
 *
 * Three things about the API shape this file.
 *
 * It is a POST search with a small query language of its own, not a REST
 * collection: `publication-date>=today(-7)` is the filter, and `fields` is
 * mandatory. Asking for a field it does not know returns a 400 that lists
 * every supported value, which is genuinely helpful — but the field list is
 * long and idiosyncratic, so the set here is the one that was actually
 * verified rather than the one that reads well.
 *
 * Almost everything is multilingual. `buyer-name` is not a string, it is
 * `{"deu": ["Stadt Essen, Zentrales Vergabemanagement"]}`, and a notice from
 * Belgium may carry three languages with no English among them. So a value is
 * resolved by preferring English, then the notice's own language, then
 * whatever there is — and never by assuming a string.
 *
 * And repeated fields repeat per lot rather than per notice: a tender with
 * eight lots reports `contract-nature` eight times, usually with the same
 * value. Deduplicated, or every tag would be a wall of "services".
 */

const API = 'https://api.ted.europa.eu/v3/notices/search';

/**
 * The fields verified to work together, 2026-09-08.
 *
 * `deadline-receipt-tender` is rejected outright and is not here. Keep this
 * list and the one in the request identical: the API's failure mode for a
 * bad combination is sometimes a 400 and sometimes an empty result set, and
 * an empty result set from a journal publishing twenty thousand notices a
 * week is indistinguishable from a quiet week unless somebody is watching.
 */
const FIELDS = [
  'publication-number',
  'notice-title',
  'publication-date',
  'buyer-name',
  'buyer-country',
  'notice-type',
  'contract-nature',
  'place-of-performance',
  'total-value',
];

/** The notice types TED issues, in words rather than codes. */
const NOTICE_TYPES = {
  'cn-standard': 'contract notice',
  'cn-social': 'contract notice (social and other specific services)',
  'cn-desg': 'design contest notice',
  'can-standard': 'contract award notice',
  'can-social': 'contract award notice (social services)',
  'can-desg': 'design contest result',
  'can-modif': 'contract modification notice',
  'pin-only': 'prior information notice',
  'pin-buyer': 'prior information notice (buyer profile)',
  'pin-rtl': 'prior information notice (call for competition)',
  'pin-tran': 'prior information notice (transport)',
  veat: 'voluntary ex-ante transparency notice',
  corr: 'corrigendum',
  subco: 'subcontract notice',
};

/** An award notice says money was committed; a contract notice says it is coming. */
const isAward = (type) => String(type ?? '').startsWith('can');

/**
 * TED writes countries as ISO 3166-1 alpha-3; the rest of this site uses
 * alpha-2.
 *
 * Left alone, a German notice would be tagged `deu` while a US award is tagged
 * `us`, and "everything in Germany" would need a reader to know which standard
 * each collection happened to use. Anything unrecognised is passed through
 * rather than dropped, so a new member state is a wrong-looking tag and not a
 * missing one.
 */
const ALPHA3 = {
  AUT: 'AT',
  BEL: 'BE',
  BGR: 'BG',
  HRV: 'HR',
  CYP: 'CY',
  CZE: 'CZ',
  DNK: 'DK',
  EST: 'EE',
  FIN: 'FI',
  FRA: 'FR',
  DEU: 'DE',
  GRC: 'GR',
  HUN: 'HU',
  IRL: 'IE',
  ITA: 'IT',
  LVA: 'LV',
  LTU: 'LT',
  LUX: 'LU',
  MLT: 'MT',
  NLD: 'NL',
  POL: 'PL',
  PRT: 'PT',
  ROU: 'RO',
  SVK: 'SK',
  SVN: 'SI',
  ESP: 'ES',
  SWE: 'SE',
  ISL: 'IS',
  LIE: 'LI',
  NOR: 'NO',
  CHE: 'CH',
  GBR: 'GB',
  UKR: 'UA',
  TUR: 'TR',
  SRB: 'RS',
  MNE: 'ME',
  MKD: 'MK',
  ALB: 'AL',
  BIH: 'BA',
  MDA: 'MD',
  GEO: 'GE',
  USA: 'US',
};

export function alpha2(code) {
  const c = String(code ?? '')
    .trim()
    .toUpperCase();
  if (!c) return null;
  return ALPHA3[c] ?? (c.length === 2 ? c : c);
}

/**
 * A multilingual value, resolved to one readable string.
 *
 * TED returns `{"deu": ["Stadt Essen"]}`, sometimes with several languages and
 * sometimes with none we can read. English first because the rest of the site
 * is in it, then whatever the notice actually has, because a German buyer name
 * is far better than no buyer name.
 */
export function oneOf(value, prefer = ['eng', 'ENG', 'en']) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const first = value.find((v) => v != null);
    return first === undefined ? null : oneOf(first, prefer);
  }
  if (typeof value === 'object') {
    for (const key of prefer) {
      if (value[key] != null) return oneOf(value[key], prefer);
    }
    const first = Object.values(value).find((v) => v != null);
    return first === undefined ? null : oneOf(first, prefer);
  }
  return String(value);
}

/** Repeated-per-lot fields, deduplicated and lower-cased. */
export function uniq(value) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(raw.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
}

/** TED writes "2026-09-01+02:00": a date with an offset and no time. */
export function tedDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s ?? '').trim());
  return m ? m[1] : null;
}

export function toItem(n) {
  const number = n['publication-number'];
  if (!number) return null;
  const title = oneOf(n['notice-title']) ?? `TED notice ${number}`;
  const buyer = oneOf(n['buyer-name']);
  const type = String(n['notice-type'] ?? '');
  const typeLabel = NOTICE_TYPES[type] ?? (type.replace(/-/g, ' ') || 'notice');
  const countries = [...new Set(uniq(n['buyer-country']).map(alpha2).filter(Boolean))];
  const natures = uniq(n['contract-nature']);
  const places = uniq(n['place-of-performance']).map((p) => p.toUpperCase());
  const when = tedDate(n['publication-date']);
  const award = isAward(type);

  return {
    externalId: `ted-${number}`,
    kind: award ? 'contract-award' : 'tender',
    title: `${title}${buyer ? ` — ${buyer}` : ''}`,
    summary: [
      `${buyer ?? 'A contracting authority'}${countries.length ? ` in ${countries.join(', ')}` : ''}`,
      `published a ${typeLabel}`,
      natures.length ? `for ${natures.join(' and ')}` : null,
      when ? `on ${when}` : null,
      `in the EU's official journal.`,
    ]
      .filter(Boolean)
      .join(' '),
    // The English rendering where TED offers one; the notice is published in
    // every official language and the number is the same in all of them.
    url: `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(number)}`,
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: [
      'public-money',
      'eu',
      award ? 'contract-award' : 'tender',
      type ? slugify(type) : null,
      ...countries.map((c) => c.toLowerCase()),
      ...natures.map((x) => slugify(x).slice(0, 30)),
    ].filter(Boolean),
    data: {
      award: {
        // Countries repeat per lot; the first is the buyer's own.
        country: countries[0] ?? 'EU',
        jurisdiction: 'European Union',
        id: String(number),
        buyer,
        buyerUnit: null,
        // TED's search index does not carry the winning supplier even on an
        // award notice; that is in the notice document itself. Left null
        // rather than filled with the buyer, which would be worse than empty.
        supplier: null,
        amount: Number(oneOf(n['total-value'])) || null,
        currency: null,
        startDate: when,
        endDate: null,
        stage: award ? 'award' : 'tender',
      },
      publicationNumber: String(number),
      noticeType: type,
      noticeTypeLabel: typeLabel,
      contractNature: natures,
      buyerCountries: countries,
      buyerCountriesAlpha3: uniq(n['buyer-country']).map((c) => c.toUpperCase()),
      // NUTS region codes, which is how the EU says where work happens.
      placeOfPerformance: places,
      source: 'TED (Tenders Electronic Daily)',
      licence: 'Reuse permitted with attribution, EU Commission decision 2011/833/EU',
      raw: n,
    },
  };
}

export const tedNotices = defineAdapter({
  name: 'ted-notices',
  title: 'EU public tenders (TED)',
  collection: 'public-money',
  description:
    'Tenders Electronic Daily, the European Union’s official procurement journal: every above-threshold public tender and contract award across the member states, roughly twenty thousand notices a week, with the buyer, its country, the nature of the contract and where the work happens. Keyless.',
  docs: 'https://docs.ted.europa.eu/api/index.html',
  kinds: ['tender', 'contract-award'],
  cadenceMinutes: 60 * 4,
  configFields: [
    {
      key: 'days',
      label: 'Days back',
      type: 'number',
      placeholder: '3',
      help: 'TED publishes thousands a day, so a short window is usually what you want.',
    },
    {
      key: 'country',
      label: 'Buyer country',
      placeholder: 'DE',
      help: 'Optional ISO country code; empty for the whole union.',
    },
    {
      key: 'awardsOnly',
      label: 'Award notices only',
      type: 'select',
      options: ['', 'yes'],
      help: 'Contracts actually awarded, rather than tenders being advertised.',
    },
    { key: 'limit', label: 'Notices per run', type: 'number', placeholder: '250' },
  ],
  defaults: { days: 3, limit: 250 },
  defaultSources: [
    { slug: 'eu-tenders', name: 'EU public tenders' },
    {
      slug: 'eu-contract-awards',
      name: 'EU contract awards',
      config: { awardsOnly: 'yes', days: 7 },
    },
  ],
  async pull({ config, http, log }) {
    const days = Math.min(Math.max(Number(config.days) || 3, 1), 30);
    const clauses = [`publication-date>=today(-${days})`];
    if (config.country) {
      clauses.push(`buyer-country=${String(config.country).trim().toUpperCase()}`);
    }
    if (config.awardsOnly === 'yes') clauses.push('notice-type=can-standard');

    const res = await http.json(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: clauses.join(' AND '),
        limit: Math.min(Math.max(Number(config.limit) || 250, 1), 250),
        fields: FIELDS,
      }),
      timeoutMs: 60_000,
    });

    const notices = res?.notices ?? [];
    // An empty answer from a journal that publishes thousands a day is far
    // more likely to be a rejected query than a quiet week, and TED signals
    // some rejections with an empty 200 rather than an error.
    if (!notices.length) {
      log(`no notices for "${clauses.join(' AND ')}" — check the query, this is unusual`);
    }
    const items = notices.map(toItem).filter(Boolean);
    log(`${items.length} notice(s) of ${res?.totalNoticeCount ?? '?'} matching`);
    return { items, note: `${items.length} of ${res?.totalNoticeCount ?? '?'}` };
  },
});
