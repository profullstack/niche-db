import { sql } from './index.js';
import { matchFixtures } from './matchups.js';

/**
 * Every query the app runs lives here. Routes, workers and MCP tools import from
 * this module and never write SQL themselves.
 */

/**
 * A Postgres array literal. Bun's parameter serialiser stringifies a JS array
 * with Array.prototype.toString, which Postgres rejects, so arrays are passed
 * as literals and cast at the call site: `${pgArray(x)}::text[]`.
 */
export function pgArray(values) {
  const items = (values ?? []).map((v) =>
    v === null || v === undefined ? 'NULL' : `"${String(v).replace(/(["\\])/g, '\\$1')}"`,
  );
  return `{${items.join(',')}}`;
}

/* ---------------------------------------------------------------- accounts -- */

/**
 * Magic-link consumption creates the account if the address is new. The first
 * account ever created is an admin, as is any address the deployment lists.
 */
export async function findOrCreateUser(email, { admin = false } = {}) {
  const [{ n }] = await sql`select count(*)::int as n from users`;
  const role = admin || n === 0 ? 'admin' : 'user';
  const [row] = await sql`
    insert into users ${sql({ email, role })}
    on conflict (email) do update
      set last_seen_at = now(),
          role = case when ${admin} then 'admin' else users.role end
    returning *, email::text as email, handle::text as handle, (xmax = 0) as created
  `;
  return row;
}

export async function getUserById(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const [row] = await sql`
    select *, email::text as email, handle::text as handle from users where id = ${id}::uuid
  `;
  return row ?? null;
}

/** Remember which referral code brought a NEW account here. Never overwrites. */
export async function setReferredBy({ userId, code }) {
  await sql`
    update users set referred_by = ${String(code).toUpperCase()}
    where id = ${userId} and referred_by is null
      and exists (select 1 from referral_codes where code = ${String(code).toUpperCase()})
  `;
}

export async function countUsers() {
  const [{ n }] = await sql`select count(*)::int as n from users`;
  return n;
}

export async function insertLoginToken({ tokenHash, email, expiresAt }) {
  await sql`
    insert into login_tokens ${sql({ token_hash: tokenHash, email, expires_at: expiresAt })}
  `;
}

/** Single-use by construction: the update is the consumption. Returns the ADDRESS. */
export async function consumeLoginToken(tokenHash) {
  const [row] = await sql`
    update login_tokens set consumed_at = now()
    where token_hash = ${tokenHash} and consumed_at is null and expires_at > now()
    returning email::text as email
  `;
  return row?.email ?? null;
}

export async function startSession({ userId, ttlDays, userAgent }) {
  const [row] = await sql`
    insert into sessions ${sql({
      user_id: userId,
      expires_at: new Date(Date.now() + ttlDays * 86_400_000),
      user_agent: userAgent ?? null,
    })}
    returning id
  `;
  return row.id;
}

export async function getSessionUser(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) return null;
  const [row] = await sql`
    select u.*, u.email::text as email, u.handle::text as handle
    from sessions s join users u on u.id = s.user_id
    where s.id = ${sessionId}::uuid and s.expires_at > now()
  `;
  return row ?? null;
}

export async function endSession(sessionId) {
  await sql`delete from sessions where id = ${sessionId}::uuid`;
}

export async function setUserTimezone(userId, timezone) {
  await sql`update users set timezone = ${timezone} where id = ${userId}`;
}

export async function updateProfile({ userId, displayName }) {
  await sql`update users set display_name = ${displayName || null} where id = ${userId}`;
}

/* ---------------------------------------------------------------- passkeys -- */

export async function insertPasskey({ credentialId, userId, publicKey, counter, transports }) {
  await sql`
    insert into passkeys ${sql({
      credential_id: credentialId,
      user_id: userId,
      public_key: publicKey,
      counter,
    })}
  `;
  await sql`
    update passkeys set transports = ${pgArray(transports)}::text[]
    where credential_id = ${credentialId}
  `;
}

export async function getPasskey(credentialId) {
  const [row] = await sql`select * from passkeys where credential_id = ${credentialId}`;
  return row ?? null;
}

export async function listPasskeys(userId) {
  return sql`
    select credential_id, created_at, last_used_at from passkeys
    where user_id = ${userId} order by created_at
  `;
}

export async function touchPasskey(credentialId, counter) {
  await sql`
    update passkeys set counter = ${counter}, last_used_at = now()
    where credential_id = ${credentialId}
  `;
}

export async function deletePasskey({ userId, credentialId }) {
  await sql`delete from passkeys where user_id = ${userId} and credential_id = ${credentialId}`;
}

/* ---------------------------------------------------------------- api keys -- */

export async function insertApiKey({ userId, name, prefix, keyHash }) {
  const [row] = await sql`
    insert into api_keys ${sql({ user_id: userId, name, prefix, key_hash: keyHash })}
    returning id, prefix
  `;
  return row;
}

export async function getApiKeyUser(keyHash) {
  const [row] = await sql`
    update api_keys k set last_used_at = now()
    from users u
    where k.key_hash = ${keyHash} and k.revoked_at is null and u.id = k.user_id
    returning u.*, u.email::text as email, u.handle::text as handle, k.id as api_key_id
  `;
  return row ?? null;
}

export async function listApiKeys(userId) {
  return sql`
    select id, name, prefix, created_at, last_used_at from api_keys
    where user_id = ${userId} and revoked_at is null order by created_at
  `;
}

