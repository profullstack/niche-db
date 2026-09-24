/**
 * The linkback proof's time budget.
 *
 * Claiming a profile proves ownership partly by fetching the pages the profile
 * names and looking for a link back. That is a network call inside a request a
 * person is waiting on, and it used to be six pages at six seconds each: a
 * claim could sit there for thirty-six seconds. The same unbounded reach is
 * what made `a claim is proven by the email the profile lists` flaky in CI,
 * where it blew through a five second test timeout, failed main, and blocked
 * unrelated merges.
 */
import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const { readHead } = await import('./profiles.js');

describe('readHead', () => {
  test('a spent budget reads nothing and does not call out', async () => {
    let called = 0;
    const fetcher = async () => {
      called++;
      return new Response('hello');
    };
    expect(await readHead('https://example.com', { fetcher, timeoutMs: 0 })).toBe('');
    expect(await readHead('https://example.com', { fetcher, timeoutMs: -1 })).toBe('');
    expect(called).toBe(0);
  });

  test('a page it cannot reach is no link back, not an error', async () => {
    const fetcher = async () => {
      throw new Error('offline');
    };
    expect(await readHead('https://example.com', { fetcher })).toBe('');
  });

  test('it stops reading once it has enough of the page', async () => {
    const fetcher = async () => new Response('<link rel="me" href="https://nichedb.test/x">');
    const head = await readHead('https://example.com', { fetcher, timeoutMs: 5000 });
    expect(head).toContain('nichedb.test/x');
  });

  /*
   * The budget is the point: whatever a page does, one read cannot outlast the
   * timeout it was given. A fetcher that never resolves must still let the
   * caller go.
   */
  test('a page that never answers gives up on its own', async () => {
    const fetcher = (url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const started = Date.now();
    expect(await readHead('https://example.com', { fetcher, timeoutMs: 150 })).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
