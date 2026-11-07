import { normaliseItem } from '@nichedb/core/adapter';
import { publicWebUrl } from '@nichedb/core/opensite';
import * as q from '@nichedb/db/queries';
import { Denied, isAdmin } from './service.js';

/**
 * MCP servers a crawler found on the open web and proved with a live handshake
 * (pit.world's pitbot), kept in /c/mcp as OpenMCP records (logicsrc.com/openmcp).
 *
 * The strings here were written by whoever runs the server. They are stored as
 * data and clipped; nothing about a record is trusted beyond "this address
 * answered `initialize` on the day it was read".
 */
export const COLLECTION = 'mcp';
export const CRAWLER_SOURCE = 'pit-crawler-mcp';
export const RECORDS_MAX = 200;

const clip = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The OpenMCP id: host and path, with the endpoint's own name dropped. */
export function recordId(endpoint) {
  const u = new URL(endpoint);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/(?:api\/|v\d+\/)?mcp$/, '');
  return `${u.hostname.toLowerCase()}${path}`.replace(/\/+$/, '');
}

/** One pushed server as an item row, or { error } saying why not. */
export function crawledMcpItem(entry) {
  if (!entry || typeof entry !== 'object') return { error: 'not an object' };
  const endpoint = publicWebUrl(entry.mcp);
  if (!endpoint || !endpoint.startsWith('https://'))
    return { error: 'mcp is not a public https address' };
  const foundOn = entry.foundOn ? publicWebUrl(entry.foundOn) : null;
  const id = recordId(endpoint);
  const name = clip(entry.name, 120) || id;
  const description = clip(entry.description, 500);
  const authRequired = entry.auth === 'required';
  const hasDescriptor = entry.descriptor === true;
  const tools = (Array.isArray(entry.tools) ? entry.tools : []).slice(0, 200).flatMap((t) => {
    const toolName = clip(t?.name, 120);
    return toolName ? [{ name: toolName, description: clip(t?.description, 500) || null }] : [];
  });
  const row = normaliseItem({
    externalId: `pit-crawler:${id}`,
    kind: 'mcp-server',
    title: name,
    summary:
      description ||
      `An MCP server at ${endpoint}${tools.length ? ` with ${tools.length} tools` : ''}.`,
    url: endpoint,
    tags: [
      'mcp',
      'remote',
      'crawled',
      'online',
      authRequired ? 'auth-required' : 'open',
      hasDescriptor ? 'descriptor' : null,
    ].filter(Boolean),
    data: {
      openmcp: {
        id,
        source: 'https://pit.world/bot',
        descriptor: {
          openmcp: '0.1',
          mcp: endpoint,
          name,
          ...(description ? { description } : {}),
          ...(tools.length ? { tools: tools.map((t) => t.name) } : {}),
          ...(authRequired ? { auth: 'required' } : {}),
        },
        compiled: !hasDescriptor,
        tools,
        server: {
          name: clip(entry.serverName, 120) || null,
          version: clip(entry.version, 40) || null,
          protocolVersion: clip(entry.protocolVersion, 40) || null,
        },
        verified: hasDescriptor,
        online: true,
        seenAt: clip(entry.seenAt, 40) || new Date().toISOString(),
        via: 'pitbot',
      },
      foundOn,
    },
  });
  if (!row) return { error: 'no title or address' };
  // The crawler hashes what the server said, so a re-read of the same server writes nothing.
  const hash = clip(entry.hash, 128);
  if (hash) row.contentHash = `crawl:${hash}`;
  return { item: row };
}

/** Admins only (an admin API key is how a crawler signs in); each record stands alone. */
export async function keepCrawledMcp({ user, records }) {
  if (!user) throw new Denied('Sign in with an API key to push records.', 401);
  if (!isAdmin(user)) throw new Denied('Pushing crawled records is for the index operators.', 403);
  if (!Array.isArray(records) || records.length === 0)
    throw new Denied('send { "records": [ { "mcp": "https://…", "name": "…", "tools": [] } ] }', 400);
  if (records.length > RECORDS_MAX)
    throw new Denied(
      `At most ${RECORDS_MAX} records a call; send ${records.length} as batches.`,
      413,
    );
  const [collection, source] = await Promise.all([
    q.getCollection(COLLECTION),
    q.getSource(CRAWLER_SOURCE),
  ]);
  if (!collection || !source)
    throw new Denied('The crawler source is not set up on this deployment yet.', 503);
  const items = [];
  const rejected = [];
  records.forEach((entry, index) => {
    const out = crawledMcpItem(entry);
    if (out.item) items.push(out.item);
    else rejected.push({ index, error: out.error });
  });
  const { added, updated } = items.length
    ? await q.upsertItems({ collectionId: collection.id, sourceId: source.id, items })
    : { added: 0, updated: 0 };
  return {
    accepted: items.length,
    added,
    updated,
    unchanged: items.length - added - updated,
    rejected,
  };
}
