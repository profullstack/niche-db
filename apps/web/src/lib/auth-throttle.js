/**
 * Escalating per-caller backoff in front of the unauthenticated auth routes.
 *
 * ## What was already here, and what it did not cover
 *
 * `packages/auth/src/password.js` counts failures per ADDRESS: ten wrong guesses
 * in fifteen minutes and that address is made to wait. That is the right defence
 * for one account under attack, and it stays exactly as it is.
 *
 * It does nothing about the other shape, which is the one actually arriving: one
 * caller working through a list of many different addresses. Every address is on
 * its own counter, so none of them ever trips, and each request still reaches
 * `Bun.password.verify` — argon2id, memory-hard, deliberately expensive. A list
 * of ten thousand addresses is therefore ten thousand free argon2 hashes, which
 * is both an unmetered credential-stuffing run and a way to burn the box's CPU
 * from outside. This refuses *before* the hash, which is the point.
 *
 * ## Keying on the address, which the old comment says not to do
 *
 * `app.js` says the forwarded address is "never used as the rate-limit key -- a
 * shared address would then throttle strangers", and that was correct about the
 * per-account counter it was describing: keying an account lockout on an IP lets
 * one person behind a NAT lock out everybody else behind it.
 *
 * This is a different thing and the trade lands the other way. It is not a
 * lockout — an emailed sign-in link is unaffected by this counter, so a throttled
 * caller always has a way in that is not guessable — and without an address key
 * there is nothing at all metering a spray across many accounts. So: strangers
 * behind one NAT can slow each other's *password form* down, and they can still
 * sign in the ordinary way while it lasts.
 *
 * ## Why escalating rather than a fixed window
 *
 * A fixed window is waited out. Fifteen minutes of quiet and the attacker starts
 * again at full rate, for ever, which is what is happening now. Doubling the
 * penalty each time prices out persistence — a minute, then two, then an hour,
 * then a day — while somebody who fat-fingered a password five times is forgiven
 * in a minute and forgiven entirely the moment they sign in.
 *
 * ## Why in this process's memory
 *
 * Because the endpoint being defended is the one that must not grow a database
 * round trip: a limiter that needs Postgres to tell an attacker "no" hands the
 * attacker the load it was built to prevent. One web instance sees every request
 * today. A deploy forgives everyone, which is the right direction to err on a
 * public sign-in page.
 */

/**
 * Three curves, because the things being defended are not alike. The third,
 * `MISS`, is documented at its own definition below.
 *
 * `AUTH` guards the endpoints that try a credential. Eight attempts is more than
 * anybody types by accident, and a caller that keeps going deserves the day-long
 * ceiling.
 *
 * `VIEW` guards GET /login, which is a page a real person looks at. The shape is
 * the same -- doubling, so a crawler at one a second is priced out within a
 * minute -- but the allowance is far wider and the ceiling is an hour rather than
 * a day. That matters because this is the one lock that can catch somebody with
 * nothing to prove: an office or a mobile carrier behind one address shares this
 * counter, and a person who cannot reach the sign-in page has no way around it.
 * Thirty views before any penalty, and an hour is the worst a false positive can
 * cost.
 *
 * In all of them, DECAY must exceed MAX_LOCK. If it does not, a caller that waits out
 * the longest lock comes back to find its strikes already decayed, the penalty
 * can never grow past that point, and the escalation quietly flattens into the
 * fixed window this was built instead of. `the penalty keeps escalating` covers
 * it; keep that test.
 */
export const AUTH = {
  FREE_ATTEMPTS: 8,
  BASE_LOCK_MS: 60 * 1000,
  MAX_LOCK_MS: 24 * 60 * 60 * 1000,
  DECAY_MS: 48 * 60 * 60 * 1000,
};

export const VIEW = {
  FREE_ATTEMPTS: 30,
  BASE_LOCK_MS: 60 * 1000,
  MAX_LOCK_MS: 60 * 60 * 1000,
  DECAY_MS: 2 * 60 * 60 * 1000,
};

/**
 * A third curve, for callers that keep asking for things that are not here.
 *
 * The two above guard routes this app actually has. Neither of them saw the
 * traffic that prompted them: on 2026-08-29 a single address spent four minutes
 * asking genrewatch for `/wp-json/batch/v1`, `/wp/`, `/wordpress/`,
 * `/blog/wp/v2/users` and `/index.php`, and POSTing to `/`, `/login`,
 * `/dashboard` and `/register` -- 507 requests, every one of them answered with
 * a 404 or refused by the edge, and not one of them on a route the auth backoff
 * is attached to. A WordPress scanner does not need this site to be WordPress
 * to keep asking, and nothing here counted how often it did.
 *
 * So this meters the misses themselves, on an allowance three times AUTH's and
 * in the same band as VIEW -- because like VIEW, and unlike AUTH, it can be
 * tripped by somebody who has done nothing wrong: a stale inbound link, a feed
 * reader still asking for a path that moved. Measured against a day of both
 * sites' logs, of 104 addresses that produced any 404 at all, three exceeded
 * eight misses and all three were scanners; the busiest innocent caller managed
 * twenty, following dead links from an old blog. Twenty-five leaves that caller
 * clear with room to spare, and still turns a 507-request sweep into 25.
 *
 * The ceiling is an hour rather than a day for the same reason as VIEW: an hour
 * is the worst a false positive can cost. DECAY still exceeds MAX_LOCK, which
 * is the invariant the whole escalation rests on.
 */
