const INTERVAL_MS = 1100;
const MAX_WAIT_MS = 60000;

/** Retry-After may be seconds or an HTTP date. Zero never removes our backoff. */
export function retryDelay(value, attempt = 0, now = Date.now()) {
  const fallback = 5000 * 3 ** attempt;
  const seconds = value?.trim() ? Number(value) : NaN;
  const requested = Number.isFinite(seconds)
    ? seconds * 1000
    : value
      ? Date.parse(value) - now
      : NaN;
  return Number.isFinite(requested) ? Math.max(fallback, requested) : fallback;
}

/**
 * Shared by every HTTP client in the process, including manual source runs.
 * MusicBrainz limits the IP, so a sleep inside each adapter alone is insufficient.
 * Serialize retries too: concurrent callers must not start their own retry storms.
 */
export function createMusicBrainzRequest({ now = Date.now, sleep = (ms) => Bun.sleep(ms) } = {}) {
  let tail = Promise.resolve();
  let readyAt = 0;
  return (fetchOnce, log = () => {}) => {
    const run = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const wait = Math.max(0, readyAt - now());
        if (wait > MAX_WAIT_MS) {
          throw new Error(
            `MusicBrainz requested a cooldown until ${new Date(readyAt).toISOString()}`,
          );
        }
        if (wait) await sleep(wait);
        let res;
        try {
          res = await fetchOnce();
        } finally {
          readyAt = now() + INTERVAL_MS;
        }
        if (res.status !== 429 && res.status !== 503) return res;
        const delay = retryDelay(res.headers.get('retry-after'), attempt, now());
        readyAt = now() + delay;
        // Long upstream cooldowns are respected without occupying a worker for
        // minutes or retrying before the server said it was ready.
        if (attempt === 3 || delay > MAX_WAIT_MS) return res;
        await res.body?.cancel().catch(() => {});
        log(`${res.status} from musicbrainz.org, waiting ${delay}ms (retry ${attempt + 1}/3)`);
      }
    };
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
}

export const requestMusicBrainz = createMusicBrainzRequest();
