import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * The FindHost register of web hosting providers, as providers.json publishes
 * it.
 *
 * FindHost (findhost.app, curated by Frank Lämmer of fortrabbit) describes 185
 * hosts by attributes and never by score: category, regions, runtimes, deploy
 * methods, who manages the OS, how fast you can leave, who owns the company.
 * Its data is CC BY 4.0 and its robots.txt says "Reuse and quotation are the
 * point", which is the reading this adapter does. The credit it asks for is
 * carried in full on every row and in this source's description:
 *
 *     FindHost, findhost.app, CC BY 4.0
 *
 * The register's own rule is worth repeating because it shapes the tags: "An
 * absent field means unknown, never zero and never bad." A provider with no
 * `green` feature is not a provider that runs on coal; it is one nobody has
 * checked. So tags say what is recorded and nothing else.
 *
 * `addedAt` is the row's date, day precision: a provider joining the register
 * is the event a "new hosting providers" feed reports. Edits move
 * `modifiedAt` and change the content hash, so they update in place.
 *
 * THE ID IS THE COLLECTION'S PROVIDER SLUG
 *
 * `data.provider` on this row is the FindHost id, and the plan adapters
 * (vultr, linode, scaleway, ovh) write the same id on every plan they emit.
 * That is the join: one company, one register row, its plans beside it,
 * without a table for it. Where OpenServer descriptors arrive with a
 * different id, the register's wins for any provider FindHost lists.
 */
export const PROVIDERS_URL = 'https://www.findhost.app/providers.json';
export const ATTRIBUTION = 'FindHost, findhost.app, CC BY 4.0';
const SITE = 'https://www.findhost.app';

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

export function toItem(p, meta = {}) {
  if (!p?.id || !p?.name) return null;
  const f = p.facets ?? {};
  const categories = list(f.category).map(slug);
  const regions = list(f.regions).map((r) => r.toLowerCase());
  const features = list(f.features).map(slug);
  const { publishedAt, timeKnown, precision } = looseDate(String(p.addedAt ?? '').slice(0, 10));
  return {
    externalId: `findhost:${p.id}`,
    kind: 'provider',
    title: p.name,
    summary: p.description ?? null,
    url: p.href ? new URL(p.href, SITE).href : `${SITE}/${p.id}/`,
    publishedAt,
    timeKnown,
    precision,
    tags: [
      'provider',
      ...categories,
      ...regions.map((r) => `region:${r}`),
      ...features,
      ...list(f.runtimes).map((r) => `runtime:${slug(r)}`),
      f.priceFrom ? `price-from:${slug(f.priceFrom)}` : null,
      f.whoManagesOs ? `os:${slug(f.whoManagesOs)}` : null,
      f.ownership ? `ownership:${slug(f.ownership)}` : null,
      p.country ? `country:${String(p.country).toLowerCase()}` : null,
      p.greenWebId ? 'green-web-checked' : null,
    ].filter(Boolean),
    data: {
      provider: p.id,
      findhostId: p.id,
      country: p.country ?? null,
      greenWebId: p.greenWebId ?? null,
      facets: f,
      notApplicable: p.notApplicable ?? [],
      addedAt: p.addedAt ?? null,
      modifiedAt: p.modifiedAt ?? null,
      checkedAt: p.checkedAt ?? null,
      figure: p.figure ?? null,
      favorite: Boolean(p.favorite),
      attribution: meta.attribution ?? ATTRIBUTION,
      licence: 'CC BY 4.0',
      licenceUrl: meta.license ?? 'https://creativecommons.org/licenses/by/4.0/',
      source: meta.url ?? `${SITE}/`,
    },
  };
}

export function parseProviders(doc) {
  const providers = Array.isArray(doc) ? doc : (doc?.providers ?? []);
  const meta = Array.isArray(doc) ? {} : (doc?.meta ?? {});
  return providers.map((p) => toItem(p, meta)).filter(Boolean);
}

export const findhost = defineAdapter({
  name: 'findhost',
  title: 'FindHost providers',
  collection: 'hosting',
  description:
    'The FindHost register of web hosting providers: 185 hosts described by attribute — category, regions, runtimes, deploy methods, who manages the OS, how fast you can leave, who owns the company — never by score. Read from providers.json. Data CC BY 4.0; credit: FindHost, findhost.app, CC BY 4.0. Keyless.',
  docs: 'https://github.com/fortrabbit/findhost',
  kinds: ['provider'],
  cadenceMinutes: 1440,
  configFields: [],
  defaultSources: [
    {
      slug: 'findhost-providers',
      name: 'Hosting: the FindHost register',
      description:
        'Web hosting providers as FindHost records them, one row each with every attribute the register holds. Data CC BY 4.0 — credit FindHost, findhost.app, CC BY 4.0 wherever a row is shown.',
    },
  ],
  async pull({ http, log }) {
    const doc = await http.json(PROVIDERS_URL, { timeoutMs: 60_000 });
    const items = parseProviders(doc);
    log(`${items.length} providers (${doc?.meta?.attribution ?? ATTRIBUTION})`);
    return { items, note: `${items.length} providers; ${doc?.meta?.attribution ?? ATTRIBUTION}` };
  },
});
