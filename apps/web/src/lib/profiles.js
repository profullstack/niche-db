import { config } from '@nichedb/config';
import { cleanHandle, parseRef, profilePath, profileRef } from '@nichedb/core/profiles';
import * as profiles from '@nichedb/db/profiles';
import * as q from '@nichedb/db/queries';
import { mergeOverrides, overridesFromDocument, parseOpenProfile } from '@profullstack/openprofile';
import { normaliseFeedUrl } from './feed-url.js';
import { userFromOpenAccess } from './openaccess.js';
import { Denied, isAdmin } from './service.js';

/**
 * The operations behind /c/profiles, shared by the page, the API, the MCP
 * tools and (through the API) the CLI: who may act, what a claim proves, and
 * how an edit is stored. The editing model is the package's: the owner's
 * overlay wins over every source, and a pull never touches it.
 */

const site = () => config.siteUrl;

export const pathOf = (p) => profilePath(p);
export const urlOf = (p) => `${site()}${profilePath(p)}`;
export const mdUrlOf = (p) => `${urlOf(p)}/openprofile.md`;

/** The profile a URL segment names, and whether the segment was its canonical form. */
export async function resolveRef(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return { profile: null, canonical: false };
  if (parsed.id !== null) {
    const p = await profiles.getProfile(parsed.id);
    if (p) return { profile: p, canonical: profileRef(p) === String(ref) };
    if (parsed.slug === '') return { profile: null, canonical: false };
  }
  if (parsed.handle) {
    const p = await profiles.getProfileByHandle(parsed.handle);
    return { profile: p, canonical: Boolean(p) && profileRef(p) === String(ref) };
  }
  // `ada-lovelace-12` where 12 is no profile: try it as a handle before giving up.
  const p = await profiles.getProfileByHandle(String(ref).toLowerCase());
  return { profile: p, canonical: Boolean(p) };
}

/**
 * Who is acting: the site's own session or API key first, then an OpenAccess
 * bearer carrying `openprofile:edit`. Null when nobody is.
 */
export async function actor(c) {
  return c.get('user') ?? (await userFromOpenAccess(c));
}

export function canEdit(user, profile) {
  if (!user) return false;
  return isAdmin(user) || (profile.owner_user_id && profile.owner_user_id === user.id);
}

export function requireEditor(user, profile) {
  if (!user)
    throw new Denied(
      'Sign in, send an API key, or an OpenAccess token with openprofile:edit.',
      401,
    );
  if (!canEdit(user, profile)) {
    throw new Denied(
      profile.owner_user_id ? 'This profile belongs to someone else.' : 'Claim this profile first.',
      403,
    );
  }
}

/* --------------------------------------------------------------- claims -- */

const LINKBACK_MS = 6000;
const LINKBACK_BYTES = 256 * 1024;