export async function revokeApiKey({ userId, id }) {
  await sql`
    update api_keys set revoked_at = now() where user_id = ${userId} and id = ${id}
  `;
}

/* -------------------------------------------------------------------- push -- */

export async function savePushSubscription({ userId, endpoint, p256dh, auth }) {
  await sql`
    insert into push_subscriptions ${sql({ user_id: userId, endpoint, p256dh, auth })}
    on conflict (endpoint) do update
      set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
          disabled_at = null
  `;
}

export async function disablePushSubscription(endpoint) {
  await sql`update push_subscriptions set disabled_at = now() where endpoint = ${endpoint}`;
}

export async function deletePushSubscription({ userId, endpoint }) {
  await sql`delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`;
}

export async function pushSubscriptionCount(userId) {
  const [{ n }] = await sql`
    select count(*)::int as n from push_subscriptions
    where user_id = ${userId} and disabled_at is null
  `;
  return n;
}

/* -------------------------------------------------------------- membership -- */

/**
 * The unexpired term that makes somebody Pro.
 *
 * Plan-scoped on purpose. `memberships` now holds Premium terms too, and an
 * unfiltered "do they have a membership" would hand a $30 Premium member the
 * $120 operator tier — the crawl pass, the top API allowance and the rest — on
 * the strength of a row existing. Pass a plan to ask about a different one.
 */
export async function activeMembership(userId, { plan = 'pro' } = {}) {
  if (!userId) return null;
  const [row] = await sql`
    select * from memberships
    where user_id = ${userId} and expires_at > now() and plan = ${plan}
    order by expires_at desc limit 1
  `;
  return row ?? null;
}

export async function membershipTerms(userId, { limit = 20 } = {}) {
  return sql`
    select * from memberships where user_id = ${userId}
    order by started_at desc limit ${limit}
  `;
}

/* ------------------------------------------------------------- collections -- */

export async function listCollections() {
  return sql`
    select c.*,
      (select count(*)::int from sources s where s.collection_id = c.id and s.enabled) as source_count,
      (select count(*)::int from feeds f where f.collection_id = c.id and f.public) as feed_count,
      coalesce((select sum(s.item_count)::int from sources s where s.collection_id = c.id), 0) as item_count
    from collections c
    where c.public
    order by c.id
  `;
}

export async function getCollection(slug) {
  const [row] = await sql`select * from collections where slug = ${slug}`;
  return row ?? null;
}

export async function upsertCollection({ slug, name, description = null, ownerId = null }) {
  const [row] = await sql`
    insert into collections ${sql({ slug, name, description, owner_id: ownerId })}
    on conflict (slug) do update set name = excluded.name,
      description = coalesce(collections.description, excluded.description)
    returning *
  `;
  return row;
}

export async function collectionStats(collectionId) {
  const [row] = await sql`
    select
      (select count(*)::int from sources where collection_id = ${collectionId} and enabled) as sources,
      (select count(*)::int from items where collection_id = ${collectionId}) as items,
      (select count(*)::int from items where collection_id = ${collectionId}
         and first_seen_at > now() - interval '1 day') as items_today,
      (select count(*)::int from feeds where collection_id = ${collectionId} and public) as feeds
  `;
  return row;
}

export async function siteStats() {
  const [row] = await sql`
    select
      (select count(*)::int from collections where public) as collections,
      (select count(*)::int from sources where enabled) as sources,
      (select count(*)::int from items) as items,
      (select count(*)::int from items where first_seen_at > now() - interval '1 day') as items_today,
      (select count(*)::int from feeds where public) as feeds,
      (select count(*)::int from users) as users
  `;
  return row;
}

/* ----------------------------------------------------------------- sources -- */

const sourceColumns = sql`
  s.*, c.slug as collection_slug, c.name as collection_name
`;

export async function listSources({ collectionId = null, ownerId = null, all = true } = {}) {
  return sql`
    select ${sourceColumns}
    from sources s join collections c on c.id = s.collection_id
    where (${collectionId === null} or s.collection_id = ${collectionId})
      and (${ownerId === null} or s.owner_id = ${ownerId}::uuid)
      and (${all} or s.enabled)
    order by c.id, s.id
  `;
}

export async function getSource(slug) {
  const [row] = await sql`
    select ${sourceColumns}
    from sources s join collections c on c.id = s.collection_id
    where s.slug = ${slug}
  `;
  return row ?? null;
}

export async function getSourceById(id) {
  const [row] = await sql`
    select ${sourceColumns}
    from sources s join collections c on c.id = s.collection_id
    where s.id = ${id}
  `;
  return row ?? null;
}

export async function insertSource({
  collectionId,
  adapter,
  slug,
  name,
  description = null,
  config = {},
  cadenceMinutes = 60,
  ownerId = null,
  enabled = true,
}) {
  const [row] = await sql`
    insert into sources (collection_id, adapter, slug, name, description, config,
                         cadence_minutes, owner_id, enabled)
    values (${collectionId}, ${adapter}, ${slug}, ${name}, ${description},
            ${JSON.stringify(config)}::jsonb, ${cadenceMinutes}, ${ownerId}, ${enabled})
    on conflict (slug) do update set
      name = excluded.name,
      description = coalesce(excluded.description, sources.description),
      -- A source seeded off because its key was missing turns on when the key
      -- arrives: it has never run, so nobody chose to stop it. One that has
      -- run keeps whatever it was set to, since that may be a person's choice.
      enabled = case
        when sources.run_count = 0 and sources.last_run_at is null then excluded.enabled
        else sources.enabled
      end,
      updated_at = now()
    returning *, (xmax = 0) as created
  `;
  return row;
}

