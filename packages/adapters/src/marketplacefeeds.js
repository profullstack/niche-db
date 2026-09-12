import { defineAdapter, first, slugify, xmlItems } from '@nichedb/core/adapter';

/**
 * Asks and offers, from the house marketplaces.
 *
 * d0rz.com and bl0ggers.com run the same two-sided board: a customer posts an
 * ASK (a ride, an errand, a usability test, a blog post to write) and a
 * provider posts an OFFER (what they will do and for how much). Each side is
 * published as one RSS feed, `/asks/rss.xml` and `/offers/rss.xml`, built by
 * the same code on both sites, so the two adapters here are one parser and a
 * host each. Keyless, and each feed is the fifty newest posts.
 *
 * The feed folds the structured fields into the description as trailing
 * paragraphs -- `Budget: $15`, `Rate: $20`, `City: Dallas, TX`, `Tags: a, b` --
 * because RSS has nowhere else to put them. They are lifted back out here so
 * a city or a budget is a field rather than a sentence, and the summary is
 * the post itself without them.
 */

/** The trailing paragraphs the feed appends, each lifted into a field. */
const FIELD = /^(Budget|Rate|City|Tags):\s*(.+)$/;

/** The posts a feed carries, and the kind each becomes. */
export const SIDES = { asks: 'ask', offers: 'offer' };

/** Split a description into the body and the fields folded onto its end. */
export function splitDescription(text) {
  const paragraphs = String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = [];
  const fields = {};
  for (const p of paragraphs) {
    const m = p.match(FIELD);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
    else body.push(p);
  }
  return { body: body.join('\n\n'), fields };
}

/** "$1,500" as 1500, or null. */
function money(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** One feed entry, or null if it has no link or title. */
export function toItem(it, { site, kind }) {
  const url = first(it.link)?.text?.trim();
  if (!url) return null;
  const title = first(it.title)?.text?.trim();
  if (!title) return null;

  const { body, fields } = splitDescription(first(it.description)?.text);
  const categories = (Array.isArray(it.category) ? it.category : it.category ? [it.category] : [])
    .map((c) => c.text?.trim())
    .filter(Boolean);
  // The feed writes the category first and the post's own tags after it.
  const [category = null, ...tags] = categories;
  const city = fields.city ?? null;

  return {
    externalId: (first(it.guid)?.text || url).slice(0, 500),
    kind,
    title,
    summary: body.replace(/\s+/g, ' ').trim().slice(0, 600) || null,
    url,
    imageUrl: null,
    publishedAt: first(it.pubDate)?.text ?? null,
    tags: [
      site,
      kind,
      category ? slugify(category) : null,
      city ? `city:${slugify(city)}` : null,
      ...tags.map(slugify),
    ].filter(Boolean),
    data: {
      site,
      category,
      city,
      budget: kind === 'ask' ? money(fields.budget) : null,
      rate: kind === 'offer' ? money(fields.rate) : null,
      tags,
      body,
    },
  };
}

export function parseFeed(xml, { site, kind }) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const item = toItem(it, { site, kind });
    if (item) out.push(item);
  }
  return out;
}

/**
 * One adapter per marketplace, differing only in the host.
 *
 * @param {object} spec
 * @param {string} spec.name       adapter name and tag: 'd0rz'
 * @param {string} spec.base       'https://d0rz.com'
 * @param {string} spec.title
 * @param {string} spec.description
 */
export function marketplaceAdapter({ name, base, title, description }) {
  return defineAdapter({
    name,
    title,
    collection: 'marketplace',
    description,
    docs: `${base}/asks/rss.xml`,
    kinds: ['ask', 'offer'],
    cadenceMinutes: 30,
    configFields: [
      {
        key: 'sides',
        label: 'Sides',
        type: 'list',
        required: true,
        placeholder: 'asks, offers',
        help: 'Which of the two boards to read: asks (what customers want done), offers (what providers will do), or both.',
      },
    ],
    defaults: { sides: Object.keys(SIDES) },
    defaultSources: [
      {
        slug: `${name}-marketplace`,
        name: `${name}: asks and offers`,
        config: { sides: Object.keys(SIDES) },
      },
    ],
    async pull({ config, http, log, deadline }) {
      const sides = (
        Array.isArray(config.sides) ? config.sides : String(config.sides ?? '').split(',')
      )
        .map((s) => String(s).trim().toLowerCase())
        .filter((s) => s in SIDES);

      const items = [];
      const failed = [];
      for (const side of sides) {
        if (Date.now() > deadline) break;
        const url = `${base}/${side}/rss.xml`;
        try {
          const xml = await http.text(url, {
            headers: { accept: 'application/rss+xml, application/xml, */*' },
            timeoutMs: 15_000,
          });
          items.push(...parseFeed(xml, { site: name, kind: SIDES[side] }));
        } catch (err) {
          failed.push(`${side} (${err.message.slice(0, 40)})`);
        }
      }
      if (failed.length) log(`failed: ${failed.join(', ')}`);
      log(`${items.length} posts from ${sides.length - failed.length} feeds`);
      return { items, note: `${items.length} posts` };
    },
  });
}
