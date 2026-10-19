import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Indie product launches, from built.indie.
 *
 * built.indie (built.indie.pit.world) is the house launch board: a maker hands
 * it one URL, it reads the homepage (meta tags, Open Graph, JSON-LD, llms.txt,
 * OpenSite, OpenProfile, OpenStack, OpenSaaS), saves the logo and a
 * screenshot, and the product goes on a daily upvote board. Its RSS feed is the
 * fifty newest; the JSON API is the same list with everything the board knows,
 * so a run pages `/api/v1/products?window=new` (keyless, CORS-open, a hundred a
 * page) to the end.
 *
 * Each launch is a `launch` row. The row's URL is the built.indie page, not the
 * product's site, so two directories listing the same product stay two
 * listings; the product's own site is `data.website`. Votes change all day and
 * the board resets at 00:00 UTC, so the whole list is re-read hourly.
 */

const DEFAULT_URL = 'https://built.indie.pit.world/api/v1/products?window=new';
const PAGE = 100;
// Fifty pages is five thousand launches; the board has under a hundred today.
const MAX_PAGES = 50;

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};
const HTTP = /^https?:\/\//i;
const urlOrNull = (v) => (typeof v === 'string' && HTTP.test(v.trim()) ? v.trim() : null);
const strings = (v) => (Array.isArray(v) ? v : []).map(clean).filter(Boolean).slice(0, 20);
const when = (s) => {
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** One launch as the API serves it, or null without a slug and name. */
export function toLaunch(p, now = Date.now()) {
  const slug = clean(p?.slug);
  const title = clean(p?.name);
  if (!slug || !title || (p.status && p.status !== 'live')) return null;
  const tags = strings(p.tags);
  const featuredUntil = when(p.featured_until);
  const featured = Boolean(featuredUntil && featuredUntil.getTime() > now);
  const maker = p.maker && typeof p.maker === 'object' ? p.maker : null;
  const tagline = clean(p.tagline);
  const description = clean(p.description);
  const stack = Array.isArray(p.stack?.items)
    ? p.stack.items
        .map((x) => clean(x?.name))
        .filter(Boolean)
        .slice(0, 30)
    : [];
  const plans = Array.isArray(p.pricing?.plans) ? p.pricing.plans : [];
  return {
    externalId: `launch:${slug}`,
    kind: 'launch',
    title: tagline ? `${title}: ${tagline}` : title,
    summary: description?.slice(0, 600) ?? tagline,
    url: urlOrNull(p.page) ?? `https://built.indie.pit.world/p/${slug}`,
    imageUrl: urlOrNull(p.card_image) ?? urlOrNull(p.screenshot) ?? urlOrNull(p.logo),
    publishedAt: when(p.launched_at),
    tags: [
      'builtindie',
      ...tags.map(slugify).filter(Boolean),
      p.verified === true ? 'verified' : null,
      featured ? 'featured' : null,
      maker?.verified === true ? 'maker-verified' : null,
      stack.length ? 'openstack' : null,
      plans.length ? 'opensaas' : null,
      p.llms ? 'llms-txt' : null,
    ].filter(Boolean),
    data: {
      slug,
      name: title,
      tagline,
      website: urlOrNull(p.url),
      domain: clean(p.domain),
      votes: Number.isFinite(p.votes) ? p.votes : null,
      // Verified = the product's site shows the built.indie badge and the backlink was checked.
      verified: p.verified === true,
      featuredUntil: featuredUntil?.toISOString() ?? null,
      logo: urlOrNull(p.logo),
      screenshot: urlOrNull(p.screenshot),
      cardImage: urlOrNull(p.card_image),
      videos: strings(p.videos).filter((v) => HTTP.test(v)),
      socials: p.socials && typeof p.socials === 'object' ? p.socials : {},
      maker: maker
        ? {
            name: clean(maker.name),
            profile: urlOrNull(maker.profile),
            verified: maker.verified === true,
            page: urlOrNull(maker.page),
          }
        : null,
      stack,
      plans: plans
        .map((x) => ({
          name: clean(x?.name),
          price: Number.isFinite(x?.price) ? x.price : null,
          period: clean(x?.period),
        }))
        .filter((x) => x.name)
        .slice(0, 20),
      currency: clean(p.pricing?.currency),
      badge: urlOrNull(p.badge),
      opensite: urlOrNull(p.opensite),
      openprofile: urlOrNull(p.openprofile),
      credit: 'built.indie launch board',
    },
  };
}

export const builtindie = defineAdapter({
  name: 'builtindie',
  title: 'built.indie launches',
  collection: 'launches',
  description:
    'Every live product on the built.indie launch board with its tagline, description, site, logo, screenshot, votes, categories, maker, built-with stack and plans, read from the keyless JSON API hourly.',
  docs: 'https://built.indie.pit.world/help#api',
  kinds: ['launch'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'url',
      label: 'API URL',
      type: 'text',
      required: false,
      help: 'The product list, newest first. limit and offset are added per page.',
    },
  ],
  defaults: { url: DEFAULT_URL },
  defaultSources: [
    {
      slug: 'builtindie-launches',
      name: 'Launches: built.indie',
      config: { url: DEFAULT_URL },
    },
  ],
  async pull({ config, http, log }) {
    const base = urlOrNull(config.url) ?? DEFAULT_URL;
    const join = base.includes('?') ? '&' : '?';
    const items = [];
    const seen = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const doc = await http.json(`${base}${join}limit=${PAGE}&offset=${page * PAGE}`, {
        timeoutMs: 30_000,
      });
      const rows = Array.isArray(doc?.products) ? doc.products : [];
      for (const p of rows) {
        const it = toLaunch(p);
        if (!it || seen.has(it.externalId)) continue;
        seen.add(it.externalId);
        items.push(it);
      }
      if (rows.length < PAGE) break;
    }
    const note = `${items.length} launches`;
    log(note);
    return { items, note };
  },
});
