import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Live aircraft, but only the ones worth a row.
 *
 * There is a version of this adapter that stores every aeroplane in the sky
 * every few minutes. It would be tens of thousands of rows a day, each one a
 * position that was true for four seconds, and nobody would ever read one. A
 * position is not news. What is news is an aircraft squawking 7700.
 *
 * So this reads the event surfaces of the ADS-B feed rather than the firehose:
 * the emergency squawks (7700 general emergency, 7600 lost radio, 7500
 * unlawful interference) and the military traffic. When this was written the
 * three emergency codes returned zero aircraft between them and the military
 * query returned 422, which is exactly the shape you want -- the rare thing is
 * rare, so its appearance means something.
 *
 * AN EMERGENCY IS AN EPISODE, NOT A PING
 *
 * The same trick `faa-nas-status` uses, for the same reason. An aircraft
 * squawking 7700 appears in poll after poll and then stops appearing, and
 * nothing records that it stopped. So the open episodes live in the cursor
 * keyed on the ICAO hex, an item is keyed on the time it was first seen, and
 * when the aircraft leaves the feed it is written once more with `endedAt` and
 * a duration. "N123AB squawked 7700 for 22 minutes over Colorado" is the row;
 * the forty positions in between are not.
 *
 * WHOSE DATA THIS IS
 *
 * adsb.lol is a community receiver network, not a government feed, and it is
 * keyless and unmetered. It is the only one of the three I tried that answers:
 * airplanes.live rejects an unrecognised client outright, and OpenSky's
 * anonymous tier works but is rate limited hard enough to be unreliable on a
 * schedule. The aircraft register fields it returns (`r`, `t`, `desc`, `ownOp`)
 * come from public FAA and international registries.
 */

const BASE = 'https://api.adsb.lol/v2';

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/** A number that may be legitimately zero: an aircraft on the ground is at 0 ft. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the transponder code means.
 *
 * These three are reserved worldwide and a pilot sets them deliberately. 7500
 * in particular is never set by accident, and an aircraft showing it is the
 * single most consequential row this adapter can produce.
 */
export const SQUAWKS = {
  7500: { label: 'unlawful interference', tag: 'hijack', severity: 'critical' },
  7600: { label: 'radio failure', tag: 'radio-failure', severity: 'urgent' },
  7700: { label: 'general emergency', tag: 'emergency', severity: 'critical' },
};

/** The watch lists this adapter knows how to read. */
export const WATCHES = {
  emergency: { path: '/sqk/7700', label: 'general emergency' },
  'radio-failure': { path: '/sqk/7600', label: 'radio failure' },
  hijack: { path: '/sqk/7500', label: 'unlawful interference' },
  military: { path: '/mil', label: 'military' },
  ladd: { path: '/ladd', label: 'limited aircraft data display' },
  pia: { path: '/pia', label: 'privacy ICAO address' },
};

/** A flight-level altitude, or "on the ground", which the feed writes as a word. */
export function altitude(v) {
  if (v === 'ground') return { feet: 0, onGround: true };
  const n = num(v);
  return { feet: n, onGround: false };
}

/**
 * One aircraft's episode on a watch list.
 *
 * `firstSeen` is the identity, so the row survives every poll the aircraft is
 * still there for, and the closing write is the same row with an end on it.
 */
