import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * OpenWebring hosts: the rings a site runs, served from its own origin at
 * `/.well-known/openwebring.json`, and each ring's members from the
 * `members_url` the host names.
 *
 * This is the first directory reading the spec (logicsrc, docs/openwebring.md).
 * A ring is an ordered, circular list of member sites; what the spec adds is
 * one file the host serves about its rings and a `made_by` declaration on
 * every member: human, ai or both, the member's own word, unverified, absent
 * shown as unstated. This adapter reads the host's file as written and the
 * members as the host lists them; it never fetches a member's own page. The
 * host already checked the member's link and says so in `status` and
 * `checked`, and a directory reports what the host gave it.
 *
 * ORIGIN IS THE PROOF
 *
 * A host descriptor is believed only when fetched from the origin it claims:
 * the URL it was read from must share a host with `site.url`. One that names
 * no `site.url` is believed only at the well-known path on the origin the
 * source was pointed at. A ring's members file is read from wherever the
 * host's descriptor points, since the host vouched for it.
 *
 * ABSENT IS UNSTATED
 *
 * A member with no `made_by` is tagged `made_by:unstated`, never `human`. A
 * ring with no `accepts` accepts all three, and says nothing. A member with
 * no `status` is `pending`, the spec's reading for a member never checked.
 *
 * IDS
 *
 * A ring is `openwebring:ring:<ring url>`; a member is
 * `openwebring:member:<ring url>#<member url>`, so a site in four rings is
 * four rows a page dedupes on `url`, and re-reading updates each in place.
 */
export const WELL_KNOWN = '/.well-known/openwebring.json';

