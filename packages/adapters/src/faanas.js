import { defineAdapter, xmlItems } from '@nichedb/core/adapter';

/**
 * The FAA's own view of why the national airspace is running late.
 *
 * `nasstatus.faa.gov` publishes, every couple of minutes, the traffic
 * management initiatives in force right now: ground stops, ground delay
 * programs, airspace flow programs, collaborative trajectory options programs,
 * airport closures and the plain arrival/departure delays at airports running
 * behind. It is the document the airlines read, it is keyless, and it is about
 * two kilobytes.
 *
 * WHAT AN ITEM IS HERE
 *
 * The feed is a snapshot, not a log: it says what is in force, never what was.
 * A ground stop that ran for two hours appears in maybe forty consecutive
 * snapshots and then simply stops appearing, and nothing anywhere records that
 * it ended. So this adapter keeps the open programs in its cursor with the time
 * each was first seen, and:
 *
 *   * an item's external id is keyed on that first-seen time, so one program is
 *     one row that updates as the delay grows, rather than a new row every two
 *     minutes;
 *   * when a program leaves the snapshot it is emitted once more, with
 *     `endedAt` and a duration, and then dropped from the cursor.
 *
 * That last emission is the whole point. "BOS ground stop, 3h 40m, thunder-
 * storms" is a fact about a day of flying that the FAA publishes nowhere; it
 * only exists if something was watching the snapshot the entire time.
 *
 * The reason string is the FAA's own wording, kept verbatim, because the reason
 * is what makes this feed worth joining to the weather: `aviation-weather` has
 * the METAR and the SIGMET for the same airport at the same minute, so "weather
 * / thunderstorms" at ORD can be read next to the observation that says why.
 */

/** Programs, in the shape the snapshot writes them. */
const PROGRAMS = [
  {
    tag: 'Program',
    kind: 'ground-stop',
    label: 'Ground stop',
    airport: (f) => text(f.ARPT),
    detail: (f) => ({ endTime: text(f.End_Time) || null }),
    line: (f) => (text(f.End_Time) ? `until ${text(f.End_Time)}` : null),
  },
  {
    tag: 'Ground_Delay',
    kind: 'ground-delay',
    label: 'Ground delay program',
    airport: (f) => text(f.ARPT),
    detail: (f) => ({ averageDelay: text(f.Avg) || null, maximumDelay: text(f.Max) || null }),
    line: (f) => (text(f.Avg) ? `averaging ${text(f.Avg)}, up to ${text(f.Max)}` : null),
  },
  {
    tag: 'Delay',
    kind: 'airport-delay',
    label: 'Departure and arrival delays',
    airport: (f) => text(f.ARPT),
    detail: (f) => ({ legs: legsOf(f) }),
    line: (f) =>
      legsOf(f)
        .map(
          (l) =>
            `${l.type.toLowerCase()}s ${l.min}${l.max ? ` to ${l.max}` : ''}${l.trend ? `, ${l.trend}` : ''}`,
        )
        .join('; ') || null,
  },
  {
    tag: 'Airport',
    kind: 'airport-closure',
    label: 'Airport closure',
    airport: (f) => text(f.ARPT),
    detail: (f) => ({ start: text(f.Start) || null, reopen: text(f.Reopen) || null }),
    line: (f) => (text(f.Reopen) ? `reopens ${text(f.Reopen)}` : null),
  },
  {
    tag: 'Airspace_Flow',
    kind: 'airspace-flow',
    label: 'Airspace flow program',
    airport: (f) => text(f.CTL_Element),
    detail: (f) => ({
      averageDelay: text(f.Avg) || null,
      start: text(f.AFP_StartTime) || text(f.FCA_Start_DateTime) || null,
      end: text(f.AFP_EndTime) || text(f.FCA_End_DateTime) || null,
    }),
    line: (f) => (text(f.Avg) ? `averaging ${text(f.Avg)}` : null),
  },
  {
    tag: 'CTOP',
    kind: 'trajectory-options',
    label: 'Collaborative trajectory options program',
    airport: (f) => text(f.Program_Name),
    detail: (f) => ({
      averageDelay: text(f.Avg) || null,
      start: text(f.CTOP_Start_Time) || null,
      end: text(f.CTOP_End_Time) || null,
    }),
    line: (f) => (text(f.Avg) ? `averaging ${text(f.Avg)}` : null),
  },
];

