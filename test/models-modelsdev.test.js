import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  API_URL,
  BATCH,
  CADENCE_MINUTES,
  CATALOG_URL,
  capabilityTags,
  catalogItem,
  modelsdev,
  offeringItem,
  priceOf,
  providerItem,
  providersOf,
  resumeFrom,
  selectProviders,
} from '../packages/adapters/src/modelsdev.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

/** Drain an async generator, returning its batches and its return value. */
const drain = async (gen) => {
  const batches = [];
  let result;
  for (;;) {
    const n = await gen.next();
    if (n.done) {
      result = n.value;
      break;
    }
    batches.push(n.value);
  }
  return { batches, items: batches.flatMap((b) => b.items), result };
};

const httpFor = (byUrl) => ({
  json: async (url) => {
    if (!(url in byUrl)) throw new Error(`unexpected fetch ${url}`);
    return byUrl[url];
  },
});

const run = async (config, byUrl, ctx = {}) =>
  drain(modelsdev.pull({ config, cursor: {}, http: httpFor(byUrl), log: () => {}, ...ctx }));

describe('models.dev prices', () => {
  test('a published zero is free, a missing price is not', () => {
    expect(priceOf({ input: 0, output: 0 })).toEqual({
      input: 0,
      output: 0,
      cacheRead: null,
      cacheWrite: null,
    });
    expect(priceOf(undefined)).toBeNull();
    expect(priceOf({})).toBeNull();
    expect(priceOf({ input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 })).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
  });

  test('a model with no cost block is not tagged free', () => {
    const item = offeringItem(
      { id: 'p', name: 'P', doc: 'https://p.example' },
      { id: 'm', name: 'M', release_date: '2026-01-01' },
    );
    expect(item.tags).not.toContain('free');
    expect(item.data.free).toBe(false);
    expect(item.data.cost).toBeNull();
    expect(item.summary).toContain('price not published');
  });
});

describe('models.dev capability tags', () => {
  test('flags and modalities become tags', () => {
    const tags = capabilityTags({
      reasoning: true,
      tool_call: true,
      structured_output: false,
      open_weights: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    });
    expect(tags).toContain('reasoning');
    expect(tags).toContain('tool-call');
    expect(tags).toContain('open-weights');
    expect(tags).not.toContain('structured-output');
    expect(tags).toContain('in:image');
    expect(tags).toContain('out:text');
  });
});

describe('models.dev offerings', () => {
  test('one item per provider per model, priced and normalisable', async () => {
    const api = await fixture('modelsdev-api.json');
    const { items, result } = await run({ type: 'offerings' }, { [API_URL]: api });

    const expected = Object.values(api).reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0);
    expect(items.length).toBe(expected);
    expect(result.note).toContain('offerings');

    const claude = items.find((i) => i.externalId.startsWith('anthropic/'));
    expect(claude.kind).toBe('model');
    expect(claude.title).toContain('·');
    expect(claude.data.provider.id).toBe('anthropic');
    expect(claude.data.cost.input).toBeGreaterThan(0);
    expect(claude.tags).toContain('anthropic');
    expect(claude.precision).toBe('day');
    expect(claude.timeKnown).toBe(false);

    for (const item of items) expect(normaliseItem(item)).not.toBeNull();
  });

  test('the same model from two providers stays two rows', async () => {
    const api = await fixture('modelsdev-api.json');
    const { items } = await run({ type: 'offerings' }, { [API_URL]: api });
    const ids = items.map((i) => i.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.includes('/'))).toBe(true);
  });

  test('a provider that publishes zero is tagged free', async () => {
    const api = await fixture('modelsdev-api.json');
    const { items } = await run({ type: 'offerings' }, { [API_URL]: api });
    const free = items.filter((i) => i.tags.includes('free'));
    expect(free.length).toBeGreaterThan(0);
    for (const item of free) {
      expect(item.data.cost.input).toBe(0);
      expect(item.data.cost.output).toBe(0);
    }
  });

  test('a provider filter keeps only what it names', async () => {
    const api = await fixture('modelsdev-api.json');
    const { items } = await run(
      { type: 'offerings', providers: ['anthropic'] },
      { [API_URL]: api },
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.data.provider.id === 'anthropic')).toBe(true);
  });

  test('a passed deadline stops the walk and names where it stopped', async () => {
    const api = await fixture('modelsdev-api.json');
    const { items, result } = await run(
      { type: 'offerings' },
      { [API_URL]: api },
      {
        deadline: Date.now() - 1,
      },
    );
    expect(items).toEqual([]);
    expect(result.note).toContain('stopped at');
  });
});

