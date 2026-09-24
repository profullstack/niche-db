import { describe, expect, test } from 'bun:test';

import {
  CADENCE_MINUTES,
  descriptorUrl,
  itemsFrom,
  modelItem,
  modelsOf,
  openmodel,
  providerItem,
  servedByProvider,
  WELL_KNOWN,
} from '../packages/adapters/src/openmodel.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const DESCRIPTOR = {
  openmodel: '0.1',
  updated: '2026-09-24',
  provider: {
    id: 'acme',
    name: 'Acme AI',
    web: 'https://acme.ai',
    doc: 'https://acme.ai/docs/models',
    env: ['ACME_API_KEY'],
  },
  models: [
    {
      id: 'acme-large',
      name: 'Acme Large',
      description: 'Flagship model',
      family: 'acme',
      reasoning: true,
      tool_call: true,
      open_weights: false,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200000, output: 64000 },
      cost: { input: 1, output: 5, cache_read: 0.1 },
      release_date: '2026-03-01',
      last_updated: '2026-06-01',
    },
    { id: 'acme-free', name: 'Acme Free', cost: { input: 0, output: 0 } },
    { id: 'acme-quiet', name: 'Acme Quiet' },
  ],
};

const AT = `https://acme.ai${WELL_KNOWN}`;

const httpFor = (byUrl) => ({
  jsonOrNull: async (url) => byUrl[url] ?? null,
});

const run = (config, byUrl) =>
  openmodel.pull({ config, cursor: {}, http: httpFor(byUrl), log: () => {} });

describe('openmodel descriptor urls', () => {
  test('a bare origin gets the well-known path, a full url is used as given', () => {
    expect(descriptorUrl('acme.ai')).toBe(`https://acme.ai${WELL_KNOWN}`);
    expect(descriptorUrl('https://acme.ai')).toBe(`https://acme.ai${WELL_KNOWN}`);
    expect(descriptorUrl('https://acme.ai/models.json')).toBe('https://acme.ai/models.json');
    expect(descriptorUrl('')).toBeNull();
  });
});

describe('openmodel origin is the proof', () => {
  test('the provider serving its own file is verified', () => {
    expect(servedByProvider(AT, DESCRIPTOR)).toBe(true);
    expect(servedByProvider('https://api.acme.ai/.well-known/openmodel.json', DESCRIPTOR)).toBe(
      true,
    );
  });

  test('somebody else serving a file about Acme is not', () => {
    expect(servedByProvider(`https://mirror.example${WELL_KNOWN}`, DESCRIPTOR)).toBe(false);
  });

  test('a file naming no web is believed only at the well-known path', () => {
    const anon = { provider: { name: 'Anon' }, models: [{ id: 'm' }] };
    expect(servedByProvider(`https://anon.example${WELL_KNOWN}`, anon)).toBe(true);
    expect(servedByProvider('https://anon.example/models.json', anon)).toBe(false);
  });

  test('a descriptor served by a stranger about a named provider is dropped', async () => {
    const url = `https://mirror.example${WELL_KNOWN}`;
    const r = await run({ providers: ['mirror.example'] }, { [url]: DESCRIPTOR });
    expect(r.items).toEqual([]);
    expect(r.note).toContain('dropped');
  });
});

describe('openmodel rows', () => {
  test('a descriptor yields its provider and every model', async () => {
    const r = await run({ providers: ['acme.ai'] }, { [AT]: DESCRIPTOR });
    const providers = r.items.filter((i) => i.kind === 'provider');
    const models = r.items.filter((i) => i.kind === 'model');
    expect(providers.length).toBe(1);
    expect(models.length).toBe(3);
    expect(providers[0].externalId).toBe('openmodel:provider:acme.ai');
    expect(providers[0].summary).toBe('3 models, 1 free');
    for (const item of r.items) expect(normaliseItem(item)).not.toBeNull();
  });

  test('a priced model carries its price and capability tags', () => {
    const item = modelItem(DESCRIPTOR, DESCRIPTOR.models[0], AT, true);
    expect(item.externalId).toBe('openmodel:acme.ai:acme-large');
    expect(item.data.cost).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: null });
    expect(item.tags).toContain('reasoning');
    expect(item.tags).toContain('tool-call');
    expect(item.tags).toContain('in:image');
    expect(item.tags).toContain('verified');
    expect(item.tags).not.toContain('free');
    expect(item.summary).toContain('200K context');
  });

  test('a published zero is free, the same rule as the models.dev reader', () => {
    const item = modelItem(DESCRIPTOR, DESCRIPTOR.models[1], AT, true);
    expect(item.data.free).toBe(true);
    expect(item.tags).toContain('free');
  });

  test('a model that states no price is unstated, not free', () => {
    const item = modelItem(DESCRIPTOR, DESCRIPTOR.models[2], AT, true);
    expect(item.data.cost).toBeNull();
    expect(item.data.free).toBe(false);
    expect(item.tags).not.toContain('free');
    expect(item.summary).toContain('price not published');
  });

  test('a capability the provider did not state stays null, never false', () => {
    const item = modelItem(DESCRIPTOR, DESCRIPTOR.models[2], AT, true);
    expect(item.data.reasoning).toBeNull();
    expect(item.data.toolCall).toBeNull();
    // open_weights was explicitly false on the flagship, and that survives.
    expect(modelItem(DESCRIPTOR, DESCRIPTOR.models[0], AT, true).data.openWeights).toBe(false);
  });

  test('models may be a map keyed by id as well as a list', () => {
    const keyed = { provider: { name: 'Acme AI' }, models: { 'acme-x': { name: 'X' } } };
    expect(modelsOf(keyed)).toEqual([{ id: 'acme-x', name: 'X' }]);
    expect(modelsOf({})).toEqual([]);
  });

  test('an unverified but self-named descriptor is kept and marked', () => {
    const anon = { provider: { name: 'Anon' }, models: [{ id: 'm', name: 'M' }] };
    const items = itemsFrom(anon, 'https://anon.example/models.json', false);
    expect(items.length).toBe(2);
    for (const i of items) expect(i.tags).toContain('unverified');
  });

  test('a descriptor with no provider name yields nothing', () => {
    expect(providerItem({ models: [{ id: 'm' }] }, AT, true)).toBeNull();
    expect(itemsFrom({ models: [{ id: 'm' }] }, AT, true)).toEqual([]);
  });
});

describe('openmodel registration', () => {
  test('it reads into the models collection, daily, with no default source', () => {
    expect(openmodel.collection).toBe('models');
    expect(openmodel.cadenceMinutes).toBe(CADENCE_MINUTES);
    expect(openmodel.kinds).toEqual(['model', 'provider']);
    // Nothing is seeded: no provider serves one yet, and a source is added by
    // pointing this adapter at an origin.
    expect(openmodel.defaultSources ?? []).toEqual([]);
  });

  test('a missing descriptor is skipped rather than failing the run', async () => {
    const r = await run({ providers: ['nope.example'] }, {});
    expect(r.items).toEqual([]);
  });
});
