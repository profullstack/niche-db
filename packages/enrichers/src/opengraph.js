import { defineEnricher } from './enricher.js';

/** The page's own OpenGraph image and description, for items whose source gave neither. */
const SKIP = [
  'sec.gov',
  'federalregister.gov',
  'usgs.gov',
  'weather.gov',
  'gdacs.org',
  'clinicaltrials.gov',
  'accessdata.fda.gov',
  'arxiv.org',
  'doi.org',
  'pkg.go.dev',
];

export function parseMeta(html) {
  const get = (names) => {
    for (const n of names) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`,
        'i',
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`,
        'i',
      );
      const m = html.match(re) ?? html.match(re2);
      if (m)
        return m[1]
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim();
    }
    return null;
  };
  return {
    image: get(['og:image', 'og:image:url', 'twitter:image']),
    description: get(['og:description', 'description', 'twitter:description']),
    title: get(['og:title']),
    site: get(['og:site_name']),
  };
}

export const opengraph = defineEnricher({
  name: 'opengraph',
  title: 'Page preview',
  description: "The linked page's own preview image and description, where the source gave none.",
  collections: [
    'games',
    'packages',
    'extensions',
    'books',
    'music',
    'tabletop',
    'health',
    'outages',
    'chess',
    'space',
    'research',
  ],
  appliesTo: (item) =>
    Boolean(item.url) &&
    (!item.image_url || !item.summary) &&
    !SKIP.some((h) => {
      try {
        return new URL(item.url).hostname.endsWith(h);
      } catch {
        return true;
      }
    }),
  perRun: 40,
  async enrich(item, { http }) {
    const res = await http.request(item.url, {
      headers: { accept: 'text/html' },
      timeoutMs: 12_000,
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 400_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {});
    const meta = parseMeta(html);
    if (!meta.image && !meta.description) return null;
    const abs = (u) => {
      try {
        return new URL(u, item.url).toString();
      } catch {
        return null;
      }
    };
    return {
      image: meta.image ? abs(meta.image) : null,
      description: meta.description,
      site: meta.site,
      imageUrl: meta.image ? abs(meta.image) : null,
      summary: meta.description,
    };
  },
});
