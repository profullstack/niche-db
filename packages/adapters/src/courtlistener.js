import {
  dateOnly,
  defineAdapter,
  first,
  looseDate,
  stripHtml,
  xmlItems,
} from '@nichedb/core/adapter';

/**
 * CourtListener, live: what Free Law Project published in the last hour.
 *
 * courtlistener-catalog walks the quarterly bulk dumps; these three adapters
 * are the freshness on top of it, and they are built around one number. The
 * REST API's free tier is 5 requests a minute, 50 an hour and 125 A DAY, per
 * token, and a source that polled it the way a source polls npm would spend
 * the day's allowance before breakfast and fail for the next twenty hours.
 * So the API is read only where nothing else carries the data, and rarely:
 *
 *   courtlistener-dockets      one request every two hours      12 a day
 *   courtlistener-judges       one request a day                 1 a day
 *   courtlistener-disclosures  one request a day                 1 a day
 *
 * Fourteen of the 125, leaving room for a person to add a source or two.
 * Each request is one page, and a page is 20 rows whatever `page_size`
 * asks (checked live: 100 was asked, 20 came back), so the docket source is
 * a sample of the newest 240 dockets a day, not the whole stream; the
 * catalogue is where the whole stream is. The cursor is the newest
 * `date_modified` seen and the next request asks for rows after it.
 *
 * Opinions and oral arguments need no token at all. CourtListener publishes
 * an Atom feed of the newest opinions, for all courts and per court, and an
 * RSS podcast of the newest oral argument recordings with the MP3 as an
 * enclosure; both are twenty entries, free, and outside the API's count. The
 * opinion feed's dates are whatever the court's document said, which is
 * sometimes a year like 2109, so a date past tomorrow is stored as unknown
 * rather than as a fact.
 *
 * External ids are CourtListener's own (cluster id, audio id, docket id,
 * person id, disclosure id) and every URL is the canonical page, exactly as
 * the catalogue builds them, so a row that arrives here today and again in
 * the next dump is one story to the collection's dedupe key.
 *
 * The data is public domain (Public Domain Mark 1.0) and every row says so.
 */

/** Who is asking; CourtListener asks for a readable agent on every surface. */
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

export const PROVIDER = 'courtlistener';
export const ATTRIBUTION = 'CourtListener / Free Law Project, Public Domain Mark 1.0';
export const SITE = 'https://www.courtlistener.com';
export const STORAGE = 'https://storage.courtlistener.com';
export const API = `${SITE}/api/rest/v4`;

/** Rows in one API page. The server caps it here whatever page_size says. */
export const API_PAGE = 20;

/** The free tier's daily allowance per token. */
export const DAILY_API_BUDGET = 125;

/** What the default sources spend of it: 12 docket runs, one judges, one disclosures. */
export const DEFAULT_API_REQUESTS_PER_DAY = 14;

/** A published date further ahead than this is a typo, not a fact. */
export const FUTURE_GRACE_MS = 24 * 60 * 60_000;

/** Summary length. */
export const SUMMARY_CHARS = 600;

/** Cadences: the feeds are free, the API is not. */
export const OPINIONS_CADENCE_MINUTES = 30;
export const ORAL_ARGUMENTS_CADENCE_MINUTES = 60;
export const DOCKETS_CADENCE_MINUTES = 120;
export const DAILY_CADENCE_MINUTES = 24 * 60;

// ── Shared ───────────────────────────────────────────────────────────────────

/** A court id as CourtListener writes them: `scotus`, `ca9`, `nysd`. Anything else is nothing. */
export function courtSlug(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : '';
}

/** The numeric id in a CourtListener path: `/opinion/10929933/slug/` under `opinion`. */
export function idFromUrl(url, segment) {
  const m = String(url ?? '').match(new RegExp(`/${segment}/(\\d+)/`));
  return m ? m[1] : null;
}

/** Whitespace collapsed and cut to `n` characters on a word where it can. */
export function trimTo(s, n = SUMMARY_CHARS) {
  const text = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= n) return text || null;
  const cut = text.slice(0, n);
  const at = cut.lastIndexOf(' ');
  return `${(at > n / 2 ? cut.slice(0, at) : cut).trim()}...`;
}