/** Edit what an operator may edit. Undefined fields are left alone. */
export async function updateSource({ id, name, description, config, cadenceMinutes, enabled }) {
  const [row] = await sql`
    update sources set
      name = coalesce(${name ?? null}, name),
      description = coalesce(${description ?? null}, description),
      config = coalesce(${config === undefined ? null : JSON.stringify(config)}::jsonb, config),
      cadence_minutes = coalesce(${cadenceMinutes ?? null}, cadence_minutes),
      enabled = coalesce(${enabled ?? null}, enabled),
      -- Re-enabling or changing config is a request to run soon.
      next_run_at = case when ${enabled === true || config !== undefined} then now() else next_run_at end,
      updated_at = now()
    where id = ${id}
    returning *
  `;
  return row ?? null;
}

export async function deleteSource(id) {
  await sql`delete from sources where id = ${id}`;
}

/** Ask a source to run at the next tick. */
export async function requestRun(id) {
  await sql`update sources set next_run_at = now(), updated_at = now() where id = ${id}`;
}

/**
 * The sources whose turn it is. Ordered by how overdue, so a starved one is
 * served first after an outage.
 */
export async function dueSources({ limit = 20, force = false } = {}) {
  return sql`
    select id, slug, adapter, next_run_at from sources
    where enabled and (${force} or next_run_at <= now())
    order by next_run_at limit ${limit}
  `;
}

/**
 * Sources that failed on an adapter this build now has, brought forward.
 *
 * A deploy that adds adapters seeds their sources and enqueues their first
 * runs, and the container still draining does not have the adapters yet, so it
 * takes some of those jobs and writes `unknown adapter`. That alone would be
 * harmless -- except `startRun` has already pushed `next_run_at` a full cadence
 * into the future, so the source does not merely fail, it forfeits its whole
 * slot. Measured on the 2026-09-09 deploys: a 5-minute source recovered in
 * minutes, a 12-hour drought source was scheduled to sit idle until 06:50 the
 * next morning, and a 24-hour FDIC source until the evening after that. Three
 * deploys in one afternoon each stranded a fresh batch.
 *
 * So on every boot the new container asks which sources are parked on that
 * error for an adapter it does in fact have, and pulls them forward. It is
 * deliberately narrow: only `unknown adapter`, only adapters now registered,
 * only enabled sources. A source failing for any other reason keeps its
 * schedule, and one naming an adapter that genuinely no longer exists stays
 * parked rather than spinning every tick.
 */
export async function rescheduleKnownAdapters(adapterNames) {
  const names = [...new Set((adapterNames ?? []).map(String))];
  if (names.length === 0) return 0;
  const rows = await sql`
    update sources set next_run_at = now(), updated_at = now()
    where enabled
      and last_error like 'unknown adapter%'
      and next_run_at > now()
      and adapter = any(${pgArray(names)}::text[])
    returning id
  `;
  return rows.length;
}

/**
 * Start a run. Pushes next_run_at forward FIRST so a second scheduler tick
 * during a long run does not enqueue it again; the finish call sets the real
 * next time.
 */
export async function startRun(sourceId) {
  const [run] = await sql`insert into runs (source_id) values (${sourceId}) returning id`;
  await sql`
    update sources set last_run_at = now(),
      next_run_at = now() + make_interval(mins => cadence_minutes),
      run_count = run_count + 1, updated_at = now()
    where id = ${sourceId}
  `;
  return run.id;
}

export async function finishRun({
  runId,
  sourceId,
  status,
  seen = 0,
  added = 0,
  updated = 0,
  error = null,
  note = null,
  cursor,
  nextRunAt,
}) {
  await sql`
    update runs set finished_at = now(), status = ${status}, seen = ${seen}, added = ${added},
      updated = ${updated}, error = ${error}, note = ${note}
    where id = ${runId}
  `;
  await sql`
    update sources set
      last_ok_at = case when ${status === 'ok'} then now() else last_ok_at end,
      last_error = ${status === 'ok' ? null : error},
      cursor = coalesce(${cursor === undefined ? null : JSON.stringify(cursor)}::jsonb, cursor),
      next_run_at = coalesce(${nextRunAt ?? null}, next_run_at),
      item_count = (select count(*)::int from items where source_id = ${sourceId}),
      updated_at = now()
    where id = ${sourceId}
  `;
}

export async function listRuns(sourceId, { limit = 20 } = {}) {
  return sql`
    select * from runs where source_id = ${sourceId} order by started_at desc limit ${limit}
  `;
}

/** Runs that never finished: a container that died mid-fetch. Marked so the UI is honest. */
export async function reapStaleRuns({ minutes = 30 } = {}) {
  const rows = await sql`
    update runs set status = 'error', finished_at = now(), error = 'abandoned (process exited)'
    where status = 'running' and started_at < now() - (${`${minutes} minutes`})::interval
    returning id
  `;
  return rows.length;
}

/* ------------------------------------------------------------------- items -- */