export const MISS = {
  FREE_ATTEMPTS: 25,
  BASE_LOCK_MS: 60 * 1000,
  MAX_LOCK_MS: 60 * 60 * 1000,
  DECAY_MS: 2 * 60 * 60 * 1000,
};

/** The key space is the internet, so it needs a bound. */
const MAX_TRACKED = 50_000;

/** @type {Map<string, { strikes: number, lockedUntil: number, lastAt: number }>} */
const seen = new Map();

/**
 * @param {number} now
 *
 * Uses the LONGEST decay of every curve, since the map is shared and a key does
 * not carry which curve made it -- add a curve and it must be named here too.
 * Sweeping too late costs a little memory; sweeping too early forgives somebody
 * who has not earned it.
 */
function sweep(now) {
  const longest = Math.max(AUTH.DECAY_MS, VIEW.DECAY_MS, MISS.DECAY_MS);
  for (const [key, entry] of seen) {
    if (entry.lockedUntil <= now && now - entry.lastAt > longest) seen.delete(key);
  }

  // Still over after dropping everything expired: shed oldest-inserted first
  // rather than grow without limit. Map preserves insertion order.
  if (seen.size > MAX_TRACKED) {
    let dropped = 0;
    const excess = seen.size - MAX_TRACKED;
    for (const key of seen.keys()) {
      seen.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * The address a request came from.
 *
 * Railway terminates TLS in front of the app, so the socket peer is always the
 * proxy and the caller is the first entry of `x-forwarded-for` — only the first,
 * because everything after it was written by whatever sat in between and a
 * caller can put whatever it likes there.
 *
 * Note the failure mode of getting this wrong: every visitor collapses to one
 * identity and the first eight requests in the world lock out the planet. Which
 * is why an unknown caller is not tracked at all — see `check`.
 *
 * @param {import('hono').Context} c
 * @returns {string|null}
 */
export function callerAddress(c) {
  const forwarded = c.req.header('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || c.req.header('x-real-ip') || null;
}

/**
 * Count one attempt from `identity` and say whether it may proceed.
 *
 * A locked caller is not charged another strike for knocking. The penalty
 * escalates once per lock earned, not once per request refused — otherwise a
 * script hammering every second reaches the day-long ceiling in under a minute
 * and a person retrying twice is treated exactly like it.
 *
 * @param {string} identity
 * @param {number} [now] injectable clock, for tests
 * @param {typeof AUTH} [limits] which curve to apply
 * @returns {{ ok: boolean, retryAfter: number, strikes: number, lockedUntil: number }}
 */
export function attempt(identity, now = Date.now(), limits = AUTH) {
  const { FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS, DECAY_MS } = limits;
  if (seen.size >= MAX_TRACKED) sweep(now);

  const entry = seen.get(identity) ?? { strikes: 0, lockedUntil: 0, lastAt: now };

  if (entry.lockedUntil > now) {
    entry.lastAt = now;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil((entry.lockedUntil - now) / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  // Quiet for long enough: start again rather than carrying a grudge for ever.
  if (now - entry.lastAt > DECAY_MS) entry.strikes = 0;

  entry.strikes += 1;
  entry.lastAt = now;

  if (entry.strikes > FREE_ATTEMPTS) {
    const over = entry.strikes - FREE_ATTEMPTS - 1;
    // Shift rather than Math.pow, and clamped, so a long-lived offender cannot
    // overflow to Infinity on its way to the ceiling.
    const lock = Math.min(BASE_LOCK_MS * 2 ** Math.min(over, 40), MAX_LOCK_MS);
    entry.lockedUntil = now + lock;
    seen.set(identity, entry);
    return {
      ok: false,
      retryAfter: Math.max(Math.ceil(lock / 1000), 1),
      strikes: entry.strikes,
      lockedUntil: entry.lockedUntil,
    };
  }

  seen.set(identity, entry);
  return { ok: true, retryAfter: 0, strikes: entry.strikes, lockedUntil: 0 };
}

/**
 * Forget a caller, on proof that it was not the thing being defended against.
 *
 * Called when a sign-in actually succeeds. Whoever just proved they hold the
 * credential is not who this is for, and the attempts before it were somebody
 * mistyping rather than an attack.
 *
 * @param {string} identity
 */
export function forgive(identity) {
  seen.delete(identity);
}

/** Forget everyone. Test seam — never call this from a request path. */
export function reset() {
  seen.clear();
}

/** Kept for the tests and for the headers a refusal carries. */
export const LIMITS = { ...AUTH, MAX_TRACKED };
