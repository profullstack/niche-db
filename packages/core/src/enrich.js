import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { defaultEnrichers, ENRICHERS } from '@nichedb/enrichers';
import { makeHttp } from './http.js';

/**
 * Enrich the newest un-enriched items: run every enricher that applies to the
 * item and is on by default for its collection, store the answers under each
 * enricher's name, and fill in image, summary and tags where the source gave
 * none. One pass per tick, bounded per enricher so the rate-limited ones
 * (YouTube, GitHub, Semantic Scholar) never starve the cheap ones.
 *
 * An item is stamped enriched even when nothing was found, so a miss costs
 * one attempt and not one attempt per tick forever.
 */
export async function enrichPending({ log = console.log, limit = config.enrich.perRun } = {}) {
  if (!config.enrich.enabled) return { skipped: 'disabled' };
  const items = await q.itemsNeedingEnrichment({ limit });
  if (items.length === 0) return { items: 0 };
  const http = makeHttp({
    userAgent: `niche-db/0.1 (+${config.siteUrl}${config.contactEmail ? `; ${config.contactEmail}` : ''})`,
    log,
  });
  const env = {
    ...config.adapters,
    youtubeKey: config.enrich.youtubeKey,
    s2Key: config.enrich.s2Key,
    contactEmail: config.contactEmail,
  };
  const spent = new Map();
  const throttled = new Set();
  let found = 0;
  for (const item of items) {
    const wanted = new Set(defaultEnrichers(item.collection_slug));
    const enrichment = {};
    let imageUrl = null;
    let summary = null;
    const tags = [];
    let deferred = false;
    for (const e of ENRICHERS) {
      if (!wanted.has(e.name)) continue;
      if (e.needsEnv.some((k) => !env[k])) continue;
      let applies = false;
      try {
        applies = e.appliesTo(item);
      } catch {}
      if (!applies) continue;
      // A throttled enricher would have applied: leave the item for a later run.
      if (throttled.has(e.name)) {
        deferred = true;
        continue;
      }
      if ((spent.get(e.name) ?? 0) >= e.perRun) {
        deferred = true;
        continue;
      }
      spent.set(e.name, (spent.get(e.name) ?? 0) + 1);
      try {
        const out = await e.enrich(item, { env, http, log });
        if (out) {
          const { imageUrl: img, summary: sum, tags: t, ...rest } = out;
          enrichment[e.name] = { ...rest, at: new Date().toISOString() };
          imageUrl ??= img ?? null;
          summary ??= sum ?? null;
          if (Array.isArray(t)) tags.push(...t);
          found++;
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        log(`[enrich] ${e.name} on ${item.id}: ${msg.slice(0, 120)}`);
        if (/429|rate limit/i.test(msg)) throttled.add(e.name);
        if (/429|rate limit|timeout|abort/i.test(msg)) deferred = true;
      }
    }
    // A budget or rate-limit miss leaves the item for the next tick rather than
    // stamping it half done.
    if (deferred && Object.keys(enrichment).length === 0) continue;
    await q.applyEnrichment({ id: item.id, enrichment, imageUrl, summary, tags });
  }
  log(
    `[enrich] ${items.length} item(s), ${found} enrichment(s)${throttled.size ? `, throttled: ${[...throttled].join(', ')}` : ''}`,
  );
  return { items: items.length, found };
}

/** Every enricher, for the feed form, the API and llms.txt. */
export function describeEnrichers() {
  return ENRICHERS.map((e) => ({
    name: e.name,
    title: e.title,
    description: e.description,
    collections: e.collections,
    needsEnv: e.needsEnv,
  }));
}
