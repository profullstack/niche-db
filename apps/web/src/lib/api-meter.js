import { createHash } from 'node:crypto';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { callerAddress } from './auth-throttle.js';
import { apiLimitFor, planOf } from './premium.js';
import { gatewayFor } from './pricing.js';

const site = () => config.siteUrl;
const HOUR = 3600;

/**
 * Per-hour metering for the machine surfaces (/api/v1 and MCP): by key when
 * there is one, by crawl pass when there is one, by address otherwise.
 *
 * WHY THE PASS COUNTS HERE. x402 is how an agent pays for this data, and an
 * agent reads it through the API and MCP far more than through pages. Until
 * 2026-10-21 a paid pass got through the gateway and then met this meter as a
 * stranger: 600 an hour per address, then a 429 that offered a membership in
 * prose. Paying bought nothing on the surfaces an agent uses, and running out
 * offered nothing an x402 client could pay. Now a pass gets the premium
 * allowance, and a stranger who runs out gets a 402 carrying the same x402
 * offer as every other refusal on the site (and an X-PAYMENT/PAYMENT-SIGNATURE
 * sent with the request settles on the spot).
 */
export async function apiMeter(c, next) {
  const user = c.get('user');
  const viaKey = c.get('viaKey');
  const plan = planOf(c);
  const { gateway } = await gatewayFor(c.req.raw);
  const pass = viaKey ? null : gateway.passFrom(c.req.raw);
  const paid = pass ? await gateway.verifyPass(pass) : false;
  const bucket = viaKey
    ? `key:${user.api_key_id}`
    : paid
      ? `pass:${createHash('sha256').update(pass).digest('hex').slice(0, 32)}`
      : `ip:${callerAddress(c) ?? 'unknown'}`;
  const limit = viaKey
    ? apiLimitFor(plan)
    : paid
      ? config.api.premiumPerHour
      : config.api.anonPerHour;
  const used = await q.bumpApiUsage(bucket);
  const headers = {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(Math.max(0, limit - used)),
    'x-plan': paid ? 'crawl-pass' : plan,
  };
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  if (used <= limit) {
    await next();
    // The MCP handler answers with its own Response, which drops c.header().
    for (const [k, v] of Object.entries(headers))
      if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    return;
  }

  if (viaKey || paid) {
    c.header('retry-after', String(HOUR));
    return c.json(
      {
        error: `Rate limit of ${limit}/hour reached for this ${viaKey ? 'key' : 'pass'}.`,
        plan,
        ...(plan === 'free' && viaKey
          ? {
              premium: {
                requests_per_hour: config.api.premiumPerHour,
                price: `$${(config.premium.dayCents / 100).toFixed(2)} a day`,
                url: `${site()}/premium`,
              },
            }
          : {}),
      },
      429,
    );
  }
  const resetSeconds = HOUR - (Math.floor(Date.now() / 1000) % HOUR);
  return gateway.sell(c.req.raw, {
    usage: { count: used, remaining: 0, resetSeconds, overLimit: true },
    quota: { requests: limit, windowSeconds: HOUR },
  });
}