/**
 * A feed date as a day, or unknown.
 *
 * Both feeds carry dates at midnight in the court's own zone, so the day is
 * the one written, taken off the string when it is ISO and off the instant
 * otherwise (the RSS form). A day past tomorrow is the court's typo (the
 * opinion feed has carried 2109 and 2028) and is stored as no date, because
 * a feed sorted by date would otherwise pin that row to the top for a
 * century.
 */
export function feedDate(s, now = Date.now()) {
  const unknown = { publishedAt: null, timeKnown: false, precision: 'day' };
  const text = String(s ?? '').trim();
  if (!text) return unknown;
  let when;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) when = looseDate(iso[0]);
  else {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) return unknown;
    when = {
      publishedAt: dateOnly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      timeKnown: false,
      precision: 'day',
    };
  }
  if (!when.publishedAt || when.publishedAt.getTime() > now + FUTURE_GRACE_MS) return unknown;
  return when;
}

/**
 * The tags a precedential status earns. The status itself, lowercased
 * (`published`, `unpublished`, `errata`, `separate`, `in-chambers`,
 * `relating-to`), never `unknown`; and `precedential` for a published one,
 * which is the word the feed is named by, since "Published" is
 * CourtListener's term for the opinions that bind.
 */
export function statusTags(status) {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (!s || s === 'unknown') return [];
  return s === 'published' ? [s, 'precedential'] : [s];
}

/** RSS puts the link in the element text; Atom in an href, and there may be several. */
function linkOf(it, rel = 'alternate') {
  const link = it.link;
  const links = Array.isArray(link) ? link : link ? [link] : [];
  const hit = links.find((l) => (l.attrs?.rel ?? 'alternate') === rel);
  return hit?.attrs?.href || hit?.text || null;
}

// ── Opinions: the Atom feed ──────────────────────────────────────────────────

export const opinionFeedUrl = (court) => `${SITE}/feed/court/${courtSlug(court) || 'all'}/`;

/** `<author><name>Supreme Court of Guam</name></author>`, read as text. */
function authorName(entry) {
  const a = first(entry.author);
  const text = stripHtml(a?.text ?? '');
  return text || null;
}

/** The summary minus the "Original document" link the feed appends to it. */
function opinionSummary(entry) {
  const text = stripHtml(first(entry.summary)?.text ?? '')
    .replace(/\s*Original document\s*$/i, '')
    .trim();
  return trimTo(text);
}

/**
 * One Atom entry as an opinion, keyed by the cluster id in its link, or null
 * for an entry without one.
 */