export function toItem(ac, { watch, firstSeen, now, ended = false, positions = 1 }) {
  const hex = clean(ac?.hex);
  if (!hex) return null;

  const callsign = clean(ac.flight);
  const registration = clean(ac.r);
  const type = clean(ac.t);
  const description = clean(ac.desc);
  const operator = clean(ac.ownOp);
  const squawk = clean(ac.squawk);
  const code = SQUAWKS[Number(squawk)] ?? null;
  const alt = altitude(ac.alt_baro);
  const lat = num(ac.lat);
  const lon = num(ac.lon);

  const who = callsign ?? registration ?? hex.toUpperCase();
  const what = code ? code.label : (WATCHES[watch]?.label ?? watch);
  const ran = ended ? minutesBetween(firstSeen, now) : null;

  return {
    externalId: `adsb-${watch}-${hex}-${firstSeen}`,
    kind: code ? 'aircraft-emergency' : 'aircraft-sighting',
    title: `${who}${type ? ` (${type})` : ''}: ${what}${ended && ran ? ` — ended after ${ran}` : ''}`,
    summary: [
      `${who}`,
      registration && registration !== who ? `, registered ${registration}` : '',
      description ? `, a ${description}` : type ? `, a ${type}` : '',
      operator ? `, operated by ${operator}` : '',
      code ? `, was squawking ${squawk} (${code.label})` : `, seen on the ${what} list`,
      alt.onGround
        ? ' on the ground'
        : alt.feet !== null
          ? ` at ${alt.feet.toLocaleString()} ft`
          : '',
      lat !== null && lon !== null ? ` near ${lat.toFixed(2)}, ${lon.toFixed(2)}` : '',
      ended
        ? `. Tracked from ${firstSeen} to ${now}${ran ? `, ${ran}` : ''}.`
        : `. First seen ${firstSeen}, still showing at ${now}.`,
    ].join(''),
    url: `https://globe.adsb.lol/?icao=${encodeURIComponent(hex)}`,
    publishedAt: firstSeen,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'aviation',
      'aircraft',
      watch,
      code ? code.tag : null,
      code ? `severity:${code.severity}` : null,
      squawk ? `squawk:${squawk}` : null,
      type ? slugify(type) : null,
      registration ? slugify(registration) : null,
      ended ? 'ended' : 'active',
      alt.onGround ? 'on-ground' : null,
    ].filter(Boolean),
    data: {
      icaoHex: hex,
      callsign,
      registration,
      aircraftType: type,
      aircraftDescription: description,
      operator,
      squawk,
      squawkMeaning: code?.label ?? null,
      watch,
      altitudeFt: alt.feet,
      onGround: alt.onGround,
      groundSpeedKt: num(ac.gs),
      trackDeg: num(ac.track),
      verticalRateFpm: num(ac.baro_rate ?? ac.geom_rate),
      firstSeenAt: firstSeen,
      lastSeenAt: now,
      endedAt: ended ? now : null,
      durationHuman: ran,
      positionsSeen: positions,
      status: ended ? 'ended' : 'active',
      statusNote: ended
        ? 'The aircraft stopped appearing on this list between the previous poll and this one, so it cleared some time in that window rather than exactly at endedAt.'
        : 'Still on the list at lastSeenAt.',
      place: { lat, lon },
      source: 'adsb.lol community ADS-B network',
      dataset: `${BASE}${WATCHES[watch]?.path ?? ''}`,
    },
  };
}

