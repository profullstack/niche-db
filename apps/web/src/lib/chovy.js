import { config } from '@nichedb/config';
import { domainEvent } from '@nichedb/knowledge';
import { SIGNATURE_HEADER, signPayload, verifySignature } from '@nichedb/knowledge/signing';

/**
 * The wire between NicheDB and Chovy.
 *
 * Both directions are signed with the same secret and the same scheme, so the
 * side that signs a question verifies the answer with the code it already has.
 * Neither side reads the other's tables; everything crosses as an event with a
 * globally unique id, which is what makes a redelivery cheap to ignore.
 */

export const chovyConfigured = () => Boolean(config.chovy.signingSecret);

/**
 * Check the signature on an internal request.
 *
 * Returns the reason on failure so an integrator debugging a 401 can tell a
 * wrong secret from a wrong clock. The reason is safe to return: it says
 * nothing a caller holding the body does not already know.
 */
export async function verifyInternalRequest(c) {
  if (!chovyConfigured())
    return { ok: false, status: 503, reason: 'this deployment has no CHOVY_SIGNING_SECRET' };

  // The raw text, not a re-serialised object: an HMAC is over bytes, and
  // JSON.stringify(JSON.parse(x)) is not always x.
  const rawBody = await c.req.text();
  const result = verifySignature({
    rawBody,
    header: c.req.header(SIGNATURE_HEADER),
    secret: config.chovy.signingSecret,
  });
  if (!result.ok) return { ok: false, status: 401, reason: result.reason };

  try {
    return { ok: true, body: rawBody ? JSON.parse(rawBody) : {}, rawBody };
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
}

/**
 * Tell Chovy something happened.
 *
 * Never throws and never blocks the thing that triggered it. An operator's
 * answer is recorded and scored whether or not the agent is reachable; a
 * delivery that failed is a log line, not a lost contribution. Without a
 * configured URL this is a no-op, which is the normal state until a Chovy
 * deployment exists to point at.
 */
export async function notifyChovy(type, { payload, nicheId = null, userId = null } = {}) {
  if (!chovyConfigured() || !config.chovy.webhookUrl) return { sent: false, reason: 'not wired' };
  const event = domainEvent({ type, producer: 'nichedb', payload, nicheId, userId });
  const rawBody = JSON.stringify(event);
  try {
    const res = await fetch(config.chovy.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signPayload({ rawBody, secret: config.chovy.signingSecret }),
      },
      body: rawBody,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('[chovy] delivery refused', type, res.status);
    return { sent: res.ok, status: res.status, eventId: event.id };
  } catch (err) {
    console.error('[chovy] could not deliver', type, err?.message ?? err);
    return { sent: false, reason: String(err?.message ?? err) };
  }
}
