import {
  accounts,
  applyOverrides,
  broadcasts,
  emoji,
  guest,
  identityKeys,
  identityMap,
  identityValue,
  kindOf,
  mergeProfiles,
  networkOf,
  normaliseUrl,
  parseOpenProfile,
  pronouns,
  renderOpenProfile,
  topics,
  web,
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

/**
 * The three identity fields OpenProfile 0.4 makes defaults, read the way the
 * spec says: `Emoji` is the person's mark (one grapheme, or an OpenEmoji
 * `:shortcode:` kept as written while there is no resolver here), `Pronouns`
 * as written and null when unstated (never inferred), `Web` through its
 * aliases (`Website`, `Homepage`, `Site`). Takes a parsed document or the
 * Markdown itself, which is canonical.
 */
export function identityFields(docOrMarkdown) {
  const doc =
    typeof docOrMarkdown === 'string' || docOrMarkdown == null
      ? parseOpenProfile(String(docOrMarkdown ?? ''))
      : docOrMarkdown;
  return { emoji: emoji(doc), pronouns: pronouns(doc), web: web(doc) };
}

/* ------------------------------------------------------- professional -- */

/**
 * The identity keys a job title and an employer are written under, in the
 * order they are believed. OpenProfile keeps an unknown key as written, so
 * `Title:` and `Company:` already survive every parse, merge and render; this
 * only reads them. Matched case-insensitively (the package lowercases keys).
 * Neither is an identity key: a company's URL here never fuses two people.
 */
export const TITLE_KEYS = ['title', 'job title', 'role', 'position'];
export const COMPANY_KEYS = ['company', 'employer'];

/** The levels `seniority` answers, most senior first. */
export const SENIORITY_LEVELS = ['c-suite', 'vp', 'director', 'manager', 'senior', 'entry'];

const SENIORITY_RULES = [
  [
    'c-suite',
    // A product owner owns a backlog, not the company.
    /\b(?:co-?founder|founder|founding partner|(?<!(?:product|process|project) )owner|chief|c[a-z]o|ciso|chro|caio|president|chair(?:man|woman|person)?|managing partner|general partner)\b/,
  ],
  ['vp', /\b(?:vp|[saeg]vp)\b/],
  ['director', /\b(?:director|head)\b/],
  ['manager', /\b(?:manager|mgr|supervisor)\b/],
  ['senior', /\b(?:senior|sr|staff|principal|lead)\b/],
  ['entry', /\b(?:intern|internship|junior|jr|trainee|apprentice|graduate|entry level)\b/],
];

/**
 * A job title's level by keyword, or null when the title says nothing about
 * one ("Software Engineer" is unstated, not entry). Simple on purpose: the
 * first rule that matches wins, most senior first, so "Co-founder & CTO" is
 * c-suite and "VP, Engineering" is vp. "Vice president" is read as vp before
 * "president" can claim it.
 */
export function seniorityOf(title) {
  const t = String(title ?? '')
    .toLowerCase()
    .replace(/[_./,&|+()]+/g, ' ')
    .replace(/\bvice[\s-]+president\b/g, 'vp')
    .replace(/\bentry[\s-]+level\b/g, 'entry level')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  for (const [level, re] of SENIORITY_RULES) if (re.test(t)) return level;
  return null;
}

/** A title as a tag value: `Co-Founder & CEO` is `co-founder-ceo`. Null for nothing. */
export function titleKey(title) {
  const k = slugify(title)
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return k || null;
}

const DOMAIN_IN_TEXT = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)\]]*)?/i;

/**
 * The company's own domain from a URL or a bare domain, never a social
 * network's: `https://www.linkedin.com/company/acme` names a page about the
 * company, not where it lives, so it is no domain. An email is no domain.
 */
export function companyDomain(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /@/.test(s)) return null;
  const m = DOMAIN_IN_TEXT.exec(s);
  if (!m) return null;
  const key = normaliseUrl(/^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`);
  const host = key.split(/[/?]/)[0];
  if (!host || !/\./.test(host) || networkOf(`https://${host}`)) return null;
  if (/(^|\.)(wikidata|wikipedia|ycombinator)\.(org|com)$/.test(host)) return null;
  return host;
}

/**
 * `Company:` as written into a name and a domain. Reads `Acme`, `acme.com`,
 * `https://acme.com`, `Acme (https://acme.com)` and `[Acme](https://acme.com)`.
 */