/**
 * Write a batch. One statement: the rows travel as JSON and are unpacked in the
 * database, which sidesteps every array-parameter problem and is one round trip
 * for a few hundred rows. A row whose content hash has not changed is skipped by
 * the WHERE on the update, so a re-fetch of the same page costs no writes.
 *
 * Deduplicated on external_id first: Postgres refuses an upsert whose own batch
 * names the same conflict target twice, and fails the whole statement.
 */
export async function upsertItems({ collectionId, sourceId, items }) {
  const unique = new Map();
  for (const it of items) unique.set(it.externalId, it);
  const rows = [...unique.values()].map((it) => ({
    external_id: it.externalId,
    kind: it.kind ?? 'item',
    title: it.title,
    summary: it.summary ?? null,
    url: it.url ?? null,
    image_url: it.imageUrl ?? null,
    published_at: it.publishedAt ?? null,
    time_known: it.timeKnown ?? true,
    precision: it.precision ?? 'minute',
    tags: it.tags ?? [],
    data: it.data ?? {},
    content_hash: it.contentHash ?? null,
    dedupe_key: it.dedupeKey ?? null,
  }));
  if (rows.length === 0) return { added: 0, updated: 0 };

  const out = await sql`
    insert into items (collection_id, source_id, external_id, kind, title, summary, url,
                       image_url, published_at, time_known, precision, tags, data, content_hash,
                       dedupe_key)
    select ${collectionId}, ${sourceId}, r.external_id, r.kind, r.title, r.summary, r.url,
           r.image_url, r.published_at, coalesce(r.time_known, true),
           coalesce(r.precision, 'minute'), coalesce(r.tags, '{}'), coalesce(r.data, '{}'),
           r.content_hash, r.dedupe_key
    from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) as r(
      external_id text, kind text, title text, summary text, url text, image_url text,
      published_at timestamptz, time_known boolean, precision text, tags text[],
      data jsonb, content_hash text, dedupe_key text)
    on conflict (source_id, external_id) do update set
      kind = excluded.kind, title = excluded.title,
      summary = coalesce(excluded.summary, items.summary),
      url = excluded.url, image_url = coalesce(excluded.image_url, items.image_url),
      published_at = excluded.published_at,
      time_known = excluded.time_known, precision = excluded.precision, tags = excluded.tags,
      data = excluded.data, content_hash = excluded.content_hash,
      dedupe_key = excluded.dedupe_key, updated_at = now()
    where items.content_hash is distinct from excluded.content_hash
    returning (xmax = 0) as inserted
  `;
  let added = 0;
  for (const r of out) if (r.inserted) added++;
  return { added, updated: out.length - added };
}

/**
 * Of these keys, which does another source in this collection already hold?
 *
 * The collection flag is checked inside the query on purpose. A collection that
 * has not opted in matches no rows, so the caller filters nothing and pays one
 * cheap indexed lookup rather than needing to know the flag first -- and a
 * collection cannot half-enable this by having the flag read in one place and
 * not another.
 *
 * `source_id <> $2` is what makes it a CROSS-source question. A source must
 * always be allowed to re-state its own items, or the second run of any source
 * would discard everything it wrote on the first.
 */
/**
 * Does this collection treat a shared URL as a shared story?
 *
 * Asked separately from `claimedDedupeKeys` because an empty result there is
 * ambiguous -- it means either "the flag is off" or "nothing matched" -- and the
 * caller needs to tell those apart to know whether to fold its own batch.
 */
export async function collectionDedupesUrls(collectionId) {
  const [row] = await sql`select dedupe_urls from collections where id = ${collectionId}`;
  return row?.dedupe_urls === true;
}

export async function claimedDedupeKeys({ collectionId, sourceId, keys }) {
  const list = [...new Set((keys ?? []).filter(Boolean))];
  if (list.length === 0) return new Set();
  /*
   * `pgArray(...)::text[]`, like every other `any()` in this file, and here it
   * is not a style choice. Bun's driver serialises a JS array by joining it
   * with commas, so a bare `= any(${list})` reaches Postgres as one string and
   * fails the whole statement with `malformed array literal`, naming the first
   * URL in the batch.
   *
   * That does not fail politely. The error propagates out of the write and
   * takes the source's entire run with it, so ingestion for the collection
   * stops and the only symptom is a complaint about a URL that is perfectly
   * fine. Shipped exactly that way and caught in production, with both new
   * sources reporting `item_count: 0`.
   */
  const rows = await sql`
    select distinct i.dedupe_key
    from items i
    join collections c on c.id = i.collection_id
    where i.collection_id = ${collectionId}
      and c.dedupe_urls
      and i.source_id <> ${sourceId}
      and i.dedupe_key = any(${pgArray(list)}::text[])
  `;
  return new Set(rows.map((r) => r.dedupe_key));
}

/**
 * The `data` this source last wrote for these external ids, keyed by id.
 *
 * Adapters emit whole items, so one that keeps a window of history per item
 * (four hundred daily bars a symbol) must read the window back before it can
 * extend it -- carrying 8k windows in the cursor is out of the question. This
 * is deliberately narrow: this source's own rows, `data` only, nothing that
 * lets an adapter read across sources. Chunked so a batch of ids never becomes
 * one enormous statement, and `pgArray` for the reason `claimedDedupeKeys`
 * explains at length.
 *
 * @returns {Promise<Map<string, object>>} absent ids are simply not in the map
 */
