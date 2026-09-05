import { render } from '../lib/http.js';
import { ERRORS, fail } from '../lib/mcp/protocol.js';
import { handle } from '../lib/mcp/server.js';
import { describe, TOOLS } from '../lib/mcp/tools.js';
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
  app.get('/docs/mcp', async (c) =>
    c.html(await render(<McpDocs user={c.get('user')} tools={TOOLS.map(describe)} />)),
  );
}
