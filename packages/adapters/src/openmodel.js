import { defineAdapter, looseDate } from '@nichedb/core/adapter';
import { capabilityTags, priceOf } from './modelsdev.js';

/**
 * OpenModel descriptors: one file a model provider serves about the models it
 * serves and what they cost, at `/.well-known/openmodel.json`.
 *
 * The `models` collection is otherwise read from models.dev, which is a
 * community database: excellent, and still a third party writing down what a
 * provider charges. This is the same shape of row with the provider as its
 * author, so a price is a statement by the company that will bill you rather
 * than a volunteer's reading of a pricing page.
 *
 * It is deliberately the same vocabulary as the models.dev entry it sits
 * beside -- cost, limit, modalities, the capability flags -- so a reader that
 * understands one understands the other, and the two land in the same feeds.
 *
 * ORIGIN IS THE PROOF
 *
 * A descriptor is believed only when it was fetched from the origin it
 * claims: the URL it was read from must share a host with `provider.web`. A
 * descriptor naming no `web` is believed only at the well-known path on the
 * origin the source was pointed at. Anywhere else it is a claim about a
 * provider by whoever hosts it, and is dropped with a note in the log.
 *
 * ABSENT IS UNSTATED
 *
 * Only `provider.name` and one model are required. A model with no `cost` has
 * not said it is free, it has said nothing: free is a published zero in and
 * out, exactly as in the models.dev reader. A missing `limit` is unstated, not
 * unlimited, and a missing capability flag is unstated, not false -- the flags
 * become tags only when the provider sets them.
 *
 * IDS
 *
 * A model is `openmodel:<host>:<model.id>`; the provider itself is
 * `openmodel:provider:<host>`. A re-read updates in place; a model that leaves
 * the file is marked gone by the ingest, not deleted.
 */
export const WELL_KNOWN = '/.well-known/openmodel.json';

/** Providers publish on their own clock; a daily read is enough. */
export const CADENCE_MINUTES = 1440;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const str = (v) => (v == null || v === '' ? null : String(v).trim());