describe('models.dev catalogue', () => {
  test('providers and lab models, each with a page of its own', async () => {
    const doc = await fixture('modelsdev-catalog.json');
    const { items, result } = await run({ type: 'catalog' }, { [CATALOG_URL]: doc });

    const providers = items.filter((i) => i.kind === 'provider');
    const models = items.filter((i) => i.kind === 'catalog-model');
    expect(providers.length).toBe(Object.keys(doc.providers).length);
    expect(models.length).toBe(Object.keys(doc.models).length);
    expect(result.note).toContain('catalogue');

    for (const m of models) {
      expect(m.url).toStartWith('https://models.dev/models/');
      expect(m.data.lab).toBeTruthy();
      expect(normaliseItem(m)).not.toBeNull();
    }
    // Distinct pages, so nothing collapses if the collection ever dedupes URLs.
    expect(new Set(models.map((m) => m.url)).size).toBe(models.length);

    const p = providers[0];
    expect(p.data.modelCount).toBeGreaterThan(0);
    // A provider has no date of its own and borrows its catalogue's newest.
    expect(p.publishedAt).toBe(p.data.catalogueUpdatedAt);
  });

  test('a provider item counts the free models it serves', async () => {
    const item = providerItem({
      id: 'p',
      name: 'P',
      models: {
        a: { id: 'a', name: 'A', cost: { input: 0, output: 0 }, last_updated: '2026-01-02' },
        b: { id: 'b', name: 'B', cost: { input: 1, output: 2 }, last_updated: '2026-03-04' },
      },
    });
    expect(item.data.modelCount).toBe(2);
    expect(item.data.freeModelCount).toBe(1);
    expect(item.summary).toBe('2 models, 1 free');
    expect(item.publishedAt).toBe('2026-03-04');
  });

  test('a catalogue key becomes the lab and the page', () => {
    const item = catalogItem('bytedance-seed/seed-2.0-pro', {
      id: 'bytedance-seed/seed-2.0-pro',
      name: 'Seed 2.0 Pro',
      release_date: '2026-02-14',
    });
    expect(item.url).toBe('https://models.dev/models/bytedance-seed/seed-2.0-pro');
    expect(item.data.lab).toBe('bytedance-seed');
    expect(item.externalId).toBe('catalog:bytedance-seed/seed-2.0-pro');
  });
});

describe('models.dev document shapes', () => {
  test('providers are read out of either document', async () => {
    const api = await fixture('modelsdev-api.json');
    const doc = await fixture('modelsdev-catalog.json');
    expect(providersOf(api).length).toBe(Object.keys(api).length);
    expect(providersOf(doc).length).toBe(Object.keys(doc.providers).length);
    expect(providersOf(null)).toEqual([]);
  });

  test('a filter accepts a list or a comma string, and an empty one keeps all', () => {
    const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(selectProviders(ps, ['a', 'c']).map((p) => p.id)).toEqual(['a', 'c']);
    expect(selectProviders(ps, 'B , c').map((p) => p.id)).toEqual(['b', 'c']);
    expect(selectProviders(ps, '').length).toBe(3);
    expect(selectProviders(ps, undefined).length).toBe(3);
  });

  test('a cursor resumes after its provider, and a vanished one starts over', () => {
    const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(resumeFrom(ps, { after: 'a' }).map((p) => p.id)).toEqual(['b', 'c']);
    expect(resumeFrom(ps, { after: 'c' })).toEqual([]);
    expect(resumeFrom(ps, { after: 'gone' }).length).toBe(3);
    expect(resumeFrom(ps, {}).length).toBe(3);
  });
});

describe('models.dev registration', () => {
  test('it ships two sources into the models collection, daily', () => {
    expect(modelsdev.collection).toBe('models');
    expect(modelsdev.cadenceMinutes).toBe(CADENCE_MINUTES);
    expect(BATCH).toBeGreaterThan(0);
    expect(modelsdev.defaultSources.map((s) => s.slug).sort()).toEqual([
      'models-dev-catalog',
      'models-dev-offerings',
    ]);
    for (const s of modelsdev.defaultSources) {
      expect(['offerings', 'catalog']).toContain(s.config.type);
    }
  });
});
