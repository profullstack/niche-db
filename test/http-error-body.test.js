import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { makeHttp } from '../packages/core/src/http.js';

/*
 * A non-2xx answer's error carries the body's first line: the CFPB search
 * said `{"state":["\"FM\" is not a valid choice."]}` on every failed run for
 * ten days, and the run's error, a status plus a URL cut before the query
 * that mattered, kept that to itself.
 */
let server;
let base;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/json400') {
        return new Response('{"state":["\\"FM\\" is not a valid choice."]}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/html403') {
        return new Response(
          "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>\nYou don't have permission.</BODY></HTML>",
          { status: 403, headers: { 'content-type': 'text/html' } },
        );
      }
      if (pathname === '/empty500') return new Response('', { status: 500 });
      if (pathname === '/miss') return new Response('nope', { status: 404 });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server?.stop(true));

const http = () => makeHttp({ userAgent: 'test', log: () => {} });

describe('http errors', () => {
  test('carry the status, the whole query and the JSON body', async () => {
    const url = `${base}/json400?size=10000&no_aggs=true&sort=created_date_desc&date_received_min=2026-09-09&date_received_max=2026-09-09&state=FM`;
    await expect(http().json(url)).rejects.toThrow(
      `400 from ${url}: {"state":["\\"FM\\" is not a valid choice."]}`,
    );
  });

  test('collapse an HTML body to one line of its text', async () => {
    const url = `${base}/html403`;
    await expect(http().text(url)).rejects.toThrow(
      `403 from ${url}: Access Denied Access Denied You don't have permission.`,
    );
  });

  test('an empty body adds nothing', async () => {
    const url = `${base}/empty500`;
    let message = '';
    await http()
      .json(url)
      .catch((e) => {
        message = e.message;
      });
    expect(message).toBe(`500 from ${url}`);
  });

  test('a long body is cut at 200 characters and a long URL at 400', async () => {
    const long = `${base}/json400?${'q=x&'.repeat(200)}`;
    let message = '';
    await http()
      .json(long)
      .catch((e) => {
        message = e.message;
      });
    expect(message.startsWith(`400 from ${long.slice(0, 400)}`)).toBe(true);
    expect(message.length).toBeLessThan(400 + 220);
  });

  test('jsonOrNull still answers null on a 404 and succeeds on a 200', async () => {
    expect(await http().jsonOrNull(`${base}/miss`)).toBeNull();
    expect(await http().json(`${base}/ok`)).toEqual({ ok: true });
  });
});