/** How long an episode ran, in the words a person would use. */
export function minutesBetween(fromISO, toISO) {
  const ms = new Date(toISO).getTime() - new Date(fromISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const adsbFlights = defineAdapter({
  name: 'adsb-flights',
  title: 'Aircraft on watch',
  collection: 'aviation',
  description:
    'Live aircraft, but only the ones that mean something: the emergency transponder codes (7700, 7600, 7500) and military traffic. Each aircraft is one row that lasts as long as it is on the list and is written once more when it clears, with how long it ran — not a position every few minutes. Keyless, from the adsb.lol receiver network.',
  docs: 'https://api.adsb.lol/docs',
  kinds: ['aircraft-emergency', 'aircraft-sighting'],
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'watch',
      label: 'Watch list',
      type: 'select',
      options: Object.keys(WATCHES),
      help: 'Which surface of the feed to read.',
    },
    {
      key: 'types',
      label: 'Only these aircraft types',
      type: 'list',
      help: 'ICAO type codes, e.g. B738. Empty means every aircraft on the list.',
    },
  ],
  defaults: { watch: 'emergency' },
  defaultSources: [
    {
      slug: 'aircraft-emergency',
      name: 'Aircraft squawking 7700 (emergency)',
      config: { watch: 'emergency' },
    },
    {
      slug: 'aircraft-radio-failure',
      name: 'Aircraft squawking 7600 (lost radio)',
      config: { watch: 'radio-failure' },
    },
    {
      slug: 'aircraft-unlawful-interference',
      name: 'Aircraft squawking 7500',
      config: { watch: 'hijack' },
    },
    {
      slug: 'aircraft-military',
      name: 'Military aircraft airborne',
      config: { watch: 'military' },
      cadenceMinutes: 60,
    },
  ],
  async pull({ config, cursor, http, log }) {
    const watch = String(config.watch ?? 'emergency');
    const spec = WATCHES[watch];
    if (!spec) throw new Error(`adsb-flights does not know the watch list ${watch}`);

    /* The military list is rate limited far harder than the squawk lists -- it
     * returns four hundred aircraft rather than none, and it answers 429 while
     * `/sqk/7700` beside it answers 200. A limit is not a failure: returning no
     * items and asking to be called back later keeps the source green and, more
     * importantly, keeps the cursor intact, because a run that threw here would
     * leave every open episode untouched and then report them all as ended on
     * the run after. */
    const res = await http.request(`${BASE}${spec.path}`, { timeoutMs: 45_000 });
    if (res.status === 429) {
      log(`rate limited on the ${watch} list; backing off`);
      return { items: [], cursor, nextInMinutes: 30, note: 'rate limited' };
    }
    if (!res.ok) throw new Error(`${res.status} from the ${watch} list`);
    const body = await res.json();
    const aircraft = Array.isArray(body?.ac) ? body.ac : [];
    const now = new Date().toISOString();

    const types = (config.types ?? []).map((t) => String(t).trim().toUpperCase()).filter(Boolean);
    const wanted = types.length
      ? aircraft.filter((a) => types.includes(String(a?.t ?? '').toUpperCase()))
      : aircraft;

    const open = { ...(cursor.open ?? {}) };
    const items = [];

    for (const ac of wanted) {
      const hex = clean(ac.hex);
      if (!hex) continue;
      const held = open[hex];
      const firstSeen = held?.firstSeen ?? now;
      const positions = (held?.positions ?? 0) + 1;
      open[hex] = { firstSeen, positions, last: snapshot(ac) };
      const item = toItem(ac, { watch, firstSeen, now, positions });
      if (item) items.push(item);
    }

    /* Whatever was on the list last time and is not now has cleared. It is
     * written once with its duration and dropped, because keeping it would
     * re-emit the same ended episode on every run forever. */
    const live = new Set(wanted.map((a) => clean(a.hex)).filter(Boolean));
    for (const [hex, held] of Object.entries(cursor.open ?? {})) {
      if (live.has(hex)) continue;
      delete open[hex];
      const item = toItem(
        { hex, ...(held.last ?? {}) },
        { watch, firstSeen: held.firstSeen, now, ended: true, positions: held.positions ?? 1 },
      );
      if (item) items.push(item);
    }

    const ended = items.length - wanted.length;
    log(`${wanted.length} aircraft on the ${watch} list, ${ended > 0 ? ended : 0} cleared`);
    return { items, cursor: { open }, note: `${wanted.length} on ${watch}` };
  },
});

/**
 * What to remember about an aircraft so the closing row can still describe it.
 *
 * Only the identifying fields: the position it held when it left the list is
 * where it was last seen, not where it is, and storing the whole record would
 * put a stale altitude in a row that says the episode ended.
 */
function snapshot(ac) {
  return {
    flight: ac.flight ?? null,
    r: ac.r ?? null,
    t: ac.t ?? null,
    desc: ac.desc ?? null,
    ownOp: ac.ownOp ?? null,
    squawk: ac.squawk ?? null,
  };
}
