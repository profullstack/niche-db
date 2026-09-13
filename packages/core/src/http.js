/**
 * The one HTTP client adapters use.
 *
 * Every upstream here is public and free, and the ones that police anything
 * police the User-Agent (SEC refuses a blank one outright) and the rate. So this
 * always identifies the deployment, always has a timeout, and turns a 429 into
 * one polite wait rather than a retry storm.
 */

import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requestMusicBrainz, retryDelay } from './musicbrainz-http.js';

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
    if (new URL(url).hostname === 'musicbrainz.org') return requestMusicBrainz(doFetch, log);
    let res = await doFetch();
    if (res.status === 429 || res.status === 503) {
      const wait = retryDelay(res.headers.get('retry-after'));
      if (wait > 60_000) return res;
      log(`${res.status} from ${new URL(url).host}, waiting ${wait}ms`);
      await res.body?.cancel().catch(() => {});
      await Bun.sleep(wait);
      res = await doFetch();
    }
    return res;
  }

  /**
   * Fetch a large file to disk, resuming whatever is already there.
   *
   * The dumps this serves are 1.7 to 11 GB, so the body is streamed chunk by
   * chunk onto an open file handle and never held in memory; the timeout covers
   * the whole transfer and defaults to an hour, because `request`'s 30 s is a
   * ceiling on an API call, not on a download. The user agent goes with it:
   * Podcast Index answers 403 without one.
   *
   * Resume: a partial file on disk becomes `Range: bytes=<size>-`. A 206 is
   * appended to it; a 200 means the server ignored the range (Discogs does) and
   * the file starts over; a 416 means the file is already whole. The total from
   * Content-Range or Content-Length, when the server gives one, is checked at
   * the end: short is `complete: false` (call again to resume), long is an
   * error. A connection that drops mid-body throws and leaves the partial file
   * where the next call picks it up.
   *
   * @param {string} url
   * @param {string} filePath
   * @param {{ timeoutMs?: number, headers?: object, onProgress?: (p: { bytes: number, total: number|null }) => void }} [opts]
   * @returns {Promise<{ path: string, bytes: number, complete: boolean }>}
   */
  async function download(
    url,
    filePath,
    { timeoutMs = 60 * 60_000, headers = {}, onProgress } = {},
  ) {
    await mkdir(dirname(filePath), { recursive: true });
    const have = (await stat(filePath).catch(() => null))?.size ?? 0;
    const req = { accept: '*/*', ...headers };
    if (have > 0) req.range = `bytes=${have}-`;

    const res = await request(url, { headers: req, timeoutMs });

    if (res.status === 416) {
      // Nothing left to send. The server's idea of the whole, if it says.
      await res.body?.cancel().catch(() => {});
      const total = rangeTotal(res.headers.get('content-range'));
      if (total !== null && total !== have) {
        // Our file is longer than theirs: a different file under the same name.
        await unlink(filePath).catch(() => {});
        throw new Error(`have ${have} bytes of ${url.slice(0, 120)} but the server has ${total}`);
      }
      return { path: filePath, bytes: have, complete: true };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${res.status} from ${url.slice(0, 120)}`);
    }

    let bytes = 0;
    let total = null;
    let append = false;
    if (res.status === 206) {
      const cr = res.headers.get('content-range') ?? '';
      const start = Number(cr.match(/^bytes\s+(\d+)-/)?.[1]);
      if (start !== have) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`asked for bytes=${have}- of ${url.slice(0, 120)}, got ${cr || '206'}`);
      }
      append = true;
      bytes = have;
      total = rangeTotal(cr);
    } else {
      // 200: the whole file, whatever we asked for.
      if (have > 0) log(`${new URL(url).host} ignored the range; restarting the download`);
      const len = Number(res.headers.get('content-length'));
      total = Number.isFinite(len) && len >= 0 && res.headers.has('content-length') ? len : null;
    }

    const fh = await open(filePath, append ? 'a' : 'w');
    try {
      for await (const chunk of res.body) {
        await fh.write(chunk);
        bytes += chunk.byteLength;
        if (total !== null && bytes > total) {
          throw new Error(`${url.slice(0, 120)} sent more than its ${total} bytes`);
        }
        onProgress?.({ bytes, total });
      }
    } finally {
      await fh.close();
    }

    const complete = total === null ? true : bytes === total;
    if (!complete) log(`${url.slice(0, 120)}: ${bytes} of ${total} bytes so far`);
    return { path: filePath, bytes, complete };
  }

  return {
    request,
    download,
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

/** The total out of `Content-Range: bytes 0-99/1000` (or the `bytes` star form of a 416), or null. */
function rangeTotal(header) {
  const m = String(header ?? '').match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}
