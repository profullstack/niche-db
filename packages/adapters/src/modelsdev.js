import { defineAdapter } from '@nichedb/core/adapter';

/**
 * models.dev: an open database of AI models, what they can do and what they cost.
 *
 * Two shapes of the same database, and the difference matters:
 *
 *   api.json     one entry per PROVIDER, each carrying the models that provider
 *                serves. The same model reaches you from a dozen providers at a
 *                dozen prices, so the row worth storing is the offering --
 *                (provider, model) -- not the model.
 *   catalog.json the providers again, plus `models`: the LAB catalogue, one entry
 *                per model as its maker published it, keyed `lab/slug`. This half
 *                is the only one with a page of its own on the site
 *                (models.dev/models/<lab>/<slug>); a provider's offering has no
 *                URL but the provider's own documentation.
 *
 * Keyless, MIT licensed, community maintained (github.com/anomalyco/models.dev).
 * Measured 2026-09-24: 223 providers, 8,179 offerings, 428 catalogue models.
 */

export const API_URL = 'https://models.dev/api.json?type=all';
export const CATALOG_URL = 'https://models.dev/catalog.json?type=all';

/** Daily. The upstream is a build artefact of a git repo, not a live feed. */
export const CADENCE_MINUTES = 1440;

/** Items handed over per batch, so a run holds a few hundred rows rather than 8,000. */
export const BATCH = 300;

/** 5 MB of JSON over one connection wants longer than the 30s default. */
const FETCH_TIMEOUT_MS = 120_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A price is only absent when the provider does not publish one. Zero is a
 * fact (free tiers exist and are the reason half of this catalogue is read),
 * so it must survive every guard: `cost.input || null` would erase it.
 */
export function priceOf(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const input = num(cost.input);
  const output = num(cost.output);
  if (input === null && output === null) return null;
  return {
    input,
    output,
    cacheRead: num(cost.cache_read),
    cacheWrite: num(cost.cache_write),
  };
}

/** Free means a published price of zero, never a missing price. */
const isFree = (price) => price !== null && price.input === 0 && price.output === 0;

/**
 * The capability flags, as tags, so a feed can be "everything that calls tools"
 * without the query language learning what a model is.
 */
export function capabilityTags(m) {
  const tags = [];
  if (m.reasoning) tags.push('reasoning');
  if (m.tool_call) tags.push('tool-call');
  if (m.structured_output) tags.push('structured-output');
  if (m.attachment) tags.push('attachment');
  if (m.open_weights) tags.push('open-weights');
  if (m.temperature) tags.push('temperature');
  if (m.experimental) tags.push('experimental');
  for (const mod of m.modalities?.input ?? []) tags.push(`in:${mod}`);
  for (const mod of m.modalities?.output ?? []) tags.push(`out:${mod}`);
  return tags;
}

/** The shared half of a model row, which both the offering and the catalogue keep. */
function modelFacts(m) {
  return {
    modelId: m.id ?? null,
    family: m.family ?? null,
    reasoning: Boolean(m.reasoning),
    reasoningOptions: m.reasoning_options ?? null,
    toolCall: Boolean(m.tool_call),
    structuredOutput: Boolean(m.structured_output),
    attachment: Boolean(m.attachment),
    temperature: Boolean(m.temperature),
    openWeights: Boolean(m.open_weights),
    interleaved: m.interleaved ?? null,
    experimental: m.experimental ?? null,
    status: m.status ?? null,
    // Upstream fields a minority of entries carry: the served model's type, and
    // the upstream provider a reseller is fronting.
    type: m.type ?? null,
    servedBy: m.provider ?? null,
    knowledgeCutoff: m.knowledge ?? null,
    modalities: m.modalities ?? null,
    limit: m.limit ?? null,
    releaseDate: m.release_date ?? null,
    lastUpdated: m.last_updated ?? null,
  };
}

/**
 * `last_updated` is the day the entry changed and `release_date` the day the
 * model shipped. Both are days, so nothing here claims a time it does not know.
 */