export async function previousItemData({ sourceId, externalIds }) {
  const ids = [...new Set((externalIds ?? []).map((v) => String(v ?? '')).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await sql`
      select external_id, data from items
      where source_id = ${sourceId}
        and external_id = any(${pgArray(ids.slice(i, i + 500))}::text[])
    `;
    for (const r of rows) out.set(r.external_id, r.data ?? {});
  }
  return out;
}

const itemColumns = sql`
  i.*, s.slug as source_slug, s.name as source_name, s.adapter,
  c.slug as collection_slug, c.name as collection_name, c.early_access
`;

export async function getItem(id) {
  const [row] = await sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where i.id = ${id}
  `;
  return row ?? null;
}

/**
 * A page of a collection, the way a site mirroring it asks.
 *
 * Newest first, keyset on id, as it always was -- and now also by tags (all of
 * them must be on the item), by when the thing happens (`from`/`to` on
 * published_at) and by when the row last changed (`since` on updated_at), in
 * either order on any of the three clocks. A site that keeps its own copy of
 * `sports` asks `since=<its last sync>` every minute and gets only what moved;
 * a page of today's fixtures asks `from`/`to` and `sort=published`.
 */
export async function recentItems({
  collectionId = null,
  sourceId = null,
  kind = null,
  tags = [],
  from = null,
  to = null,
  since = null,
  sort = 'id',
  order = 'desc',
  beforeId = null,
  afterId = null,
  limit = 50,
} = {}) {
  const wantedTags = (tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const byPublished = sort === 'published';
  const byUpdated = sort === 'updated';
  const asc = order === 'asc';
  return sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where (${collectionId === null} or i.collection_id = ${collectionId})
      and (${sourceId === null} or i.source_id = ${sourceId})
      and (${kind === null} or i.kind = ${kind})
      and (${wantedTags.length === 0} or i.tags @> ${pgArray(wantedTags)}::text[])
      and (${from === null} or i.published_at >= ${from})
      and (${to === null} or i.published_at < ${to})
      and (${since === null} or i.updated_at >= ${since})
      and (${beforeId === null} or i.id < ${beforeId ?? 0})
      and (${afterId === null} or i.id > ${afterId ?? 0})
    order by
      case when ${byPublished && asc} then i.published_at end asc nulls last,
      case when ${byPublished && !asc} then i.published_at end desc nulls last,
      case when ${byUpdated && asc} then i.updated_at end asc,
      case when ${byUpdated && !asc} then i.updated_at end desc,
      case when ${!byPublished && !byUpdated && asc} then i.id end asc,
      i.id desc
    limit ${Math.min(Math.max(1, limit), 500)}
  `;
}

/**
 * The best items for a name.
 *
 * What a player asks with a file called "Top.Gun.Maverick.2022.1080p.mkv" or a
 * playlist entry called "ESPN2 HD": which title, which channel, which fixture
 * is this? Trigram similarity on the title, which the GIN index answers
 * quickly; the caller cleans the name first (year, quality tags, dots) so what
 * arrives here is the thing's name and, when known, its year and kind to
 * narrow by. Each row carries `score` in 0..1.
 *
 * A matchup ("Chiefs vs Bills") arrives with `teams`, and is answered by the
 * fixture whose two teams they are (see matchups.js), in the window `date`
 * names or the default one. When no fixture answers and the caller did not
 * insist on a fixture, the plain match runs on `fallback` (the name as a
 * channel), so a channel called "Discovery - Science" still matches.
 */
export async function matchItems(
  term,
  {
    collectionId = null,
    kind = null,
    tags = [],
    year = null,
    limit = 5,
    minScore = 0.3,
    teams = null,
    league = null,
    date = null,
    fallback = null,
    now = new Date(),
  } = {},
) {
  let t = String(term ?? '').trim();
  if (!t) return [];
  if (teams?.length === 2 && (kind === null || kind === 'fixture')) {
    const fixtures = await matchFixtures(teams, { league, collectionId, date, now, limit });
    if (fixtures.length || kind === 'fixture') return fixtures;
    t = String(fallback ?? '').trim() || t;
  }
  const wantedTags = (tags ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return sql`
    select ${itemColumns},
      similarity(i.title, ${t}) as score
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where (${collectionId === null} or i.collection_id = ${collectionId})
      and (${kind === null} or i.kind = ${kind})
      and (${wantedTags.length === 0} or i.tags @> ${pgArray(wantedTags)}::text[])
      and (${year === null} or (i.data->>'year')::int between ${(year ?? 0) - 1} and ${(year ?? 0) + 1})
      and (i.title % ${t} or i.title ilike ${`%${t}%`})
    order by
      (case when lower(i.title) = lower(${t}) then 1 else 0 end) desc,
      (case when ${year !== null} and (i.data->>'year')::int = ${year ?? 0} then 1 else 0 end) desc,
      score desc,
      i.id desc
    limit ${Math.min(Math.max(1, limit), 50)}
  `.then((rows) =>
    rows.filter(
      (r) => Number(r.score) >= minScore || String(r.title).toLowerCase().includes(t.toLowerCase()),
    ),
  );
}

/** What is coming: items dated in the future, soonest first. */
export async function upcomingItems({ collectionId = null, days = 30, limit = 100 } = {}) {
  return sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where (${collectionId === null} or i.collection_id = ${collectionId})
      and i.published_at > now()
      and i.published_at < now() + (${`${days} days`})::interval
    order by i.published_at asc
    limit ${Math.min(Math.max(1, limit), 500)}
  `;
}

/**
 * Full-text over title, summary and tags, with a trigram fallback so a query for
 * a fragment of a package name still lands.
 */
export async function searchItems(term, { collectionId = null, kind = null, limit = 30 } = {}) {
  const t = String(term ?? '').trim();
  if (!t) return [];
  return sql`
    select ${itemColumns},
      ts_rank(i.search, websearch_to_tsquery('simple', ${t})) as rank
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where (${collectionId === null} or i.collection_id = ${collectionId})
      and (${kind === null} or i.kind = ${kind})
      and (i.search @@ websearch_to_tsquery('simple', ${t}) or i.title ilike ${`%${t}%`})
    order by rank desc, i.id desc
    limit ${Math.min(Math.max(1, limit), 200)}
  `;
}

export async function kindsForCollection(collectionId) {
  return sql`
    select kind, count(*)::int as n from items where collection_id = ${collectionId}
    group by kind order by n desc
  `;
}

export async function topTags(collectionId, { limit = 40 } = {}) {
  return sql`
    select tag, count(*)::int as n
    from items i, unnest(i.tags) as tag
    where i.collection_id = ${collectionId}
    group by tag order by n desc limit ${limit}
  `;
}

/* ------------------------------------------------------------------- feeds -- */

const feedColumns = sql`
  f.*, c.slug as collection_slug, c.name as collection_name
`;

export async function listFeeds({ collectionId = null, ownerId = null, publicOnly = true } = {}) {
  return sql`
    select ${feedColumns}
    from feeds f join collections c on c.id = f.collection_id
    where (${collectionId === null} or f.collection_id = ${collectionId})
      and (${ownerId === null} or f.owner_id = ${ownerId}::uuid)
      and (${!publicOnly} or f.public)
    order by f.follower_count desc, f.id
  `;
}

export async function getFeed(slug) {
  const [row] = await sql`
    select ${feedColumns}
    from feeds f join collections c on c.id = f.collection_id
    where f.slug = ${slug}
  `;
  return row ?? null;
}

export async function getFeedById(id) {
  const [row] = await sql`
    select ${feedColumns}
    from feeds f join collections c on c.id = f.collection_id
    where f.id = ${id}
  `;
  return row ?? null;
}

export async function insertFeed({
  collectionId,
  slug,
  name,
  description = null,
  ownerId = null,
  query = {},
  isPublic = true,
}) {
  const [row] = await sql`
    insert into feeds (collection_id, slug, name, description, owner_id, query, public)
    values (${collectionId}, ${slug}, ${name}, ${description}, ${ownerId},
            ${JSON.stringify(query)}::jsonb, ${isPublic})
    on conflict (slug) do update set
      name = excluded.name,
      description = coalesce(excluded.description, feeds.description),
      updated_at = now()
    returning *, (xmax = 0) as created
  `;
  return row;
}

export async function updateFeed({ id, name, description, query, isPublic }) {
  const [row] = await sql`
    update feeds set
      name = coalesce(${name ?? null}, name),
      description = coalesce(${description ?? null}, description),
      query = coalesce(${query === undefined ? null : JSON.stringify(query)}::jsonb, query),
      public = coalesce(${isPublic ?? null}, public),
      updated_at = now()
    where id = ${id}
    returning *
  `;
  return row ?? null;
}

export async function deleteFeed(id) {
  await sql`delete from feeds where id = ${id}`;
}

export async function countUserFeeds(userId) {
  const [{ n }] = await sql`select count(*)::int as n from feeds where owner_id = ${userId}`;
  return n;
}

/** Normalise a stored feed query into the shape feedItems reads. */
export function feedQuery(feed) {
  const raw = feed?.query ?? {};
  const q = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const arr = (v) =>
    (Array.isArray(v) ? v : String(v ?? '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean);
  return {
    sources: arr(q.sources),
    kinds: arr(q.kinds),
    tags: arr(q.tags),
    q: String(q.q ?? '').trim(),
    upcoming: Boolean(q.upcoming),
    enrichers: Array.isArray(q.enrichers) ? q.enrichers : null,
  };
}

/**
 * The items a feed selects. One statement with every predicate optional, so a
 * feed is "the whole collection" until it says otherwise.
 *
 * `afterId` is the delivery scanner's cursor (ascending); `beforeId` is the
 * page's (descending). Upcoming feeds order by date rather than arrival.
 */
export async function feedItems(feed, { afterId = null, beforeId = null, limit = 50 } = {}) {
  const fq = feedQuery(feed);
  return sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where i.collection_id = ${feed.collection_id}
      and (${fq.sources.length === 0} or s.slug = any(${pgArray(fq.sources)}::text[]))
      and (${fq.kinds.length === 0} or i.kind = any(${pgArray(fq.kinds)}::text[]))
      and (${fq.tags.length === 0} or i.tags && ${pgArray(fq.tags)}::text[])
      and (${fq.q === ''} or i.search @@ websearch_to_tsquery('simple', ${fq.q})
           or i.title ilike ${`%${fq.q}%`})
      and (${!fq.upcoming} or i.published_at > now())
      and (${afterId === null} or i.id > ${afterId ?? 0})
      and (${beforeId === null} or i.id < ${beforeId ?? 0})
    order by
      case when ${fq.upcoming} then i.published_at end asc,
      case when ${afterId !== null} then i.id end asc,
      i.id desc
    limit ${Math.min(Math.max(1, limit), 500)}
  `;
}

export async function followFeed({
  userId,
  feedId,
  channels,
  webhookUrl = null,
  webhookSecret = null,
}) {
  const chans = channels?.length ? channels : ['webpush', 'email'];
  await sql`
    insert into follows (user_id, feed_id, channels, webhook_url, webhook_secret)
    values (${userId}, ${feedId}, ${pgArray(chans)}::text[], ${webhookUrl}, ${webhookSecret})
    on conflict (user_id, feed_id) do update set
      channels = excluded.channels,
      webhook_url = coalesce(excluded.webhook_url, follows.webhook_url),
      webhook_secret = coalesce(excluded.webhook_secret, follows.webhook_secret)
  `;
  await sql`
    update feeds set follower_count = (select count(*)::int from follows where feed_id = ${feedId})
    where id = ${feedId}
  `;
}

export async function getFollow({ userId, feedId }) {
  const [row] = await sql`
    select * from follows where user_id = ${userId} and feed_id = ${feedId}
  `;
  return row ?? null;
}

export async function unfollowFeed({ userId, feedId }) {
  await sql`delete from follows where user_id = ${userId} and feed_id = ${feedId}`;
  await sql`
    update feeds set follower_count = (select count(*)::int from follows where feed_id = ${feedId})
    where id = ${feedId}
  `;
}

export async function isFollowing({ userId, feedId }) {
  if (!userId) return false;
  const [row] = await sql`
    select 1 from follows where user_id = ${userId} and feed_id = ${feedId}
  `;
  return Boolean(row);
}

export async function listFollows(userId) {
  return sql`
    select ${feedColumns}, fo.channels, fo.created_at as followed_at
    from follows fo join feeds f on f.id = fo.feed_id join collections c on c.id = f.collection_id
    where fo.user_id = ${userId}
    order by fo.created_at desc
  `;
}

/** Latest items across everything a person follows. */
export async function followedItems(userId, { limit = 60 } = {}) {
  const feeds = await listFollows(userId);
  const seen = new Set();
  const out = [];
  for (const feed of feeds) {
    for (const item of await feedItems(feed, { limit: 20 })) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ ...item, feed_slug: feed.slug, feed_name: feed.name });
    }
  }
  return out.sort((a, b) => b.id - a.id).slice(0, limit);
}

