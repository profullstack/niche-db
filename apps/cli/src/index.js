/**
 * nichedb: the CLI, and an MCP server over stdio.
 *
 * Talks to a deployment's HTTP API, so it works against any NicheDB -- the
 * public one, or your own via `--api http://localhost:3000`. Zero dependencies
 * and one file, so it installs in a second and can be vendored anywhere.
 *
 * It is both a module and a program: the tests import {@link run} and the
 * `bin/` shim executes it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const VERSION = '0.7.0';
const DEFAULT_API = process.env.NICHEDB_API ?? 'https://nichedb.dev';
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'nichedb');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Every command, in the order they are worth learning. Rendered into --help
 * and into the /docs/cli page, so the two cannot drift.
 */
export const COMMANDS = [
  {
    name: 'collections',
    usage: 'collections',
    summary: 'The collections (niches) and their counts.',
    options: ['--json'],
  },
  {
    name: 'sources',
    usage: 'sources [--collection <slug>]',
    summary: 'Sources with status, last run and item counts.',
    options: ['--collection <slug>', '--json'],
  },
  {
    name: 'source',
    usage: 'source <slug>',
    summary: 'One source, its recent runs and config.',
    options: ['--json'],
  },
  {
    name: 'source add',
    usage: 'source add <adapter> [--name …] [--collection …] [--config k=v …] [--every <min>]',
    summary: 'Add a source (key required; admin or Pro).',
    options: ['--name', '--collection', '--config k=v (repeatable)', '--every <minutes>', '--json'],
  },
  {
    name: 'source run',
    usage: 'source run <slug>',
    summary: 'Fetch a source now (key required).',
    options: [],
  },
  {
    name: 'source pause',
    usage: 'source pause|resume <slug>',
    summary: 'Pause or resume a source (key required).',
    options: [],
  },
  {
    name: 'source rm',
    usage: 'source rm <slug>',
    summary: 'Delete a source and its items (key required).',
    options: [],
  },
  {
    name: 'adapters',
    usage: 'adapters',
    summary: 'Every adapter and the config fields it takes.',
    options: ['--json'],
  },
  {
    name: 'feeds',
    usage: 'feeds [--collection <slug>]',
    summary: 'Public feeds, most followed first.',
    options: ['--collection <slug>', '--json'],
  },
  {
    name: 'items',
    usage: 'items <feed> [--limit n] [--before id]',
    summary: 'What a feed selects, newest first.',
    options: ['--limit <n>', '--before <id>', '--json', '--urls'],
  },
  {
    name: 'recent',
    usage:
      'recent [--collection …] [--source …] [--kind …] [--tags a,b] [--from …] [--to …] [--since …] [--sort id|published|updated]',
    summary:
      'Newest items across a collection or source, or a window of them, or what changed since.',
    options: [
      '--collection',
      '--source',
      '--kind',
      '--tags a,b (every one must be on the item)',
      '--from / --to (ISO, on published_at)',
      '--since (ISO, on updated_at)',
      '--sort id|published|updated',
      '--order asc|desc',
      '--limit',
      '--json',
      '--urls',
    ],
  },
  {
    name: 'match',
    usage: 'match <name> [--collection …] [--kind …] [--year …] [--tags a,b]',
    summary:
      'Which title, channel or fixture is this name? A release name or a playlist entry, cleaned and matched by similarity.',
    options: ['--collection', '--kind', '--year', '--tags', '--limit', '--json', '--urls'],
  },
  {
    name: 'upcoming',
    usage: 'upcoming [--collection <slug>] [--days n]',
    summary: 'Items dated in the future, soonest first.',
    options: ['--collection', '--days', '--limit', '--json'],
  },
  {
    name: 'search',
    usage: 'search <query> [--collection …] [--kind …]',
    summary: 'Full-text search.',
    options: ['--collection', '--kind', '--limit', '--json', '--urls'],
  },
  {
    name: 'item',
    usage: 'item <id>',
    summary: 'One item with its full data payload.',
    options: ['--json'],
  },
  {
    name: 'feed create',
    usage:
      'feed create --collection <slug> --name <name> [--sources a,b] [--kinds …] [--tags …] [--q …] [--upcoming] [--private]',
    summary: 'Save a query as a feed (key required).',
    options: [],
  },
  {
    name: 'feed rm',
    usage: 'feed rm <slug>',
    summary: 'Delete your feed (key required).',
    options: [],
  },
  {
    name: 'follow',
    usage:
      'follow <feed> [--channels email,webpush,webhook] [--webhook-url …] [--webhook-secret …]',
    summary: 'Follow a feed as the key owner.',
    options: [],
  },
  { name: 'unfollow', usage: 'unfollow <feed>', summary: 'Stop following.', options: [] },
  {
    name: 'following',
    usage: 'following',
    summary: 'The feeds your key follows.',
    options: ['--json'],
  },
  {
    name: 'rss',
    usage: 'rss <feed>',
    summary: 'Print the RSS URL (or the feed itself with --fetch).',
    options: ['--fetch'],
  },
  {
    name: 'login',
    usage: 'login [--api <url>] [--key <ndb_…>]',
    summary: 'Store an API key for a deployment.',
    options: [],
  },
  { name: 'whoami', usage: 'whoami', summary: 'Who the stored key belongs to.', options: [] },
  {
    name: 'mcp',
    usage: 'mcp [--api <url>]',
    summary: 'Run as an MCP server over stdio (for Claude Code, Cursor, …).',
    options: [],
  },
];

