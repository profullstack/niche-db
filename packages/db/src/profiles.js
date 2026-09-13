import { normaliseItem } from '@nichedb/core/adapter';
import { build, keysOf, profileItem, profileSlug } from '@nichedb/core/profiles';
import { sql } from './index.js';
import { pgArray, upsertItems } from './queries.js';

/**
 * People: the rows behind /c/profiles. See migration 0018 for the shape.
 *
 * `absorb` is the whole pull path: a document fetched from an app is matched
 * to a profile by its identity keys, stored as a source, and the profile is
 * re-rendered from every source under the owner's overrides. The owner's
 * edits are never touched by a pull; a new source only adds what it knows.
 */

const detail = sql`
  p.*,
  u.email::text as owner_email,
  u.handle::text as owner_handle,
  coalesce(
    (select json_agg(json_build_object(
        'id', s.id, 'app', s.app, 'source_url', s.source_url, 'page_url', s.page_url,
        'fetched_at', s.fetched_at, 'updated_at', s.updated_at)
      order by s.id)
     from profile_sources s where s.profile_id = p.id),
    '[]'::json) as sources
`;

const shape = (row) => {
  if (!row) return null;
  const out = { ...row, id: Number(row.id) };
  out.sources = typeof row.sources === 'string' ? JSON.parse(row.sources) : (row.sources ?? []);
  out.data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {});
  out.overrides =
    typeof row.overrides === 'string' ? JSON.parse(row.overrides) : (row.overrides ?? {});
  return out;
};

export async function getProfile(id) {
  if (!Number.isInteger(Number(id))) return null;
  const [row] = await sql`
    select ${detail} from profiles p left join users u on u.id = p.owner_user_id
    where p.id = ${Number(id)}
  `;
  return shape(row);
}

export async function getProfileByHandle(handle) {
  const [row] = await sql`
    select ${detail} from profiles p left join users u on u.id = p.owner_user_id
    where p.handle = ${String(handle)}
  `;
  return shape(row);
}

/** The profile any of these identity keys belongs to, or null. */
export async function findByKeys(keys) {
  const list = [...new Set((keys ?? []).filter(Boolean))];
  if (list.length === 0) return null;
  const [row] = await sql`
    select profile_id from profile_identities
    where key = any(${pgArray(list)}::text[])
    order by profile_id limit 1
  `;
  return row ? getProfile(row.profile_id) : null;
}

export async function sourceDocs(profileId) {
  return (
    await sql`select doc from profile_sources where profile_id = ${profileId} order by id`
  ).map((r) => r.doc);
}

/**
 * Re-render a profile from its sources and overrides, write the row, its
 * identity keys and its item in the collection. The one place a profile's
 * `doc` is ever written.
 */
export async function rebuild(profileId, { siteUrl, collectionId = null } = {}) {
  const profile = await getProfile(profileId);
  if (!profile) return null;
  const docs = await sourceDocs(profile.id);
  const built = build({ sourceDocs: docs, overrides: profile.overrides });
  const [row] = await sql`
    update profiles set
      name = ${built.name}, slug = ${profileSlug(built.name)}, kind = ${built.kind},
      headline = ${built.headline}, doc = ${built.markdown},
      data = ${JSON.stringify(built.view)}::text::jsonb, updated_at = now()
    where id = ${profile.id}
    returning id
  `;
  // Keys follow the rendered document: an owner who removes an account
  // releases its key; a source that adds one claims it, unless another
  // profile already holds it (then the two are candidates for a merge a human
  // decides, and the key stays where it was).
  await sql`delete from profile_identities where profile_id = ${profile.id}`;
  for (const key of built.keys) {
    await sql`
      insert into profile_identities (profile_id, key) values (${profile.id}, ${key})
      on conflict (key) do nothing
    `;
  }
  const fresh = await getProfile(profile.id);
  const colId = collectionId ?? (await collectionIdFor(fresh));
  if (siteUrl && colId && fresh.source_id) {
    await upsertItems({
      collectionId: colId,
      sourceId: fresh.source_id,
      items: [normalisedProfileItem(fresh, siteUrl, built)],
    });
  }
  return { profile: fresh, built, updated: Boolean(row) };
}

async function collectionIdFor(profile) {
  if (!profile?.source_id) return null;
  const [row] = await sql`select collection_id from sources where id = ${profile.source_id}`;
  return row?.collection_id ?? null;
}

