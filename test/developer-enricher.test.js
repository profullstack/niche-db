import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { EnrichmentBlocks } from '../apps/web/src/views/enrichment.jsx';
import { providerItem } from '../packages/adapters/src/openserver.js';
import {
  brewMatches,
  conventionalLinks,
  developer,
  homeOf,
  npmMatches,
  registrableDomain,
  seedBlock,
  terraformMatches,
} from '../packages/enrichers/src/developer.js';
import { DEVELOPER_SEED, SEED_DOMAINS } from '../packages/enrichers/src/developer-seed.js';
import { defaultEnrichers } from '../packages/enrichers/src/index.js';

const verified = JSON.parse(
  await readFile(
    new URL('../packages/enrichers/test/fixtures/developer-seed-verified.json', import.meta.url),
    'utf8',
  ),
);

describe('the developer seed', () => {
  test('is keyed by registrable domain, every CLI names a guide, and every command was read off that guide', () => {
    for (const [domain, row] of DEVELOPER_SEED) {
      expect(domain).toBe(registrableDomain(domain));
      expect(row.domain).toBe(domain);
      if (!row.cli) {
        expect(row.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        continue;
      }
      expect(row.cli.name).toMatch(/^[a-z0-9@./-]+$/);
      expect(row.cli.docs).toMatch(/^https:\/\//);
      const rec = verified[domain];
      expect(
        rec,
        `${domain} has no verification record; run scripts/verify-developer-seed.js`,
      ).toBeTruthy();
      expect(rec.url).toBe(row.cli.docs);
      for (const cmd of Object.values(row.cli.install)) {
        for (const part of cmd.split(' && ')) {
          expect(rec.verified, `${domain}: "${part}" is not on ${row.cli.docs} any more`).toContain(
            part,
          );
        }
      }
      expect(rec.missing).toEqual([]);
    }
  });

  test('aliases resolve to the same row and the block carries the guide as its source', () => {
    expect(SEED_DOMAINS.get('hetzner.cloud')).toBe(SEED_DOMAINS.get('hetzner.com'));
    const b = seedBlock('ovh.com');
    expect(b.cli.name).toBe('ovhcloud');
    expect(b.cli.verified).toBe('guide');
    expect(b.cli.install.brew).toBe('brew install --cask ovh/tap/ovhcloud-cli');
    expect(b.terraform).toEqual({
      source: 'ovh/ovh',
      docs: 'https://registry.terraform.io/providers/ovh/ovh/latest/docs',
    });
    expect(b.github).toBe('https://github.com/ovh');
    expect(b.source_notes[0]).toContain('read off https://github.com/ovh/ovhcloud-cli');
  });

  test('a host we looked at and found no CLI for is recorded as such, with the date', () => {
    const b = seedBlock('kinsta.com');
    expect(b.cli).toBeNull();
    expect(b.api_docs).toBe('https://kinsta.com/docs/kinsta-api-intro/');
    expect(b.source_notes[0]).toMatch(/none found on 2026-09-13/);
    expect(seedBlock('nobody.example')).toBeNull();
  });
});

describe('matching a registry by domain, never by name', () => {
  test('a Homebrew formula must live on the provider’s domain and read as a CLI', () => {
    const formulae = [
      {
        name: 'digital-realty-tool',
        desc: 'CLI for something',
        homepage: 'https://digitalrealty.com',
      },
      {
        name: 'doctl',
        desc: 'Command-line tool for DigitalOcean',
        homepage: 'https://docs.digitalocean.com/reference/doctl/',
      },
      { name: 'do-sdk', desc: 'A library', homepage: 'https://digitalocean.com/sdk' },
    ];
    expect(brewMatches(formulae, 'digitalocean.com').map((f) => f.name)).toEqual(['doctl']);
    expect(brewMatches(formulae, 'digital.com')).toEqual([]);
  });

  test('an npm package must point its homepage at the provider’s domain', () => {
    const objects = [
      {
        package: {
          name: 'railway',
          description: 'unofficial railway cli',
          links: { homepage: 'https://github.com/someone/railway' },
        },
      },
      {
        package: {
          name: '@railway/cli',
          description: 'Railway CLI',
          links: {
            homepage: 'https://docs.railway.com/cli',
            repository: 'git+https://github.com/railwayapp/cli.git',
          },
        },
      },
    ];
    expect(npmMatches(objects, 'railway.com').map((p) => p.name)).toEqual(['@railway/cli']);
    expect(npmMatches(objects, 'railway.app')).toEqual([]);
  });

  test('a Terraform provider must carry the vendor’s own namespace, or hashicorp’s, under the slug', () => {
    const data = [
      { attributes: { namespace: 'randomdev', name: 'vultr', tier: 'community' } },
      { attributes: { namespace: 'vultr', name: 'vultr', tier: 'partner' } },
      { attributes: { namespace: 'vultr', name: 'vultr-extras', tier: 'partner' } },
    ];
    expect(terraformMatches(data, 'vultr').map((a) => `${a.namespace}/${a.name}`)).toEqual([
      'vultr/vultr',
    ]);
    expect(
      terraformMatches([{ attributes: { namespace: 'hashicorp', name: 'aws' } }], 'aws'),
    ).toHaveLength(1);
  });

  test('the provider’s home comes from its own data, the FindHost corpus, or its URL, never from findhost.app', () => {
    expect(homeOf({ data: { web: 'https://example.host/about' } })).toBe('https://example.host');
    expect(homeOf({ data: { findhostId: 'zerops' } }, { zerops: 'https://zerops.io' })).toBe(
      'https://zerops.io',
    );
    expect(homeOf({ url: 'https://www.findhost.app/zerops/', data: {} }, {})).toBeNull();
    expect(registrableDomain('my.host.co.uk')).toBe('host.co.uk');
    expect(registrableDomain('client.capconnect.com')).toBe('capconnect.com');
  });
});

describe('a provider that serves its own OpenServer 0.2 descriptor', () => {
  const descriptor = {
    provider: {
      name: 'Northwind Hosting',
      web: 'https://northwind.example',
      developer: {
        cli: {
          name: 'nwctl',
          install: { brew: 'brew install northwind/tap/nwctl' },
          docs: 'https://northwind.example/docs/cli',
          repo: 'https://github.com/northwind/nwctl',
        },
        api_docs: 'https://northwind.example/docs/api',
      },
    },
    offers: [{ name: 'ARM 4' }],
  };

  test('the adapter keeps the developer block as written and tags the row has-cli', () => {
    const row = providerItem(descriptor, 'https://northwind.example/.well-known/openserver.json');
    expect(row.data.developer).toEqual(descriptor.provider.developer);
    expect(row.tags).toContain('has-cli');
    const none = providerItem(
      { provider: { name: 'Plain', web: 'https://plain.example' }, offers: [] },
      'https://plain.example/.well-known/openserver.json',
    );
    expect(none.data.developer).toBeNull();
    expect(none.tags).not.toContain('has-cli');
  });

  test('the enricher believes the descriptor over the seed and never searches a registry for it', async () => {
    let calls = 0;
    const http = {
      async json() {
        calls++;
        throw new Error('no network in this test');
      },
      async request() {
        calls++;
        return { status: 404, ok: false };
      },
    };
    const out = await developer.enrich(
      {
        kind: 'provider',
        title: 'Hetzner',
        url: 'https://www.hetzner.com/',
        data: {
          provider: 'hetzner',
          web: 'https://www.hetzner.com/',
          developer: descriptor.provider.developer,
        },
      },
      { http, env: {}, log: () => {} },
    );
    expect(out.cli.name).toBe('nwctl');
    expect(out.cli.verified).toBe('descriptor');
    expect(out.cli.install.brew).toBe('brew install northwind/tap/nwctl');
    expect(out.api_docs).toBe('https://northwind.example/docs/api');
    expect(out.source_notes[0]).toMatch(/own OpenServer descriptor/);
    expect(out.tags).toContain('has-cli');
  });

  test('a descriptor that states "cli": null is believed too, and nothing is searched', async () => {
    const seen = [];
    const http = {
      async json(url) {
        seen.push(url);
        throw new Error('no network in this test');
      },
      async request(url) {
        seen.push(url);
        return { status: 404, ok: false };
      },
    };
    const out = await developer.enrich(
      {
        kind: 'provider',
        title: 'Plain',
        url: 'https://plain.example/',
        data: { provider: 'plain', web: 'https://plain.example/', developer: { cli: null } },
      },
      { http, env: {}, log: () => {} },
    );
    expect(out.cli).toBeNull();
    expect(out.source_notes).toContain('cli: the provider states it has none');
    expect(seen.some((u) => /formulae\.brew\.sh|registry\.npmjs/.test(u))).toBe(false);
  });
});

describe('the enricher end to end, with no network', () => {
  const fakeHttp = (routes) => ({
    async json(url) {
      for (const [re, body] of routes) if (re.test(url)) return body;
      throw new Error(`404 from ${url}`);
    },
    async request(url) {
      for (const [re, body] of routes)
        if (re.test(url)) return { status: 200, url, ok: true, json: async () => body };
      return { status: 404, url, ok: false };
    },
  });

  test('a seeded host answers from the guide and still probes the conventional pages', async () => {
    const http = fakeHttp([
      [/status\.hetzner\.com\/api\/v2\/status\.json/, { status: { indicator: 'none' } }],
    ]);
    const out = await developer.enrich(
      {
        kind: 'provider',
        title: 'Hetzner',
        url: 'https://www.findhost.app/hetzner/',
        data: { provider: 'hetzner', findhostId: 'hetzner', web: 'https://www.hetzner.com/' },
      },
      { http, env: {}, log: () => {} },
    );
    expect(out.cli.name).toBe('hcloud');
    expect(out.cli.verified).toBe('guide');
    expect(out.terraform.source).toBe('hetznercloud/hcloud');
    expect(out.status).toBe('https://status.hetzner.com/');
    expect(out.tags).toEqual(['has-cli', 'has-terraform', 'has-status-page']);
    expect(out.domain).toBe('hetzner.com');
  });

  test('an unseeded host is matched in the registries by domain and gets the install line the registry implies', async () => {
    const http = fakeHttp([
      [
        /formulae\.brew\.sh/,
        [{ name: 'zeropsctl', desc: 'Zerops CLI', homepage: 'https://zerops.io/cli' }],
      ],
      [
        /registry\.terraform\.io/,
        { data: [{ attributes: { namespace: 'zeropsio', name: 'zerops', tier: 'community' } }] },
      ],
      [/developers\.zerops\.io/, {}],
    ]);
    const out = await developer.enrich(
      {
        kind: 'provider',
        title: 'Zerops',
        url: 'https://www.findhost.app/zerops/',
        data: { provider: 'zerops', findhostId: 'zerops', web: 'https://zerops.io' },
      },
      { http, env: {}, log: () => {} },
    );
    expect(out.cli).toEqual({
      name: 'zeropsctl',
      repo: null,
      docs: 'https://zerops.io/cli',
      install: { brew: 'brew install zeropsctl' },
      verified: 'registry',
    });
    expect(out.terraform).toBeNull();
    expect(out.api_docs).toBe('https://developers.zerops.io/');
    expect(out.source_notes).toContain('cli: Homebrew formula zeropsctl, homepage on zerops.io');
  });

  test('a host with nothing anywhere is stamped "none found" rather than guessed', async () => {
    const http = fakeHttp([
      [/formulae\.brew\.sh/, []],
      [/registry\.npmjs\.org/, { objects: [] }],
      [/registry\.terraform\.io/, { data: [] }],
    ]);
    const out = await developer.enrich(
      {
        kind: 'provider',
        title: 'Nobody',
        url: 'https://www.findhost.app/nobody/',
        data: { provider: 'nobody', web: 'https://nobody.example' },
      },
      { http, env: {}, log: () => {} },
    );
    expect(out.cli).toBeNull();
    expect(out.tags).toEqual([]);
    expect(out.source_notes.some((n) => /cli: none found on \d{4}-\d{2}-\d{2}/.test(n))).toBe(true);
    const c = await conventionalLinks(http, 'https://nobody.example');
    expect(c).toEqual({ status: null, api_docs: null });
  });

  test('plan rows are not enriched, and hosting turns the enricher on by default', async () => {
    expect(developer.appliesTo({ kind: 'plan' })).toBe(false);
    expect(defaultEnrichers('hosting')).toContain('developer');
    expect(
      await developer.enrich(
        { kind: 'provider', url: 'https://www.findhost.app/x/', data: {} },
        { http: fakeHttp([]), env: {}, log: () => {} },
      ),
    ).toBeNull();
  });
});

describe('the item page', () => {
  test('renders the install commands as code with the guide, Terraform and status links', () => {
    const html = EnrichmentBlocks({
      enrichment: { developer: seedBlock('scaleway.com') },
    }).toString();
    expect(html).toContain('Install the CLI: scw');
    expect(html).toContain('<code>brew install scw</code>');
    expect(html).toContain('href="https://github.com/scaleway/scaleway-cli"');
    expect(html).toContain('Terraform scaleway/scaleway');
    expect(html).toContain('as printed on the vendor');
    expect(html).toContain('href="https://github.com/scaleway"');
    const none = EnrichmentBlocks({
      enrichment: { developer: { ...seedBlock('kinsta.com'), status: null } },
    }).toString();
    expect(none).toContain('No official CLI found');
    expect(none).toContain('API docs');
  });
});