export function opinionItem(entry, { court = '', now = Date.now() } = {}) {
  const url = linkOf(entry) ?? first(entry.id)?.text ?? null;
  const id = idFromUrl(url, 'opinion');
  const title = first(entry.title)?.text?.trim();
  if (!id || !title) return null;
  const status = first(entry.category)?.attrs?.term ?? '';
  const when = feedDate(first(entry.published)?.text ?? first(entry.updated)?.text, now);
  const courtId = courtSlug(court);
  return {
    externalId: id,
    kind: 'opinion',
    title,
    summary: opinionSummary(entry),
    url,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: [PROVIDER, courtId, ...statusTags(status)].filter(Boolean),
    data: {
      provider: PROVIDER,
      court: authorName(entry),
      courtId: courtId || null,
      precedentialStatus: status || null,
      pdf: linkOf(entry, 'enclosure'),
      published: first(entry.published)?.text ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

export function parseOpinionFeed(xml, opts = {}) {
  const out = [];
  for (const entry of xmlItems(xml, 'entry')) {
    const item = opinionItem(entry, opts);
    if (item) out.push(item);
  }
  return out;
}

export const courtlistener = defineAdapter({
  name: 'courtlistener',
  title: 'CourtListener: newest opinions',
  collection: 'law',
  description:
    'Court opinions as they are published, from CourtListener’s Atom feed: the twenty newest across every court, or for one court by its id (scotus, ca9, nysd). Keyless and outside the API budget. Each row is the case name, the court, the date filed, the syllabus where there is one and the precedential status; the catalogue walked from the bulk dumps fills in the rest of the record under the same id.',
  docs: 'https://www.courtlistener.com/help/feeds/',
  kinds: ['opinion'],
  cadenceMinutes: OPINIONS_CADENCE_MINUTES,
  configFields: [
    {
      key: 'court',
      label: 'Court id',
      placeholder: 'scotus',
      help: 'Optional: one court’s feed instead of all courts. scotus, ca9, nysd and the rest of CourtListener’s ids.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'courtlistener-opinions', name: 'CourtListener: newest opinions, all courts' },
    {
      slug: 'courtlistener-opinions-scotus',
      name: 'CourtListener: Supreme Court opinions',
      config: { court: 'scotus' },
    },
  ],
  async pull({ config, http, log }) {
    const court = courtSlug(config?.court);
    const xml = await http.text(opinionFeedUrl(court), {
      headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml, application/xml, */*' },
    });
    const items = parseOpinionFeed(xml, { court });
    const undated = items.filter((i) => !i.publishedAt).length;
    log(`${items.length} opinion(s)${undated ? `, ${undated} with no usable date` : ''}`);
    return { items, note: `${items.length} opinion(s) from the ${court || 'all courts'} feed` };
  },
});

// ── Oral arguments: the podcast ──────────────────────────────────────────────

export const podcastUrl = (court) => `${SITE}/podcast/court/${courtSlug(court) || 'all'}/`;

/** One podcast item as an oral argument, keyed by the audio id in its link. */
export function oralArgumentItem(it, { court = '', now = Date.now() } = {}) {
  const url = first(it.link)?.text || first(it.guid)?.text || null;
  const id = idFromUrl(url, 'audio');
  const title = first(it.title)?.text?.trim();
  if (!id || !title) return null;
  const enclosure = first(it.enclosure)?.attrs ?? {};
  const duration = Number(first(it['itunes:duration'])?.text);
  const bytes = Number(enclosure.length);
  const when = feedDate(first(it.pubDate)?.text, now);
  const courtId = courtSlug(court);
  const description = trimTo(stripHtml(first(it.description)?.text ?? ''));
  return {
    externalId: id,
    kind: 'oral-argument',
    title,
    summary: description && description !== title ? description : null,
    url,
    publishedAt: when.publishedAt,
    timeKnown: when.timeKnown,
    precision: when.precision,
    tags: [PROVIDER, courtId].filter(Boolean),
    data: {
      provider: PROVIDER,
      court: first(it['dc:creator'])?.text ?? first(it['itunes:author'])?.text ?? null,
      courtId: courtId || null,
      mp3: enclosure.url ?? null,
      mp3Bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      attribution: ATTRIBUTION,
    },
  };
}

export function parseOralArgumentFeed(xml, opts = {}) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const item = oralArgumentItem(it, opts);
    if (item) out.push(item);
  }
  return out;
}

export const courtlistenerOralArguments = defineAdapter({
  name: 'courtlistener-oral-arguments',
  title: 'CourtListener: newest oral arguments',
  collection: 'law',
  description:
    'Oral argument recordings as CourtListener publishes them, from its podcast feed: the twenty newest across the federal appellate courts, or one court by its id. Keyless and outside the API budget. Each row carries the MP3, its size and duration, the court and the argument date.',
  docs: 'https://www.courtlistener.com/help/feeds/',
  kinds: ['oral-argument'],
  cadenceMinutes: ORAL_ARGUMENTS_CADENCE_MINUTES,
  configFields: [
    {
      key: 'court',
      label: 'Court id',
      placeholder: 'ca9',
      help: 'Optional: one court’s podcast instead of all courts.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'courtlistener-oral-arguments', name: 'CourtListener: newest oral arguments' },
  ],
  async pull({ config, http, log }) {
    const court = courtSlug(config?.court);
    const xml = await http.text(podcastUrl(court), {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, */*' },
    });
    const items = parseOralArgumentFeed(xml, { court });
    log(`${items.length} oral argument(s)`);
    return {
      items,
      note: `${items.length} oral argument(s) from the ${court || 'all courts'} podcast`,
    };
  },
});

// ── The API: dockets, judges, disclosures ────────────────────────────────────

/** A person's display name from CourtListener's four name columns. */
export function personName(r) {
  const name = [r?.name_first, r?.name_middle, r?.name_last]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const suffix = String(r?.name_suffix ?? '').trim();
  return suffix ? `${name} ${suffix}` : name;
}

/** The canonical pages, built the way the site builds them. */
export const personUrl = (id, slug) => `${SITE}/person/${id}/${slug || 'person'}/`;
export const docketUrl = (id, slug) => `${SITE}/docket/${id}/${slug || 'docket'}/`;

/** One docket from the API as an item; a blocked docket (a party asked) is nothing. */
export function docketItem(r) {
  if (!r?.id || r.blocked) return null;
  const caseName = String(r.case_name || r.case_name_short || r.case_name_full || '').trim();
  const number = String(r.docket_number ?? '').trim();
  const title = caseName ? (number ? `${caseName} (${number})` : caseName) : number;
  if (!title) return null;
  const when = looseDate(r.date_filed ?? '');
  const court = courtSlug(r.court_id);
  return {
    externalId: String(r.id),
    kind: 'docket',
    title,
    summary: trimTo([r.nature_of_suit, r.cause].filter(Boolean).join('; ')),
    url: r.absolute_url ? `${SITE}${r.absolute_url}` : docketUrl(r.id, r.slug),
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, court].filter(Boolean),
    data: {
      provider: PROVIDER,
      court: court || null,
      docketNumber: number || null,
      natureOfSuit: r.nature_of_suit || null,
      cause: r.cause || null,
      dateFiled: r.date_filed ?? null,
      dateTerminated: r.date_terminated ?? null,
      assignedTo: r.assigned_to_str || null,
      pacerCaseId: r.pacer_case_id || null,
      source: r.source ?? null,
      dateModified: r.date_modified ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

/** One person from the API as a judge row; an alias of another person is nothing. */
export function judgeItem(r) {
  if (!r?.id || r.is_alias_of) return null;
  const title = personName(r);
  if (!title) return null;
  return {
    externalId: String(r.id),
    kind: 'judge',
    title,
    summary: null,
    url: personUrl(r.id, r.slug),
    publishedAt: null,
    timeKnown: false,
    precision: 'day',
    tags: [PROVIDER, 'judge'],
    data: {
      provider: PROVIDER,
      nameFirst: r.name_first || null,
      nameMiddle: r.name_middle || null,
      nameLast: r.name_last || null,
      nameSuffix: r.name_suffix || null,
      slug: r.slug || null,
      fjcId: r.fjc_id ?? null,
      dateOfBirth: r.date_dob ?? null,
      dateOfDeath: r.date_dod ?? null,
      birthplace: [r.dob_city, r.dob_state, r.dob_country].filter(Boolean).join(', ') || null,
      gender: r.gender || null,
      religion: r.religion || null,
      hasPhoto: Boolean(r.has_photo),
      dateModified: r.date_modified ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

/** One financial disclosure from the API; the person is a URL there, so the id comes off it. */
export function disclosureItem(r) {
  if (!r?.id) return null;
  const personId = idFromUrl(r.person, 'people');
  const year = Number(r.year);
  const when = looseDate(Number.isInteger(year) ? String(year) : '');
  return {
    externalId: String(r.id),
    kind: 'financial-disclosure',
    title: `Financial disclosure ${Number.isInteger(year) ? year : '?'} (person ${personId ?? '?'})`,
    summary: null,
    url: r.filepath || r.download_filepath || null,
    imageUrl: r.thumbnail || null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: 'year',
    tags: [PROVIDER, 'financial-disclosure'],
    data: {
      provider: PROVIDER,
      year: Number.isInteger(year) ? year : null,
      reportType: r.report_type ?? null,
      isAmended: Boolean(r.is_amended),
      pageCount: r.page_count ?? null,
      personId,
      sha1: r.sha1 || null,
      dateModified: r.date_modified ?? null,
      attribution: ATTRIBUTION,
    },
  };
}

/** What the API adapter can read, by the `resource` config. */
export const RESOURCES = {
  dockets: { path: 'dockets', kind: 'docket', item: docketItem },
  people: { path: 'people', kind: 'judge', item: judgeItem },
  'financial-disclosures': {
    path: 'financial-disclosures',
    kind: 'financial-disclosure',
    item: disclosureItem,
  },
};

/** The one request a run makes: newest first, and only what changed since the cursor. */
export function apiUrl(resource, cursor = {}) {
  const params = new URLSearchParams({ order_by: '-date_modified', page_size: String(API_PAGE) });
  if (typeof cursor?.maxModified === 'string' && cursor.maxModified) {
    params.set('date_modified__gt', cursor.maxModified);
  }
  return `${API}/${RESOURCES[resource].path}/?${params}`;
}

/**
 * The cursor after a page: the newest `date_modified` seen so far, kept as
 * the API wrote it so the filter gets it back verbatim, compared as an
 * instant because the site's zone changes offset twice a year.
 */
export function nextCursor(prev, results) {
  let max = typeof prev?.maxModified === 'string' && prev.maxModified ? prev.maxModified : null;
  let maxMs = max ? Date.parse(max) : Number.NEGATIVE_INFINITY;
  for (const r of results ?? []) {
    const s = r?.date_modified;
    if (typeof s !== 'string') continue;
    const ms = Date.parse(s);
    if (Number.isFinite(ms) && ms > maxMs) {
      max = s;
      maxMs = ms;
    }
  }
  return { maxModified: max, checkedAt: new Date().toISOString() };
}

export const courtlistenerApi = defineAdapter({
  name: 'courtlistener-api',
  title: 'CourtListener API: dockets, judges, disclosures',
  collection: 'law',
  description:
    'The newest changes to one CourtListener table, one API request a run: dockets (case name, number, court, nature of suit, cause, dates), people (judges and their names, dates and birthplaces) or financial disclosures (year, report type, pages, the PDF). Needs COURTLISTENER_TOKEN, whose free tier is 125 requests a day; the three default sources spend fourteen. A page is twenty rows, so this is a sample of what changed, kept current from the cursor; the catalogue walked from the bulk dumps is the whole table.',
  docs: 'https://www.courtlistener.com/help/api/rest/',
  kinds: ['docket', 'judge', 'financial-disclosure'],
  cadenceMinutes: DOCKETS_CADENCE_MINUTES,
  needsEnv: ['courtlistenerToken'],
  configFields: [
    {
      key: 'resource',
      label: 'Table',
      type: 'select',
      options: Object.keys(RESOURCES),
      help: 'Which table to read: dockets, people (judges) or financial-disclosures.',
    },
  ],
  defaults: { resource: 'dockets' },
  defaultSources: [
    {
      slug: 'courtlistener-dockets',
      name: 'CourtListener: newest dockets',
      config: { resource: 'dockets' },
      cadenceMinutes: DOCKETS_CADENCE_MINUTES,
    },
    {
      slug: 'courtlistener-judges',
      name: 'CourtListener: judges, newest changes',
      config: { resource: 'people' },
      cadenceMinutes: DAILY_CADENCE_MINUTES,
    },
    {
      slug: 'courtlistener-disclosures',
      name: 'CourtListener: financial disclosures, newest changes',
      config: { resource: 'financial-disclosures' },
      cadenceMinutes: DAILY_CADENCE_MINUTES,
    },
  ],
  async pull({ config, cursor, env, http, log }) {
    if (!env?.courtlistenerToken) throw new Error('COURTLISTENER_TOKEN is not set');
    const resource = RESOURCES[config?.resource] ? config.resource : 'dockets';
    const spec = RESOURCES[resource];
    const page = await http.json(apiUrl(resource, cursor), {
      headers: {
        authorization: `Token ${env.courtlistenerToken}`,
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
    });
    const results = Array.isArray(page?.results) ? page.results : [];
    const items = results.map(spec.item).filter(Boolean);
    const next = nextCursor(cursor, results);
    log(`${items.length} ${spec.kind}(s) of ${results.length} rows, 1 request`);
    return {
      items,
      cursor: next,
      note: `${items.length} ${spec.kind}(s), 1 request${page?.next ? ', more remain' : ''}`,
    };
  },
});
