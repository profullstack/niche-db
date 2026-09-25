import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { parseHead } from '@nichedb/core/opensite';
import { parseTable } from './awesomeclaudecode.js';

/**
 * Y Combinator companies that run an MCP server, from Installmap.
 *
 * Installmap crawled every reachable YC domain on 2026-09-23 and published
 * one row per domain with three flags and the evidence behind each positive
 * (installmap.com/research/yc-startups-llms-txt-api-mcp-by-batch, CC BY 4.0).
 * Of 5,630 rows, 182 are this collection's business: 119 of the 900 sampled
 * companies have an MCP server by Installmap's checks, and 81 of the whole list
 * are in the official registry, 18 of them both.
 *
 * The CSV knows that a company has a server. It mostly does not know WHERE:
 * the evidence is "home text 'MCP Server'" as often as "mcp subdomain 200".
 * So each row is turned into an OpenMCP record (logicsrc.com/openmcp) the way
 * the spec says a catalog builds one, and the record says honestly how much of
 * that worked:
 *
 *   * The endpoint comes from the evidence (an `mcp.` subdomain that answered,
 *     a `/mcp` path, a homepage link to an MCP page is only a page), then from
 *     the official registry's remotes for the company's reverse-domain
 *     namespace, then from the company's own `/.well-known/openmcp.json`.
 *   * `verified` is the descriptor: true only when the origin served one.
 *   * `online` is the handshake: `initialize` then `tools/list`, with no
 *     credential, because a catalog holds none. Most of these endpoints answer
 *     401, which is a real server that wants a key, so the record is offline
 *     with the status as `lastError` rather than left out.
 *
 * That last point is where this reads the spec loosely on purpose. An OpenMCP
 * catalog lists only a relay it could verify or reach, which on 2026-09-25
 * would have been four of 182. This is a directory of companies whose server
 * someone checked for, so every row is kept and the two flags carry the truth.
 *
 * The same pass reads each company's homepage for what it says about itself:
 * the description, the accounts it links (X, LinkedIn, GitHub, YouTube,
 * Discord and the rest), and the founders its schema.org markup names. One
 * Wikidata query adds what Wikidata knows (CC0). ycombinator.com is NOT read:
 * its terms forbid scraping, and yc-oss is a scrape of it. The company and its
 * founders become OpenProfile documents in `profiles` through the second
 * adapter below, so a founder is a person you can follow, not a string in a
 * JSON blob.
 */

export const CSV =
  'https://installmap.com/static/data/yc-startups-llms-txt-api-mcp-by-batch/data.csv';
export const RESEARCH = 'https://installmap.com/research/yc-startups-llms-txt-api-mcp-by-batch';
export const ATTRIBUTION = 'Installmap, September 2026 (CC BY 4.0)';
/** The day Installmap fetched the subdomains and paths, per the research page. */
const CRAWLED = '2026-09-23T00:00:00Z';
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const WDQS = 'https://query.wikidata.org/sparql';
const PROTOCOL = '2025-06-18';

/** Only the rows with a server, or a registry listing, belong here. */
export const hasMcp = (r) => r.mcp_server === '1' || r.mcp_registry === '1';

/** `anakin.io` -> `io.anakin`, the namespace registry names are published under. */
export const reverseDomain = (domain) =>
  String(domain).toLowerCase().split('.').reverse().join('.');

/**
 * Every endpoint the evidence points at, most specific first.
 *
 * `mcp subdomain 200` and `/mcp endpoint 401` are the relay itself. A homepage
 * link whose path says mcp is usually a docs page about it, which is where a
 * person goes to connect but not what an MCP client calls, so it is kept as
 * `docs`, never as an endpoint.
 *
 * @param {{ domain: string, mcp_evidence?: string }} row
 * @returns {{ endpoints: string[], docs: string|null, registryNames: string[] }}
 */
