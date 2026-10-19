import { ownerOf } from './owners.js';

/**
 * Shared infrastructure that is never one actor and is never listed or
 * approved: every network in the owner registry (owners.js), which is
 * Cloudflare's edge, the big public resolvers, the search crawlers and
 * Apple's 17.0.0.0/8. Used by the abuse.ch adapter and the /traffic review.
 */
export function isSharedIp(ip) {
  return ownerOf(ip) !== null;
}
