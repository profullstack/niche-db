/**
 * Signed service requests between Chovy and NicheDB.
 *
 * The internal routes create scored work and move somebody's revenue share, so
 * they are not open to whoever can reach the port. Every one carries an HMAC
 * over the body and a timestamp, in the same shape this deployment already
 * verifies for CoinPay webhooks:
 *
 *   X-Chovy-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *   signed payload:    `${t}.${rawBody}`
 *
 * The same scheme in both directions, so Chovy verifies what we send back with
 * the code it already uses to sign what it sends.
 *
 * It lives here, with the rest of the contract, because a signature scheme one
 * side invents privately is a scheme the other side gets subtly wrong. Pure
 * strings in and out: no request object, no framework.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-chovy-signature';

/** Seconds either side of now that a signature is still good for. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The header value for a body. `timestamp` is injectable so a test can pin it. */
export function signPayload({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  if (!secret) throw new TypeError('signPayload needs a secret');
  const t = Math.floor(Number(timestamp));
  const mac = createHmac('sha256', secret)
    .update(`${t}.${rawBody ?? ''}`)
    .digest('hex');
  return `t=${t},v1=${mac}`;
}

/** `t=1,v1=abc` → { t: '1', v1: 'abc' }. Splits on the first `=` only. */
function parseHeader(header) {
  const out = {};
  for (const part of String(header ?? '').split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * Is this body signed by someone holding the secret, recently?
 *
 * Returns a reason rather than a bare false, because "your clock is wrong" and
 * "your secret is wrong" are different problems and an integrator debugging a
 * 401 cannot tell them apart otherwise.
 */
export function verifySignature({
  rawBody,
  header,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
}) {
  if (!secret) return { ok: false, reason: 'no signing secret is configured' };
  if (!header) return { ok: false, reason: 'no signature' };

  const parts = parseHeader(header);
  const t = Number(parts.t);
  const given = parts.v1;
  if (!Number.isFinite(t) || !given) return { ok: false, reason: 'malformed signature' };

  // Checked before the compare, so a captured request cannot be replayed for
  // ever. A future timestamp is refused on the same window: a clock running
  // ahead is still a clock nobody should trust to be unique.
  if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: 'signature expired' };

  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody ?? ''}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  // Length has to match before timingSafeEqual, which throws on a mismatch.
  // Comparing lengths first leaks only the length, which the header already shows.
  if (a.length !== b.length) return { ok: false, reason: 'bad signature' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  return { ok: true, timestamp: t };
}
