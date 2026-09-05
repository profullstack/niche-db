/**
 * The one HTTP client adapters use.
 *
 * Every upstream here is public and free, and the ones that police anything
 * police the User-Agent (SEC refuses a blank one outright) and the rate. So this
 * always identifies the deployment, always has a timeout, and turns a 429 into
 * one polite wait rather than a retry storm.
 */

export function makeHttp({ userAgent, log = () => {} }) {
  async function request(url, { headers = {}, timeoutMs = 30_000, method = 'GET', body } = {}) {
    const doFetch = () =>
      fetch(url, {
        method,
        headers: { 'user-agent': userAgent, accept: 'application/json, text/xml, */*', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    let res = await doFetch();
    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 5) * 1000, 60_000);
      log(`${res.status} from ${new URL(url).host}, waiting ${wait}ms`);
      await Bun.sleep(wait);
      res = await doFetch();
    }
    return res;
  }

  return {
    request,
    async json(url, opts) {
      const res = await request(url, opts);
      if (!res.ok) throw new Error(`${res.status} from ${url.slice(0, 120)}`);
      return res.json();
    },
    async text(url, opts) {
      const res = await request(url, opts);
      if (!res.ok) throw new Error(`${res.status} from ${url.slice(0, 120)}`);
      return res.text();
    },
    /** Same but null on a miss, for lookups where absence is normal. */
    async jsonOrNull(url, opts) {
      const res = await request(url, opts);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} from ${url.slice(0, 120)}`);
      return res.json();
    },
  };
}