export function parseCompany(raw) {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(s);
  if (link) {
    const name = link[1].trim() || null;
    const domain = companyDomain(link[2]);
    return name || domain ? { name, domain } : null;
  }
  // An address is never kept, not even as a name.
  const plain = s.replace(/\S+@\S+/g, ' ');
  const m = DOMAIN_IN_TEXT.exec(plain);
  const domain = m ? companyDomain(m[0]) : null;
  const name =
    (m ? plain.replace(m[0], ' ') : plain)
      .replace(/\(\s*\)|\[\s*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
      .trim() || null;
  return name || domain ? { name: name ? name.slice(0, 200) : null, domain } : null;
}

/** The tag value for a company: its domain when known, else a slug of its name. */
export function companyKey(company) {
  if (!company) return null;
  if (company.domain) return company.domain;
  const k = slugify(company.name ?? '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return k || null;
}

const firstOf = (doc, keys) => {
  for (const k of keys) {
    const v = identityValue(doc, k)?.replace(/\s+/g, ' ').trim();
    if (v) return v;
  }
  return null;
};

/**
 * Job title, employer and the seniority the title implies, from what the
 * person (or a public page about them that an adapter already reads)
 * published: `Title:`/`Role:` and `Company:` identity lines. A title written
 * `CEO at Acme` with no `Company:` line names both. Nothing is guessed from
 * the headline. Takes a parsed document or the Markdown.
 */
export function professionalFields(docOrMarkdown) {
  const doc =
    typeof docOrMarkdown === 'string' || docOrMarkdown == null
      ? parseOpenProfile(String(docOrMarkdown ?? ''))
      : docOrMarkdown;
  let title = firstOf(doc, TITLE_KEYS);
  let company = parseCompany(firstOf(doc, COMPANY_KEYS));
  if (title) {
    const at = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(title);
    if (at) {
      title = at[1].trim();
      company ??= parseCompany(at[2]);
    }
    title = title.slice(0, 200);
  }
  return { title: title || null, company: company ?? null, seniority: seniorityOf(title) };
}

/** The facet tags for those fields: `title:<key>`, `company:<domain|slug>`, `seniority:<level>`. */
export function professionalTags(fields) {
  const f = fields ?? {};
  const t = titleKey(f.title);
  const c = companyKey(f.company);
  return [
    t ? `title:${t}` : null,
    c ? `company:${c}` : null,
    f.seniority ? `seniority:${f.seniority}` : null,
  ].filter(Boolean);
}

/**
 * A search's professional filters as the facet tags `listProfiles` matches:
 * `title` and `company` normalised the way the tags are written (a URL or a
 * domain becomes the domain), `seniority` one of the known levels, and
 * `tags` (comma list or array) passed through lowercased.
 */
export function facetFilter({ title, company, seniority, tags } = {}) {
  const out = [];
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  for (const t of list) {
    const v = String(t ?? '')
      .trim()
      .toLowerCase();
    if (v) out.push(v);
  }
  if (title) {
    const t = titleKey(title);
    if (t) out.push(`title:${t}`);
  }
  if (company) {
    const c = companyKey(parseCompany(company));
    if (c) out.push(`company:${c}`);
  }
  if (seniority) {
    const s = String(seniority).trim().toLowerCase();
    if (!SENIORITY_LEVELS.includes(s))
      throw new RangeError(`seniority is one of ${SENIORITY_LEVELS.join(', ')}`);
    out.push(`seniority:${s}`);
  }
  return [...new Set(out)].slice(0, 10);
}

/**
 * A LinkedIn profile or company page as the identity key it is stored under
 * (`linkedin.com/in/ada`), or null for anything that is not one. The only
 * identity a profile may be looked up by from outside: never an email, which
 * would make the directory an oracle for addresses people did not publish.
 */
export function linkedinKey(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 300 || /@/.test(s.split('/')[0])) return null;
  const key = normaliseUrl(/^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`);
  const m = /^(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company|pub)\/([^/?#]+)/.exec(key);
  if (!m) return null;
  return `linkedin.com/${m[1]}/${m[2]}`;
}

/** The parsed view kept in `profiles.data` and on the item: what a reader wants without parsing. */
export function profileView(doc) {
  // Keyed by canonical key, so a document that says `Website` is read as `web`.
  const identity = identityMap(doc);
  const work = professionalFields(doc);
  const facets = professionalTags(work);
  return {
    // Only when stated, so a profile without them keeps the view (and the item hash) it had.
    ...(work.title ? { title: work.title } : {}),
    ...(work.company ? { company: work.company } : {}),
    ...(work.seniority ? { seniority: work.seniority } : {}),
    ...(facets.length ? { facets } : {}),
    name: doc.name,
    kind: kindOf(doc),
    headline: doc.headline,
    ...identityFields(doc),
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
    web: web(doc),
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
      ...(view.facets ?? []),
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