export const MADE_BY = ['human', 'ai', 'both'];
export const STATUSES = ['active', 'inactive', 'pending'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const str = (v) => (v == null || v === '' ? null : String(v).trim());
const lower = (v) => (v == null || v === '' ? null : String(v).trim().toLowerCase());

/** A URL as a member is matched: scheme dropped, host lowercased, no www, no trailing slash. */
export function siteKey(url) {
  try {
    const u = new URL(String(url).trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return String(url ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
}

/** A bare origin becomes the well-known path; anything with a path is read as given. */
export function descriptorUrl(entry) {
  const raw = String(entry).trim();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}${WELL_KNOWN}`;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * True when the host descriptor was served from the origin it describes: the
 * host of `site.url`, or a subdomain either way. One with no `site.url` is
 * believed only at the well-known path.
 */
export function servedByHost(fetchedFrom, descriptor) {
  const a = hostOf(fetchedFrom);
  if (!a) return false;
  const web = descriptor?.site?.url;
  if (!web) {
    try {
      return new URL(fetchedFrom).pathname === WELL_KNOWN;
    } catch {
      return false;
    }
  }
  const b = hostOf(web);
  return Boolean(b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

function when(s) {
  if (!s) return { publishedAt: null, timeKnown: false, precision: 'day' };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return looseDate(String(s).slice(0, 10));
}

const madeByOf = (m) => {
  const v = lower(m?.made_by);
  return v && MADE_BY.includes(v) ? v : null;
};

const statusOf = (m) => {
  const v = lower(m?.status);
  return v && STATUSES.includes(v) ? v : 'pending';
};

function attribution(hostName, host) {
  return `${hostName} (${host}), from its own OpenWebring descriptor`;
}

/** The rings a host descriptor lists, each with what the host said about it. */
export function ringsOf(descriptor) {
  const hosts = Array.isArray(descriptor?.hosts) ? descriptor.hosts : [];
  return hosts.filter((r) => r && typeof r === 'object' && (str(r.url) || str(r.slug)));
}

/** One row per ring, from the host descriptor alone (member counts as the host stated them). */
export function ringItem(descriptor, ring, fetchedFrom, extra = {}) {
  const host = hostOf(fetchedFrom);
  const hostName = str(descriptor?.site?.name) ?? host;
  const url =
    str(ring.url) ?? (str(ring.slug) ? `${new URL(fetchedFrom).origin}/ring/${ring.slug}` : null);
  if (!url) return null;
  const slug = str(ring.slug) ?? url.split('/').filter(Boolean).pop();
  const name = str(ring.name) ?? slug;
  const accepts = Array.isArray(ring.accepts)
    ? ring.accepts.map(lower).filter((a) => MADE_BY.includes(a))
    : null;
  const members = Number.isFinite(Number(ring.members))
    ? Number(ring.members)
    : (extra.members ?? null);
  const active = extra.active ?? null;
  const counts = [
    members != null ? `${members} member${members === 1 ? '' : 's'}` : null,
    active != null ? `${active} active` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    externalId: `openwebring:ring:${url}`,
    kind: 'ring',
    title: name,
    summary:
      [str(ring.description), counts ? `${counts}.` : null].filter(Boolean).join(' ') ||
      `${name}, a ring on ${host}.`,
    url,
    ...when(ring.updated ?? descriptor?.updated),
    tags: [
      'ring',
      'openwebring',
      `host:${host}`,
      ...(accepts?.length ? accepts.map((a) => `accepts:${a}`) : []),
    ],
    data: {
      openwebring: descriptor?.openwebring ?? null,
      descriptor: fetchedFrom,
      host: { name: hostName, url: str(descriptor?.site?.url) ?? null },
      ring: {
        slug,
        name,
        url,
        description: str(ring.description),
        accepts,
        join: str(ring.join),
        members_url: str(ring.members_url),
        opml: str(ring.opml),
      },
      members,
      active,
      attribution: attribution(hostName, host),
    },
  };
}

/** One row per member, from the ring's own file, as the host listed it. */
export function memberItem(descriptor, ring, member, fetchedFrom, position) {
  const url = str(member?.url);
  if (!url || !/^https?:\/\//.test(url)) return null;
  const host = hostOf(fetchedFrom);
  const hostName = str(descriptor?.site?.name) ?? host;
  const ringUrl = str(ring.url) ?? `${new URL(fetchedFrom).origin}/ring/${ring.slug}`;
  const ringName = str(ring.name) ?? str(ring.slug) ?? ringUrl;
  const madeBy = madeByOf(member);
  const disclosure = lower(member.disclosure);
  const status = statusOf(member);
  const name = str(member.name) ?? hostOf(url) ?? url;
  const said = madeBy
    ? `made by ${madeBy === 'both' ? 'a person and AI both' : madeBy === 'ai' ? 'AI' : 'a person'}`
    : 'who makes it unstated';
  return {
    externalId: `openwebring:member:${ringUrl}#${siteKey(url)}`,
    kind: 'member',
    title: name,
    summary: `${name}, ${status} in the ${ringName} ring on ${host}: ${said}${disclosure ? ` (${disclosure})` : ''}.`,
    url,
    ...when(member.checked ?? member.since ?? ring.updated ?? descriptor?.updated),
    tags: [
      'member',
      'openwebring',
      `host:${host}`,
      `ring:${str(ring.slug) ?? siteKey(ringUrl)}`,
      `status:${status}`,
      `made_by:${madeBy ?? 'unstated'}`,
      disclosure ? `disclosure:${disclosure}` : null,
      str(member.lang) ? `lang:${lower(member.lang)}` : null,
    ].filter(Boolean),
    data: {
      descriptor: fetchedFrom,
      ring: { slug: str(ring.slug), name: ringName, url: ringUrl },
      member,
      site: siteKey(url),
      position: Number.isFinite(position) ? position : null,
      made_by: madeBy,
      disclosure,
      status,
      attribution: attribution(hostName, host),
    },
  };
}

/** A ring's members file as rows, plus what the file said about itself. */
export function parseRingFile(descriptor, ring, file, fetchedFrom) {
  const members = Array.isArray(file?.members) ? file.members : [];
  const items = members
    .map((m, i) => memberItem(descriptor, { ...ring, ...(file?.ring ?? {}) }, m, fetchedFrom, i))
    .filter(Boolean);
  const active = items.filter((i) => i.data.status === 'active').length;
  return { items, members: members.length, active };
}

/** The host descriptor as ring rows, or why it was refused. */
export function parseHost(descriptor, fetchedFrom) {
  if (!servedByHost(fetchedFrom, descriptor)) return { rings: [], rejected: 'origin' };
  const rings = ringsOf(descriptor);
  if (!str(descriptor?.site?.name) && !str(descriptor?.site?.url))
    return { rings: [], rejected: 'site' };
  return { rings, rejected: null };
}

export const openwebring = defineAdapter({
  name: 'openwebring',
  title: 'OpenWebring hosts',
  collection: 'webrings',
  description:
    'The rings a host runs and the sites in them, read from the OpenWebring descriptor it serves at /.well-known/openwebring.json and each ring’s members file: one row per ring and one per member, with the member’s own word on who makes the site (human, ai, both, or unstated) and the status the host last verified. A descriptor counts only when served from the origin it describes; a member’s page is never fetched here, the host did that. Keyless.',
  docs: 'https://logicsrc.com/docs/openwebring',
  kinds: ['ring', 'member'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'urls',
      label: 'Hosts',
      type: 'list',
      help: 'Host origins (read at /.well-known/openwebring.json) or full descriptor URLs.',
      placeholder: 'https://rssamplifier.com',
    },
  ],
  defaults: { urls: [] },
  defaultSources: [
    {
      slug: 'rssamplifier-rings',
      name: 'rssamplifier.com: one ring per topic, and the house ring',
      description:
        'The OpenWebring host rssamplifier.com runs: a ring per well-covered topic seeded from the independent feeds it reads, and a curated ring of the sites Profullstack publishes. Each member carries its own made_by declaration and the status the host last verified.',
      config: { urls: ['https://rssamplifier.com'] },
      enabled: true,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const entries = (
      Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(',')
    )
      .map(descriptorUrl)
      .filter(Boolean)
      .slice(0, 50);
    if (entries.length === 0) {
      log('no hosts configured');
      return { items: [], note: 'no hosts configured' };
    }
    const items = [];
    const failed = [];
    let hosts = 0;
    let ringCount = 0;
    for (const url of entries) {
      if (Date.now() > deadline) break;
      let descriptor;
      try {
        descriptor = await http.json(url, { timeoutMs: 20_000 });
      } catch (err) {
        failed.push(`${hostOf(url) ?? url} (${err.message.slice(0, 40)})`);
        continue;
      }
      const { rings, rejected } = parseHost(descriptor, url);
      if (rejected) {
        failed.push(
          `${hostOf(url)} (${rejected === 'origin' ? 'not served by the host it names' : 'no site'})`,
        );
        continue;
      }
      hosts += 1;
      for (const ring of rings.slice(0, 200)) {
        if (Date.now() > deadline) break;
        let counts = {};
        const membersUrl = str(ring.members_url);
        if (membersUrl) {
          try {
            const file = await http.json(membersUrl, { timeoutMs: 20_000 });
            const parsed = parseRingFile(descriptor, ring, file, url);
            items.push(...parsed.items.slice(0, 500));
            counts = { members: parsed.members, active: parsed.active };
          } catch (err) {
            failed.push(`${ring.slug ?? membersUrl} (${err.message.slice(0, 40)})`);
          }
        } else if (Array.isArray(ring.members)) {
          const parsed = parseRingFile(descriptor, ring, { members: ring.members }, url);
          items.push(...parsed.items.slice(0, 500));
          counts = { members: parsed.members, active: parsed.active };
        }
        const row = ringItem(descriptor, ring, url, counts);
        if (row) {
          items.push(row);
          ringCount += 1;
        }
      }
    }
    log(
      `${hosts} hosts, ${ringCount} rings, ${items.length - ringCount} members${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${hosts} hosts, ${ringCount} rings, ${items.length - ringCount} members${failed.length ? `; ${failed.length} reads failed` : ''}`,
    };
  },
});
