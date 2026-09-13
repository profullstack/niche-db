import { defineAdapter } from '@nichedb/core/adapter';

/**
 * Sportarr's people, as OpenProfile.md documents for the `profiles` collection.
 *
 * sportarr.net/browse/persons is a list of 111,733 names behind a public API
 * (`/api/public/v1/persons`, 50 a page, no filter that works, no fields beyond
 * the name and a slug: nationality, birth date, photo and position are null on
 * every row we sampled, and the detail endpoint adds nothing). A name alone is
 * not a person a directory can carry, so this source uses the list as a seed
 * and Wikidata as the substance: each name is searched, the first candidate
 * whose description reads like a sportsperson is fetched, and only a human
 * with a sport (or an athlete's occupation) becomes a document. The rest are
 * skipped, which is what keeps the People collection to people who are known.
 *
 * What Wikidata gives is what "enrich with their socials" asked for: Twitter
 * (P2002), Instagram (P2003), Facebook (P2013), YouTube (P2397), the official
 * site (P856), the photo (P18), the sport (P641), the current team (P54), the
 * country (P27) and the birth date (P569), plus the Wikipedia article. The
 * accounts are the identity keys, so an athlete who later serves their own
 * OpenProfile.md with the same Twitter merges into this row rather than
 * duplicating it (the core matches by account URL, never by name).
 *
 * Cost. One search per name; three requests for a name that resolves. The
 * run stops at `lookups` requests and resumes at the same page and index ten
 * minutes later; a whole pass over the list is a week or so at the default,
 * which is fine for a catalogue that changes slowly. Wikidata asks for a
 * descriptive user agent and a gentle rate, so every request carries one and
 * a pause sits between them.
 *
 * Content signals. sportarr.net/robots.txt allows `/` with
 * `Content-Signal: search=yes,ai-train=no,use=reference`; this is reference
 * use. Wikidata is CC0.
 */

export const SPORTARR = 'https://sportarr.net';
export const SPORTARR_API = `${SPORTARR}/api/public/v1/persons`;
export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData';
export const USER_AGENT = 'nichedb (https://nichedb.dev; hello@nichedb.dev)';

/** Requests per run by default: about a hundred names, a third of which resolve. */
export const LOOKUPS = 300;

/** Milliseconds between requests, which Wikidata's etiquette asks for. */
export const PAUSE_MS = 250;

/** Consecutive failures after which a run stops asking, so an outage costs little. */
const FAILURE_STOP = 3;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** A candidate's description, when it reads like somebody who plays or coaches a sport. */
export const SPORT_WORDS =
  /\b(footballer|soccer|player|boxer|fighter|wrestler|martial art|racing driver|race car driver|racer|athlete|golfer|tennis|swimmer|cyclist|skater|gymnast|runner|sprinter|hurdler|jumper|thrower|jockey|rower|climber|surfer|skier|snowboarder|sailor|shooter|archer|fencer|judoka|karateka|taekwondo|weightlifter|bodybuilder|powerlifter|coach|manager|referee|umpire|cricketer|rugby|hockey|basketball|baseball|volleyball|handball|lacrosse|motorcycle|darts|snooker|billiards|bowler|curler|triathlete|marathon|decathlete|pentathlete|equestrian|polo|badminton|table tennis|squash|esports|chess|goalkeeper|quarterback|pitcher|driver|kickboxer|sumo|luger|bobsledder|biathlete|paddler|canoeist|kayaker|diver|water polo|netball|softball|sport)\b/i;

const text = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/** One page of the Sportarr list. */
export function parsePersons(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const persons = [];
  const seen = new Set();
  for (const p of items) {
    const name = text(p?.name);
    const slug = text(p?.slug);
    const shortId = text(p?.shortId);
    if (!name || !slug || seen.has(slug)) continue;
    seen.add(slug);
    persons.push({ name, slug, shortId: shortId ?? slug, id: text(p?.id) });
  }
  return {
    persons,
    page: Number(body?.page) || 1,
    totalPages: Number(body?.totalPages) || 1,
    total: Number(body?.total) || persons.length,
  };
}

export const pageUrl = (page) => `${SPORTARR_API}?page=${encodeURIComponent(String(page))}`;
export const personPage = (p) => `${SPORTARR}/browse/persons/${encodeURIComponent(p.shortId)}`;
export const personApi = (p) => `${SPORTARR_API}/${encodeURIComponent(p.slug)}`;