export function fromEvidence(row) {
  const d = String(row.domain).toLowerCase();
  const parts = String(row.mcp_evidence ?? '')
    .split(' | ')
    .map((p) => p.trim())
    .filter(Boolean);
  const endpoints = [];
  let docs = null;
  const registryNames = [];
  for (const p of parts) {
    if (/^mcp subdomain \d+/.test(p)) endpoints.push(`https://mcp.${d}/mcp`, `https://mcp.${d}/`);
    else if (/^\/mcp (endpoint|page)/.test(p)) endpoints.push(`https://${d}/mcp`);
    else if (p.startsWith('registry ')) registryNames.push(p.slice('registry '.length).trim());
    else if (!docs) {
      const link = /^home link ((?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*mcp\S*)$/i.exec(p);
      if (link) docs = `https://${link[1].replace(/\/+$/, '')}`;
    }
  }
  return { endpoints: [...new Set(endpoints)], docs, registryNames };
}

/**
 * The OpenMCP record id: host and path of the endpoint, with the endpoint's
 * own name (`/mcp`, `/api/mcp`, `/v1/mcp`) dropped, as the spec derives it. A
 * company whose endpoint nobody found is keyed on its domain.
 */
export function recordId(endpoint, domain) {
  if (!endpoint) return String(domain).toLowerCase();
  try {
    const u = new URL(endpoint);
    const path = u.pathname.replace(/\/+$/, '').replace(/\/(?:api\/|v\d+\/)?mcp$/, '');
    return `${u.hostname.toLowerCase()}${path}`.replace(/\/+$/, '');
  } catch {
    return String(domain).toLowerCase();
  }
}

/* ------------------------------------------------------------------ accounts */

/*
 * Each network, the pattern its profile links take, and the one URL to keep.
 * Share and intent links, a network's own marketing pages and personal
 * LinkedIn pages are not the company's account.
 */
const NETWORKS = [
  {
    key: 'x',
    rx: /https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/(?!intent\b|share\b|home\b|search\b|hashtag\b|i\/|privacy\b|tos\b)([A-Za-z0-9_]{1,15})(?=[/"'?#\s<]|$)/gi,
    url: (m) => `https://x.com/${m[1]}`,
  },
  {
    key: 'linkedin',
    rx: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase)\/([^/"'?#\s<]+)/gi,
    url: (m) => `https://www.linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`,
  },
  {
    key: 'github',
    rx: /https?:\/\/(?:www\.)?github\.com\/(?!features\b|about\b|pricing\b|sponsors\b|login\b|marketplace\b|orgs\b|topics\b|site\b)([A-Za-z0-9-]{1,39})(?=[/"'?#\s<]|$)/gi,
    url: (m) => `https://github.com/${m[1]}`,
  },
  {
    key: 'youtube',
    rx: /https?:\/\/(?:www\.)?youtube\.com\/(@[A-Za-z0-9_.-]+|c\/[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+|user\/[A-Za-z0-9_.-]+)/gi,
    url: (m) => `https://www.youtube.com/${m[1]}`,
  },
  {
    key: 'discord',
    rx: /https?:\/\/(?:www\.)?discord(?:\.gg|(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/gi,
    url: (m) => `https://discord.gg/${m[1]}`,
  },
  {
    key: 'facebook',
    rx: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer\b|share\b|dialog\b|tr\b|plugins\b|policies\b)([A-Za-z0-9.-]{2,})(?=[/"'?#\s<]|$)/gi,
    url: (m) => `https://www.facebook.com/${m[1]}`,
  },
  {
    key: 'instagram',
    rx: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore\b)([A-Za-z0-9_.]{2,30})(?=[/"'?#\s<]|$)/gi,
    url: (m) => `https://www.instagram.com/${m[1]}`,
  },
  {
    key: 'bluesky',
    rx: /https?:\/\/bsky\.app\/profile\/([A-Za-z0-9.-]+)/gi,
    url: (m) => `https://bsky.app/profile/${m[1]}`,
  },
  {
    key: 'crunchbase',
    rx: /https?:\/\/(?:www\.)?crunchbase\.com\/organization\/([^/"'?#\s<]+)/gi,
    url: (m) => `https://www.crunchbase.com/organization/${m[1]}`,
  },
];

/** The letters of a name, for telling the company's handle from a customer's. */
const squash = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The company's own account on each network, from its homepage.
 *
 * Schema.org `sameAs` is the company saying so and wins outright. Otherwise the
 * links on the page: one distinct account is taken, several are resolved in
 * favour of the one whose handle contains the company's name or domain, and if
 * none does the network is left out. A homepage that quotes three customers'
 * tweets names four X accounts, and guessing would give the company one of
 * theirs.
 *
 * @param {string} html
 * @param {{ name: string, domain: string, sameAs?: string[] }} who
 * @returns {Record<string, string>}
 */
export function accountsOf(html, { name, domain, sameAs = [] }) {
  const out = {};
  const hints = [squash(name), squash(String(domain).split('.')[0])].filter((h) => h.length >= 3);
  const text = String(html ?? '');
  for (const net of NETWORKS) {
    const declared = sameAs.flatMap((u) => [...String(u).matchAll(net.rx)]).map((m) => net.url(m));
    if (declared.length) {
      out[net.key] = declared[0];
      continue;
    }
    const found = [...new Set([...text.matchAll(net.rx)].map((m) => net.url(m)))];
    if (found.length === 1) out[net.key] = found[0];
    else if (found.length > 1) {
      const own = found.filter((u) => {
        const handle = squash(u.split('/').pop());
        return hints.some((h) => handle.includes(h) || (handle.length >= 4 && h.includes(handle)));
      });
      if (own.length === 1) out[net.key] = own[0];
    }
  }
  return out;
}

const TYPES_ORG = /organization|corporation|company|localbusiness|softwareapplication|ngo/i;

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const typesOf = (node) => asList(node?.['@type']).map(String);
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

/**
 * What the homepage's schema.org markup says about the company: its `sameAs`
 * accounts, its logo, and the founders it names, each with whatever accounts
 * the markup gives them.
 *
 * @param {object[]} jsonld
 * @param {string} domain
 */
export function schemaOrgOf(jsonld, domain) {
  const own = (u) => {
    try {
      return new URL(u).hostname
        .toLowerCase()
        .replace(/^www\./, '')
        .endsWith(domain);
    } catch {
      return false;
    }
  };
  const sameAs = [];
  let logo = null;
  let description = null;
  const founders = new Map();
  for (const node of jsonld ?? []) {
    if (!node || typeof node !== 'object' || !typesOf(node).some((t) => TYPES_ORG.test(t)))
      continue;
    for (const u of asList(node.sameAs)) if (httpUrl(u)) sameAs.push(httpUrl(u));
    logo ??= httpUrl(typeof node.logo === 'object' ? node.logo?.url : node.logo);
    if (!description && typeof node.description === 'string') description = node.description.trim();
    for (const f of [...asList(node.founder), ...asList(node.founders)]) {
      const person = typeof f === 'string' ? { name: f } : f;
      const name = String(person?.name ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      // "Floot Team" is a byline, not a founder.
      if (!name || name.length > 80 || /[<>{}]/.test(name) || /\bteam\b/i.test(name)) continue;
      // A founder's page on the company's own site would make every founder
      // the company: identity keys are URLs, and they would all share it.
      const accounts = [person.url, ...asList(person.sameAs)]
        .map(httpUrl)
        .filter((u) => u && !own(u));
      const have = founders.get(name.toLowerCase());
      const title =
        typeof person.jobTitle === 'string' ? person.jobTitle.replace(/\s+/g, ' ').trim() : null;
      if (have) have.accounts = [...new Set([...have.accounts, ...accounts])];
      else founders.set(name.toLowerCase(), { name, title: title || null, accounts });
    }
  }
  return { sameAs, logo, description, founders: [...founders.values()] };
}

/* ---------------------------------------------------------------- the probe */

/** An MCP answer may come back as JSON or as one server-sent event. */
export function rpcResult(text) {
  const s = String(text ?? '').trim();
  const candidates = s.startsWith('{')
    ? [s]
    : s
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
  for (const c of candidates) {
    try {
      const msg = JSON.parse(c);
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return msg;
    } catch {
      // Not this line.
    }
  }
  return null;
}

async function rpc(http, url, method, params, session, id) {
  const res = await http.request(url, {
    method: 'POST',
    timeoutMs: 12_000,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
      ...(session ? { 'mcp-protocol-version': PROTOCOL } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
  });
  // A notification has no reply worth reading; free the connection.
  if (!id) {
    await res.body?.cancel().catch(() => {});
    return { res, msg: null };
  }
  return { res, msg: rpcResult(await res.text()) };
}

/**
 * The OpenMCP handshake, unauthenticated: `initialize`, then `tools/list`.
 *
 * @returns {Promise<{ online: boolean, server: object|null, tools: object[],
 *                     error: string|null }>}
 */
export async function handshake(http, endpoint) {
  try {
    const init = await rpc(
      http,
      endpoint,
      'initialize',
      {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'nichedb', version: '1' },
      },
      null,
      1,
    );
    if (!init.res.ok || !init.msg?.result) {
      // A 200 that is not JSON-RPC is a web page that happens to live at /mcp.
      const why = init.res.ok ? 'answered, but not as MCP' : String(init.res.status);
      return { online: false, server: null, tools: [], error: `initialize: ${why}` };
    }
    const session = init.res.headers.get('mcp-session-id');
    const r = init.msg.result;
    const server = {
      name: r.serverInfo?.name ?? null,
      version: r.serverInfo?.version ?? null,
      protocolVersion: r.protocolVersion ?? null,
    };
    await rpc(http, endpoint, 'notifications/initialized', {}, session, null).catch(() => {});
    const list = await rpc(http, endpoint, 'tools/list', {}, session, 2);
    const tools = Array.isArray(list.msg?.result?.tools) ? list.msg.result.tools : null;
    if (!tools) {
      return { online: false, server, tools: [], error: `tools/list: ${list.res.status}` };
    }
    return {
      online: true,
      server,
      tools: tools.slice(0, 200).map((t) => ({
        name: String(t.name ?? ''),
        description: t.description ? String(t.description).slice(0, 500) : null,
      })),
      error: null,
    };
  } catch (err) {
    return {
      online: false,
      server: null,
      tools: [],
      error: String(err?.message ?? err).slice(0, 120),
    };
  }
}

/** The origin's OpenMCP descriptor, or null. */
export async function descriptorAt(http, origin) {
  try {
    const res = await http.request(`${origin}/.well-known/openmcp.json`, { timeoutMs: 8_000 });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const doc = JSON.parse(await res.text());
    return doc && typeof doc === 'object' && typeof doc.mcp === 'string' ? doc : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- the gathering */

/** `fn` over `list`, `n` at a time, in order. */
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

/** The registry's servers under a company's namespace, newest version of each. */
export async function registryServers(http, domain) {
  const ns = reverseDomain(domain);
  try {
    const res = await http.json(`${REGISTRY}?${new URLSearchParams({ search: ns, limit: '50' })}`);
    const byName = new Map();
    for (const e of res.servers ?? []) {
      const s = e.server ?? e;
      const name = String(s.name ?? '');
      if (!name.startsWith(`${ns}/`) && !name.startsWith(`${ns}.`)) continue;
      byName.set(name, s);
    }
    return [...byName.values()].map((s) => ({
      name: s.name,
      remotes: (s.remotes ?? [])
        .filter((r) => !r.type || /streamable|http/i.test(r.type))
        .map((r) => r.url)
        .filter((u) => /^https:\/\//.test(String(u)) && !/\{/.test(String(u))),
      repository: s.repository?.url ?? null,
    }));
  } catch {
    return [];
  }
}

const WD_SITE_VARIANTS = (d) =>
  ['http', 'https'].flatMap((p) =>
    ['', 'www.'].flatMap((w) => ['', '/'].map((s) => `<${p}://${w}${d}${s}>`)),
  );

/**
 * What Wikidata knows about each company, matched on the official website
 * (P856): its accounts and its founders (P112) with theirs. One query per 60
 * domains; Wikidata matched 26 of these 182 on 2026-09-25.
 *
 * @returns {Promise<Map<string, { qid: string, accounts: Record<string,string>,
 *           founders: { name: string, qid: string, accounts: string[] }[] }>>}
 */
export async function wikidataFor(http, domains) {
  const out = new Map();
  for (let i = 0; i < domains.length; i += 60) {
    const chunk = domains.slice(i, i + 60);
    const query = `SELECT ?site ?item ?x ?li ?gh ?cb ?f ?fLabel ?fx ?fli ?fgh ?fweb WHERE {
  VALUES ?site { ${chunk.flatMap(WD_SITE_VARIANTS).join(' ')} }
  ?item wdt:P856 ?site.
  OPTIONAL { ?item wdt:P2002 ?x } OPTIONAL { ?item wdt:P4264 ?li }
  OPTIONAL { ?item wdt:P2037 ?gh } OPTIONAL { ?item wdt:P2088 ?cb }
  OPTIONAL { ?item wdt:P112 ?f . ?f wdt:P31 wd:Q5 .
    OPTIONAL { ?f wdt:P2002 ?fx } OPTIONAL { ?f wdt:P6634 ?fli }
    OPTIONAL { ?f wdt:P2037 ?fgh } OPTIONAL { ?f wdt:P856 ?fweb } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
    let rows = [];
    try {
      const res = await http.request(WDQS, {
        method: 'POST',
        timeoutMs: 60_000,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/sparql-results+json',
        },
        body: new URLSearchParams({ query }).toString(),
      });
      if (!res.ok) throw new Error(`query.wikidata.org answered ${res.status}`);
      rows = (await res.json()).results?.bindings ?? [];
    } catch {
      continue;
    }
    for (const b of rows) {
      const v = (k) => b[k]?.value ?? null;
      let domain;
      try {
        domain = new URL(v('site')).hostname.toLowerCase().replace(/^www\./, '');
      } catch {
        continue;
      }
      const qid = v('item').split('/').pop();
      // A site can be the official website of a product as well as of its
      // maker (bitmovin.com is Bitmovin and libdash). Keep the first entity
      // that has any account, else the first.
      let entry = out.get(domain);
      if (entry && entry.qid !== qid) {
        if (Object.keys(entry.accounts).length) continue;
        if (!(v('x') || v('li') || v('gh') || v('cb'))) continue;
        entry = null;
      }
      if (!entry) {
        entry = { qid, accounts: {}, founders: new Map() };
        out.set(domain, entry);
      }
      if (v('x')) entry.accounts.x ??= `https://x.com/${v('x')}`;
      if (v('li')) entry.accounts.linkedin ??= `https://www.linkedin.com/company/${v('li')}`;
      if (v('gh')) entry.accounts.github ??= `https://github.com/${v('gh')}`;
      if (v('cb'))
        entry.accounts.crunchbase ??= `https://www.crunchbase.com/organization/${v('cb')}`;
      if (v('f')) {
        const fq = v('f').split('/').pop();
        const f = entry.founders.get(fq) ?? { name: v('fLabel'), qid: fq, accounts: new Set() };
        if (v('fx')) f.accounts.add(`https://x.com/${v('fx')}`);
        if (v('fli')) f.accounts.add(`https://www.linkedin.com/in/${v('fli')}`);
        if (v('fgh')) f.accounts.add(`https://github.com/${v('fgh')}`);
        if (v('fweb')) f.accounts.add(v('fweb'));
        f.accounts.add(`https://www.wikidata.org/wiki/${fq}`);
        entry.founders.set(fq, f);
      }
    }
  }
  for (const e of out.values()) {
    e.founders = [...e.founders.values()]
      .filter((f) => f.name && !/^Q\d+$/.test(f.name))
      .map((f) => ({ ...f, accounts: [...f.accounts] }));
  }
  return out;
}

/** The homepage: what it says about the company, read once. */
async function readHomepage(http, domain, name) {
  try {
    const res = await http.request(`https://${domain}/`, {
      timeoutMs: 15_000,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/html/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, accounts: {}, founders: [], description: null, logo: null };
    }
    const html = (await res.text()).slice(0, 2 * 1024 * 1024);
    const head = parseHead(html);
    const meta = (n) => head.metas.find((m) => m.name === n)?.content || null;
    const org = schemaOrgOf(head.jsonld, domain);
    return {
      status: res.status,
      finalUrl: res.url || `https://${domain}/`,
      title: head.title || null,
      description: meta('og:description') ?? meta('description') ?? org.description,
      logo: org.logo ?? meta('og:image'),
      accounts: accountsOf(html, { name, domain, sameAs: org.sameAs }),
      founders: org.founders,
    };
  } catch (err) {
    return {
      status: null,
      error: String(err?.message ?? err).slice(0, 120),
      accounts: {},
      founders: [],
      description: null,
      logo: null,
    };
  }
}

/**
 * One company, everything this source learns about it: the CSV row, the
 * homepage, Wikidata, the registry, and the OpenMCP probe.
 */
async function gatherOne(http, row, wikidata) {
  const domain = row.domain.toLowerCase();
  const name = row.name || domain;
  const ev = fromEvidence(row);
  const [home, registry] = await Promise.all([
    readHomepage(http, domain, name),
    row.mcp_registry === '1' || ev.registryNames.length ? registryServers(http, domain) : [],
  ]);

  const candidates = [...ev.endpoints, ...registry.flatMap((s) => s.remotes)];
  const origins = [
    ...new Set([
      `https://${domain}`,
      ...candidates.map((u) => {
        try {
          return new URL(u).origin;
        } catch {
          return null;
        }
      }),
    ]),
  ].filter(Boolean);

  let descriptor = null;
  let source = null;
  for (const o of origins) {
    descriptor = await descriptorAt(http, o);
    if (descriptor) {
      source = `${o}/.well-known/openmcp.json`;
      break;
    }
  }
  if (descriptor) {
    try {
      candidates.unshift(new URL(descriptor.mcp, source).href);
    } catch {
      // A descriptor whose mcp is not a URL is not a pointer to anything.
    }
  }

  let endpoint = null;
  let probe = { online: false, server: null, tools: [], error: null };
  let lastError = null;
  for (const c of [...new Set(candidates)]) {
    const p = await handshake(http, c);
    lastError = p.error;
    if (p.online) {
      endpoint = c;
      probe = p;
      break;
    }
    // Keep the first that asked for a credential as the endpoint: a 401 or
    // 403 is a server that exists and wants a key this probe will not send.
    // A 404, a 405 to a POST, or a web page is not a relay at that address.
    if (!endpoint && /: 40[13]$/.test(p.error ?? '')) {
      endpoint = c;
      probe = p;
    }
  }
  if (!endpoint && !descriptor && candidates.length === 0) {
    probe.error = 'no endpoint published: the evidence is a mention';
  } else if (!endpoint && candidates.length) {
    probe.error = `no candidate answered as MCP (${lastError ?? 'no answer'})`;
  }

  const wd = wikidata.get(domain) ?? null;
  const accounts = { ...(wd?.accounts ?? {}), ...home.accounts };
  const founders = [...home.founders];
  for (const f of wd?.founders ?? []) {
    const same = founders.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    if (same) same.accounts = [...new Set([...same.accounts, ...f.accounts])];
    else founders.push({ name: f.name, title: null, accounts: f.accounts });
  }
  return {
    row,
    domain,
    name,
    ev,
    home,
    registry,
    descriptor,
    source,
    endpoint,
    probe,
    wd,
    accounts,
    founders,
  };
}

/*
 * Both adapters read the same companies, and a worker runs them back to back,
 * so one gathering serves both for an hour instead of probing 182 sites twice.
 */
const memo = new Map();

export async function gather({ config, http, log }) {
  const url = String(config.url || CSV);
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value;

  const res = await http.request(url, { headers: { accept: 'text/csv, text/plain, */*' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const lastModified = res.headers.get('last-modified');
  const rows = parseTable(await res.text()).filter(hasMcp);
  if (!rows.length) throw new Error('the Installmap CSV had no MCP rows');
  const limit = Number(config.limit) > 0 ? Number(config.limit) : rows.length;
  const picked = rows.slice(0, limit);

  const wikidata = await wikidataFor(
    http,
    picked.map((r) => r.domain.toLowerCase()),
  );
  const concurrency = Math.max(1, Math.min(Number(config.concurrency) || 8, 24));
  const companies = await mapLimit(picked, concurrency, (r) => gatherOne(http, r, wikidata));
  const online = companies.filter((c) => c.probe.online).length;
  log(
    `${companies.length} companies: ${online} online, ${companies.filter((c) => c.descriptor).length} verified, ${wikidata.size} on Wikidata, ${companies.reduce((n, c) => n + c.founders.length, 0)} founders`,
  );
  const value = {
    companies,
    publishedAt: CRAWLED,
    lastModified: lastModified ? new Date(lastModified).toISOString() : null,
  };
  memo.set(url, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ records */

const yes = (v) => (v === '1' ? true : v === '0' ? false : null);

/** `Summer 2015` -> `yc-s15`, `Winter 2014` -> `yc-w14`; YC's newer Spring batch is spelled out, `yc-spring26`. */
export function batchTag(batch) {
  const m = /^(Winter|Summer|Spring|Fall|Autumn)\s+(\d{4})$/i.exec(String(batch ?? '').trim());
  if (!m) return null;
  const season = { winter: 'w', summer: 's', spring: 'spring', fall: 'f', autumn: 'f' }[
    m[1].toLowerCase()
  ];
  return `yc-${season}${m[2].slice(2)}`;
}

/**
 * The OpenMCP record for one company, as a catalog would serve it.
 *
 * `descriptor` is the relay's own when it served one, otherwise one compiled
 * from what was found, and `compiled: true` says so, because a descriptor is a
 * claim and this one is ours rather than theirs. `auth` is left out unless the
 * relay stated it: absence is unstated.
 */
export function openMcpRecord(c, seenAt) {
  const tags = ['yc', batchTag(c.row.batch)].filter(Boolean);
  const descriptor = c.descriptor ?? {
    openmcp: '0.1',
    ...(c.endpoint ? { mcp: c.endpoint } : {}),
    name: c.name,
    ...(c.home.description ? { description: c.home.description.slice(0, 500) } : {}),
    url: `https://${c.domain}`,
    tags,
    ...(c.probe.tools.length ? { tools: c.probe.tools.map((t) => t.name) } : {}),
  };
  return {
    id: recordId(c.endpoint ?? (c.descriptor ? descriptor.mcp : null), c.domain),
    source: c.source ?? RESEARCH,
    descriptor,
    compiled: !c.descriptor,
    tools: c.probe.tools,
    server: c.probe.server,
    verified: Boolean(c.descriptor),
    online: c.probe.online,
    seenAt,
    firstSeenAt: null,
    failures: c.probe.online ? 0 : 1,
    lastError: c.probe.error,
    via: RESEARCH,
  };
}

/** One row in `mcp`: the record, the company, and where every fact came from. */
export function mcpItem(c, seenAt, publishedAt) {
  const record = openMcpRecord(c, seenAt);
  const r = c.row;
  const flags = {
    llmsTxt: yes(r.llms_txt),
    llmsHandWritten: yes(r.llms_hand_written),
    llmsGenerator: r.llms_generator || null,
    publicApi: yes(r.public_api),
    mcpServer: yes(r.mcp_server),
    mcpRegistry: yes(r.mcp_registry),
    mcpPlatformOnly: yes(r.mcp_platform_only),
    sampled: yes(r.in_sample),
  };
  const summary =
    c.home.description?.replace(/\s+/g, ' ').trim().slice(0, 500) ||
    `${c.name}, Y Combinator ${r.batch}, runs an MCP server.`;
  return {
    externalId: `installmap-yc:${c.domain}`,
    kind: 'mcp-server',
    title: `${c.name} (YC ${r.batch})`,
    summary,
    // The endpoint when one answered anything, else the company. Never a
    // docs page: two companies' docs can share a host (docs.readme.com).
    url: c.endpoint ?? `https://${c.domain}`,
    imageUrl: c.home.logo ?? null,
    publishedAt,
    tags: [
      'mcp',
      'yc',
      batchTag(r.batch),
      r.year ? `founded-batch-${r.year}` : null,
      record.online ? 'online' : 'offline',
      record.verified ? 'verified' : null,
      c.endpoint ? 'remote' : null,
      flags.mcpRegistry ? 'registry' : null,
      flags.publicApi === true ? 'public-api' : flags.publicApi === false ? 'no-public-api' : null,
      flags.llmsTxt ? 'llms-txt' : null,
      c.founders.length ? 'founders' : null,
    ].filter(Boolean),
    data: {
      openmcp: record,
      company: {
        name: c.name,
        domain: c.domain,
        web: `https://${c.domain}`,
        batch: r.batch || null,
        year: r.year ? Number(r.year) : null,
        batchGroup: r.batch_group || null,
        description: c.home.description ?? null,
        logo: c.home.logo ?? null,
        accounts: c.accounts,
        founders: c.founders.map((f) => ({ name: f.name, title: f.title, accounts: f.accounts })),
        wikidata: c.wd?.qid ?? null,
        homepageStatus: c.home.status ?? null,
      },
      docs: c.ev.docs,
      registry: c.registry.map((s) => ({
        name: s.name,
        remotes: s.remotes,
        repository: s.repository,
      })),
      installmap: {
        ...flags,
        apiEvidence: r.api_evidence || null,
        mcpEvidence: r.mcp_evidence || null,
        dataset: CSV,
        research: RESEARCH,
      },
      attribution: ATTRIBUTION,
    },
  };
}

/* ----------------------------------------------------------------- profiles */

const oneLine = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[—–]/g, '-')
    .trim();

const sentence = (s) => {
  const t = oneLine(s);
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The company as an OpenProfile.md: Kind organization, its site and accounts. */
export function companyDoc(c) {
  const lines = [
    `# ${oneLine(c.name)}`,
    '',
    '- **Kind**: organization',
    `- **Web**: https://${c.domain}`,
  ];
  if (c.home.logo && /^https:\/\//.test(c.home.logo)) lines.push(`- **Avatar**: ${c.home.logo}`);
  lines.push('');
  if (c.home.description) lines.push(sentence(c.home.description.slice(0, 400)), '');
  const facts = [`Y Combinator ${c.row.batch}.`];
  if (c.endpoint) facts.push(`Runs an MCP server at ${c.endpoint}.`);
  else facts.push('Runs an MCP server.');
  const from = [ATTRIBUTION, "the company's homepage", c.wd ? `Wikidata (${c.wd.qid})` : null];
  const named = from.filter(Boolean);
  facts.push(`Compiled by NicheDB from ${named.slice(0, -1).join(', ')} and ${named.at(-1)}.`);
  lines.push(facts.join(' '));
  const accounts = Object.values(c.accounts);
  if (c.wd) accounts.push(`https://www.wikidata.org/wiki/${c.wd.qid}`);
  if (accounts.length) {
    lines.push('', '## Accounts', '');
    for (const a of accounts) lines.push(`- ${a}`);
  }
  lines.push('', '## Topics', '', '- MCP', '- Y Combinator', '');
  return lines.join('\n');
}

/** A founder as an OpenProfile.md. Their accounts are their identity keys. */
export function founderDoc(f, c) {
  const lines = [`# ${oneLine(f.name)}`, '', '- **Kind**: person'];
  const web = f.accounts.find(
    (u) =>
      !/linkedin\.com|x\.com|twitter\.com|github\.com|wikidata\.org|facebook\.com|instagram\.com/.test(
        u,
      ),
  );
  if (web) lines.push(`- **Web**: ${web}`);
  lines.push('');
  const role = f.title ? oneLine(f.title) : 'Founder';
  lines.push(
    `${role} of ${oneLine(c.name)} (https://${c.domain}), Y Combinator ${c.row.batch}. Compiled by NicheDB from ${c.name}'s homepage${f.accounts.some((u) => u.includes('wikidata.org')) ? ' and Wikidata' : ''}.`,
  );
  const accounts = f.accounts.filter((u) => u !== web);
  if (accounts.length) {
    lines.push('', '## Accounts', '');
    for (const a of accounts) lines.push(`- ${a}`);
  }
  lines.push('', '## Topics', '', '- Founder', '- Y Combinator', '');
  return lines.join('\n');
}

/*
 * The item the core absorbs into `profiles`. `source_url` is what keeps a
 * person one person across runs: the company's for the company, the company's
 * with a fragment per founder for each founder, so a rerun updates rather than
 * adds, and a founder who later serves their own OpenProfile merges on an
 * account they share.
 */
function profileItemOf({ id, title, summary, doc, sourceUrl, pageUrl, fetchedAt, tags }) {
  return {
    externalId: id.slice(0, 500),
    kind: 'openprofile',
    title,
    summary,
    url: pageUrl,
    publishedAt: fetchedAt,
    timeKnown: true,
    precision: 'minute',
    tags: ['openprofile', 'from:installmap', ...tags],
    data: {
      app: 'installmap',
      listing: CSV,
      source_url: sourceUrl,
      page_url: pageUrl,
      updated_at: null,
      fetched_at: fetchedAt,
      doc,
    },
  };
}

export function profileItems(c, fetchedAt) {
  const web = `https://${c.domain}`;
  const out = [
    profileItemOf({
      id: `installmap-yc:${c.domain}`,
      title: c.name,
      summary: c.home.description ? oneLine(c.home.description).slice(0, 300) : null,
      doc: companyDoc(c),
      sourceUrl: `${web}/#installmap-yc`,
      pageUrl: web,
      fetchedAt,
      tags: ['organization', 'yc', batchTag(c.row.batch)].filter(Boolean),
    }),
  ];
  for (const f of c.founders) {
    const slug = slugify(f.name);
    if (!slug) continue;
    out.push(
      profileItemOf({
        id: `installmap-yc:${c.domain}:founder:${slug}`,
        title: f.name,
        summary: `${f.title ? oneLine(f.title) : 'Founder'}, ${c.name}`,
        doc: founderDoc(f, c),
        sourceUrl: `${web}/#founder-${slug}`,
        pageUrl: f.accounts[0] ?? web,
        fetchedAt,
        tags: ['person', 'founder', 'yc'],
      }),
    );
  }
  return out;
}

/* ----------------------------------------------------------------- adapters */

const configFields = [
  { key: 'url', label: 'Dataset URL', placeholder: CSV },
  {
    key: 'concurrency',
    label: 'Companies at a time',
    type: 'number',
    placeholder: '8',
    help: 'Each company is a homepage read, a descriptor check and up to three MCP handshakes.',
  },
  {
    key: 'limit',
    label: 'Companies per run',
    type: 'number',
    placeholder: 'all',
    help: 'Leave empty for every company the dataset flags (182 on 2026-09-23).',
  },
];

export const installmapYcMcp = defineAdapter({
  name: 'installmap-yc-mcp',
  title: 'Installmap: YC companies with an MCP server',
  collection: 'mcp',
  description:
    "Y Combinator companies with an MCP server, from Installmap's crawl of every reachable YC domain (CC BY 4.0): 182 companies, each an OpenMCP record (logicsrc.com/openmcp) with the endpoint, whether it served a descriptor (verified) and whether it answered an unauthenticated handshake (online), plus the batch, whether it has a public API or an llms.txt, the evidence Installmap found, and the company's own accounts and founders from its homepage and Wikidata.",
  docs: RESEARCH,
  kinds: ['mcp-server'],
  cadenceMinutes: 60 * 24 * 7,
  configFields,
  defaults: { url: CSV, concurrency: 8 },
  defaultSources: [{ slug: 'installmap-yc-mcp', name: 'MCP: YC companies (Installmap)' }],
  async pull(ctx) {
    const { companies, publishedAt } = await gather(ctx);
    const seenAt = new Date().toISOString();
    const items = companies.map((c) => mcpItem(c, seenAt, publishedAt));
    const online = companies.filter((c) => c.probe.online).length;
    return {
      items,
      note: `${items.length} companies, ${online} online, ${companies.filter((c) => c.endpoint).length} with an endpoint`,
    };
  },
});

export const installmapYcPeople = defineAdapter({
  name: 'installmap-yc-people',
  title: 'Installmap: YC MCP companies and their founders',
  collection: 'profiles',
  description:
    "The companies in Installmap's YC MCP dataset and the people behind them, as OpenProfile documents: each company as an organization with the accounts its homepage links or declares (X, LinkedIn, GitHub, YouTube, Discord, Bluesky, Crunchbase) and its Wikidata entry, and each founder its schema.org markup or Wikidata names, with their own accounts. ycombinator.com is not read: its terms forbid scraping.",
  docs: RESEARCH,
  kinds: ['openprofile'],
  cadenceMinutes: 60 * 24 * 7,
  configFields,
  defaults: { url: CSV, concurrency: 8 },
  defaultSources: [
    { slug: 'installmap-yc-people', name: 'People: YC MCP companies and founders (Installmap)' },
  ],
  async pull(ctx) {
    const { companies } = await gather(ctx);
    const fetchedAt = new Date().toISOString();
    const items = companies.flatMap((c) => profileItems(c, fetchedAt));
    const people = items.length - companies.length;
    return { items, note: `${companies.length} companies, ${people} founders` };
  },
});
