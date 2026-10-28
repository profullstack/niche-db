import { describe, expect, test } from 'bun:test';

/*
 * What agents see in tools/list. Directories such as Glimind grade the
 * server on it: every tool says whether it reads or changes state, and every
 * parameter says what it takes. A new tool or parameter without them fails
 * here, before a client has to guess.
 */

process.env.DATABASE_URL ??= 'postgres://localhost/unused';
const { TOOLS, describe: describeTool } = await import('../apps/web/src/lib/mcp/tools.js');
const { handle } = await import('../apps/web/src/lib/mcp/server.js');

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

/** Every property in a JSON schema, nested objects and array items included. */
function params(schema, path = []) {
  const out = [];
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    out.push({ path: [...path, name].join('.'), prop });
    if (prop?.properties) out.push(...params(prop, [...path, name]));
  }
  return out;
}

/** Tools whose names promise a side effect. */
const MUTATING =
  /^(create|update|delete|add|run|follow|claim|submit|redeem|rotate|test)_|_(code|secret)$/;

describe('MCP tools/list', () => {
  test('there are tools to check', () => {
    expect(TOOLS.length).toBeGreaterThan(30);
  });

  test('every tool carries all four annotations as booleans', () => {
    const missing = [];
    for (const t of TOOLS) {
      for (const h of HINTS)
        if (typeof t.annotations?.[h] !== 'boolean') missing.push(`${t.name}.${h}`);
    }
    expect(missing).toEqual([]);
  });

  test('tools/list sends the annotations', () => {
    for (const t of TOOLS) expect(describeTool(t).annotations).toEqual(t.annotations);
  });

  test('a read-only tool is never destructive', () => {
    const bad = TOOLS.filter((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint);
    expect(bad.map((t) => t.name)).toEqual([]);
  });

  test('tools that change state do not claim to be read-only', () => {
    const bad = TOOLS.filter((t) => MUTATING.test(t.name) && t.annotations.readOnlyHint);
    expect(bad.map((t) => t.name)).toEqual([]);
  });

  test('deleting, rotating and overwriting are marked destructive', () => {
    const want = ['delete_webhook', 'rotate_webhook_secret', 'update_webhook', 'update_profile'];
    for (const name of want)
      expect(TOOLS.find((t) => t.name === name)?.annotations.destructiveHint).toBe(true);
  });

  test('every parameter has a description', () => {
    const missing = [];
    for (const t of TOOLS)
      for (const { path, prop } of params(t.inputSchema))
        if (typeof prop?.description !== 'string' || prop.description.trim().length < 8)
          missing.push(`${t.name}(${path})`);
    expect(missing).toEqual([]);
  });

  test('every free-form string parameter shows an example or its choices', () => {
    const missing = [];
    for (const t of TOOLS)
      for (const { path, prop } of params(t.inputSchema)) {
        if (prop.type !== 'string' || prop.enum) continue;
        const d = prop.description;
        // An example ("e.g."), or a closed list of values written out ("a, b or c").
        if (!/e\.g\.|\bor\b|,/.test(d)) missing.push(`${t.name}(${path}): ${d}`);
      }
    expect(missing).toEqual([]);
  });

  test('required parameters exist in the schema', () => {
    for (const t of TOOLS)
      for (const r of t.inputSchema.required ?? [])
        expect(Object.keys(t.inputSchema.properties)).toContain(r);
  });

  test('a JSON-RPC tools/list answers with the annotations', async () => {
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { header: () => null },
    );
    const tools = res.body.result.tools;
    expect(tools.length).toBe(TOOLS.length);
    expect(tools.every((t) => HINTS.every((h) => typeof t.annotations[h] === 'boolean'))).toBe(
      true,
    );
  });
});
