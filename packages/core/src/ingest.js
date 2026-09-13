import { ADAPTERS, adapterByName } from '@nichedb/adapters';
import { config } from '@nichedb/config';
import * as profiles from '@nichedb/db/profiles';
import * as q from '@nichedb/db/queries';
import { normaliseItem } from './adapter.js';
import { makeHttp } from './http.js';
import { profileItem } from './profiles.js';

const UA = () =>
  `niche-db/0.1 (+${config.siteUrl}${config.contactEmail ? `; ${config.contactEmail}` : ''})`;

/** Deployment secrets adapters may ask for, by the keys their configFields name. */
export function envFor() {
  return {
    tmdbApiKey: config.adapters.tmdbApiKey,
    sportsProxyUrl: config.adapters.sportsProxyUrl,
    livetennisApiKey: config.adapters.livetennisApiKey,
    sportsdbApiKey: config.adapters.sportsdbApiKey,
    igdbClientId: config.adapters.igdbClientId,
    igdbClientSecret: config.adapters.igdbClientSecret,
    githubToken: config.adapters.githubToken,
    courtlistenerToken: config.adapters.courtlistenerToken,
    alpacaKeyId: config.adapters.alpacaKeyId,
    alpacaSecretKey: config.adapters.alpacaSecretKey,
    alpacaFeed: config.adapters.alpacaFeed,
    coingeckoApiKey: config.adapters.coingeckoApiKey,
    cryptoProxyUrl: config.adapters.cryptoProxyUrl,
    dataGovApiKey: config.adapters.dataGovApiKey,
    blsApiKey: config.adapters.blsApiKey,
    hetznerApiToken: config.adapters.hetznerApiToken,
    digitaloceanToken: config.adapters.digitaloceanToken,
    upcloudUsername: config.adapters.upcloudUsername,
    upcloudPassword: config.adapters.upcloudPassword,
    obscuraMcpUrl: config.adapters.obscuraMcpUrl,
    contactEmail: config.contactEmail,
  };
}

/**
 * Run one source once: ask its adapter what is new, write it, record the run.
 *
 * Bounded by a wall-clock deadline the adapter is handed and by a batch size
 * per write. A failure records the error on the source and leaves the cursor
 * where it was, so the next run resumes rather than skips.
 */
