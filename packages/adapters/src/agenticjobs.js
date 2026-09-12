import { decodeEntities, defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Job postings, from agenticjobs.work.
 *
 * agenticjobs is a house job board for work where an AI agent may apply, or
 * may do the job: every posting says so in `agentPolicy`. The public API is
 * keyless, CORS-open and paged by offset, `sort=recent` so a walk from offset
 * zero meets the newest posting first, with a ceiling of 100 a page.
 *
 * Pay arrives two ways and both are carried: `salary` is the classic range
 * with a period, and `pay.lines` is anything else -- per unit, per task, in a
 * token -- which is the shape a bounty on this board actually takes.
 */

const BASE = 'https://agenticjobs.work/api/v1/jobs';
const SITE = 'https://agenticjobs.work';

/** The documented ceiling per page. */
const PAGE = 100;

/** Pages per run. The board is small today; ten pages is a thousand postings. */
const DEFAULT_PAGES = 10;

/**
 * Decoded, whitespace-collapsed, and null when nothing is left.
 *
 * `decodeEntities` always returns a string because the XML parser needs it to.
 * A title that was only an entity decodes to nothing, and a posting with no
 * title is not a posting, so the emptiness has to become null somewhere.
 */
const clean = (s) => {
  const t = decodeEntities(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

const strings = (v) =>
  (Array.isArray(v) ? v : [])
    .map((s) => clean(s))
    .filter(Boolean)
    .slice(0, 20);

/** One posting, or null if it is unpublished, has no id or no title. */
export function toItem(job) {
  const id = clean(job?.id);
  if (!id) return null;
  if (job.status && job.status !== 'published') return null;
  const title = clean(job.title);
  if (!title) return null;

  const org = job.org ?? {};
  const company = clean(org.name);
  const slug = clean(job.slug);
  const tags = strings(job.tags);
  const stack = strings(job.stack);
  const workplace = clean(job.workplace)?.toLowerCase() ?? null;
  const employmentType = clean(job.employmentType)?.toLowerCase() ?? null;
  const seniority = clean(job.seniority)?.toLowerCase() ?? null;
  const agentPolicy = clean(job.agentPolicy)?.toLowerCase() ?? null;

  const published = job.publishedAt ?? job.createdAt ?? null;
  const date = published ? new Date(published) : null;

  return {
    externalId: id.slice(0, 500),
    kind: 'job',
    title: company ? `${title} — ${company}` : title,
    summary: clean(job.description)?.slice(0, 600) ?? null,
    url: slug ? `${SITE}/jobs/${slug}` : SITE,
    imageUrl: typeof org.logoUrl === 'string' && org.logoUrl ? org.logoUrl : null,
    publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
    tags: [
      'agenticjobs',
      employmentType,
      workplace,
      seniority,
      agentPolicy ? `agents:${agentPolicy}` : null,
      company ? `company:${slugify(org.slug ?? company)}` : null,
      ...tags.map(slugify),
      ...stack.map(slugify),
    ].filter(Boolean),
    data: {
      company,
      companySlug: clean(org.slug),
      companyUrl: typeof org.website === 'string' && org.website ? org.website : null,
      location: clean(job.location),
      remote: workplace === 'remote',
      remoteRegions: strings(job.remoteRegions),
      workplace,
      employmentType,
      seniority,
      agentPolicy,
      pay: job.pay ?? null,
      salary: job.salary ?? null,
      tags,
      stack,
      requirements: strings(job.requirements),
      responsibilities: strings(job.responsibilities),
      applyVia: clean(job.apply?.via),
      expiresAt: job.expiresAt ?? null,
      updatedAt: job.updatedAt ?? null,
    },
  };
}

export const agenticjobs = defineAdapter({
  name: 'agenticjobs',
  title: 'agenticjobs.work postings',
  collection: 'jobs',
  description:
    'Every published posting on the agenticjobs.work board, newest first: title, company, location, whether it is remote, the pay in whatever shape it was written, the stack, and whether an AI agent may apply. Keyless public API.',
  docs: 'https://agenticjobs.work/api/v1/jobs',
  kinds: ['job'],
  cadenceMinutes: 30,
  configFields: [
    {
      key: 'pages',
      label: 'Pages per run',
      type: 'number',
      required: false,
      help: 'A hundred postings a page, newest first.',
    },
  ],
  defaults: { pages: DEFAULT_PAGES },
  defaultSources: [
    {
      slug: 'agenticjobs-postings',
      name: 'Jobs: agenticjobs.work postings',
      config: { pages: DEFAULT_PAGES },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const pages = Math.min(Math.max(Number(config.pages) || DEFAULT_PAGES, 1), 50);
    const items = [];
    const seen = new Set();
    let offset = 0;
    let total = null;

    for (let page = 0; page < pages; page++) {
      if (Date.now() > deadline) break;
      let doc;
      try {
        doc = await http.json(`${BASE}?sort=recent&limit=${PAGE}&offset=${offset}`, {
          timeoutMs: 20_000,
        });
      } catch (err) {
        log(`offset ${offset} failed (${err.message.slice(0, 60)})`);
        break;
      }
      const rows = Array.isArray(doc?.items) ? doc.items : [];
      for (const row of rows) {
        const item = toItem(row);
        if (item && !seen.has(item.externalId)) {
          seen.add(item.externalId);
          items.push(item);
        }
      }
      total = Number.isFinite(doc?.total) ? doc.total : total;
      offset += rows.length;
      if (rows.length < PAGE || (total !== null && offset >= total)) break;
    }

    log(`${items.length} postings${total !== null ? ` of ${total}` : ''}`);
    return { items, note: `${items.length} postings` };
  },
});
