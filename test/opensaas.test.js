import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { adapterByName } from '../packages/adapters/src/index.js';
import {
  actionsOf,
  descriptorUrl,
  exitOf,
  opensaas,
  parseDescriptor,
  planItem,
  servedByService,
} from '../packages/adapters/src/opensaas.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { COLLECTIONS } = await import('../packages/core/src/seed.js');

const json = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const URL_ = 'https://nichedb.dev/.well-known/opensaas.json';

describe('OpenSaaS descriptors: where one is read and whether it is believed', () => {
  test('a bare origin is read at the well-known path; a full URL as given', () => {
    expect(descriptorUrl('nichedb.dev')).toBe(URL_);
    expect(descriptorUrl('https://nichedb.dev/')).toBe(URL_);
    expect(descriptorUrl('https://cdn.nichedb.dev/x/opensaas.json')).toBe(
      'https://cdn.nichedb.dev/x/opensaas.json',
    );
    expect(descriptorUrl('not a url')).toBeNull();
  });

  test('believed from the origin it names, a subdomain either way, and nowhere else', async () => {
    const doc = await json('opensaas-descriptor.json');
    expect(servedByService(URL_, doc)).toBe(true);
    expect(servedByService('https://www.nichedb.dev/opensaas.json', doc)).toBe(true);
    expect(servedByService('https://mirror.example/nichedb/opensaas.json', doc)).toBe(false);
    expect(parseDescriptor(doc, 'https://mirror.example/x.json').rejected).toBe('origin');
    const noWeb = { service: { name: 'X' }, actions: { cancel: { page: 'https://x.example/c' } } };
    expect(servedByService('https://x.example/.well-known/opensaas.json', noWeb)).toBe(true);
    expect(servedByService('https://x.example/opensaas.json', noWeb)).toBe(false);
  });

  test('a name and one action are the only required keys', () => {
    expect(parseDescriptor({ service: {} }, URL_).rejected).toBe('service');
    expect(
      parseDescriptor({ service: { name: 'X', web: 'https://nichedb.dev' } }, URL_).rejected,
    ).toBe('actions');
    const least = parseDescriptor(
      {
        service: { name: 'X', web: 'https://nichedb.dev' },
        actions: { cancel: { page: 'https://nichedb.dev/c' } },
      },
      URL_,
    );
    expect(least.rejected).toBeNull();
    expect(least.items).toHaveLength(1);
    expect(least.items[0].kind).toBe('service');
    expect(least.items[0].externalId).toBe('opensaas:service:nichedb.dev');
  });
});

describe('OpenSaaS descriptors: what a plan row carries', () => {
  test('one item per plan, priced in the service words, the way out beside the way in', async () => {
    const doc = await json('opensaas-descriptor.json');
    const { items, rejected } = parseDescriptor(doc, URL_);
    expect(rejected).toBeNull();
    expect(items.map((i) => i.externalId)).toEqual([
      'opensaas:nichedb.dev:premium',
      'opensaas:nichedb.dev:pro',
    ]);
    const pro = items[1];
    expect(pro.kind).toBe('plan');
    expect(pro.title).toBe('NicheDB Pro');
    expect(pro.summary).toBe('30 USD per month. everything in Premium, add sources, API key');
    expect(pro.url).toBe('https://nichedb.dev/pro');
    expect(pro.data.exit).toEqual({
      subscribeSteps: 2,
      subscribeApi: true,
      cancelStated: true,
      cancelSteps: 1,
      cancelConfirm: 'click',
      cancelFlagged: false,
      cancelApi: true,
      cancelPage: true,
      cancelEffective: 'period-end',
      refund: 'none',
      exportApi: true,
      deleteApi: true,
    });
    expect(pro.tags).toContain('cancel:stated');
    expect(pro.tags).toContain('cancel:agent');
    expect(pro.tags).toContain('renews');
    expect(normaliseItem(pro)).not.toBeNull();
  });

  test('absent is unstated: no cancel is no cancel, no renews is not auto-renew, a call is flagged', () => {
    const doc = {
      service: { name: 'Gym', web: 'https://gym.example', currency: 'USD' },
      plans: [{ id: 'basic', name: 'Basic', price: 0 }],
      actions: { subscribe: { page: 'https://gym.example/join', steps: 1 } },
    };
    const url = 'https://gym.example/.well-known/opensaas.json';
    const { items } = parseDescriptor(doc, url);
    expect(items[0].data.exit.cancelStated).toBe(false);
    expect(items[0].data.exit.cancelSteps).toBeNull();
    expect(items[0].tags).toContain('cancel:unstated');
    expect(items[0].tags).toContain('free');
    expect(items[0].tags).not.toContain('renews');
    expect(items[0].tags).not.toContain('prepaid');
    const flagged = exitOf(
      actionsOf({
        actions: { cancel: { page: 'https://gym.example/x', confirm: 'call', steps: 4 } },
      }),
    );
    expect(flagged.cancelFlagged).toBe(true);
    expect(flagged.cancelConfirm).toBe('call');
    // An action with neither a page nor an api is nothing to act on.
    expect(actionsOf({ actions: { pause: { steps: 1 } } })).toEqual({});
  });

  test('a plan without an id is keyed by its name; one with neither is dropped', () => {
    const doc = {
      service: { name: 'X', web: 'https://nichedb.dev' },
      actions: { cancel: { page: 'https://nichedb.dev/c' } },
    };
    expect(planItem(doc, { name: 'Team' }, URL_, true).externalId).toBe(
      'opensaas:nichedb.dev:Team',
    );
    expect(planItem(doc, { price: 3 }, URL_, true)).toBeNull();
  });
});

describe('OpenSaaS: the adapter and its source', () => {
  test('registered on saas, daily, seeded with nichedb.dev, and its kinds are plan and service', () => {
    expect(adapterByName('opensaas')).toBe(opensaas);
    expect(opensaas.collection).toBe('saas');
    expect(COLLECTIONS.some((c) => c.slug === 'saas')).toBe(true);
    expect(opensaas.cadenceMinutes).toBe(1440);
    expect(opensaas.kinds).toEqual(['plan', 'service']);
    expect(opensaas.defaultSources[0].config.urls).toEqual(['https://nichedb.dev']);
  });

  test('a pull reads the configured descriptors, probes the rest, and remembers a miss for a week', async () => {
    const doc = await json('opensaas-descriptor.json');
    const calls = [];
    const http = {
      async json(url) {
        calls.push(url);
        if (url === URL_) return doc;
        throw new Error('404');
      },
    };
    const notes = [];
    const result = await opensaas.pull({
      config: { urls: ['nichedb.dev'], probe: ['https://miss.example', 'https://nichedb.dev'] },
      cursor: {
        misses: { 'https://old.example/.well-known/opensaas.json': Date.now() - 8 * 86_400_000 },
      },
      http,
      log: (m) => notes.push(m),
      deadline: Date.now() + 10_000,
    });
    expect(result.items).toHaveLength(2);
    expect(calls).toEqual([URL_, 'https://miss.example/.well-known/opensaas.json']);
    expect(Object.keys(result.cursor.misses)).toEqual([
      'https://miss.example/.well-known/opensaas.json',
    ]);
    expect(result.note).toBe('1 services, 2 rows');
    // A remembered miss is not probed again.
    const again = await opensaas.pull({
      config: { urls: [], probe: ['https://miss.example'] },
      cursor: result.cursor,
      http,
      log: () => {},
      deadline: Date.now() + 10_000,
    });
    expect(again.items).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