export const searchUrl = (name) =>
  `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=5&format=json`;
export const entityUrl = (qid) => `${WIKIDATA_ENTITY}/${encodeURIComponent(qid)}.json`;
export const labelsUrl = (qids) =>
  `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(qids.join('|'))}&props=labels&languages=en&format=json`;

/**
 * The search hit to fetch, or null. The label must be the name (Wikidata
 * search also matches aliases and documentaries about the person) and the
 * description must read like a sportsperson; the first such hit wins, which
 * is Wikidata's own relevance order.
 */
export function pickCandidate(searchBody, name) {
  const hits = Array.isArray(searchBody?.search) ? searchBody.search : [];
  const wanted = name.trim().toLowerCase();
  for (const h of hits) {
    const label = text(h?.label)?.toLowerCase();
    const desc = text(h?.description) ?? '';
    if (label !== wanted) continue;
    if (!SPORT_WORDS.test(desc)) continue;
    return { qid: h.id, description: desc };
  }
  return null;
}

const claimValues = (claims, prop) => {
  const out = [];
  for (const c of claims?.[prop] ?? []) {
    if (c?.rank === 'deprecated') continue;
    const v = c?.mainsnak?.datavalue?.value;
    if (v === undefined || v === null) continue;
    out.push(v);
  }
  return out;
};
const ids = (claims, prop) =>
  claimValues(claims, prop)
    .map((v) => v?.id)
    .filter(Boolean);
const strings = (claims, prop) =>
  claimValues(claims, prop)
    .map((v) => text(v))
    .filter(Boolean);

