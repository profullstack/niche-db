import { config } from '@nichedb/config';
import { llmsTxt } from '../llms.js';
import {
  checkHeaders,
  ERRORS,
  era,
  fail,
  META_SERVER_INFO,
  modernVersion,
  negotiate,
  ok,
  rpcError,
  SUPPORTED_VERSIONS,
  unsupportedVersion,
} from './protocol.js';
import { describe, runTool, TOOLS, TOOLS_BY_NAME } from './tools.js';

/**
 * The MCP server: one JSON-RPC message in, one answer out. Stateless, so the
 * same endpoint serves both eras of the protocol and runs on the web service.
 */

export const SERVER_INFO = { name: 'nichedb', title: config.siteName, version: '1.0.0' };
export const CAPABILITIES = { tools: {}, resources: {} };

export const INSTRUCTIONS = [
  `${config.siteName} is an open, ever-growing database of real-time public data: collections`,
  '(games, packages, filings, ...), each fed by sources that fetch on a schedule, cut into',
  'feeds people follow. Anyone may read; a key is needed only to write.',
  '',
  'Start with `search_items` when you know a name, `recent_items` or `feed_items` to see what',
  'is new, and `upcoming` for anything dated in the future. `list_collections` and `list_feeds`',
  'say what exists. Every item carries `time_known`: when it is false, the date is real and',
  'the clock is not, so never say "at 12:00" for one of those.',
  '',
  'With a key (Authorization: Bearer ndb_…) you can `create_feed`, `follow_feed`, and on',
  'deployments that allow it `add_source` and `run_source`.',
].join('\n');

function resources() {
  return [
    {
      uri: `${config.siteUrl}/llms.txt`,
      name: 'llms.txt',
      title: 'The deployment, described for language models',
      description:
        'Collections, sources, feeds and every machine-readable endpoint, in one document.',
      mimeType: 'text/plain',
    },
  ];
}

export async function handle(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: fail(null, ERRORS.INVALID_REQUEST, 'Expected a JSON-RPC object') };
  }
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  const isNotification = !('id' in message);
  if (!method) return { status: 400, body: fail(id, ERRORS.INVALID_REQUEST, 'Missing method') };

  const modern = era(message) === 'modern';
  if (modern) {
    const bad = checkHeaders(message, ctx.header);
    if (bad) return { status: 400, body: fail(id, bad.code, bad.message) };
    const version = modernVersion(message);
    if ('unsupported' in version)
      return { status: 400, body: unsupportedVersion(id, version.unsupported) };
  }
  if (isNotification) return { status: 202, body: null };

  try {
    const result = await dispatch(method, message.params ?? {}, ctx);
    if (result === UNKNOWN_METHOD) {
      return {
        status: modern ? 404 : 200,
        body: fail(id, ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`),
      };
    }
    return { status: 200, body: ok(id, result) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err && typeof err === 'object' && 'rpcCode' in err) {
      return { status: 200, body: fail(id, Number(err.rpcCode), detail) };
    }
    console.error('[mcp]', err);
    return { status: 200, body: fail(id, ERRORS.INTERNAL, `Internal error: ${detail}`) };
  }
}

const UNKNOWN_METHOD = Symbol('unknown-method');

async function dispatch(method, params, ctx) {
  switch (method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: { [META_SERVER_INFO]: SERVER_INFO },
      };
    case 'initialize':
      return {
        protocolVersion: negotiate(params?.protocolVersion),
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(describe) };
    case 'tools/call':
      return callTool(params, ctx);
    case 'resources/list':
      return { resources: resources() };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'resources/read':
      return readResource(params);
    case 'prompts/list':
      return { prompts: [] };
    default:
      return UNKNOWN_METHOD;
  }
}

async function callTool(params, ctx) {
  const name = String(params?.name ?? '');
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool)
    return text(`No such tool: ${name}. Call tools/list for what this server offers.`, true);
  try {
    return text(JSON.stringify(await runTool(tool, params?.arguments ?? {}, ctx), null, 2));
  } catch (err) {
    if (err && typeof err === 'object' && 'toolError' in err)
      return text(String(err.message), true);
    throw err;
  }
}

async function readResource(params) {
  const uri = String(params?.uri ?? '');
  const resource = resources().find((r) => r.uri === uri);
  if (!resource) throw rpcError(ERRORS.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
  return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: await llmsTxt() }] };
}

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError });
