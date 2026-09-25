import { describe, expect, test } from 'bun:test';
import { ADAPTERS, adapterByName } from '../packages/adapters/src/index.js';
import {
  accountsOf,
  batchTag,
  fromEvidence,
  hasMcp,
  mcpItem,
  openMcpRecord,
  profileItems,
  recordId,
  reverseDomain,
  rpcResult,
  schemaOrgOf,
} from '../packages/adapters/src/installmap.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { keysOf } from '../packages/core/src/profiles.js';

const row = (over = {}) => ({
  domain: 'example.com',
  name: 'Example',
  batch: 'Summer 2015',
  year: '2015',
  batch_group: '2012-17',
  llms_txt: '1',
  llms_generator: '',
  llms_hand_written: '1',
  mcp_registry: '0',
  in_sample: '1',
  public_api: '0',
  mcp_server: '1',
  mcp_platform_only: '0',
  api_evidence: '',
  mcp_evidence: '',
  ...over,
});

const company = (over = {}) => ({
  row: row(),
  domain: 'example.com',
  name: 'Example',
  ev: { endpoints: [], docs: null, registryNames: [] },
  home: { status: 200, description: 'Example does things.', logo: null },
  registry: [],
  descriptor: null,
  source: null,
  endpoint: 'https://mcp.example.com/mcp',
  probe: { online: false, server: null, tools: [], error: 'initialize: 401' },
  wd: null,
  accounts: { x: 'https://x.com/example' },
  founders: [],
  ...over,
});

describe('which rows, and where their servers are', () => {
  test('only a server or a registry listing is this collection', () => {
    expect(hasMcp(row())).toBe(true);
    expect(hasMcp(row({ mcp_server: '', mcp_registry: '1' }))).toBe(true);
    expect(hasMcp(row({ mcp_server: '0' }))).toBe(false);
    expect(hasMcp(row({ mcp_server: '' }))).toBe(false);
  });

  test('the evidence names endpoints, a docs page and registry names, and keeps them apart', () => {
    const ev = fromEvidence(
      row({
        mcp_evidence:
          'home link text "MCP Server" | home link lattice.com/platform/mcp | mcp subdomain 401 | /mcp endpoint 401 | registry com.example/thing',
      }),
    );
    expect(ev.endpoints).toEqual([
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/',
      'https://example.com/mcp',
    ]);
    // A page about the server is where a person goes, not what a client calls.
    expect(ev.docs).toBe('https://lattice.com/platform/mcp');
    expect(ev.registryNames).toEqual(['com.example/thing']);
    expect(fromEvidence(row({ mcp_evidence: 'home text "MCP Server"' })).endpoints).toEqual([]);
  });

  test('the record id drops the endpoint name, as the spec derives it', () => {
    expect(recordId('https://mcp.anakin.io/mcp', 'anakin.io')).toBe('mcp.anakin.io');
    expect(recordId('https://agenticjobs.work/api/mcp', 'x')).toBe('agenticjobs.work');
    expect(recordId('https://a.example/v1/mcp', 'x')).toBe('a.example');
    expect(recordId('https://a.example/tenant/mcp', 'x')).toBe('a.example/tenant');
    expect(recordId(null, 'Example.com')).toBe('example.com');
    expect(reverseDomain('anakin.io')).toBe('io.anakin');
  });

  test('an MCP answer is read as JSON or as a server-sent event', () => {
    expect(rpcResult('{"jsonrpc":"2.0","id":1,"result":{"a":1}}')?.result).toEqual({ a: 1 });
    expect(
      rpcResult('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"b":2}}\n\n')?.result,
    ).toEqual({ b: 2 });
    expect(rpcResult('<!doctype html><html>')).toBeNull();
  });
});

describe('what the homepage says about the company', () => {
  const html = `
    <a href="https://twitter.com/intent/tweet?text=hi">share</a>
    <a href="https://x.com/somecustomer">quote</a>
    <a href="https://x.com/ExampleHQ">us</a>
    <a href="https://www.linkedin.com/company/example-inc/">li</a>
    <a href="https://www.linkedin.com/in/some-person">person</a>
    <a href="https://github.com/features/actions">features</a>
    <a href="https://discord.gg/abc123">chat</a>`;

  test("a customer's account on the homepage is not the company's", () => {
    const a = accountsOf(html, { name: 'Example', domain: 'example.com' });
    expect(a.x).toBe('https://x.com/ExampleHQ');
    expect(a.linkedin).toBe('https://www.linkedin.com/company/example-inc');
    expect(a.github).toBeUndefined();
    expect(a.discord).toBe('https://discord.gg/abc123');
  });

  test('two accounts and neither is the company: say nothing rather than guess', () => {
    const a = accountsOf('<a href="https://x.com/alice"></a><a href="https://x.com/bob"></a>', {
      name: 'Example',
      domain: 'example.com',
    });
    expect(a.x).toBeUndefined();
  });

  test('a declared sameAs wins over whatever the page links', () => {
    const a = accountsOf(html, {
      name: 'Example',
      domain: 'example.com',
      sameAs: ['https://twitter.com/declared'],
    });
    expect(a.x).toBe('https://x.com/declared');
  });

  test('founders come from the markup, never keyed on the company site', () => {
    const org = schemaOrgOf(
      [
        { '@type': 'WebSite', founder: { name: 'Not An Org' } },
        {
          '@type': ['Organization'],
          sameAs: ['https://x.com/example', 'nonsense'],
          logo: { url: 'https://example.com/logo.png' },
          founder: [
            {
              '@type': 'Person',
              name: 'Ada  Lovelace',
              jobTitle: 'CEO',
              url: 'https://www.linkedin.com/in/ada',
            },
            { '@type': 'Person', name: 'Bob', url: 'https://www.example.com/team/bob' },
            'Carol',
            { name: 'Example Team' },
          ],
        },
      ],
      'example.com',
    );
    expect(org.sameAs).toEqual(['https://x.com/example']);
    expect(org.logo).toBe('https://example.com/logo.png');
    expect(org.founders.map((f) => f.name)).toEqual(['Ada Lovelace', 'Bob', 'Carol']);
    expect(org.founders[0]).toMatchObject({
      title: 'CEO',
      accounts: ['https://www.linkedin.com/in/ada'],
    });
    // Bob's page is on the company's site; as a key it would fuse him with it.
    expect(org.founders[1].accounts).toEqual([]);
  });
});