const dateOf = (m) => m.last_updated ?? m.release_date ?? null;

/** One provider's offering of one model: the row that carries a price. */
export function offeringItem(provider, m) {
  const price = priceOf(m.cost);
  const context = num(m.limit?.context);
  const summary = [
    m.description,
    price ? `$${price.input}/$${price.output} per 1M tokens` : 'price not published',
    context ? `${Math.round(context / 1000)}K context` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    externalId: `${provider.id}/${m.id}`,
    kind: 'model',
    title: `${m.name} · ${provider.name}`,
    summary,
    // A provider's offering has no page of its own; its documentation is the
    // nearest honest link. Several offerings share one, which is fine: this
    // collection does not dedupe on URL.
    url: provider.doc ?? null,
    publishedAt: dateOf(m),
    precision: 'day',
    timeKnown: false,
    tags: [
      'models.dev',
      provider.id,
      ...(m.family ? [m.family] : []),
      ...capabilityTags(m),
      ...(isFree(price) ? ['free'] : []),
    ],
    data: {
      provider: {
        id: provider.id,
        name: provider.name,
        doc: provider.doc ?? null,
        npm: provider.npm ?? null,
        env: provider.env ?? [],
      },
      name: m.name ?? null,
      description: m.description ?? null,
      cost: price,
      costUnit: price ? 'usd per 1M tokens' : null,
      free: isFree(price),
      ...modelFacts(m),
    },
  };
}

/** One model as its lab published it, which is the half with a page on the site. */
export function catalogItem(key, m) {
  const lab = String(key).split('/')[0] ?? null;
  return {
    externalId: `catalog:${key}`,
    kind: 'catalog-model',
    title: m.name ?? key,
    summary: m.description ?? null,
    url: `https://models.dev/models/${key}`,
    publishedAt: dateOf(m),
    precision: 'day',
    timeKnown: false,
    tags: [
      'models.dev',
      'catalog',
      ...(lab ? [lab] : []),
      ...(m.family ? [m.family] : []),
      ...capabilityTags(m),
    ],
    data: {
      lab,
      catalogKey: key,
      name: m.name ?? null,
      description: m.description ?? null,
      ...modelFacts(m),
    },
  };
}

/**
 * A provider, with the size and the freshness of its catalogue.
 *
 * A provider has no date of its own, so it takes the newest date of anything it
 * serves -- the last time its catalogue changed -- rather than sorting to the
 * bottom of the collection forever with a null.
 */
export function providerItem(provider) {
  const models = Object.values(provider.models ?? {});
  const dates = models.map(dateOf).filter(Boolean).sort();
  const free = models.filter((m) => isFree(priceOf(m.cost))).length;
  return {
    externalId: `provider:${provider.id}`,
    kind: 'provider',
    title: provider.name ?? provider.id,
    summary: `${models.length} model${models.length === 1 ? '' : 's'}${free ? `, ${free} free` : ''}`,
    url: provider.doc ?? null,
    publishedAt: dates.at(-1) ?? null,
    precision: 'day',
    timeKnown: false,
    tags: ['models.dev', 'provider', provider.id],
    data: {
      id: provider.id,
      name: provider.name ?? null,
      doc: provider.doc ?? null,
      npm: provider.npm ?? null,
      env: provider.env ?? [],
      modelCount: models.length,
      freeModelCount: free,
      catalogueUpdatedAt: dates.at(-1) ?? null,
    },
  };
}

/** The providers map, whichever of the two documents it arrived in. */
export function providersOf(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const map = doc.providers && typeof doc.providers === 'object' ? doc.providers : doc;
  return Object.entries(map)
    .filter(([, p]) => p && typeof p === 'object' && p.models)
    .map(([id, p]) => ({ ...p, id: p.id ?? id }));
}

