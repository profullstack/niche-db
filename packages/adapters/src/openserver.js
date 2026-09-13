import { defineAdapter, looseDate } from '@nichedb/core/adapter';
import { describeOffer, priceBucket } from './hosting.js';

/**
 * OpenServer descriptors: a provider's own statement of what it sells,
 * served from its own origin at `/.well-known/openserver.json`.
 *
 * This is the first reader of the spec (logicsrc, being written alongside).
 * The other hosting adapters go to a provider's API and translate; this one
 * takes the provider's words as written, because the whole point of the
 * descriptor is that the provider said it. Nothing is normalised beyond the
 * lower-casing a tag needs, the provider is attributed on every row, and the
 * descriptor's own `updated` is the row's date.
 *
 * ORIGIN IS THE PROOF
 *
 * A descriptor is believed only when it was fetched from the origin it claims
 * to describe: the URL it was read from must share a host with
 * `provider.web`. A descriptor for vultr.com hosted on someone else's domain
 * is a claim about Vultr made by a stranger, and is dropped with a note in
 * the log. A bare origin in the source config is read at the well-known
 * path; a full URL is read as given and held to the same rule.
 *
 * IDS
 *
 * The provider row is `openserver:provider:<host>`; an offer is
 * `openserver:offer:<host>:<offer.id>`. Re-reading tomorrow updates both in
 * place. `data.provider` is the descriptor's `provider.id` when it has one,
 * else the host with its `www.` removed -- and where the FindHost register
 * lists the company under another id, the register's wins, so a deployment
 * may map the two in the source config (`providers`: `host=slug`).
 *
 * There is no live descriptor today, so the seeded source starts with no
 * URLs and paused; add an origin and enable it.
 */
