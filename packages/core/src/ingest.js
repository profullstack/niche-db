import { ADAPTERS, adapterByName } from '@nichedb/adapters';
import { config } from '@nichedb/config';
import * as profiles from '@nichedb/db/profiles';
import * as q from '@nichedb/db/queries';
import { normaliseItem } from './adapter.js';
import { makeHttp } from './http.js';
import { profileItem } from './profiles.js';
import { retryMinutes } from './retry.js';

const UA = () =>
  `niche-db/0.1 (+${config.siteUrl}${config.contactEmail ? `; ${config.contactEmail}` : ''})`;

/** Deployment secrets adapters may ask for, by the keys their configFields name. */
export function envFor() {
  return {
    tmdbApiKey: config.adapters.tmdbApiKey,
    sportsProxyUrl: config.adapters.sportsProxyUrl,
    livetennisApiKey: config.adapters.livetennisApiKey,
    sportsdbApiKey: config.adapters.sportsdbApiKey,
    thetvdbApiKey: config.adapters.thetvdbApiKey,
    igdbClientId: config.adapters.igdbClientId,
    igdbClientSecret: config.adapters.igdbClientSecret,
    githubToken: config.adapters.githubToken,
    nvdApiKey: config.adapters.nvdApiKey,
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
    bittorrentedSupabaseUrl: config.adapters.bittorrentedSupabaseUrl,
    bittorrentedSupabaseKey: config.adapters.bittorrentedSupabaseKey,
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
export async function runSource(
  sourceId,
  { log = console.log, resolveAdapter = adapterByName } = {},
) {
  const source = await q.getSourceById(sourceId);
  if (!source) return { skipped: 'no such source' };
  if (!source.enabled) return { skipped: 'disabled' };

  // The registry, unless a caller brings its own: a test runs a fake adapter
  // through the real loop without mocking the registry, which is in an import
  // cycle with this package and hangs Bun's loader when mocked.
  const adapter = resolveAdapter(source.adapter);
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

  // An adapter that declares a budget (a walk of a hundred thousand documents,
  // an hour through a dump) gets it; everything else gets the deployment's.
  const deadline = started + (adapter.budgetMs ?? config.ingest.runDeadlineMs);

  try {
    const result = await adapter.pull({
      config: { ...adapter.defaults, ...(storedConfig ?? {}) },
      cursor: cursor ?? {},
      env: envFor(),
      http: makeHttp({ userAgent: UA(), log: l }),
      log: l,
      budget: config.ingest.budget,
      deadline,
      // What this source wrote last time for these ids, so an adapter that
      // keeps a rolling window per item can extend it rather than restate it.
      previous: (externalIds) => q.previousItemData({ sourceId: source.id, externalIds }),
    });

    /*
     * Two shapes come back. A paged API hands over one array and is written in
     * one go. A dump hands over an async iterable of `{ items, cursor }` batches
     * (or `pull` is itself an async generator) and is drained one batch at a
     * time, so a multi-gigabyte file never has more than one batch in memory
     * and the cursor each batch carried is on the source before the next one is
     * read. The iterator's return value is the run's `{ cursor, note,
     * nextInMinutes }`, exactly where the array form puts them.
     */
    const batches = asBatches(result);
    const totals = { seen: 0, added: 0, updated: 0 };
    let outcome = result;

    if (batches) {
      const walk = await drainBatches({ batches, source, adapter, deadline, totals, log: l });
      // `{ items: walk(), note }` may say something up front; the walk's own
      // return value, being later and better informed, wins where both speak.
      outcome = { ...(batches === result ? {} : result), ...walk };
    } else {
      const w = await writeBatch({ source, adapter, items: result?.items ?? [], log: l });
      totals.seen += w.seen;
      totals.added += w.added;
      totals.updated += w.updated;
    }

    const nextRunAt = outcome?.nextInMinutes
      ? new Date(Date.now() + outcome.nextInMinutes * 60_000)
      : null;
    await q.finishRun({
      runId,
      sourceId: source.id,
      status: 'ok',
      seen: totals.seen,
      added: totals.added,
      updated: totals.updated,
      note: outcome?.note ?? null,
      cursor: outcome?.cursor,
      nextRunAt,
    });
    l(
      `seen ${totals.seen}, added ${totals.added}, updated ${totals.updated} in ${Date.now() - started}ms`,
    );
    return { ...totals };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 1000);
    const nextRunAt = await retryAt(source).catch(() => null);
    await q.finishRun({ runId, sourceId: source.id, status: 'error', error: message, nextRunAt });
    l(`failed: ${message}${nextRunAt ? `; retrying at ${nextRunAt.toISOString()}` : ''}`);
    return { error: message };
  }
}

/**
 * When the run that just failed is tried again: see `retryMinutes`. The
 * failures before this one are counted from the runs table, since the run
 * being recorded is not finished yet.
 */
export async function retryAt(source, now = Date.now()) {
  const before = await q.consecutiveErrors(source.id);
  return new Date(now + retryMinutes(before, source.cadence_minutes) * 60_000);
}

/**
 * The async iterable of batches a pull handed back, or null for the array form.
 *
 * Either `{ items: <async iterable> }` or the pull's own return value being one
 * (an `async *pull`). An array is deliberately not one: arrays are sync
 * iterables only, so the check is exact.
 */
function asBatches(result) {
  if (result && typeof result[Symbol.asyncIterator] === 'function') return result;
  const items = result?.items;
  if (items && typeof items[Symbol.asyncIterator] === 'function') return items;
  return null;
}

/**
 * Walk the batches. Manual iteration rather than `for await`, because the
 * generator's return value is the run's outcome and `for await` throws it away.
 *
 * Two safety nets an adapter should not need but a dump makes cheap to have:
 * the cursor from each batch is saved as soon as the batch is written, so the
 * worst a crash costs is one batch re-written (upsertItems is idempotent on
 * `(source_id, external_id)` and skips unchanged content); and a batch that
 * lands past the deadline ends the run, closing the generator so its files and
 * processes are released, and asks for the next run in a minute. An adapter
 * that stops itself at the deadline (which it should) returns its own outcome
 * and never hits the second one.
 */
async function drainBatches({ batches, source, adapter, deadline, totals, log }) {
  const it = batches[Symbol.asyncIterator]();
  let count = 0;
  let lastCursor;
  try {
    for (;;) {
      const { value, done } = await it.next();
      if (done) return value ?? { cursor: lastCursor };
      const w = await writeBatch({ source, adapter, items: value?.items ?? [], log });
      totals.seen += w.seen;
      totals.added += w.added;
      totals.updated += w.updated;
      // A batch may also add to rows this source already wrote (see patchItems).
      if (value?.patches?.length) {
        const p = await q.patchItems({ sourceId: source.id, patches: value.patches });
        totals.seen += value.patches.length;
        totals.updated += p.updated;
      }
      count += 1;
      if (value?.cursor !== undefined) {
        lastCursor = value.cursor;
        await q.saveCursor(source.id, value.cursor);
      }
      if (Date.now() > deadline) {
        log(`out of time after ${count} batch${count === 1 ? '' : 'es'}; resuming in a minute`);
        await it.return?.();
        return { cursor: lastCursor, note: `out of time after ${count} batches`, nextInMinutes: 1 };
      }
    }
  } catch (err) {
    // Let the generator's own cleanup run (a spawned xz, an open file) before
    // the error reaches finishRun. Its cursor stays where the last batch left it.
    await it.return?.().catch(() => {});
    throw err;
  }
}

/**
 * One batch of an adapter's items into the table: normalise, fold duplicates,
 * upsert in slices of 200. The whole of a paged pull is one batch; a dump is
 * many. Returns the counts finishRun records.
 */
async function writeBatch({ source, adapter, items: raw, log }) {
  let pulled = (raw ?? []).map(normaliseItem).filter(Boolean);

  /*
   * People are not rows an adapter can write on its own. A document an
   * adapter fetched or compiled (openprofiles reads the apps' own files,
   * sportarr-persons writes one per athlete from Wikidata) is matched to a
   * profile by its identity
   * keys, stored as one of that profile's sources, and the profile is
   * re-rendered under the owner's overrides; what reaches the collection is
   * one row per person, not one per document. Done here because it needs
   * the database, which an adapter never sees.
   */
  if (Array.isArray(adapter.kinds) && adapter.kinds.includes('openprofile')) {
    pulled = await absorbProfiles({ source, pulled, log });
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
    if (dropped > 0) log(`${dropped} duplicate ${dropped === 1 ? 'story' : 'stories'} dropped`);
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
  return { seen: items.length, added, updated };
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