/* ------------------------------------------------------------- deliveries -- */

/** Feeds somebody follows, with the cursor the scanner left. */
export async function feedsWithFollowers() {
  return sql`
    select ${feedColumns} from feeds f join collections c on c.id = f.collection_id
    where f.follower_count > 0 order by f.id
  `;
}

export async function setFeedScanCursor(feedId, itemId) {
  await sql`
    update feeds set last_scanned_item_id = greatest(last_scanned_item_id, ${itemId})
    where id = ${feedId}
  `;
}

/** The newest item id, so a brand-new feed starts delivering from now, not from history. */
export async function maxItemId() {
  const [{ id }] = await sql`select coalesce(max(id), 0)::bigint as id from items`;
  return Number(id);
}

/** Who follows a feed, with everything delivery needs. */
export async function followerTargets(feedId) {
  return sql`
    select u.id as user_id, u.email::text as email, u.timezone, fo.channels,
      fo.webhook_url, fo.webhook_secret,
      coalesce((
        select json_agg(json_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
        from push_subscriptions p where p.user_id = u.id and p.disabled_at is null
      ), '[]'::json) as push_subscriptions
    from follows fo join users u on u.id = fo.user_id
    where fo.feed_id = ${feedId}
  `;
}

/**
 * Claim deliveries. The primary key is the idempotency guard: a retried job
 * gets back only the rows it newly won, and sends nothing for the rest.
 */