const text = (field) => String((Array.isArray(field) ? field[0] : field)?.text ?? '').trim();

/**
 * The arrival and departure legs of one delay entry.
 *
 * `Delay` carries one or two `Arrival_Departure` children distinguished only by
 * a `Type` attribute, so an airport delayed in both directions is a single row
 * with two very different numbers in it.
 *
 * The `Min`/`Max`/`Trend` inside a leg arrive as that leg's unparsed body --
 * the XML reader in core stops at the outermost tag it matched rather than
 * descending -- so they are read out of the text here.
 */
export function legsOf(fields) {
  const raw = fields.Arrival_Departure;
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const child = (body, tag) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(String(body ?? ''))?.[1]?.trim() ?? '';
  return list
    .map((leg) => ({
      type: String(leg?.attrs?.Type ?? '').trim() || 'Arrival',
      min: child(leg?.text, 'Min'),
      max: child(leg?.text, 'Max'),
      trend: child(leg?.text, 'Trend'),
    }))
    .filter((l) => l.min || l.max);
}

/**
 * Read one snapshot into the programs it holds.
 *
 * Parsed per program tag over the whole document rather than by walking
 * `Delay_type` blocks, because the FAA emits the same block name more than once
 * in a single snapshot -- two separate `Airport Closures` sections is normal,
 * one for airports shut outright and one for airports shut to transient general
 * aviation -- and a reader that assumed one block per type would silently keep
 * whichever came last.
 */
export function parseStatus(xml) {
  const updated = /<Update_Time>([^<]+)<\/Update_Time>/.exec(xml)?.[1]?.trim() ?? null;
  const out = [];
  for (const p of PROGRAMS) {
    for (const fields of xmlItems(xml, p.tag)) {
      // `Delay` also matches `Ground_Delay`'s inner text in a document where the
      // two nest; requiring the identifying field keeps only the real ones.
      const where = p.airport(fields);
      if (!where) continue;
      const reason = text(fields.Reason);
      out.push({
        key: `${p.kind}:${where}`,
        kind: p.kind,
        label: p.label,
        where,
        reason: reason || null,
        line: p.line(fields),
        detail: p.detail(fields),
      });
    }
  }
  return { updated, programs: dedupe(out) };
}

/** One row per program per place: the same airport twice in a snapshot is the snapshot repeating itself. */
function dedupe(programs) {
  const seen = new Map();
  for (const p of programs) if (!seen.has(p.key)) seen.set(p.key, p);
  return [...seen.values()];
}

