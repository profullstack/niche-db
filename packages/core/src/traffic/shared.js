import { sharedOwnerOf } from './owners.js';

/**
 * Shared infrastructure that is never one actor and is never listed or
 * approved: every shared network in the owner registry (owners.js; hosting providers
 * are named there but listed like anyone else), which is
 * Cloudflare's edge, the big public resolvers, the search crawlers and
 * Apple's 17.0.0.0/8. Used by the abuse.ch adapter and the /traffic review.
 */
export function isSharedIp(ip) {
  return sharedOwnerOf(ip) !== null;
}
