import { createHash } from 'node:crypto';
import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * OpenThreat descriptors: what a security tool found in the open, served from
 * its own origin at `/.well-known/openthreat.json`.
 *
 * This is the first reader of the spec (logicsrc, docs/openthreat.md). The
 * reporter is the author of what it discloses and what it withholds: a
 * finding in a public repository, an attack observed against its own hosts,
 * an indicator, an advisory. This adapter takes the file as written. Nothing
 * is normalised beyond the lower-casing a tag needs, the reporter is
 * attributed on every row, and the reporter's own dates are the row's dates.
 *
 * ORIGIN IS THE PROOF
 *
 * A descriptor is believed only when it was fetched from the origin it
 * claims: the URL it was read from must share a host with `reporter.web`. A
 * descriptor that names no `web` is believed only at the well-known path on
 * the origin the source was pointed at (the spec's first discovery route);
 * anywhere else it is a claim about the reporter by whoever hosts it, and is
 * dropped with a note in the log. A bare origin in the source config is read
 * at the well-known path; a full URL is read as given and held to the same
 * rule.
 *
 * ABSENT IS UNSTATED
 *
 * Only `reporter.name` and `threats[].title` are required. Everything else is
 * kept exactly as given under `data.threat`, and a tag is written only for a
 * value the reporter stated -- with the two readings the spec fixes: no
 * `status` reads as open and no `kind` as a finding, so the "open" and
 * "findings" feeds hold the threats a reporter meant them to. No `severity`
 * is unstated, never low, and no `location` is never invented: a secret is
 * published unlocated on purpose.
 *
 * IDS
 *
 * The reporter row is `openthreat:reporter:<host>`; a threat is
 * `openthreat:<host>:<threat.id>`. Re-reading on the hour updates both in
 * place, which is how a threat goes from open to fixed, blocked or withdrawn
 * without a second row: a `withdrawn` threat is still emitted, with its
 * status tag, so the row it retracts is updated rather than left open. A
 * threat with no `id` gets one derived from its kind, subject, rule and
 * title, as the spec says, so a retitled threat is a new one.
 */
export const WELL_KNOWN = '/.well-known/openthreat.json';

export const KINDS = ['finding', 'attack', 'indicator', 'advisory'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

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
 * True when the descriptor was served from the origin it describes: the host
 * of `reporter.web`, or a subdomain either way. A descriptor with no `web`
 * is believed only at the well-known path.
 */
export function servedByReporter(fetchedFrom, descriptor) {
  const a = hostOf(fetchedFrom);
  if (!a) return false;
  const web = descriptor?.reporter?.web;
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

const lower = (v) => (v == null || v === '' ? null : String(v).trim().toLowerCase());
const str = (v) => (v == null || v === '' ? null : String(v).trim());

/** The stable id, or the one the spec says to derive when the reporter gave none. */
export function threatId(t) {
  const own = str(t?.id);
  if (own) return own;
  const key = [t?.kind ?? '', t?.subject?.name ?? '', t?.rule ?? '', t?.title ?? '']
    .map((s) => String(s).trim().toLowerCase())
    .join('\n');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** One line for a threat whose reporter wrote no `message`: what fired, where. */
export function describeThreat(t) {
  const what = [str(t?.severity), str(t?.rule)].filter(Boolean).join(' ');
  const where = str(t?.subject?.name);
  if (what && where) return `${what} in ${where}`;
  return what || (where ? `in ${where}` : null);
}

function attribution(reporter, host) {
  return `${reporter.name} (${host}), from its own OpenThreat descriptor`;
}

export function reporterItem(descriptor, fetchedFrom) {
  const r = descriptor?.reporter;
  if (!str(r?.name)) return null;
  const host = hostOf(fetchedFrom);
  const origin = (() => {
    try {
      return new URL(fetchedFrom).origin;
    } catch {
      return null;
    }
  })();
  const threats = Array.isArray(descriptor.threats) ? descriptor.threats : [];
  return {
    externalId: `openthreat:reporter:${host}`,
    kind: 'reporter',
    title: str(r.name),
    summary: `${str(r.name)}, as it describes itself in its OpenThreat descriptor: ${threats.length} threat${threats.length === 1 ? '' : 's'} in the open.`,
    url: str(r.web) ?? origin,
    ...when(descriptor.updated),
    tags: ['reporter', 'openthreat', r.tool ? `tool:${lower(r.tool)}` : null].filter(Boolean),
    data: {
      openthreat: descriptor.openthreat ?? null,
      descriptor: fetchedFrom,
      reporter: r,
      threats: threats.length,
      updated: descriptor.updated ?? null,
      attribution: attribution(r, host),
    },
  };
}

export function threatItem(descriptor, t, fetchedFrom) {
  const r = descriptor?.reporter;
  if (!str(r?.name) || !str(t?.title)) return null;
  const host = hostOf(fetchedFrom);
  const kind = lower(t.kind) ?? 'finding';
  const status = lower(t.status) ?? 'open';
  const subjectName = str(t.subject?.name);
  const refs = Array.isArray(t.refs) ? t.refs.filter((u) => typeof u === 'string' && u) : [];
  return {
    externalId: `openthreat:${host}:${threatId(t)}`,
    kind,
    title: str(t.title),
    summary: str(t.message) ?? describeThreat(t),
    url: str(t.subject?.url) ?? refs[0] ?? str(r.web) ?? null,
    ...when(t.last_seen ?? t.first_seen ?? descriptor.updated),
    tags: [
      'openthreat',
      `kind:${kind}`,
      `status:${status}`,
      t.severity ? `severity:${lower(t.severity)}` : null,
      t.rule ? `rule:${lower(t.rule)}` : null,
      t.category ? `category:${lower(t.category)}` : null,
      t.cwe ? `cwe:${lower(t.cwe)}` : null,
      subjectName ? `subject:${subjectName.toLowerCase()}` : null,
      `reporter:${host}`,
    ].filter(Boolean),
    data: {
      reporter: { name: str(r.name), web: str(r.web) ?? null },
      descriptor: fetchedFrom,
      threat: t,
      attribution: attribution(r, host),
    },
  };
}

export function parseDescriptor(descriptor, fetchedFrom) {
  if (!servedByReporter(fetchedFrom, descriptor)) return { items: [], rejected: 'origin' };
  const reporter = reporterItem(descriptor, fetchedFrom);
  if (!reporter) return { items: [], rejected: 'reporter' };
  const threats = (Array.isArray(descriptor.threats) ? descriptor.threats : [])
    .map((t) => threatItem(descriptor, t, fetchedFrom))
    .filter(Boolean);
  return { items: [reporter, ...threats], rejected: null };
}

export const openthreat = defineAdapter({
  name: 'openthreat',
  title: 'OpenThreat descriptors',
  collection: 'threats',
  description:
    'What a security tool found in the open, read from the OpenThreat descriptor it serves at /.well-known/openthreat.json: one reporter row and one row per threat (a finding in a public repository, an attack on the reporter’s own hosts, an indicator, an advisory), in the reporter’s words, attributed to the reporter. A descriptor counts only when it is served from the origin it describes. Never a private scan: the reporter publishes only what was already visible to anyone who looked. Keyless.',
  docs: 'https://logicsrc.com/docs/openthreat',
  kinds: ['reporter', ...KINDS],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'urls',
      label: 'Descriptors',
      type: 'list',
      help: 'Reporter origins (read at /.well-known/openthreat.json) or full descriptor URLs.',
      placeholder: 'https://threatcrush.com',
    },
  ],
  defaults: { urls: [] },
  defaultSources: [
    {
      slug: 'threatcrush-discovery',
      name: 'ThreatCrush: what its GitHub App found in public repositories',
      description:
        'The OpenThreat descriptor threatcrush.com serves: findings its GitHub App made in public repositories, attacks observed against its own hosts, and indicators, as ThreatCrush states them. Secrets are published unlocated; private scans and paying users never appear.',
      config: { urls: ['https://threatcrush.com'] },
      enabled: true,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const entries = (
      Array.isArray(config.urls) ? config.urls : String(config.urls ?? '').split(',')
    )
      .map(descriptorUrl)
      .filter(Boolean)
      .slice(0, 200);
    if (entries.length === 0) {
      log('no descriptors configured');
      return { items: [], note: 'no descriptors configured' };
    }
    const items = [];
    const failed = [];
    let reporters = 0;
    for (const url of entries) {
      if (Date.now() > deadline) break;
      try {
        const doc = await http.json(url, { timeoutMs: 20_000 });
        const { items: got, rejected } = parseDescriptor(doc, url);
        if (rejected) {
          failed.push(
            `${hostOf(url)} (${rejected === 'origin' ? 'not served by the reporter it names' : 'no reporter'})`,
          );
          continue;
        }
        reporters += 1;
        items.push(...got);
      } catch (err) {
        failed.push(`${hostOf(url) ?? url} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${reporters} reporters, ${items.length - reporters} threats${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${reporters} reporters, ${items.length - reporters} threats${failed.length ? `; ${failed.length} descriptors rejected` : ''}`,
    };
  },
});