/**
 * Where a deadline-stopped run left off.
 *
 * The cursor names the last provider written, not an index: the document is
 * rebuilt upstream between runs and a provider added anywhere above the mark
 * would shift every index below it. A cursor naming a provider that is no
 * longer there resumes from the top rather than skipping the run -- refetching
 * rows that are already correct costs a write of nothing, and skipping them
 * loses them.
 */
export function resumeFrom(providers, cursor) {
  const after = cursor?.after;
  if (!after) return providers;
  const at = providers.findIndex((p) => p.id === after);
  return at === -1 ? providers : providers.slice(at + 1);
}

/** Only the providers a source asked for, or all of them. */
export function selectProviders(providers, only) {
  const wanted = new Set(
    (Array.isArray(only) ? only : String(only ?? '').split(','))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean),
  );
  if (wanted.size === 0) return providers;
  return providers.filter((p) => wanted.has(String(p.id).toLowerCase()));
}

export const modelsdev = defineAdapter({
  name: 'modelsdev',
  title: 'models.dev',
  collection: 'models',
  description:
    'Every AI model and what it costs, from models.dev: one row per provider offering with its price per million tokens, context window, modalities and capabilities, plus the lab catalogue and the providers themselves. Keyless, MIT licensed, updated daily.',
  docs: 'https://models.dev',
  kinds: ['model', 'catalog-model', 'provider'],
  cadenceMinutes: CADENCE_MINUTES,
  configFields: [
    {
      key: 'type',
      label: 'What',
      type: 'select',
      options: ['offerings', 'catalog'],
      required: true,
      help: 'offerings: every provider, every model it serves, at its price. catalog: the lab catalogue and the providers themselves.',
    },
    {
      key: 'providers',
      label: 'Providers',
      type: 'list',
      placeholder: 'anthropic, openai',
      help: 'Optional: only these provider ids.',
    },
  ],
  defaults: { type: 'offerings' },
  defaultSources: [
    {
      slug: 'models-dev-offerings',
      name: 'models.dev: models and prices',
      config: { type: 'offerings' },
    },
    {
      slug: 'models-dev-catalog',
      name: 'models.dev: lab catalogue and providers',
      config: { type: 'catalog' },
    },
  ],
  async *pull({ config, cursor, http, log, deadline }) {
    const catalog = config.type === 'catalog';
    const doc = await http.json(catalog ? CATALOG_URL : API_URL, {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const all = selectProviders(providersOf(doc), config.providers);
    const providers = catalog ? all : resumeFrom(all, cursor);

    let items = [];
    let count = 0;
    let stoppedAt = null;

    if (catalog) {
      for (const p of providers) items.push(providerItem(p));
      const models = doc?.models && typeof doc.models === 'object' ? doc.models : {};
      for (const [key, m] of Object.entries(models)) {
        if (m && typeof m === 'object') items.push(catalogItem(key, m));
      }
      for (let i = 0; i < items.length; i += BATCH) {
        yield { items: items.slice(i, i + BATCH) };
      }
      count = items.length;
      log(`${providers.length} providers, ${count - providers.length} catalogue models`);
      return { note: `${count} rows from the catalogue` };
    }

    for (const p of providers) {
      /*
       * A deadline stops between providers rather than inside one, and the
       * cursor names the provider to resume from. At-least-once is safe: the
       * whole document is refetched next run and the upserts are idempotent.
       */
      if (deadline && Date.now() > deadline) {
        stoppedAt = p.id;
        break;
      }
      for (const m of Object.values(p.models ?? {})) {
        if (m && typeof m === 'object') items.push(offeringItem(p, m));
      }
      if (items.length >= BATCH) {
        count += items.length;
        yield { items, cursor: { after: p.id } };
        items = [];
      }
    }
    if (items.length > 0) {
      count += items.length;
      yield { items };
    }

    log(`${count} offerings from ${providers.length} providers`);
    return {
      cursor: {},
      note: stoppedAt
        ? `${count} offerings, stopped at ${stoppedAt}`
        : `${count} offerings from ${providers.length} providers`,
    };
  },
});
