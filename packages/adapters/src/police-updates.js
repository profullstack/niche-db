import { defineAdapter, stripHtml } from '@nichedb/core/adapter';
import { robotsAllows } from '@nichedb/core/opensite';
import { parseFeed } from './newsfeed.js';
import catalogue from './police-sources-ca.json';

export const POLICE_CITIES = catalogue.cities;
export const POLICE_SCOPE = {
  state: catalogue.state,
  populationYear: catalogue.populationYear,
  minimumPopulation: catalogue.minimumPopulation,
  populationSource: catalogue.populationSource,
};
const AGENT = 'NicheDBPoliceSources';
const text = (value) =>
  stripHtml(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const identity = (value) =>
  text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Relative archive ages are display text, never a substitute for a publication date. */
export function nixleDate(value) {
  const m = text(value).match(
    /([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?, (\d{4})\s*::\s*(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\s+(PST|PDT)/i,
  );
  if (!m) return null;
  const hour = Number(m[4]);
  if (hour < 1 || hour > 12 || Number(m[5]) > 59) return null;
  const clock = String((hour % 12) + (m[6].toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0');
  const date = new Date(
    `${m[1]} ${m[2]}, ${m[3]} ${clock}:${m[5]}:00 ${m[7].toUpperCase() === 'PDT' ? '-0700' : '-0800'}`,
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseNixleArchive(html, source) {
  const publisher = html.match(/<title>Messages from (.*?)\s*:\s*Nixle<\/title>/is)?.[1];
  if (
    !publisher ||
    identity(publisher) !== identity(source.publisher) ||
    !/id=["']wire["']/.test(html)
  )
    throw new Error('Expected the configured Nixle publisher archive');
  const rows = [];
  for (const match of html.matchAll(/<li\s+id=["']pub_(\d+)["'][^>]*>([\s\S]*?)<\/li>/g)) {
    const title = text(match[2].match(/<p class="headline_agency">([\s\S]*?)<\/p>/)?.[1])
      .replace(/\s*More\s*(?:[»›]|&raquo;|&#187;)\s*$/, '')
      .trim();
    if (title)
      rows.push({ id: match[1], title, url: `https://local.nixle.com/alert/${match[1]}/` });
  }
  if (/pub_\d+/.test(html) && !rows.length) throw new Error('Nixle archive markup changed');
  return rows.slice(0, 20);
}

export async function parseNixleAlert(html, entry, source) {
  let body = '';
  let stamp = '';
  let publisherPath = null;
  let foundBody = false;
  await new HTMLRewriter()
    .on('#fullpubhd .certified a', {
      element(e) {
        publisherPath = e.getAttribute('href');
      },
    })
    .on('#fullpubhd dl.last dd', {
      text(t) {
        stamp += t.text;
      },
    })
    .on('#alert-body', {
      element() {
        foundBody = true;
      },
      text(t) {
        body += t.text;
      },
    })
    .on('#alert-body p, #alert-body br, #alert-body div', {
      element() {
        body += ' ';
      },
    })
    .transform(new Response(html))
    .text();
  const path = publisherPath
    ? new URL(publisherPath, source.url).pathname.replace(/\/$/, '')
    : null;
  if (!foundBody || path !== new URL(source.url).pathname.replace(/\/$/, ''))
    throw new Error(`Unexpected publisher or missing alert body for ${entry.id}`);
  return {
    externalId: `nixle:${entry.id}`,
    title: entry.title,
    summary: text(body).slice(0, 600) || null,
    url: entry.url,
    publishedAt: nixleDate(stamp),
  };
}

export function policeItem(raw, city) {
  const date = raw.publishedAt ? new Date(raw.publishedAt) : null;
  const publishedAt = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  return {
    ...raw,
    kind: 'police-update',
    title: text(raw.title),
    publishedAt,
    timeKnown: Boolean(publishedAt),
    tags: ['police-update', 'us', city.state.toLowerCase(), city.slug],
    data: {
      publisher: city.ingestion.publisher,
      publisher_url: city.ingestion.url,
      country: 'US',
      state: city.state,
      city: city.name,
      jurisdiction: `${city.name}, ${city.state}`,
      census_geoid: city.geoid,
      population: city.population,
      population_year: catalogue.populationYear,
      // A news release has no incident coordinates. Geographic queries use
      // the city's Census reference point, explicitly labelled in the UI.
      coverage: { type: 'Point', coordinates: [city.lon, city.lat] },
      coverage_basis: 'census-jurisdiction-reference-point',
      location_precision: 'jurisdiction',
      occurred_at: null,
      published_at: publishedAt,
      archive_headline: raw.title,
    },
  };
}

export const policeUpdates = defineAdapter({
  name: 'police-updates',
  title: 'Local police announcements',
  collection: 'crime',
  description:
    'Public police RSS and Nixle announcements, starting with California cities over 50,000 residents. Includes crime releases and public safety advisories. City locations identify the publishing jurisdiction; publication times are not incident times. No API key required.',
  kinds: ['police-update'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'city',
      label: 'City',
      type: 'select',
      required: true,
      options: POLICE_CITIES.filter((c) => c.ingestion).map((c) => c.slug),
    },
  ],
  defaultSources: POLICE_CITIES.filter((c) => c.ingestion).map((c) => ({
    slug: `police-ca-${c.slug}`,
    name: `${c.name}, CA: police updates`,
    config: { city: c.slug },
    cadenceMinutes: 60,
  })),
  async pull({ config, http, previous, budget = 10, deadline = Infinity }) {
    const city = POLICE_CITIES.find((c) => c.slug === config.city && c.ingestion);
    if (!city) throw new Error('Select a city with a reviewed public feed');
    const source = city.ingestion;
    const headers = { 'user-agent': `${AGENT}/1.0 (+https://nichedb.dev)` };
    const options = { headers, timeoutMs: 15000 };
    let rules = '';
    // A missing robots file is normal; an access/rate-limit error is not.
    const robots = await http.request(new URL('/robots.txt', source.url).href, options);
    if (robots.ok) rules = await robots.text();
    else if (robots.status !== 404 && robots.status !== 410)
      throw new Error(`Robots check: HTTP ${robots.status}`);
    const read = async (url) => {
      const u = new URL(url);
      if (!robotsAllows(rules, u.pathname + u.search, AGENT))
        throw new Error('Publisher robots policy disallows this path');
      return http.text(url, options);
    };
    const body = await read(source.url);
    let items;
    if (source.format === 'rss') {
      if (!/<(?:rss\b|feed\b|rdf:RDF\b)/i.test(body) || /<html\b/i.test(body.slice(0, 500)))
        throw new Error('Expected RSS or Atom, received a different page');
      items = parseFeed(body, source.url)
        .slice(0, 50)
        .map((item) => policeItem(item, city));
    } else {
      const entries = parseNixleArchive(body, source);
      const prior = previous ? await previous(entries.map((e) => `nixle:${e.id}`)) : new Map();
      // Fetch unseen/changed entries first, then refresh the latest two for
      // corrections. Only successful writes enter previous(); failures retry.
      const pending = entries.filter(
        (e) => prior.get(`nixle:${e.id}`)?.archive_headline !== e.title,
      );
      const refresh = entries.slice(0, 2).filter((e) => !pending.includes(e));
      items = [];
      const limit = Math.min(20, Math.max(0, budget));
      for (const entry of [...pending, ...refresh].slice(0, limit)) {
        if (Date.now() >= deadline) break;
        await Bun.sleep(500);
        items.push(policeItem(await parseNixleAlert(await read(entry.url), entry, source), city));
      }
    }
    return {
      items,
      note: `${items.length} police announcements; location is the city reference point`,
    };
  },
});