/* --------------------------------------------------------------- args -- */

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) =>
        c.toUpperCase(),
      );
      let val = eq > 0 ? a.slice(eq + 1) : undefined;
      if (val === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          val = next;
          i++;
        } else val = true;
      }
      if (key === 'config') {
        if (!flags.config) flags.config = [];
        flags.config.push(val);
      } else flags[key] = val;
    } else positional.push(a);
  }
  return { flags, positional };
}

/* ------------------------------------------------------------- config -- */

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

/* ---------------------------------------------------------------- api -- */

export function makeClient({ api, key, fetchImpl = fetch }) {
  const base = String(api).replace(/\/$/, '');
  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': `nichedb-cli/${VERSION}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data?.error ?? `${res.status} from ${path}`);
    return data;
  }
  return {
    base,
    key,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

/* ------------------------------------------------------------- output -- */

const out = (s) => process.stdout.write(`${s}\n`);
const pad = (s, n) =>
  String(s ?? '')
    .padEnd(n)
    .slice(0, n);
const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');

function printItems(items, { json, urls }) {
  if (json) return out(JSON.stringify(items, null, 2));
  if (urls) {
    for (const i of items) out(i.url ?? i.page);
    return;
  }
  for (const i of items) {
    out(
      `${i.id}  ${when(i.published_at ?? i.first_seen_at)}${i.time_known === false ? '~' : ' '} ${pad(i.kind, 8)} ${i.title}`,
    );
    if (i.url) out(`      ${i.url}`);
  }
  if (items.length === 0) out('(nothing)');
}

function help() {
  out(`nichedb ${VERSION} — sources in, feeds out.\n`);
  out('Usage: nichedb <command> [options]\n');
  for (const c of COMMANDS) out(`  ${pad(c.usage, 68)} ${c.summary}`);
  out(
    '\nGlobal: --api <url> (default from `nichedb login`, else NICHEDB_API), --key <ndb_…>, --json',
  );
}

const kv = (list) =>
  Object.fromEntries(
    (list ?? []).map((s) => {
      const i = String(s).indexOf('=');
      return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)];
    }),
  );
const csv = (v) =>
  v === undefined || v === true
    ? undefined
    : String(v)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/* ---------------------------------------------------------------- run -- */