/** The same row `normaliseItem` in the core would build (same hash, so a no-op rebuild costs no write). */
function normalisedProfileItem(profile, siteUrl, built) {
  return normaliseItem(profileItem(profile, siteUrl, built));
}

/**
 * One fetched document into the table: match, store, rebuild.
 *
 * @returns {{ profile: object, created: boolean, merged: boolean }}
 */
export async function absorb({ app, sourceUrl, pageUrl, doc, sourceId, collectionId, siteUrl }) {
  const keys = keysOf(doc);
  const [existingSource] = await sql`
    select profile_id from profile_sources where source_url = ${sourceUrl}
  `;
  let profile = existingSource ? await getProfile(existingSource.profile_id) : null;
  let merged = false;
  if (!profile) {
    profile = await findByKeys(keys);
    merged = Boolean(profile);
  }
  let created = false;
  if (!profile) {
    const built = build({ sourceDocs: [doc], overrides: null });
    const [row] = await sql`
      insert into profiles (slug, name, kind, headline, doc, data, source_id)
      values (${profileSlug(built.name)}, ${built.name}, ${built.kind}, ${built.headline},
              ${built.markdown}, ${JSON.stringify(built.view)}::text::jsonb, ${sourceId ?? null})
      returning id
    `;
    profile = await getProfile(row.id);
    created = true;
  }
  await sql`
    insert into profile_sources (profile_id, app, source_url, page_url, doc, fetched_at, updated_at)
    values (${profile.id}, ${app}, ${sourceUrl}, ${pageUrl ?? null}, ${doc}, now(), now())
    on conflict (source_url) do update set
      profile_id = excluded.profile_id, app = excluded.app, page_url = excluded.page_url,
      doc = excluded.doc, fetched_at = now(),
      updated_at = case when profile_sources.doc is distinct from excluded.doc then now()
                        else profile_sources.updated_at end
  `;
  if (!profile.source_id && sourceId) {
    await sql`update profiles set source_id = ${sourceId} where id = ${profile.id}`;
  }
  const out = await rebuild(profile.id, { siteUrl, collectionId });
  return { profile: out.profile, built: out.built, created, merged };
}

export async function listProfiles({ q = null, since = null, limit = 50, publicOnly = true } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
  const term = q ? `%${String(q).trim()}%` : null;
  const rows = await sql`
    select ${detail} from profiles p left join users u on u.id = p.owner_user_id
    where (${!publicOnly} or p.public)
      and (${term}::text is null or p.name ilike ${term} or p.headline ilike ${term} or p.doc ilike ${term})
      and (${since}::timestamptz is null or p.updated_at > ${since}::timestamptz)
    order by p.updated_at desc, p.id desc
    limit ${cap}
  `;
  return rows.map(shape);
}

export async function countProfiles() {
  const [row] = await sql`select count(*)::int as n from profiles`;
  return row?.n ?? 0;
}

export async function setOverrides(profileId, overrides) {
  await sql`
    update profiles set overrides = ${JSON.stringify(overrides ?? {})}::text::jsonb, updated_at = now()
    where id = ${profileId}
  `;
}

export async function setPublic(profileId, isPublic) {
  await sql`update profiles set public = ${Boolean(isPublic)}, updated_at = now() where id = ${profileId}`;
}

/** Take a handle. Returns false when another profile has it. */
export async function setHandle(profileId, handle) {
  try {
    await sql`update profiles set handle = ${handle}, updated_at = now() where id = ${profileId}`;
    return true;
  } catch (err) {
    if (/unique|duplicate/i.test(String(err?.message))) return false;
    throw err;
  }
}

export async function claim(profileId, { userId, method }) {
  const [row] = await sql`
    update profiles set owner_user_id = ${userId}::uuid, claimed_at = now(), claim_method = ${method},
      updated_at = now()
    where id = ${profileId} and owner_user_id is null
    returning id
  `;
  return Boolean(row);
}

export async function profilesOf(userId) {
  const rows = await sql`
    select ${detail} from profiles p left join users u on u.id = p.owner_user_id
    where p.owner_user_id = ${userId}::uuid order by p.updated_at desc
  `;
  return rows.map(shape);
}

/** The identity keys a profile currently holds, for the claim check. */
export async function keysFor(profileId) {
  return (await sql`select key from profile_identities where profile_id = ${profileId}`).map(
    (r) => r.key,
  );
}

/** The profile an items row stands for, by its external id. */
export function profileIdOfItem(item) {
  const m = /^profile:(\d+)$/.exec(String(item?.external_id ?? ''));
  return m ? Number(m[1]) : null;
}