export async function claimDeliveries(rows) {
  if (rows.length === 0) return [];
  return sql`
    insert into deliveries (feed_id, user_id, item_id, channel)
    select r.feed_id, r.user_id::uuid, r.item_id, r.channel
    from jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb)
      as r(feed_id bigint, user_id text, item_id bigint, channel text)
    on conflict (feed_id, user_id, item_id, channel) do update
      set status = 'sent', sent_at = now()
      where deliveries.status = 'failed'
    returning feed_id, user_id, item_id, channel
  `;
}

export async function markDeliveriesFailed({ feedId, userId, itemIds, channel }) {
  await sql`
    update deliveries set status = 'failed'
    where feed_id = ${feedId} and user_id = ${userId} and channel = ${channel}
      and item_id = any(${pgArray(itemIds)}::bigint[])
  `;
}

/* --------------------------------------------------------------- api usage -- */

/** Count one request in this hour's bucket and return the running total. */
export async function bumpApiUsage(bucket) {
  const [row] = await sql`
    insert into api_usage (bucket, hour, count)
    values (${bucket}, date_trunc('hour', now()), 1)
    on conflict (bucket, hour) do update set count = api_usage.count + 1
    returning count
  `;
  return row.count;
}

/** What a bucket has spent this hour, without the asking counting as a use. */
export async function apiUsage(bucket) {
  const [row] = await sql`
    select count from api_usage
     where bucket = ${bucket} and hour = date_trunc('hour', now())
  `;
  return row?.count ?? 0;
}