/** Wikidata's `+1988-07-14T00:00:00Z` at day precision -> `1988-07-14`; coarser -> the year. */
export function wikidataDate(v) {
  const t = text(v?.time);
  if (!t) return null;
  const m = t.match(/^\+?(-?\d{1,4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const precision = Number(v?.precision ?? 11);
  if (precision >= 11) return `${m[1].padStart(4, '0')}-${m[2]}-${m[3]}`;
  if (precision === 10) return `${m[1].padStart(4, '0')}-${m[2]}`;
  return m[1].padStart(4, '0');
}

/** What we keep of an entity: a human, ideally with a sport. Null when it is not a person. */
export function readEntity(body, qid) {
  const e = body?.entities?.[qid];
  if (!e) return null;
  const claims = e.claims ?? {};
  if (!ids(claims, 'P31').includes('Q5')) return null;
  return {
    qid,
    label: text(e.labels?.en?.value),
    description: text(e.descriptions?.en?.value),
    sports: ids(claims, 'P641'),
    occupations: ids(claims, 'P106'),
    countries: ids(claims, 'P27'),
    teams: ids(claims, 'P54'),
    born: wikidataDate(claimValues(claims, 'P569')[0]),
    twitter: strings(claims, 'P2002')[0] ?? null,
    instagram: strings(claims, 'P2003')[0] ?? null,
    facebook: strings(claims, 'P2013')[0] ?? null,
    youtube: strings(claims, 'P2397')[0] ?? null,
    website: strings(claims, 'P856')[0] ?? null,
    image: strings(claims, 'P18')[0] ?? null,
    wikipedia: text(e.sitelinks?.enwiki?.title),
  };
}

/** The label ids worth a name: every sport, the newest team, the countries. */
export const labelIds = (ent) => [
  ...new Set([...ent.sports, ...ent.teams.slice(-1), ...ent.countries]),
];

export function readLabels(body) {
  const out = new Map();
  for (const [qid, e] of Object.entries(body?.entities ?? {})) {
    const l = text(e?.labels?.en?.value);
    if (l) out.set(qid, l);
  }
  return out;
}

/** Wikimedia Commons serves the file by name; spaces are underscores. */
export const commonsUrl = (file) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=512`;

/**
 * The document. Identity block per the spec (Kind, Handle, Web, Avatar), the
 * headline is Wikidata's description, one line of provenance, then Accounts
 * (the identity keys) and Topics (the sports). No em dashes anywhere.
 */
export function profileDoc(person, ent, labels) {
  const name = ent.label ?? person.name;
  const sports = ent.sports.map((q) => labels.get(q)).filter(Boolean);
  const team = ent.teams.length ? labels.get(ent.teams.at(-1)) : null;
  const country = ent.countries.map((q) => labels.get(q)).filter(Boolean)[0] ?? null;
  const lines = [`# ${name}`, '', '- **Kind**: person', `- **Handle**: ${person.slug}`];
  if (ent.website) lines.push(`- **Web**: ${ent.website}`);
  if (ent.image) lines.push(`- **Avatar**: ${commonsUrl(ent.image)}`);
  lines.push('');
  if (ent.description)
    lines.push(
      ent.description.charAt(0).toUpperCase() +
        ent.description.slice(1) +
        (/[.!?]$/.test(ent.description) ? '' : '.'),
    );
  const facts = [];
  if (ent.born) facts.push(`Born ${ent.born}`);
  if (country) facts.push(`from ${country}`);
  if (team) facts.push(`plays for ${team}`);
  lines.push(
    '',
    `${facts.length ? `${facts.join(', ')}. ` : ''}Compiled by NicheDB from Sportarr (${person.shortId}) and Wikidata (${ent.qid}).`,
  );
  lines.push('', '## Accounts', '', `- ${personPage(person)}`);
  if (ent.twitter) lines.push(`- https://x.com/${ent.twitter}`);
  if (ent.instagram) lines.push(`- https://www.instagram.com/${ent.instagram}`);
  if (ent.facebook) lines.push(`- https://www.facebook.com/${ent.facebook}`);
  if (ent.youtube) lines.push(`- https://www.youtube.com/channel/${ent.youtube}`);
  if (ent.wikipedia)
    lines.push(
      `- https://en.wikipedia.org/wiki/${encodeURIComponent(ent.wikipedia.replace(/ /g, '_'))}`,
    );
  lines.push(`- https://www.wikidata.org/wiki/${ent.qid}`);
  if (sports.length) {
    lines.push('', '## Topics', '');
    for (const s of sports) lines.push(`- ${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The item the core absorbs: kind `openprofile` with the document under data.doc. */
export function personItem(person, ent, labels, fetchedAt) {
  const doc = profileDoc(person, ent, labels);
  const sports = ent.sports.map((q) => labels.get(q)).filter(Boolean);
  return {
    externalId: personApi(person).slice(0, 500),
    kind: 'openprofile',
    title: ent.label ?? person.name,
    summary: ent.description ?? null,
    url: personPage(person),
    publishedAt: fetchedAt,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'openprofile',
      'from:sportarr',
      ...sports.map((s) => `sport:${s.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    ],
    data: {
      app: 'sportarr',
      listing: SPORTARR_API,
      source_url: personApi(person),
      page_url: personPage(person),
      wikidata: ent.qid,
      updated_at: null,
      fetched_at: fetchedAt,
      doc,
    },
  };
}

/** Where a run starts: the cursor's page and index, else page 1. */
export function resumeAt(prev) {
  const page = Math.floor(Number(prev?.page));
  const index = Math.floor(Number(prev?.index));
  return { page: page >= 1 ? page : 1, index: index >= 0 ? index : 0 };
}

export const sportarrPersons = defineAdapter({
  name: 'sportarr-persons',
  title: 'Sportarr people, via Wikidata',
  collection: 'profiles',
  description:
    'The people Sportarr lists (111,733 names, 50 a page, nothing but the name), each looked up on Wikidata and kept only when Wikidata knows them as a human with a sport: one OpenProfile.md per athlete, coach or fighter with their Twitter, Instagram, Facebook, YouTube, website, photo, sports, team, country and birth date, and the Wikipedia article. The accounts are the identity keys, so a person who later serves their own profile merges rather than duplicates. A run stops at its request cap and resumes at the same page; a pass over the whole list takes about a week.',
  docs: 'https://logicsrc.com/docs/openprofile',
  kinds: ['openprofile'],
  cadenceMinutes: 360,
  configFields: [
    {
      key: 'lookups',
      label: 'Requests per run',
      type: 'number',
      placeholder: String(LOOKUPS),
      help: 'One Wikidata search per name, two more when the name resolves. The walk stops here and picks up ten minutes later.',
    },
    {
      key: 'pauseMs',
      label: 'Pause between requests (ms)',
      type: 'number',
      placeholder: String(PAUSE_MS),
      help: 'Wikidata asks for a gentle rate from scripts; this is the gap between its requests.',
    },
  ],
  defaults: { lookups: LOOKUPS, pauseMs: PAUSE_MS },
  defaultSources: [
    {
      slug: 'sportarr-persons',
      name: 'People: Sportarr athletes, via Wikidata',
      config: { lookups: LOOKUPS, pauseMs: PAUSE_MS },
    },
  ],
  async pull({ config, cursor: prev, http, log, deadline }) {
    const cap = Math.max(1, Math.floor(Number(config?.lookups)) || LOOKUPS);
    const pause =
      config?.pauseMs === 0 ? 0 : Math.max(0, Math.floor(Number(config?.pauseMs))) || PAUSE_MS;
    const stopAt = Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY;
    const started = resumeAt(prev);
    let { page, index } = started;
    let requests = 0;
    let failures = 0;
    let streak = 0;
    let stopped = null;
    let names = 0;
    let totalPages = Number(prev?.totalPages) || null;
    const items = [];
    const fetchedAt = new Date().toISOString();

    const get = async (url) => {
      if (requests > 0) await sleep(pause);
      requests += 1;
      const res = await http.request(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        timeoutMs: 20_000,
      });
      if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
      return res.json();
    };

    walk: for (;;) {
      if (requests >= cap) {
        stopped = 'cap';
        break;
      }
      if (Date.now() > stopAt) {
        stopped = 'deadline';
        break;
      }
      let listing;
      try {
        listing = parsePersons(await get(pageUrl(page)));
        streak = 0;
      } catch (err) {
        failures += 1;
        streak += 1;
        log(`sportarr page ${page} unavailable (${err?.message ?? err})`);
        if (streak >= FAILURE_STOP) {
          stopped = 'errors';
          break;
        }
        continue;
      }
      totalPages = listing.totalPages;
      if (!listing.persons.length && page > totalPages) {
        stopped = 'done';
        break;
      }
      for (; index < listing.persons.length; index++) {
        if (requests >= cap) {
          stopped = 'cap';
          break walk;
        }
        if (Date.now() > stopAt) {
          stopped = 'deadline';
          break walk;
        }
        const person = listing.persons[index];
        names += 1;
        try {
          const candidate = pickCandidate(await get(searchUrl(person.name)), person.name);
          if (!candidate) {
            streak = 0;
            continue;
          }
          const ent = readEntity(await get(entityUrl(candidate.qid)), candidate.qid);
          if (!ent || (!ent.sports.length && !SPORT_WORDS.test(ent.description ?? ''))) {
            streak = 0;
            continue;
          }
          const wanted = labelIds(ent);
          const labels = wanted.length ? readLabels(await get(labelsUrl(wanted))) : new Map();
          items.push(personItem(person, ent, labels, fetchedAt));
          streak = 0;
        } catch (err) {
          failures += 1;
          streak += 1;
          log(`${person.name} (${person.shortId}): ${String(err?.message ?? err).slice(0, 80)}`);
          if (streak >= FAILURE_STOP) {
            stopped = 'errors';
            break walk;
          }
        }
      }
      if (stopped) break;
      if (page >= totalPages) {
        page = totalPages + 1;
        index = 0;
        stopped = 'done';
        break;
      }
      page += 1;
      index = 0;
    }

    if (requests > 0 && failures === requests) {
      throw new Error(
        `sportarr/wikidata: every request failed (${requests} of ${requests}); see the log`,
      );
    }

    const done = stopped === 'done';
    const reason =
      stopped === 'cap'
        ? 'at the request cap'
        : stopped === 'deadline'
          ? 'on the run deadline'
          : stopped === 'errors'
            ? 'after repeated failures'
            : null;
    return {
      items,
      cursor: {
        page: done ? 1 : page,
        index: done ? 0 : index,
        totalPages,
        walkedAt: done ? fetchedAt : (prev?.walkedAt ?? null),
      },
      nextInMinutes: done ? undefined : 10,
      note:
        `${items.length} people from ${names} names in ${requests} requests (page ${started.page} #${started.index} to page ${page} #${index}` +
        `${totalPages ? ` of ${totalPages} pages` : ''})` +
        (failures ? `, ${failures} failed` : '') +
        (done
          ? '; the whole list walked, next run starts over at page 1'
          : `; stopped ${reason}, resuming in 10 min`),
    };
  },
});