/** How long a program has been in force, in the words a person would use. */
export function duration(fromISO, toISO) {
  const ms = new Date(toISO).getTime() - new Date(fromISO).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function toItem(program, { firstSeen, now, ended = false }) {
  const ran = ended ? duration(firstSeen, now) : null;
  return {
    externalId: `faa-${program.kind}-${program.where}-${firstSeen}`,
    kind: program.kind,
    title: `${program.label}: ${program.where}${program.reason ? ` — ${program.reason}` : ''}${
      ended && ran ? ` (ended after ${ran})` : ''
    }`,
    summary: [
      `${program.label} at ${program.where}`,
      program.reason ? `because of ${program.reason}` : null,
      program.line ? `(${program.line})` : null,
      ended
        ? `. In force from ${firstSeen} to ${now}${ran ? `, ${ran}` : ''}.`
        : `. In force since ${firstSeen}, still listed at ${now}.`,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(' .', '.'),
    url: 'https://nasstatus.faa.gov/',
    publishedAt: firstSeen,
    timeKnown: true,
    precision: 'minute',
    tags: [
      'aviation',
      'us',
      'faa',
      program.kind,
      program.where.toLowerCase(),
      ended ? 'ended' : 'in-force',
      ...reasonTags(program.reason),
    ].filter(Boolean),
    data: {
      programType: program.kind,
      programLabel: program.label,
      airport: program.where,
      reason: program.reason,
      ...program.detail,
      firstSeenAt: firstSeen,
      lastSeenAt: now,
      endedAt: ended ? now : null,
      durationHuman: ran,
      status: ended ? 'ended' : 'in-force',
      statusNote: ended
        ? 'The FAA snapshot stopped listing this program between the previous poll and this one, so it ended some time in that window rather than exactly at endedAt.'
        : 'Still listed in the FAA snapshot at lastSeenAt.',
      source: 'FAA National Airspace System status',
      dataset: 'https://nasstatus.faa.gov/api/airport-status-information',
    },
  };
}

/** The coarse cause, so "every weather ground stop this month" is one query. */
export function reasonTags(reason) {
  const s = String(reason ?? '').toLowerCase();
  const tags = [];
  if (/weather|thunder|snow|fog|wind|ice|rain|low ceiling|visibility/.test(s)) tags.push('weather');
  if (/thunderstorm|convective/.test(s)) tags.push('thunderstorms');
  if (/volume|traffic management/.test(s)) tags.push('traffic-volume');
  if (/equipment|radar|outage/.test(s)) tags.push('equipment');
  if (/runway|taxiway|construction|maintenance/.test(s)) tags.push('runway');
  if (/staffing|controller/.test(s)) tags.push('staffing');
  if (/disabled aircraft|accident|incident|emergency/.test(s)) tags.push('incident');
  return tags;
}

export const faaAirportStatus = defineAdapter({
  name: 'faa-nas-status',
  title: 'FAA airspace status',
  collection: 'aviation',
  description:
    'Ground stops, ground delay programs, airspace flow programs, airport closures and the airports running behind, as the FAA lists them in force. Each program is one row that updates while it lasts and is written once more when it ends, with how long it ran — which is the part the FAA itself never publishes. Keyless.',
  docs: 'https://nasstatus.faa.gov/',
  kinds: [
    'ground-stop',
    'ground-delay',
    'airport-delay',
    'airport-closure',
    'airspace-flow',
    'trajectory-options',
  ],
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'airports',
      label: 'Only these airports',
      type: 'list',
      help: 'Three-letter FAA codes. Empty means every airport in the snapshot.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'faa-nas-status', name: 'FAA airspace status: the whole country' }],
  async pull({ config, cursor, http, log }) {
    const xml = await http.text('https://nasstatus.faa.gov/api/airport-status-information', {
      headers: { accept: 'application/xml, text/xml, */*' },
      timeoutMs: 30_000,
    });
    const { updated, programs } = parseStatus(xml);
    const now = new Date().toISOString();

    const only = (config.airports ?? []).map((a) => String(a).trim().toUpperCase()).filter(Boolean);
    const wanted = only.length ? programs.filter((p) => only.includes(p.where)) : programs;

    const open = { ...(cursor.open ?? {}) };
    const items = [];

    for (const p of wanted) {
      const firstSeen = open[p.key] ?? now;
      open[p.key] = firstSeen;
      items.push(toItem(p, { firstSeen, now }));
    }

    /* Whatever was open last time and is not in this snapshot has ended. It is
     * written once with its duration and then forgotten -- keeping it would
     * re-emit the same ended program on every run forever. */
    const live = new Set(wanted.map((p) => p.key));
    for (const [key, firstSeen] of Object.entries(cursor.open ?? {})) {
      if (live.has(key)) continue;
      delete open[key];
      // Split once: a CTOP's program name is free text and may contain a colon.
      const at = key.indexOf(':');
      const kind = key.slice(0, at);
      const where = key.slice(at + 1);
      const spec = PROGRAMS.find((p) => p.kind === kind);
      items.push(
        toItem(
          {
            key,
            kind,
            label: spec?.label ?? kind,
            where,
            reason: cursor.reasons?.[key] ?? null,
            line: null,
            detail: {},
          },
          { firstSeen, now, ended: true },
        ),
      );
    }

    // The reason a program gave while it was open, kept so the closing row can
    // still say why it happened after the snapshot has stopped saying so.
    const reasons = {};
    for (const p of wanted) if (p.reason) reasons[p.key] = p.reason;

    log(
      `${wanted.length} program(s) in force${updated ? ` as of ${updated}` : ''}, ${
        items.length - wanted.length
      } ended`,
    );
    return {
      items,
      cursor: { open, reasons, updated },
      note: `${wanted.length} in force`,
    };
  },
});
