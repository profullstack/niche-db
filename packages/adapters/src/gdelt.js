import { defineAdapter } from '@nichedb/core/adapter';

/**
 * GDELT: worldwide news monitoring, keyless and free.
 *
 * The newsroom feeds in this collection are seven English desks. GDELT is the
 * counterweight — it indexes news in 65 languages from a very long tail of
 * outlets, and reports which country and language each story came from, so a
 * feed can follow a beat rather than a masthead.
 *
 * **It rate-limits harder than it documents.** The published limit is one
 * request every five seconds, but measured against the live API on 2026-09-08
 * from a datacenter address, six-second spacing still lost three beats of five
 * to 429s and took 152 seconds, because the shared HTTP client adds its own
 * five-second wait and retry on top. Ten-second spacing over three beats is the
 * setting that actually completes. Treat the documented number as a floor for a
 * residential caller, not a budget.
 *
 * A beat that still fails is logged and skipped rather than failing the pull:
 * losing one for a cycle is not worth losing the others, and the next run is
 * two hours away, not two days.
 */
export const DEFAULT_QUERIES = ['election', 'economy', 'conflict'];

/**
 * The desk a beat belongs on.
 *
 * GDELT beats are search terms, not sections: "election" is how you ask, and
 * "politics" is where a reader expects to find the answer. Anything not listed
 * files under its own name, so adding a beat needs no change here.
 */
export const SECTION_OF = { election: 'politics', economy: 'business', conflict: 'world' };

export const sectionFor = (query) => SECTION_OF[query] ?? String(query ?? '').toLowerCase();

/** GDELT stamps articles `20260727T141500Z`, which `new Date()` will not parse. */
export function seenDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

export function toItem(query, a) {
  if (!a?.url || !a?.title) return null;
  const country = (a.sourcecountry ?? '').trim();
  const language = (a.language ?? '').trim();
  const section = sectionFor(query);
  return {
    externalId: `gdelt:${a.url}`,
    kind: 'story',
    title: a.title,
    summary: null,
    url: a.url,
    // GDELT sends "" rather than omitting the field when there is no image.
    imageUrl: a.socialimage || null,
    publishedAt: seenDate(a.seendate),
    tags: [
      'news',
      section,
      'gdelt',
      query,
      a.domain?.toLowerCase(),
      country ? country.toLowerCase() : null,
      language ? language.toLowerCase() : null,
    ].filter(Boolean),
    data: {
      section,
      query,
      domain: a.domain ?? null,
      country: country || null,
      language: language || null,
    },
  };
}

export function parseResponse(body, query) {
  // A throttled or malformed query answers with prose, not JSON.
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  const out = [];
  for (const a of doc?.articles ?? []) {
    const item = toItem(query, a);
    if (item) out.push(item);
  }
  return out;
}

export const gdelt = defineAdapter({
  name: 'gdelt',
  title: 'GDELT world coverage',
  collection: 'news',
  description:
    'Worldwide news from GDELT, which indexes outlets in 65 languages and tags each story with its source country and language. Keyless. One query per beat, spaced ten seconds apart because GDELT throttles aggressively, so keep the list short.',
  docs: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
  kinds: ['story'],
  cadenceMinutes: 180,
  configFields: [
    {
      key: 'queries',
      label: 'Beats',
      type: 'list',
      required: true,
      placeholder: DEFAULT_QUERIES.join(', '),
      help: 'GDELT search terms, one per beat. Each costs a request, spaced ten seconds apart, so keep this to a handful.',
    },
  ],
  defaults: { queries: DEFAULT_QUERIES },
  defaultSources: [
    {
      slug: 'news-global',
      name: 'News: global beats (GDELT)',
      config: { queries: DEFAULT_QUERIES },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const queries = (
      Array.isArray(config.queries) ? config.queries : String(config.queries ?? '').split(',')
    )
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 10);

    const items = [];
    const failed = [];
    for (const [i, query] of queries.entries()) {
      if (Date.now() > deadline) break;
      // Ten seconds, not the documented five: see the note at the top of this file.
      if (i > 0) await Bun.sleep(10_000);
      const url =
        'https://api.gdeltproject.org/api/v2/doc/doc' +
        `?query=${encodeURIComponent(`${query} sourcelang:english`)}` +
        '&mode=ArtList&maxrecords=75&sort=datedesc&format=json';
      try {
        const parsed = parseResponse(await http.text(url, { timeoutMs: 30_000 }), query);
        if (parsed === null) {
          failed.push(`${query} (throttled)`);
          continue;
        }
        items.push(...parsed);
      } catch (err) {
        failed.push(`${query} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${queries.length} beats, ${items.length} stories${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} stories across ${queries.length - failed.length} beats${failed.length ? `; ${failed.length} throttled or failed` : ''}`,
    };
  },
});