export async function runSource(sourceId, { log = console.log } = {}) {
  const source = await q.getSourceById(sourceId);
  if (!source) return { skipped: 'no such source' };
  if (!source.enabled) return { skipped: 'disabled' };

  const adapter = adapterByName(source.adapter);
  if (!adapter) {
    /*
     * Almost always a deploy in flight rather than a broken source: the new
     * container has seeded a source whose adapter the container still draining
     * does not have, and that one takes the job. `startRun` has already pushed
     * `next_run_at` a full cadence out, so without a short retry here the
     * source does not just fail, it forfeits its slot -- which for a 12-hour
     * drought source or a 24-hour register is most of a day of nothing over a
     * rollout that lasted seconds. Two minutes covers the overlap, and
     * `rescheduleKnownAdapters` on the next boot catches anything already
     * parked further out.
     */
    await q.finishRun({
      runId: await q.startRun(source.id),
      sourceId: source.id,
      status: 'error',
      error: `unknown adapter ${source.adapter}`,
      nextRunAt: new Date(Date.now() + 2 * 60_000),
    });
    return { error: 'unknown adapter' };
  }

  const runId = await q.startRun(source.id);
  const started = Date.now();
  const tag = `[ingest ${source.slug}]`;
  const l = (m) => log(`${tag} ${m}`);
  const storedConfig =
    typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
  const cursor = typeof source.cursor === 'string' ? JSON.parse(source.cursor) : source.cursor;

  try {
    const result = await adapter.pull({
      config: { ...adapter.defaults, ...(storedConfig ?? {}) },
      cursor: cursor ?? {},
      env: envFor(),
      http: makeHttp({ userAgent: UA(), log: l }),
      log: l,
      budget: config.ingest.budget,
      deadline: started + config.ingest.runDeadlineMs,
      // What this source wrote last time for these ids, so an adapter that
      // keeps a rolling window per item can extend it rather than restate it.
      previous: (externalIds) => q.previousItemData({ sourceId: source.id, externalIds }),
    });

    let pulled = (result?.items ?? []).map(normaliseItem).filter(Boolean);

    /*
     * People are not rows an adapter can write on its own. A document the
     * openprofiles adapter fetched is matched to a profile by its identity
     * keys, stored as one of that profile's sources, and the profile is
     * re-rendered under the owner's overrides; what reaches the collection is
     * one row per person, not one per document. Done here because it needs
     * the database, which an adapter never sees.
     */
    if (adapter.name === 'openprofiles') {
      pulled = await absorbProfiles({ source, pulled, log: l });
    }

    /*
     * Drop what another source in this collection already carries.
     *
     * `(source_id, external_id)` cannot see across sources, so without this a
     * collection that aggregates aggregators hands a reader the same story once
     * per source that indexed it -- a BBC piece arriving from the newsroom's own
     * feed, from GDELT and from two directories that both index the BBC.
     *
     * Only for a collection that has opted in (the query checks), and never
     * against this source's own rows, or a source's second run would discard
     * everything its first run wrote. First writer keeps the story, which makes
     * the winner a property of source order rather than of luck -- so seed the
     * source you would rather read from before the ones that echo it.
     */
    const dedupes = await q.collectionDedupesUrls(source.collection_id);
    let items = pulled;

    if (dedupes) {
      const claimed = await q.claimedDedupeKeys({
        collectionId: source.collection_id,
        sourceId: source.id,
        keys: pulled.map((it) => it.dedupeKey),
      });

      /*
       * Two folds, because a story arrives twice in two different ways.
       *
       * Across sources: another source in this collection already carries it.
       * Never against this source's own rows, or a second run would discard
       * everything the first one wrote.
       *
       * Within one pull: one publisher can expose the same article through two
       * feeds, and an adapter that keys an item on (feed, url) has no way to
       * see that -- the keys genuinely differ. Measured on the news collection:
       * aiornot.vote publishes `latest-media` and `photorealistic` carrying the
       * same posts, which is 5 duplicate URLs in 1,195. The batch fold is what
       * the cross-source filter cannot do, because it deliberately ignores this
       * source.
       *
       * First one wins in both, so the winner is a property of order rather
       * than of luck.
       */
      const seen = new Set();
      items = pulled.filter((it) => {
        if (!it.dedupeKey) return true;
        if (claimed.has(it.dedupeKey) || seen.has(it.dedupeKey)) return false;
        seen.add(it.dedupeKey);
        return true;
      });

      const dropped = pulled.length - items.length;
      if (dropped > 0) l(`${dropped} duplicate ${dropped === 1 ? 'story' : 'stories'} dropped`);
    }

    let added = 0;
    let updated = 0;
    for (let i = 0; i < items.length; i += 200) {
      const r = await q.upsertItems({
        collectionId: source.collection_id,
        sourceId: source.id,
        items: items.slice(i, i + 200),
      });
      added += r.added;
      updated += r.updated;
    }

    const nextRunAt = result?.nextInMinutes
      ? new Date(Date.now() + result.nextInMinutes * 60_000)
      : null;
    await q.finishRun({
      runId,
      sourceId: source.id,
      status: 'ok',
      seen: items.length,
      added,
      updated,
      note: result?.note ?? null,
      cursor: result?.cursor,
      nextRunAt,
    });
    l(`seen ${items.length}, added ${added}, updated ${updated} in ${Date.now() - started}ms`);
    return { seen: items.length, added, updated };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 1000);
    await q.finishRun({ runId, sourceId: source.id, status: 'error', error: message });
    l(`failed: ${message}`);
    return { error: message };
  }
}

/** The openprofiles adapter's documents into the profiles tables; back come the people. */
async function absorbProfiles({ source, pulled, log }) {
  const people = new Map();
  let created = 0;
  let merged = 0;
  let failed = 0;
  for (const it of pulled) {
    const d = it.data ?? {};
    if (it.kind !== 'openprofile' || typeof d.doc !== 'string' || !d.source_url) continue;
    try {
      const out = await profiles.absorb({
        app: d.app ?? 'unknown',
        sourceUrl: d.source_url,
        pageUrl: d.page_url ?? null,
        doc: d.doc,
        sourceId: source.id,
        collectionId: source.collection_id,
        siteUrl: config.siteUrl,
      });
      if (out.created) created += 1;
      if (out.merged) merged += 1;
      const item = normaliseItem(profileItem(out.profile, config.siteUrl, out.built));
      if (item) people.set(item.externalId, item);
    } catch (err) {
      failed += 1;
      log(`profile ${d.source_url}: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }
  log(
    `${pulled.length} documents: ${created} new people, ${merged} merged into existing${failed ? `, ${failed} failed` : ''}`,
  );
  return [...people.values()];
}

/** Every adapter, for the add-source page and the API. Nothing secret in here. */
export function describeAdapters() {
  return ADAPTERS.map((a) => ({
    name: a.name,
    title: a.title,
    collection: a.collection,
    description: a.description,
    docs: a.docs ?? null,
    kinds: a.kinds,
    cadenceMinutes: a.cadenceMinutes,
    configFields: a.configFields,
    needsEnv: a.needsEnv ?? [],
  }));
}

export { ADAPTERS, adapterByName };