describe('the OpenMCP record and the row', () => {
  test('compiled, unverified, offline with the reason, auth unstated', () => {
    const r = openMcpRecord(company(), '2026-09-25T00:00:00.000Z');
    expect(r.id).toBe('mcp.example.com');
    expect(r.descriptor.openmcp).toBe('0.1');
    expect(r.descriptor.mcp).toBe('https://mcp.example.com/mcp');
    expect(r.descriptor.auth).toBeUndefined();
    expect(r).toMatchObject({
      compiled: true,
      verified: false,
      online: false,
      failures: 1,
      lastError: 'initialize: 401',
    });
  });

  test("a relay's own descriptor is kept as served and makes the record verified", () => {
    const descriptor = {
      openmcp: '0.1',
      mcp: 'https://example.com/api/mcp',
      auth: { kind: 'bearer' },
    };
    const r = openMcpRecord(
      company({
        descriptor,
        source: 'https://example.com/.well-known/openmcp.json',
        endpoint: 'https://example.com/api/mcp',
        probe: {
          online: true,
          server: { name: 'ex', version: '1', protocolVersion: '2025-06-18' },
          tools: [{ name: 'search', description: null }],
          error: null,
        },
      }),
      '2026-09-25T00:00:00.000Z',
    );
    expect(r.descriptor).toBe(descriptor);
    expect(r).toMatchObject({
      id: 'example.com',
      verified: true,
      online: true,
      compiled: false,
      failures: 0,
      source: 'https://example.com/.well-known/openmcp.json',
    });
  });

  test('keyed on the endpoint, tagged by batch and flags, attributed', () => {
    const item = mcpItem(company(), '2026-09-25T00:00:00.000Z', '2026-09-23T00:00:00Z');
    expect(item.externalId).toBe('installmap-yc:example.com');
    expect(item.kind).toBe('mcp-server');
    expect(item.url).toBe('https://mcp.example.com/mcp');
    expect(item.tags).toEqual(
      expect.arrayContaining(['yc', 'yc-s15', 'offline', 'remote', 'no-public-api', 'llms-txt']),
    );
    expect(item.data.attribution).toContain('CC BY 4.0');
    expect(item.data.company.accounts.x).toBe('https://x.com/example');
    expect(normaliseItem(item)).not.toBeNull();
  });

  test('with no endpoint found the company is the key, never a docs page', () => {
    const bare = mcpItem(company({ endpoint: null }), 'now', null);
    expect(bare.url).toBe('https://example.com');
    expect(bare.tags).not.toContain('remote');
    expect(batchTag('Winter 2014')).toBe('yc-w14');
    expect(batchTag('Spring 2026')).toBe('yc-spring26');
    expect(batchTag('')).toBeNull();
  });
});

describe('people', () => {
  test('the company and each founder become OpenProfiles that cannot fuse', () => {
    const c = company({
      accounts: {
        x: 'https://x.com/example',
        linkedin: 'https://www.linkedin.com/company/example',
      },
      founders: [
        { name: 'Ada Lovelace', title: 'CEO', accounts: ['https://www.linkedin.com/in/ada'] },
        { name: 'Bob', title: null, accounts: [] },
      ],
    });
    const items = profileItems(c, '2026-09-25T00:00:00.000Z');
    expect(items.map((i) => i.kind)).toEqual(['openprofile', 'openprofile', 'openprofile']);
    const [org, ada, bob] = items;
    expect(org.data.doc).toContain('- **Kind**: organization');
    expect(org.data.doc).toContain('- https://x.com/example');
    expect(org.data.doc).toContain("and the company's homepage.");
    expect(ada.data.doc).toContain('- **Kind**: person');
    expect(ada.data.doc).toContain('CEO of Example');
    // Distinct, stable sources, so a rerun updates the same person.
    expect(new Set(items.map((i) => i.data.source_url)).size).toBe(3);
    // No founder shares an identity key with the company.
    const orgKeys = new Set(keysOf(org.data.doc));
    for (const f of [ada, bob]) {
      for (const k of keysOf(f.data.doc)) expect(orgKeys.has(k)).toBe(false);
    }
    expect(keysOf(ada.data.doc).some((k) => k.includes('linkedin.com/in/ada'))).toBe(true);
    for (const i of items) expect(i.data.doc).not.toMatch(/[—–]/);
  });
});

describe('registration', () => {
  test('servers in mcp after the registry, people in profiles', () => {
    expect(adapterByName('installmap-yc-mcp')?.collection).toBe('mcp');
    expect(adapterByName('installmap-yc-people')?.collection).toBe('profiles');
    expect(adapterByName('installmap-yc-people')?.kinds).toEqual(['openprofile']);
    const order = ADAPTERS.map((a) => a.name);
    expect(order.indexOf('mcp-registry')).toBeLessThan(order.indexOf('installmap-yc-mcp'));
  });
});