export async function pruneApiUsage({ days = 7 } = {}) {
  await sql`delete from api_usage where hour < now() - (${`${days} days`})::interval`;
}

/* ---------------------------------------------------------------- sitemaps -- */

export async function feedSlugs({ limit = 5000 } = {}) {
  return sql`select slug, updated_at from feeds where public order by id limit ${limit}`;
}

export async function itemIdRange() {
  const [row] = await sql`select min(id)::bigint as lo, max(id)::bigint as hi from items`;
  return row;
}

export async function itemsPage({ afterId = 0, limit = 5000 } = {}) {
  return sql`
    select id, updated_at from items where id > ${afterId} order by id limit ${limit}
  `;
}

/* -------------------------------------------------------------- enrichment -- */

/**
 * Newest items nobody has enriched yet, a fair share per collection: one
 * source that lands a thousand rows at once must not starve the others.
 */
export async function itemsNeedingEnrichment({ limit = 50, perCollection = 8 } = {}) {
  return sql`
    select ${itemColumns}
    from (
      select id, row_number() over (partition by collection_id order by id desc) as rn
      from items where enriched_at is null
    ) p
    join items i on i.id = p.id
    join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where p.rn <= ${perCollection}
    order by p.rn, i.id desc
    limit ${limit}
  `;
}

/**
 * Store what the enrichers found. Fills image, summary and tags only where the
 * item had none, so the source's own words always win.
 *
 * Finding something is a change to the row, so updated_at moves with it and a
 * site walking the collection by since= sees the poster arrive. Finding
 * nothing is not, or every miss would look like news to every mirror.
 */
export async function applyEnrichment({
  id,
  enrichment,
  imageUrl = null,
  summary = null,
  tags = [],
}) {
  const found = Object.keys(enrichment ?? {}).length > 0;
  await sql`
    update items set
      enrichment = ${JSON.stringify(enrichment ?? {})}::text::jsonb,
      image_url = coalesce(image_url, ${imageUrl}),
      summary = coalesce(summary, ${summary}),
      tags = (select array(select distinct t from unnest(tags || ${pgArray(tags)}::text[]) as t)),
      enriched_at = now(),
      updated_at = case when ${found} then now() else updated_at end
    where id = ${id}
  `;
}

export async function enrichmentStats() {
  const [row] = await sql`
    select
      (select count(*)::int from items where enriched_at is null) as pending,
      (select count(*)::int from items where enrichment <> '{}'::jsonb) as enriched
  `;
  return row;
}

/* ------------------------------------------------------------- crawl sales -- */

/** One x402 sale. The ref (the payment nonce) is unique, so a replayed receipt is one row. */
export async function recordCrawlSale({
  payer,
  ref,
  days,
  priceCents,
  totalCents,
  currency,
  userAgent,
  expiresAt,
}) {
  const [row] = await sql`
    insert into crawl_sales (payer, ref, days, price_cents, total_cents, currency, user_agent, expires_at)
    values (${payer ?? null}, ${ref ?? null}, ${days ?? 1}, ${priceCents}, ${totalCents},
            ${currency ?? 'USD'}, ${userAgent ?? null}, ${expiresAt ?? null})
    on conflict (ref) do nothing
    returning id
  `;
  return row ?? null;
}

/** What a payer has spent here, ever, in cents. Zero for a stranger. */
export async function crawlSpendByPayer(payer) {
  if (!payer) return 0;
  const [row] = await sql`
    select coalesce(sum(total_cents), 0)::int as spent from crawl_sales where lower(payer) = lower(${payer})
  `;
  return row?.spent ?? 0;
}

/** The sale a pass came from, by the ref inside the pass. */
export async function crawlSaleByRef(ref) {
  if (!ref) return null;
  const [row] = await sql`select * from crawl_sales where ref = ${ref}`;
  return row ?? null;
}

export async function crawlSalesStats() {
  const [row] = await sql`
    select count(*)::int as sales,
           coalesce(sum(total_cents), 0)::int as total_cents,
           count(distinct lower(payer))::int as payers,
           count(*) filter (where created_at > now() - interval '1 day')::int as sales_today
    from crawl_sales
  `;
  return row;
}

/* ------------------------------------------------------------------ sites -- */

/**
 * The one item in a collection whose url is any of these, newest first. An
 * OpenSite record is keyed by its canonical address, and a path on the
 * index stands for that address with or without a scheme or a trailing
 * slash, so the caller lists the forms and this picks whichever exists.
 */
export async function itemByUrls({ collectionId, urls }) {
  const list = [...new Set((urls ?? []).filter(Boolean))];
  if (list.length === 0) return null;
  const [row] = await sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where i.collection_id = ${collectionId}
      and i.url = any(${pgArray(list)}::text[])
    order by i.updated_at desc
    limit 1
  `;
  return row ?? null;
}

/** Every item in a collection on one host, newest first. */
export async function itemsForHost({ collectionId, host, limit = 50 }) {
  const h = String(host ?? '').toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) return [];
  return sql`
    select ${itemColumns}
    from items i join sources s on s.id = i.source_id join collections c on c.id = i.collection_id
    where i.collection_id = ${collectionId}
      and (i.url like ${`https://${h}/%`} or i.url like ${`http://${h}/%`}
           or i.url = ${`https://${h}`} or i.url = ${`http://${h}`})
    order by i.updated_at desc
    limit ${Math.max(1, Math.min(Number(limit) || 50, 200))}
  `;
}