export const WELL_KNOWN = '/.well-known/openserver.json';

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** A bare origin becomes the well-known path; anything with a path is read as given. */
export function descriptorUrl(entry) {
  const raw = String(entry).trim();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}${WELL_KNOWN}`;
    return u.href;
  } catch {
    return null;
  }
}

/** True when the descriptor was served from the origin it describes. */
export function servedByProvider(fetchedFrom, descriptor) {
  const a = hostOf(fetchedFrom);
  const b = hostOf(descriptor?.provider?.web);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

export function providerSlug(descriptor, fetchedFrom, aliases = {}) {
  const host = hostOf(fetchedFrom);
  const own = descriptor?.provider?.id ? String(descriptor.provider.id) : host;
  return aliases[host] ?? aliases[own] ?? own;
}

function when(s) {
  if (!s) return { publishedAt: null, timeKnown: false, precision: 'day' };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return looseDate(String(s).slice(0, 10));
}

export function providerItem(descriptor, fetchedFrom, aliases = {}) {
  const p = descriptor?.provider;
  if (!p?.name || !p?.web) return null;
  const host = hostOf(fetchedFrom);
  const slug = providerSlug(descriptor, fetchedFrom, aliases);
  return {
    externalId: `openserver:provider:${host}`,
    kind: 'provider',
    title: p.name,
    summary: p.description ?? `${p.name}, as described in its OpenServer descriptor.`,
    url: p.web,
    ...when(descriptor.updated),
    tags: [
      'provider',
      'openserver',
      p.country ? `country:${String(p.country).toLowerCase()}` : null,
      p.status ? `status:${String(p.status).toLowerCase()}` : null,
      p.developer?.cli ? 'has-cli' : null,
    ].filter(Boolean),
    data: {
      provider: slug,
      // OpenServer 0.2: the provider's own statement of its CLI, API docs,
      // Terraform provider and GitHub org, kept as written so the developer
      // enricher shows the provider's words instead of the seed's.
      developer: p.developer && typeof p.developer === 'object' ? p.developer : null,
      openserver: descriptor.openserver ?? null,
      descriptor: fetchedFrom,
      name: p.name,
      web: p.web,
      operator: p.operator ?? null,
      country: p.country ?? null,
      support: p.support ?? null,
      status: p.status ?? null,
      offers: Array.isArray(descriptor.offers) ? descriptor.offers.length : 0,
      updated: descriptor.updated ?? null,
      attribution: `${p.name} (${host}), from its own OpenServer descriptor`,
    },
  };
}

export function offerItem(descriptor, o, fetchedFrom, aliases = {}) {
  const p = descriptor?.provider;
  if (!o?.id || !p?.name) return null;
  const host = hostOf(fetchedFrom);
  const slug = providerSlug(descriptor, fetchedFrom, aliases);
  const monthly = o.price?.interval === 'month' ? Number(o.price.amount) : null;
  const regions = (o.location?.regions ?? []).map((r) => String(r).toLowerCase());
  const countries = (o.location?.countries ?? []).map((c) => String(c).toLowerCase());
  return {
    externalId: `openserver:offer:${host}:${o.id}`,
    kind: 'plan',
    title: `${p.name} ${o.name ?? o.id}`,
    summary: o.description ?? describeOffer(o) ?? null,
    url: o.url ?? p.web,
    ...when(o.updated ?? descriptor.updated),
    tags: [
      'plan',
      'openserver',
      `provider:${slug}`,
      o.kind ? `kind:${String(o.kind).toLowerCase()}` : null,
      priceBucket(monthly),
      o.price?.currency ? `currency:${String(o.price.currency).toLowerCase()}` : null,
      o.compute?.arch ? `arch:${String(o.compute.arch).toLowerCase()}` : null,
      o.compute?.gpu ? 'gpu' : null,
      o.stock ? `stock:${String(o.stock).toLowerCase()}` : null,
      ...regions.map((r) => `region:${r}`),
      ...countries.map((c) => `country:${c}`),
    ].filter(Boolean),
    data: {
      provider: slug,
      providerName: p.name,
      offer: o,
      descriptor: fetchedFrom,
      attribution: `${p.name} (${host}), from its own OpenServer descriptor`,
    },
  };
}

export function parseDescriptor(descriptor, fetchedFrom, aliases = {}) {
  if (!servedByProvider(fetchedFrom, descriptor)) return { items: [], rejected: 'origin' };
  const provider = providerItem(descriptor, fetchedFrom, aliases);
  if (!provider) return { items: [], rejected: 'provider' };
  const offers = (Array.isArray(descriptor.offers) ? descriptor.offers : [])
    .map((o) => offerItem(descriptor, o, fetchedFrom, aliases))
    .filter(Boolean);
  return { items: [provider, ...offers], rejected: null };
}

/** `host=slug` lines in the source config into a lookup. */
export function parseAliases(list) {
  const out = {};
  for (const entry of Array.isArray(list) ? list : String(list ?? '').split(',')) {
    const [host, slug] = String(entry)
      .split('=')
      .map((s) => s.trim());
    if (host && slug) out[host.toLowerCase().replace(/^www\./, '')] = slug;
  }
  return out;
}

export const openserver = defineAdapter({
  name: 'openserver',
  title: 'OpenServer descriptors',
  collection: 'hosting',
  description:
    'A provider’s own catalogue, read from the OpenServer descriptor it serves at /.well-known/openserver.json: one provider row and one row per offer, in the provider’s words, attributed to the provider. A descriptor counts only when it is served from the origin it describes. Keyless.',
  docs: 'https://logicsrc.com/docs/openserver',
  kinds: ['provider', 'plan'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'urls',
      label: 'Descriptors',
      type: 'list',
      help: 'Provider origins (read at /.well-known/openserver.json) or full descriptor URLs.',
      placeholder: 'https://example-host.com',
    },
    {
      key: 'providers',
      label: 'Provider ids',
      type: 'list',
      help: 'host=slug, where the FindHost register lists the company under a different id than its descriptor.',
      placeholder: 'ovhcloud.com=ovh',
    },
  ],
  defaults: { urls: [], providers: [] },
  defaultSources: [
    {
      slug: 'openserver',
      name: 'Hosting: OpenServer descriptors',
      config: { urls: [], providers: [] },
      enabled: false,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const entries = (
      Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(',')
    )
      .map(descriptorUrl)
      .filter(Boolean)
      .slice(0, 200);
    const aliases = parseAliases(config.providers);
    if (entries.length === 0) {
      log('no descriptors configured');
      return { items: [], note: 'no descriptors configured' };
    }
    const items = [];
    const failed = [];
    let providers = 0;
    for (const url of entries) {
      if (Date.now() > deadline) break;
      try {
        const doc = await http.json(url, { timeoutMs: 20_000 });
        const { items: got, rejected } = parseDescriptor(doc, url, aliases);
        if (rejected) {
          failed.push(
            `${hostOf(url)} (${rejected === 'origin' ? 'not served by the provider it names' : 'no provider'})`,
          );
          continue;
        }
        providers += 1;
        items.push(...got);
      } catch (err) {
        failed.push(`${hostOf(url) ?? url} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${providers} providers, ${items.length - providers} offers${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${providers} providers, ${items.length - providers} offers${failed.length ? `; ${failed.length} descriptors rejected` : ''}`,
    };
  },
});
