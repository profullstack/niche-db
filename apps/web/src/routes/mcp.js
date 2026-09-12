import { render } from '../lib/http.js';
import { ERRORS, fail } from '../lib/mcp/protocol.js';
import { handle } from '../lib/mcp/server.js';
import { describe, TOOLS } from '../lib/mcp/tools.js';
import { config } from '@nichedb/config';
import { McpDocs } from '../views/admin.jsx';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers':
    'content-type, accept, authorization, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'mcp-protocol-version',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
};

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

/** The MCP endpoint at /mcp (and /api/mcp): stateless Streamable HTTP, POST only. */
const KEY_TOOLS = new Set(['create_feed', 'follow_feed', 'add_source', 'run_source']);

export function registerMcp(app) {
  for (const path of ['/mcp', '/api/mcp']) {
    app.post(path, async (c) => {
      const header = (name) => c.req.header(name) ?? null;
      const ctx = { header, user: c.get('user') };
      let payload;
      try {
        payload = await c.req.json();
      } catch {
        return json(400, fail(null, ERRORS.PARSE, 'Invalid JSON'));
      }
      if (Array.isArray(payload)) {
        const answers = await Promise.all(payload.map((m) => handle(m, ctx)));
        const bodies = answers.map((a) => a.body).filter(Boolean);
        if (bodies.length === 0) return new Response(null, { status: 202, headers: CORS });
        return json(200, bodies);
      }
      const { status, body } = await handle(payload, ctx);
      if (!body) return new Response(null, { status, headers: CORS });
      return json(status, body);
    });
    app.options(path, () => new Response(null, { status: 204, headers: CORS }));
    app.delete(path, () =>
      json(405, fail(null, ERRORS.METHOD_NOT_FOUND, 'This MCP server is stateless'), {
        allow: 'POST, OPTIONS',
      }),
    );
  }
  app.get('/mcp', async (c) => {
    if ((c.req.header('accept') ?? '').includes('text/html')) {
      return c.html(await render(<McpDocs user={c.get('user')} tools={TOOLS.map(describe)} />));
    }
    return json(405, fail(null, ERRORS.METHOD_NOT_FOUND, 'This MCP endpoint accepts POST only'), {
      allow: 'POST, OPTIONS',
    });
  });
  // The tools that answer with no key. Everything else calls needUser and
  // says so; this list is kept by hand so a new tool has to say which it is.
  const OPEN_TOOLS = TOOLS.map((t) => t.name).filter((n) => !KEY_TOOLS.has(n));

  // NicheDB as an OpenMCP relay (logicsrc.com/openmcp): where the MCP
  // endpoint is, how a caller authenticates, which tools are open, what it
  // is for. A catalog that fetches this from our own origin lists NicheDB as
  // verified rather than as an endpoint that happened to answer.
  app.get('/.well-known/openmcp.json', (c) =>
    json(200, {
      openmcp: '0.1',
      mcp: `${config.siteUrl}/mcp`,
      name: 'NicheDB',
      description:
        'An open, ever-growing database of real-time public data: collections, sources, feeds and items, searchable and followable, over MCP.',
      url: config.siteUrl,
      auth: { kind: 'api-key', url: `${config.siteUrl}/settings`, open: OPEN_TOOLS },
      tags: ['data', 'feeds', 'search', 'public-data', 'nichedb'],
      tools: TOOLS.map((t) => t.name),
      catalogs: ['https://openmcp.logicsrc.com'],
    }, { 'cache-control': 'public, max-age=300' }),
  );

  app.get('/docs/mcp', async (c) =>
    c.html(await render(<McpDocs user={c.get('user')} tools={TOOLS.map(describe)} />)),
  );
}
