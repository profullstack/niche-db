/**
 * The OpenMCP descriptor: points at this site's MCP endpoint, names every
 * tool, and says which answer with no key. The key list is kept by hand,
 * so this checks it against the code: every tool that calls needUser is a
 * key tool, and no open tool does.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { registerMcp } from './mcp.js';
import { TOOLS } from '../lib/mcp/tools.js';

test('the descriptor is served, points at /mcp, lists every tool and the open ones', async () => {
  const app = new Hono();
  registerMcp(app);
  const response = await app.request('https://nichedb.dev/.well-known/openmcp.json');
  expect(response.status).toBe(200);
  const descriptor = await response.json();
  expect(descriptor.openmcp).toBe('0.1');
  expect(descriptor.mcp).toMatch(/\/mcp$/);
  expect(descriptor.auth.kind).toBe('api-key');
  expect(descriptor.tools).toEqual(TOOLS.map((t) => t.name));
  expect(descriptor.auth.open.length).toBeGreaterThan(0);
  expect(descriptor.auth.open.every((name) => descriptor.tools.includes(name))).toBe(true);
});

test('the open list matches which tools call needUser', async () => {
  const source = readFileSync(new URL('../lib/mcp/tools.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export const TOOLS = ['));
  const parts = body.split(/\n  \{\n    name: '([a-z_]+)'/);
  const keyByCode = new Set();
  for (let i = 1; i < parts.length; i += 2) if (parts[i + 1]?.includes('needUser(')) keyByCode.add(parts[i]);
  const app = new Hono();
  registerMcp(app);
  const descriptor = await (await app.request('https://nichedb.dev/.well-known/openmcp.json')).json();
  const open = new Set(descriptor.auth.open);
  for (const tool of TOOLS) expect(open.has(tool.name)).toBe(!keyByCode.has(tool.name));
});