export async function run(
  argv,
  { fetchImpl = fetch, stdin = process.stdin, stdout = process.stdout } = {},
) {
  const { flags, positional } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const cfg = await loadConfig();
  const api = flags.api ?? cfg.api ?? DEFAULT_API;
  const key = flags.key ?? cfg.keys?.[api] ?? process.env.NICHEDB_KEY ?? null;
  const client = makeClient({ api, key, fetchImpl });
  const json = Boolean(flags.json);

  if (!cmd || cmd === 'help' || flags.help) {
    help();
    return 0;
  }
  if (flags.version || cmd === 'version') {
    out(VERSION);
    return 0;
  }

  switch (cmd) {
    case 'login': {
      let k = flags.key;
      if (!k) {
        const rl = createInterface({ input: stdin, output: stdout });
        k = await new Promise((r) =>
          rl.question(`API key for ${api} (from ${api}/settings): `, (a) => {
            rl.close();
            r(a.trim());
          }),
        );
      }
      const me = await makeClient({ api, key: k, fetchImpl }).get('/api/v1/me');
      cfg.api = api;
      cfg.keys = { ...(cfg.keys ?? {}), [api]: k };
      await saveConfig(cfg);
      out(`Signed in to ${api} as ${me.email}${me.pro ? ' (Pro)' : ''}. Saved to ${CONFIG_FILE}.`);

      return 0;
    }
    case 'whoami': {
      const me = await client.get('/api/v1/me');
      out(
        json
          ? JSON.stringify(me, null, 2)
          : `${me.email} · ${me.role}${me.pro ? ' · Pro' : ''} · ${me.feeds} feeds · ${api}`,
      );

      return 0;
    }
    case 'collections': {
      const { collections } = await client.get('/api/v1/collections');
      if (json) {
        out(JSON.stringify(collections, null, 2));
        return 0;
      }
      for (const c of collections)
        out(
          `${pad(c.slug, 12)} ${pad(String(c.items), 9)} items  ${c.sources} sources  ${c.feeds} feeds  ${c.name}`,
        );
      return 0;
    }
    case 'adapters': {
      const { adapters } = await client.get('/api/v1/adapters');
      if (json) {
        out(JSON.stringify(adapters, null, 2));
        return 0;
      }
      for (const a of adapters) {
        out(`${pad(a.name, 18)} ${pad(a.collection, 10)} every ${a.cadenceMinutes}m  ${a.title}`);
        for (const f of a.configFields)
          out(
            `    --config ${f.key}=…  ${f.label}${f.required ? ' (required)' : ''}${f.options ? ` [${f.options.join('|')}]` : ''}`,
          );
        if (a.needsEnv?.length) out(`    needs on the server: ${a.needsEnv.join(', ')}`);
      }
      return 0;
    }
    case 'sources': {
      const qs = flags.collection ? `?collection=${encodeURIComponent(flags.collection)}` : '';
      const { sources } = await client.get(`/api/v1/sources${qs}`);
      if (json) {
        out(JSON.stringify(sources, null, 2));
        return 0;
      }
      for (const s of sources) {
        const st = !s.enabled
          ? 'paused'
          : s.last_error
            ? 'ERROR '
            : s.last_ok_at
              ? 'ok    '
              : 'wait  ';
        out(
          `${st} ${pad(s.slug, 28)} ${pad(String(s.item_count), 8)} every ${pad(`${s.cadence_minutes}m`, 5)} last ${when(s.last_ok_at)}  ${s.name}`,
        );
        if (s.last_error) out(`       ${s.last_error.slice(0, 100)}`);
      }
      return 0;
    }
    case 'source': {
      const [sub, arg] = rest;
      if (sub === 'add') {
        const body = {
          adapter: arg,
          name: flags.name,
          collection: flags.collection,
          config: kv(flags.config),
          cadence_minutes: flags.every ? Number(flags.every) : undefined,
        };
        for (const [k, v] of Object.entries(body.config))
          if (typeof v === 'string' && v.includes(','))
            body.config[k] = v.split(',').map((s) => s.trim());
        const { source } = await client.post('/api/v1/sources', body);
        out(
          json
            ? JSON.stringify(source, null, 2)
            : `Added ${source.slug} (${source.adapter}). First fetch is queued. ${api}/s/${source.slug}`,
        );

        return 0;
      }
      if (sub === 'run') {
        await client.post(`/api/v1/sources/${arg}/run`);
        out(`Queued ${arg}.`);
        return 0;
      }
      if (sub === 'pause' || sub === 'resume') {
        await client.patch(`/api/v1/sources/${arg}`, { enabled: sub === 'resume' });
        out(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${arg}.`);
        return 0;
      }
      if (sub === 'rm') {
        await client.del(`/api/v1/sources/${arg}`);
        out(`Deleted ${arg}.`);
        return 0;
      }
      if (!sub) throw new Error('source <slug>, or source add|run|pause|resume|rm');
      const { source, runs } = await client.get(`/api/v1/sources/${sub}`);
      if (json) {
        out(JSON.stringify({ source, runs }, null, 2));
        return 0;
      }
      out(
        `${source.name} (${source.slug}) · ${source.adapter} · ${source.enabled ? 'enabled' : 'paused'} · every ${source.cadence_minutes}m · ${source.item_count} items`,
      );
      out(`config: ${JSON.stringify(source.config)}`);
      if (source.last_error) out(`last error: ${source.last_error}`);
      for (const r of runs)
        out(
          `  ${when(r.started_at)} ${pad(r.status, 7)} seen ${r.seen} new ${r.added} ${r.error ?? r.note ?? ''}`,
        );
      return 0;
    }
    case 'feeds': {
      const qs = flags.collection ? `?collection=${encodeURIComponent(flags.collection)}` : '';
      const { feeds } = await client.get(`/api/v1/feeds${qs}`);
      if (json) {
        out(JSON.stringify(feeds, null, 2));
        return 0;
      }
      for (const f of feeds)
        out(`${pad(f.slug, 30)} ${pad(f.collection, 10)} ${pad(String(f.followers), 5)} ${f.name}`);
      return 0;
    }
    case 'feed': {
      const [sub, arg] = rest;
      if (sub === 'create') {
        const { feed } = await client.post('/api/v1/feeds', {
          collection: flags.collection,
          name: flags.name,
          description: flags.description,
          sources: csv(flags.sources),
          kinds: csv(flags.kinds),
          tags: csv(flags.tags),
          q: flags.q,
          upcoming: Boolean(flags.upcoming),
          public: !flags.private,
        });
        out(
          json
            ? JSON.stringify(feed, null, 2)
            : `Created ${feed.slug}: ${feed.page}\nRSS ${feed.rss}`,
        );

        return 0;
      }
      if (sub === 'rm') {
        await client.del(`/api/v1/feeds/${arg}`);
        out(`Deleted ${arg}.`);
        return 0;
      }
      throw new Error('feed create|rm');
    }
    case 'items': {
      const [slug] = rest;
      if (!slug) throw new Error('items <feed>');
      const qs = new URLSearchParams();
      if (flags.limit) qs.set('limit', flags.limit);
      if (flags.before) qs.set('before', flags.before);
      const { items } = await client.get(`/api/v1/feeds/${slug}/items?${qs}`);
      printItems(items, { json, urls: flags.urls });
      return 0;
    }
    case 'recent': {
      const qs = new URLSearchParams();
      for (const k of [
        'collection',
        'source',
        'kind',
        'tags',
        'from',
        'to',
        'since',
        'sort',
        'order',
        'limit',
        'before',
        'after',
      ])
        if (flags[k]) qs.set(k, flags[k]);
      const { items } = await client.get(`/api/v1/items?${qs}`);
      printItems(items, { json, urls: flags.urls });
      return 0;
    }
    case 'match': {
      const name = rest.join(' ');
      if (!name) throw new Error('match <name>');
      const qs = new URLSearchParams({ q: name });
      for (const k of ['collection', 'kind', 'year', 'tags', 'limit'])
        if (flags[k]) qs.set(k, flags[k]);
      const answer = await client.get(`/api/v1/match?${qs}`);
      if (json) {
        console.log(JSON.stringify(answer, null, 2));
        return 0;
      }
      const p = answer.parsed;
      console.log(
        `read as: ${p.name}${p.year ? ` (${p.year})` : ''}${p.season ? ` S${p.season}` : ''}${p.episode ? `E${p.episode}` : ''} · ${p.kind}`,
      );
      printItems(
        answer.items.map((i) => ({ ...i, title: `${(i.score * 100).toFixed(0)}%  ${i.title}` })),
        { json: false, urls: flags.urls },
      );
      return 0;
    }
    case 'upcoming': {
      const qs = new URLSearchParams();
      for (const k of ['collection', 'days', 'limit']) if (flags[k]) qs.set(k, flags[k]);
      const { items } = await client.get(`/api/v1/items/upcoming?${qs}`);
      printItems(items, { json, urls: flags.urls });
      return 0;
    }
    case 'search': {
      const term = rest.join(' ');
      if (!term) throw new Error('search <query>');
      const qs = new URLSearchParams({ q: term });
      for (const k of ['collection', 'kind', 'limit']) if (flags[k]) qs.set(k, flags[k]);
      const { items } = await client.get(`/api/v1/search?${qs}`);
      printItems(items, { json, urls: flags.urls });
      return 0;
    }
    case 'item': {
      const { item } = await client.get(`/api/v1/items/${rest[0]}`);
      if (json) {
        out(JSON.stringify(item, null, 2));
        return 0;
      }
      out(
        `${item.title}\n${item.url ?? item.page}\n${item.kind} · ${item.collection}/${item.source} · ${when(item.published_at)}${item.time_known === false ? ' (date only)' : ''}`,
      );
      if (item.summary) out(`\n${item.summary}`);
      out(`\ntags: ${item.tags.join(', ')}\n${JSON.stringify(item.data, null, 2)}`);
      return 0;
    }
    case 'follow': {
      await client.post(`/api/v1/feeds/${rest[0]}/follow`, {
        channels: csv(flags.channels),
        webhook_url: flags.webhookUrl,
        webhook_secret: flags.webhookSecret,
      });
      out(`Following ${rest[0]}.`);
      return 0;
    }
    case 'unfollow': {
      await client.del(`/api/v1/feeds/${rest[0]}/follow`);
      out(`Unfollowed ${rest[0]}.`);
      return 0;
    }
    case 'following': {
      const { feeds } = await client.get('/api/v1/following');
      if (json) {
        out(JSON.stringify(feeds, null, 2));
        return 0;
      }
      for (const f of feeds) out(`${pad(f.slug, 30)} ${f.name}`);
      return 0;
    }
    case 'rss': {
      const url = `${client.base}/f/${rest[0]}.rss`;
      if (!flags.fetch) {
        out(url);
        return 0;
      }
      const res = await fetchImpl(url);
      out(await res.text());
      return 0;
    }
    case 'mcp':
      return serveMcp({ client, stdin, stdout });
    default:
      throw new Error(`Unknown command: ${cmd}. Try nichedb help.`);
  }
}

/* ---------------------------------------------------------------- mcp -- */

/**
 * MCP over stdio: newline-delimited JSON-RPC in, out. Every message is
 * forwarded to the deployment's HTTP endpoint with the stored key, so the
 * tool list and behaviour are exactly the server's -- nothing is duplicated
 * here. Notifications get no reply, as the protocol says.
 */
export async function serveMcp({
  client,
  stdin = process.stdin,
  stdout = process.stdout,
  fetchImpl = fetch,
}) {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  const send = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const isNotification = message && typeof message === 'object' && !('id' in message);
    try {
      const res = await fetchImpl(`${client.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `nichedb-cli/${VERSION}`,
          ...(client.key ? { authorization: `Bearer ${client.key}` } : {}),
          ...(message?.params?._meta?.['io.modelcontextprotocol/protocolVersion']
            ? {
                'mcp-protocol-version':
                  message.params._meta['io.modelcontextprotocol/protocolVersion'],
                'mcp-method': message.method,
                ...(message.params?.name ? { 'mcp-name': message.params.name } : {}),
              }
            : {}),
        },
        body: JSON.stringify(message),
      });
      if (isNotification) continue;
      const body = await res.text();
      if (body) send(JSON.parse(body));
      else send({ jsonrpc: '2.0', id: message.id ?? null, result: {} });
    } catch (err) {
      if (!isNotification)
        send({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32603, message: String(err?.message ?? err) },
        });
    }
  }
  return 0;
}