/** A bare origin becomes the well-known path; anything with a path is read as given. */
export function descriptorUrl(entry) {
  const raw = String(entry ?? '').trim();
  if (!raw) return null;
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
  if (!a) return false;
  const web = descriptor?.provider?.web;
  if (!web) {
    try {
      return new URL(fetchedFrom).pathname === WELL_KNOWN;
    } catch {
      return false;
    }
  }
  const b = hostOf(web);
  return Boolean(b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

/** The models the file lists, each as written; anything without an id is dropped. */
export function modelsOf(descriptor) {
  const raw = descriptor?.models;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([id, m]) => ({ id, ...(m ?? {}) }))
      : [];
  return list.filter((m) => m && typeof m === 'object' && (str(m.id) || str(m.name)));
}

function when(s) {
  if (!s) return { publishedAt: null, timeKnown: false, precision: 'day' };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return looseDate(String(s).slice(0, 10));
}

/** The day this model last changed, the provider's word for it. */
const modelWhen = (m, descriptor) =>
  when(m.last_updated ?? m.release_date ?? descriptor?.updated ?? null);

/**
 * One model a provider serves, in its own words.
 *
 * The capability tags come from the shared helper the models.dev reader uses,
 * so `tool-call` means the same thing on both rows and one feed catches both.
 */
export function modelItem(descriptor, m, fetchedFrom, verified) {
  const provider = descriptor?.provider ?? {};
  const host = hostOf(fetchedFrom);
  const id = str(m.id) ?? str(m.name);
  if (!str(provider.name) || !id) return null;
  const price = priceOf(m.cost);
  const free = price !== null && price.input === 0 && price.output === 0;
  const context = Number.isFinite(Number(m.limit?.context)) ? Number(m.limit.context) : null;
  const summary = [
    str(m.description),
    price ? `$${price.input}/$${price.output} per 1M tokens` : 'price not published',
    context ? `${Math.round(context / 1000)}K context` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    externalId: `openmodel:${host}:${id}`,
    kind: 'model',
    title: `${str(m.name) ?? id} · ${str(provider.name)}`,
    summary,
    url: str(m.url) ?? str(provider.doc) ?? str(provider.web) ?? fetchedFrom,
    ...modelWhen(m, descriptor),
    tags: [
      'openmodel',
      ...(host ? [`provider:${host}`] : []),
      ...(str(m.family) ? [m.family] : []),
      ...capabilityTags(m),
      ...(free ? ['free'] : []),
      ...(verified ? ['verified'] : ['unverified']),
    ],
    data: {
      openmodel: descriptor.openmodel ?? null,
      descriptor: fetchedFrom,
      verified,
      provider: {
        id: str(provider.id) ?? host,
        name: str(provider.name),
        web: str(provider.web),
        doc: str(provider.doc),
        api: provider.api ?? null,
        env: Array.isArray(provider.env) ? provider.env : [],
        npm: str(provider.npm),
      },
      modelId: id,
      name: str(m.name) ?? id,
      description: str(m.description),
      cost: price,
      costUnit: price ? (str(m.cost?.unit) ?? 'usd per 1M tokens') : null,
      free,
      // Absent is unstated, so a flag the provider did not set stays null here
      // rather than becoming a false the reader would quote back as a fact.
      reasoning: m.reasoning ?? null,
      toolCall: m.tool_call ?? null,
      structuredOutput: m.structured_output ?? null,
      attachment: m.attachment ?? null,
      temperature: m.temperature ?? null,
      openWeights: m.open_weights ?? null,
      knowledgeCutoff: str(m.knowledge),
      status: str(m.status),
      family: str(m.family),
      modalities: m.modalities ?? null,
      limit: m.limit ?? null,
      releaseDate: str(m.release_date),
      lastUpdated: str(m.last_updated),
    },
  };
}

/** The provider itself, with the size of the catalogue it published. */
export function providerItem(descriptor, fetchedFrom, verified) {
  const provider = descriptor?.provider ?? {};
  const host = hostOf(fetchedFrom);
  if (!str(provider.name)) return null;
  const models = modelsOf(descriptor);
  const free = models.filter((m) => {
    const p = priceOf(m.cost);
    return p !== null && p.input === 0 && p.output === 0;
  }).length;
  return {
    externalId: `openmodel:provider:${host}`,
    kind: 'provider',
    title: str(provider.name),
    summary: `${models.length} model${models.length === 1 ? '' : 's'}${free ? `, ${free} free` : ''}`,
    url: str(provider.doc) ?? str(provider.web) ?? fetchedFrom,
    ...when(descriptor.updated),
    tags: [
      'openmodel',
      'provider',
      ...(host ? [`provider:${host}`] : []),
      ...(verified ? ['verified'] : ['unverified']),
    ],
    data: {
      openmodel: descriptor.openmodel ?? null,
      descriptor: fetchedFrom,
      verified,
      id: str(provider.id) ?? host,
      name: str(provider.name),
      web: str(provider.web),
      doc: str(provider.doc),
      api: provider.api ?? null,
      env: Array.isArray(provider.env) ? provider.env : [],
      npm: str(provider.npm),
      modelCount: models.length,
      freeModelCount: free,
    },
  };
}

/** Everything one descriptor yields: the provider, then its models. */
export function itemsFrom(descriptor, fetchedFrom, verified) {
  const p = providerItem(descriptor, fetchedFrom, verified);
  if (!p) return [];
  return [
    p,
    ...modelsOf(descriptor).map((m) => modelItem(descriptor, m, fetchedFrom, verified)),
  ].filter(Boolean);
}

export const openmodel = defineAdapter({
  name: 'openmodel',
  title: 'OpenModel descriptors',
  collection: 'models',
  description:
    "A model provider's own file about the models it serves and what they cost, read from /.well-known/openmodel.json on the provider's origin. The same vocabulary as the models.dev rows beside it, with the provider as the author. Believed only when served from the origin it describes.",
  docs: 'https://logicsrc.com/docs/openmodel',
  kinds: ['model', 'provider'],
  cadenceMinutes: CADENCE_MINUTES,
  configFields: [
    {
      key: 'providers',
      label: 'Providers',
      type: 'list',
      required: true,
      placeholder: 'acme.ai, api.example.com/.well-known/openmodel.json',
      help: 'An origin (the well-known path is added) or a full descriptor URL.',
    },
  ],
  defaults: { providers: [] },
  async pull({ config, http, log }) {
    const entries = (Array.isArray(config.providers) ? config.providers : [config.providers])
      .flatMap((e) => String(e ?? '').split(','))
      .map((e) => e.trim())
      .filter(Boolean);
    const items = [];
    let read = 0;
    let dropped = 0;
    for (const entry of entries) {
      const url = descriptorUrl(entry);
      if (!url) continue;
      const doc = await http.jsonOrNull(url);
      if (!doc) {
        log(`${entry}: no descriptor`);
        continue;
      }
      const verified = servedByProvider(url, doc);
      if (!verified && doc?.provider?.web) {
        // It names the provider it describes and was served by someone else:
        // a third party's claim about a company's prices, which is the one
        // thing this reader exists not to carry. A file that names no `web`
        // is only ever about whoever served it, so that one is kept unverified.
        log(`${entry}: not served by the provider it describes, dropped`);
        dropped++;
        continue;
      }
      const got = itemsFrom(doc, url, verified);
      if (got.length === 0) {
        log(`${entry}: descriptor names no provider`);
        continue;
      }
      items.push(...got);
      read++;
    }
    const note = `${items.length} row(s) from ${read} descriptor(s)${dropped ? `, ${dropped} dropped` : ''}`;
    log(note);
    return { items, note };
  },
});
