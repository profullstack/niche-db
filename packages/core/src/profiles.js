import {
  accounts,
  applyOverrides,
  broadcasts,
  guest,
  identityKeys,
  identityValue,
  kindOf,
  mergeProfiles,
  networkOf,
  parseOpenProfile,
  renderOpenProfile,
  topics,
} from '@profullstack/openprofile';
import { slugify } from './adapter.js';

/**
 * People, as the pure half: what an OpenProfile.md says once parsed, how
 * several of them about one person become one document, and what the row in
 * the `profiles` collection looks like. Nothing here touches the database;
 * `@nichedb/db/profiles` does the storing and calls this for the thinking.
 *
 * The rules are the package's (logicsrc.com/openprofile): a name is never an
 * identity, an account URL is; the owner's overrides win over every source;
 * absence is unstated. Two shows are two `### <show>` groups, never one blur.
 */

/** The parsed view kept in `profiles.data` and on the item: what a reader wants without parsing. */
export function profileView(doc) {
  const identity = {};
  for (const e of doc.identity)
    if (!(e.key.toLowerCase() in identity)) identity[e.key.toLowerCase()] = e.value;
  return {
    name: doc.name,
    kind: kindOf(doc),
    headline: doc.headline,
    identity,
    accounts: accounts(doc).map((a) => ({ ...a, network: networkOf(a.url) })),
    topics: topics(doc),
    broadcasts: broadcasts(doc),
    guest: guest(doc),
    sections: doc.sections.map((s) => s.name),
  };
}

/** The URL slug for a name: `ada-lovelace`. Never empty. */
export function profileSlug(name) {
  return (
    slugify(name)
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'person'
  );
}

/** The part of a page URL after /c/profiles/: `<slug>-<id>`, or the handle once there is one. */
export function profileRef(profile) {
  return profile.handle
    ? profile.handle
    : `${profileSlug(profile.slug || profile.name)}-${profile.id}`;
}

export function profilePath(profile) {
  return `/c/profiles/${profileRef(profile)}`;
}

/**
 * What `/c/profiles/<ref>` was asked for: an id with a cosmetic slug, or a
 * handle. A bare number is an id too. Null for nothing usable.
 */
export function parseRef(ref) {
  const s = String(ref ?? '').trim();
  if (!s || s.length > 120) return null;
  let m = /^(?:(.*)-)?(\d+)$/.exec(s);
  if (m) return { id: Number(m[2]), slug: m[1] ?? '', handle: null };
  m = /^[a-z0-9][a-z0-9-]{1,39}$/i.exec(s);
  if (m) return { id: null, slug: null, handle: s.toLowerCase() };
  return null;
}

/** A handle a person may take: the shape the table enforces, or null. */
export function cleanHandle(raw) {
  const h = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  if (!h) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(h) || /-\d+$/.test(h) || /^\d+$/.test(h)) return null;
  return h;
}

/**
 * Several source documents and the owner's overrides into the document served.
 * Sources are merged oldest first, so the first app that met the person is the
 * primary and later ones fill what it lacked; then the owner wins.
 */
export function assemble(sourceDocs, overrides) {
  const parsed = sourceDocs.map((md) => parseOpenProfile(md));
  const merged = parsed.length ? mergeProfiles(parsed) : parseOpenProfile('');
  const doc = applyOverrides(merged, overrides ?? null);
  if (!doc.name) doc.name = 'Unnamed';
  return doc;
}

/** The rendered document, its view and its keys, from what the row needs to hold. */
export function build({ sourceDocs, overrides }) {
  const doc = assemble(sourceDocs, overrides);
  return {
    doc,
    markdown: renderOpenProfile(doc),
    view: profileView(doc),
    keys: identityKeys(doc),
    name: doc.name,
    kind: kindOf(doc),
    headline: doc.headline,
    avatar: identityValue(doc, 'Avatar'),
    web: identityValue(doc, 'Web'),
  };
}

/** The identity keys of one source document alone, for matching before a merge. */
export function keysOf(markdown) {
  return identityKeys(parseOpenProfile(markdown));
}

/**
 * The item the `profiles` collection carries for a profile: one row per
 * person, keyed `profile:<id>`, so the collection page, feeds, search and
 * `get_item` see people the way they see everything else. The URL is the
 * profile's own page here, not an outbound link, because this row IS the
 * canonical copy of the merge.
 */
export function profileItem(profile, siteUrl, built) {
  const view = built?.view ?? profile.data ?? {};
  const name = built?.name ?? profile.name;
  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  return {
    externalId: `profile:${profile.id}`,
    kind: 'person',
    title: name,
    summary: built?.headline ?? profile.headline ?? null,
    url: `${siteUrl}${profilePath({ ...profile, name })}`,
    imageUrl: built?.avatar ?? view.identity?.avatar ?? null,
    publishedAt: profile.updated_at ?? null,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'person',
      view.kind ? `kind:${view.kind}` : null,
      ...(view.broadcasts?.length ? ['broadcast', 'podcaster'] : []),
      ...(view.guest ? ['guest'] : []),
      ...(view.topics ?? []).slice(0, 12),
      ...sources.map((s) => `from:${s.app}`),
      profile.claimed_at ? 'claimed' : null,
    ].filter(Boolean),
    data: {
      profile_id: Number(profile.id),
      ref: profileRef({ ...profile, name }),
      openprofile: `${siteUrl}${profilePath({ ...profile, name })}/openprofile.md`,
      ...view,
      sources: sources.map((s) => ({ app: s.app, url: s.source_url, page: s.page_url })),
      claimed: Boolean(profile.claimed_at),
    },
  };
}