/** The first bytes of a public page, or '' when it cannot be read. */
export async function readHead(url, { fetcher = fetch } = {}) {
  const safe = normaliseFeedUrl(url);
  if (!safe) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINKBACK_MS);
  try {
    const res = await fetcher(safe, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': `${config.siteName} (+${config.siteUrl})`,
        accept: 'text/html, text/markdown, */*',
      },
    });
    if (!res.ok) return '';
    const reader = res.body?.getReader();
    if (!reader) return '';
    const dec = new TextDecoder();
    let head = '';
    while (head.length < LINKBACK_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      head += dec.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return head;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** Every URL this profile answers at, so a link back to any of them counts. */
export function profileUrls(profile) {
  const out = new Set([urlOf(profile), mdUrlOf(profile)]);
  out.add(`${site()}/c/profiles/${profile.id}`);
  if (profile.slug) out.add(`${site()}/c/profiles/${profile.slug}-${profile.id}`);
  if (profile.handle) out.add(`${site()}/c/profiles/${profile.handle}`);
  return [...out];
}

/** Does this text link back to the profile (a plain link, or rel=openprofile / rel=me to it)? */
export function linksBack(text, profile) {
  const body = String(text ?? '');
  if (!body) return false;
  const targets = profileUrls(profile).map((u) => u.replace(/^https?:\/\//, '').replace(/\/$/, ''));
  return targets.some((t) => body.includes(t));
}

/**
 * What proves a claim, in order: the claimant's email is one of the
 * profile's identity keys; the profile's Web page or any source page links
 * back here; an admin says so. Returns the method, or null.
 */
export async function proveClaim(user, profile, { fetcher = fetch, adminFor = null } = {}) {
  if (isAdmin(user) && adminFor) return 'admin';
  const keys = await profiles.keysFor(profile.id);
  const email = String(user.email ?? '').toLowerCase();
  if (email && keys.includes(`email:${email}`)) return 'email';
  const principalProfile = user.openaccess?.profile ?? null;
  if (principalProfile && profile.sources.some((s) => s.source_url === principalProfile))
    return 'openaccess';
  const pages = [profile.data?.identity?.web, ...profile.sources.map((s) => s.page_url)].filter(
    Boolean,
  );
  for (const page of pages.slice(0, 6)) {
    if (linksBack(await readHead(page, { fetcher }), profile)) return 'linkback';
  }
  return null;
}

export async function claimProfile(user, profile, { email = null, fetcher = fetch } = {}) {
  if (!user)
    throw new Denied(
      'Sign in, send an API key, or an OpenAccess token with openprofile:edit.',
      401,
    );
  if (profile.owner_user_id) {
    if (profile.owner_user_id === user.id) return { method: profile.claim_method, already: true };
    throw new Denied('This profile is already claimed.', 409);
  }
  let owner = user;
  const method = await proveClaim(user, profile, { fetcher, adminFor: email });
  if (method === 'admin') owner = await q.findOrCreateUser(String(email).toLowerCase());
  if (!method) {
    throw new Denied(
      `Nothing proves this profile is yours yet. Either sign in with the email the profile lists, or add a link to ${urlOf(profile)} on your site or your show's page and try again.`,
      403,
    );
  }
  const ok = await profiles.claim(profile.id, { userId: owner.id, method });
  if (!ok) throw new Denied('This profile was claimed a moment ago.', 409);
  await profiles.rebuild(profile.id, { siteUrl: site() });
  return { method, already: false };
}

/* ---------------------------------------------------------------- edits -- */

/**
 * Store an edit. `markdown` is a whole OpenProfile.md the owner wrote (every
 * part of it becomes an override); `patch` is a partial overlay; `handle` and
 * `public` are the row's own fields. Returns the rebuilt profile.
 */
export async function editProfile(user, profile, { markdown, patch, handle, isPublic } = {}) {
  requireEditor(user, profile);
  let overrides = profile.overrides ?? {};
  if (typeof markdown === 'string') {
    if (markdown.length > 64 * 1024) throw new Denied('A profile is at most 64 KB.', 413);
    const generated = parseOpenProfile(profile.doc);
    overrides = mergeOverrides(overrides, overridesFromDocument(markdown, generated, true));
  }
  if (patch && typeof patch === 'object') {
    const clean = {};
    if (patch.name !== undefined)
      clean.name = patch.name === null ? null : String(patch.name).slice(0, 200);
    if (patch.headline !== undefined)
      clean.headline = patch.headline === null ? null : String(patch.headline).slice(0, 500);
    if (patch.prose !== undefined)
      clean.prose = patch.prose === null ? null : String(patch.prose).slice(0, 8000);
    if (patch.identity && typeof patch.identity === 'object') {
      clean.identity = {};
      for (const [k, v] of Object.entries(patch.identity).slice(0, 40)) {
        const key = String(k).trim().slice(0, 40);
        if (key) clean.identity[key] = v === null || v === '' ? null : String(v).slice(0, 500);
      }
    }
    if (patch.sections && typeof patch.sections === 'object') {
      clean.sections = {};
      for (const [k, v] of Object.entries(patch.sections).slice(0, 40)) {
        const key = String(k).trim().slice(0, 40);
        if (key) clean.sections[key] = String(v ?? '').slice(0, 16000);
      }
    }
    overrides = mergeOverrides(overrides, clean);
  }
  await profiles.setOverrides(profile.id, overrides);
  if (handle !== undefined) {
    const h = handle === null || handle === '' ? null : cleanHandle(handle);
    if (handle && !h)
      throw new Denied(
        'A handle is 2 to 40 lowercase letters, digits and dashes, and does not end in a number.',
        400,
      );
    if (h !== profile.handle && !(await profiles.setHandle(profile.id, h)))
      throw new Denied(`The handle ${h} is taken.`, 409);
  }
  if (isPublic !== undefined) await profiles.setPublic(profile.id, isPublic);
  const out = await profiles.rebuild(profile.id, { siteUrl: site() });
  return out.profile;
}

/* -------------------------------------------------------------- shapes -- */

export function profileOut(p) {
  return {
    id: Number(p.id),
    ref: profileRef(p),
    handle: p.handle ?? null,
    name: p.name,
    kind: p.kind ?? null,
    headline: p.headline ?? null,
    public: p.public,
    claimed: Boolean(p.claimed_at),
    claim_method: p.claim_method ?? null,
    owner: p.owner_handle ?? null,
    identity: p.data?.identity ?? {},
    accounts: p.data?.accounts ?? [],
    topics: p.data?.topics ?? [],
    broadcasts: p.data?.broadcasts ?? [],
    guest: p.data?.guest ?? null,
    sources: (p.sources ?? []).map((s) => ({
      app: s.app,
      url: s.source_url,
      page: s.page_url,
      fetched_at: s.fetched_at,
    })),
    page: urlOf(p),
    openprofile: mdUrlOf(p),
    updated_at: p.updated_at,
    created_at: p.created_at,
  };
}
