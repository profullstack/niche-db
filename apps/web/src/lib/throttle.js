/**
 * The site-wide allowance: a hundred requests a minute, per caller, on every
 * route. Going over is answered 402 with the caller's own crawl offer.
 *
 * WHY. The gate above charges crawlers that say who they are. Nothing charged
 * the ones that do not, and nothing counted a page route at all. That is the
 * shape that failed on coinpayportal on 2026-09-08: a headless browser found a
 * route nobody had listed and walked 19,000 of its URLs a day for two days,
 * declaring nothing, tripping no list, every hit served from the database.
 *
 * WHY A THROTTLE PER GATEWAY. The price here is the buyer's own -- a dollar a
 * day at list, less the more it has spent (lib/pricing.js) -- so the gateway is
 * chosen per request and a refusal has to quote the price that buyer would
 * actually pay. The counting must NOT split along with it, or a caller whose
 * price changed mid-window would be handed a fresh allowance for crossing a
 * discount threshold. One store, shared by every gateway's throttle.
 */

import { createThrottle, memoryStore } from '@profullstack/throttle';

/** One counter for the whole site, whatever price the caller is being quoted. */
const store = memoryStore();

const throttles = new Map();

/** The throttle that refuses at `gateway`'s price. Built once per gateway. */
function throttleFor(gateway) {
  let throttle = throttles.get(gateway);
  if (!throttle) {
    throttle = createThrottle({
      gateway,
      store,
      /*
       * A signed-in reader and an API caller get the larger budget, keyed on
       * the credential rather than the address so two of them never share a
       * bucket. Not an exemption: an unmetered site for anyone willing to sign
       * up first is a worse trade than metering a member generously.
       */
      credential: { limit: 600, ceiling: 1200 },
      rules: [
        /* Sign-in stays address-bucketed, or a guess buys the member budget. */
        { path: '/auth/', limit: 10, credential: false },
        { path: '/healthz', open: true },
        /*
         * The surfaces an agent needs in order to USE the data rather than
         * copy it stay generous, for the same reason they are outside the
         * gate: they are the point of the index, not the cost of it.
         */
        { path: '/mcp', limit: 600 },
      ],
    });
    throttles.set(gateway, throttle);
  }
  return throttle;
}

/** Resolves to a Response for a caller over the allowance, or undefined. */
export const meter = (gateway, request) => throttleFor(gateway).handle(request);
