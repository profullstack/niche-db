import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Every civil aviation accident and incident the NTSB has investigated, from
 * the bulk database it publishes rather than from an API, because there is no
 * usable API.
 *
 * This is the third leg of the aviation collection and the one that makes the
 * other two more than a status board. `faa-nas-status` says the airspace is
 * delayed today; `aviation-metar` says what the weather is doing at the field.
 * This says what happened the last thirty-one thousand times something went
 * wrong, and -- the part that matters -- it carries the weather at the moment
 * it did. The `events` table has a `metar` column holding the raw observation
 * at the accident, in the identical format `aviation-metar` publishes hourly.
 * The same string, from the same service, thirty years apart. That is the join.
 *
 * WHY A 96 MB DOWNLOAD AND NOT A QUERY
 *
 * The NTSB's public query service (CAROL) answers a malformed request with a
 * 400 that names the problem and a well-formed one with `500 An unknown
 * exception occured` [sic]. It is not a usable interface. What the NTSB does
 * publish reliably is `avall.zip`: a 96 MB archive holding a 558 MB Microsoft
 * Access database, rebuilt monthly, currently carrying 31,436 events with the
 * newest eight days old. The monthly delta archives beside it stop in December
 * 2022 and are not a maintained incremental path, so the full file is the file.
 *
 * WHY RE-READING IT IS CHEAP ANYWAY
 *
 * An NTSB investigation is published long before it is finished: a preliminary
 * report within days, a factual report months later, and a probable cause that
 * can take two years. They are all the same event under the same `ev_id`. So
 * this adapter deliberately re-reads events it has already stored, keyed on
 * that id, and lets the upsert do the work -- an unchanged accident hashes to
 * the row already there and costs no write, while one the NTSB has since
 * ruled on gains its probable cause in place rather than arriving as a second
 * row that contradicts the first.
 *
 * WHAT IT COSTS PER RUN
 *
 * A run emits a bounded slice, newest first, and remembers where it stopped.
 * Not because of the database -- `runSource` already chunks its writes into
 * batches of 200 -- but because the whole file is 31,000 accidents carrying a
 * hundred and forty megabytes of narrative text, and building all of that into
 * items in one pass would hold the lot in memory and run past the four-minute
 * ingest deadline. The extracted tables are cached beside the archive and keyed
 * on the file's publication date, so the slices after the first cost no
 * download at all -- and when the NTSB publishes a new file, the date changes,
 * the cache misses, and the walk starts again from the newest accident.
 *
 * NEEDS `mdbtools` AND `unzip` ON THE HOST. Both are in the Dockerfile. There
 * is no pure-JavaScript reader for a 558 MB Access database worth trusting, and
 * `mdb-json` writes one JSON object per line with the newlines inside a
 * narrative escaped -- which the CSV export does not, and which is why the
 * narrative table reads as 522,053 lines and 28,436 rows.
 */

const LISTING = 'https://data.ntsb.gov/avdata';
const ARCHIVE =
  'https://data.ntsb.gov/avdata/FileDirectory/DownloadFile?fileID=C%3A%5Cavdata%5Cavall.zip';

/** The tables worth reading, and what each is for. */
const TABLES = ['events', 'aircraft', 'narratives'];

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

/** A number that may legitimately be zero: a fatality count of 0 is a fact. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * When the NTSB last rebuilt the archive, from its own listing page.
 *
 * The page prints a `Date created` beside every file. Reading it is one small
 * request and it is what makes the 96 MB download conditional rather than
 * monthly-and-hopeful.
 */
export function archiveDate(htmlText) {
  const row =
    /avall\.zip[^\d]{0,40}(\d{1,2}\/\d{1,2}\/\d{4})[^\d]{0,4}(\d{1,2}:\d{2}:\d{2})?/i.exec(
      String(htmlText ?? '').replace(/<[^>]+>/g, ' '),
    );
  if (!row) return null;
  const [, date] = row;
  const [m, d, y] = date.split('/').map(Number);
  if (!y || !m || !d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * An NTSB date, which arrives as `08/22/26 00:00:00`.
 *
 * The two-digit year is the trap: `26` is 2026 and `98` is 1998, and neither
 * `new Date` nor any amount of hoping gets that right on its own -- handed
 * `08/22/26` it returns 1926, which would publish every accident in the file a
 * century early and sort them before everything else in the collection. The
 * database starts in 1982, so 82 and above is last century.
 */
export function ntsbDate(raw, timeHHMM = null) {
  const s = String(raw ?? '').trim();
  /* Four digits before two in the alternation. The other order matches the
   * `20` of `03/04/2015` and reads it as 2020, which is a wrong date that
   * still parses, still sorts and never raises anything. */
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/.exec(s);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  // 82 itself is 1982, the first year in the database, so the boundary is
  // inclusive: `>` here would file the oldest accidents under 2082.
  const year =
    yy.length === 4 ? Number(yy) : Number(yy) >= 82 ? 1900 + Number(yy) : 2000 + Number(yy);
  const day = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const t = num(timeHHMM);
  if (t === null) return { date: day, timeKnown: false };
  // `ev_time` is HHMM as an integer, so 1830 is 18:30 and 217 is 02:17.
  const hh = String(Math.floor(t / 100)).padStart(2, '0');
  const mi = String(t % 100).padStart(2, '0');
  if (Number(hh) > 23 || Number(mi) > 59) return { date: day, timeKnown: false };
  return { date: `${day}T${hh}:${mi}:00Z`, timeKnown: true };
}

/**
 * A coordinate from the decimal columns, which are the only trustworthy ones.
 *
 * The `latitude`/`longitude` text columns hold packed degrees-minutes-seconds
 * like `003000N`, and the same row's `dec_latitude` says 30. Reading the packed
 * pair as a number puts a Texas accident three thousand degrees north.
 */
const coord = (v, limit) => {
  const n = num(v);
  return n !== null && Math.abs(n) <= limit && n !== 0 ? n : null;
};

const INJURY = {
  FATL: 'fatal',
  SERS: 'serious',
  MINR: 'minor',
  NONE: 'no injuries',
};

const EVENT_TYPE = { ACC: 'Accident', INC: 'Incident' };

/**
 * What the NTSB did to the aeroplane, from the code it files it under.
 *
 * `damage` is `SUBS`, `DEST`, `MINR` or `NONE`, and printed raw it reads
 * "Aircraft subs." -- which says nothing to anyone who has not read the
 * codebook. `SUBS` is the threshold that makes an event an accident rather
 * than an incident, so it is the most important word in the row.
 */
const DAMAGE = {
  DEST: 'destroyed',
  SUBS: 'substantially damaged',
  MINR: 'lightly damaged',
  NONE: 'undamaged',
  UNK: null,
};

/**
 * A name, unless it is one of the register's placeholders.
 *
 * The operator columns carry a bare `N` on a great many rows -- a leftover flag
 * rather than an operator -- and printed straight it produces "operated by N",
 * which reads like a company. Anything under two characters is not a name.
 */
export function operatorName(...candidates) {
  for (const c of candidates) {
    const s = clean(c);
    if (s && s.length > 1 && !/^(n|y|na|n\/a|none|unk|unknown)$/i.test(s)) return s;
  }
  return null;
}

/** VMC and IMC are the whole story in one field: could the pilot see out. */
const CONDITIONS = { VMC: 'visual conditions', IMC: 'instrument conditions' };

/**
 * One accident, from its event row plus whatever the other tables add.
 *
 * `aircraft` and `narratives` are keyed on the same `ev_id`, so they arrive
 * here already looked up rather than being searched for per row.
 */
export function toItem(ev, { aircraft = null, narrative = null } = {}) {
  const id = clean(ev?.ev_id);
  const when = ntsbDate(ev?.ev_date, ev?.ev_time);
  if (!id || !when) return null;

  const kind = EVENT_TYPE[clean(ev.ev_type)] ?? 'Event';
  const city = clean(ev.ev_city);
  const state = clean(ev.ev_state);
  const country = clean(ev.ev_country);
  const where = [city, state === 'OF' ? null : state, country === 'USA' ? null : country]
    .filter(Boolean)
    .join(', ');

  const fatal = num(ev.inj_tot_f);
  const serious = num(ev.inj_tot_s);
  const minor = num(ev.inj_tot_m);
  const aboard = num(ev.inj_tot_t);
  const worst = INJURY[clean(ev.ev_highest_injury)] ?? null;

  const make = clean(aircraft?.acft_make);
  const model = clean(aircraft?.acft_model);
  const plane = [make, model].filter(Boolean).join(' ') || null;
  const registration = clean(aircraft?.regis_no);
  const operator = operatorName(aircraft?.oper_name, aircraft?.oper_individual_name);
  const damageCode = clean(aircraft?.damage);
  const damage = damageCode ? (DAMAGE[damageCode.toUpperCase()] ?? null) : null;
  const phase = clean(aircraft?.phase_flt_spec);
  const farPart = clean(aircraft?.far_part);

  const cause = clean(narrative?.narr_cause);
  const account =
    clean(narrative?.narr_accp) ?? clean(narrative?.narr_accf) ?? clean(narrative?.narr_inc);
  const metar = clean(ev.metar);
  const conditions = CONDITIONS[clean(ev.wx_cond_basic)] ?? null;

  const headline = [
    plane ?? 'Aircraft',
    registration ? `(${registration})` : null,
    kind === 'Accident' ? 'accident' : 'incident',
    where ? `near ${where}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    externalId: `ntsb-${id}`,
    kind: 'accident',
    title: `${headline}${fatal ? ` — ${fatal} killed` : ''}`,
    summary: [
      `${kind} on ${String(when.date).slice(0, 10)}`,
      where ? ` at ${where}` : '',
      plane ? `, ${plane}` : '',
      registration ? ` ${registration}` : '',
      operator ? `, operated by ${operator}` : '',
      '. ',
      fatal !== null || serious !== null
        ? `${fatal ?? 0} killed, ${serious ?? 0} seriously injured${aboard !== null ? ` of ${aboard} aboard` : ''}. `
        : '',
      damage ? `Aircraft ${damage}. ` : '',
      conditions ? `Flown in ${conditions}. ` : '',
      cause ? `Probable cause: ${cause}` : account ? account : '',
    ]
      .join('')
      .trim()
      .slice(0, 3900),
    url: clean(ev.ntsb_no)
      ? `https://data.ntsb.gov/carol-main-public/basic-search?ntsbNumber=${encodeURIComponent(ev.ntsb_no)}`
      : LISTING,
    publishedAt: when.date,
    timeKnown: when.timeKnown,
    precision: when.timeKnown ? 'minute' : 'day',
    tags: [
      'aviation',
      'accident',
      kind.toLowerCase(),
      country === 'USA' ? 'us' : country ? slugify(country) : null,
      state && state !== 'OF' ? state.toLowerCase() : null,
      make ? slugify(make).slice(0, 40) : null,
      fatal ? 'fatal' : null,
      worst ? `injury:${slugify(worst)}` : null,
      damageCode ? `damage:${slugify(DAMAGE[damageCode.toUpperCase()] ?? damageCode)}` : null,
      phase ? `phase:${slugify(phase).slice(0, 30)}` : null,
      farPart ? `far:${slugify(farPart)}` : null,
      cause ? 'probable-cause' : 'under-investigation',
      metar ? 'has-metar' : null,
      conditions ? slugify(conditions) : null,
    ].filter(Boolean),
    data: {
      eventId: id,
      ntsbNumber: clean(ev.ntsb_no),
      eventType: kind,
      occurredAt: when.date,
      aircraft: plane,
      make,
      model,
      registration,
      serial: clean(aircraft?.acft_serial_no),
      operator,
      owner: operatorName(aircraft?.owner_acft),
      farPart,
      damage,
      damageCode,
      phaseOfFlight: phase,
      departureAirport: clean(aircraft?.dprt_apt_id),
      destinationAirport: clean(aircraft?.dest_apt_id),
      injuries: { fatal, serious, minor, none: num(ev.inj_tot_n), aboard, highest: worst },
      /*
       * The weather the NTSB recorded at the accident, including the raw METAR
       * where one was captured. `aviation-metar` publishes the identical field
       * for every reporting airport every hour, so an accident and the hourly
       * record of the sky it happened under are the same shape.
       */
      weather: {
        metar,
        conditions,
        conditionsCode: clean(ev.wx_cond_basic),
        lightConditions: clean(ev.light_cond),
        temperatureC: num(ev.wx_temp),
        dewpointC: num(ev.wx_dew_pt),
        windDirectionDeg: num(ev.wind_dir_deg),
        windSpeedKt: num(ev.wind_vel_kts),
        gustKt: num(ev.gust_kts),
        visibilitySm: num(ev.vis_sm),
        ceilingFt: num(ev.sky_ceil_ht),
        observedAtStation: clean(ev.wx_obs_fac_id),
      },
      probableCause: cause,
      narrative: account ? account.slice(0, 20_000) : null,
      narrativeNote: cause
        ? 'The NTSB has ruled on this event; `probableCause` is its finding.'
        : 'No probable cause published yet. An NTSB investigation runs for months and often years, and this row is updated in place when the finding lands.',
      place: {
        country: country === 'USA' ? 'US' : country,
        state: state === 'OF' ? null : state,
        city,
        lat: coord(ev.dec_latitude, 90),
        lon: coord(ev.dec_longitude, 180),
        nearestAirport: clean(ev.ev_nr_apt_id),
        airportName: clean(ev.apt_name),
      },
      source: 'NTSB aviation accident database (avall.mdb)',
      dataset: LISTING,
    },
  };
}

/** NDJSON, as `mdb-json` writes it: one object per line, nothing else. */
export function parseNdjson(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (t?.[0] !== '{') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A truncated final line is the only way this happens, and it is one row.
    }
  }
  return out;
}

/** Newest accident first, so a bounded run stores what a reader wants first. */
export function newestFirst(events) {
  return [...events].sort((a, b) => {
    const at = ntsbDate(a?.ev_date)?.date ?? '';
    const bt = ntsbDate(b?.ev_date)?.date ?? '';
    return bt.localeCompare(at);
  });
}

/** One row per ev_id, preferring the row that actually says something. */
export function indexByEvent(rows, pick = () => true) {
  const by = new Map();
  for (const r of rows) {
    const id = clean(r?.ev_id);
    if (!id) continue;
    const held = by.get(id);
    if (!held || (!pick(held) && pick(r))) by.set(id, r);
  }
  return by;
}

const hasCause = (n) => Boolean(clean(n?.narr_cause));

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run a binary, or say plainly which one is missing. */
async function run(cmd, args, { cwd, stdoutFile = null } = {}) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: stdoutFile ? Bun.file(stdoutFile) : 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = proc.stderr ? await new Response(proc.stderr).text() : '';
    throw new Error(`${cmd} exited ${code}${err ? `: ${err.slice(0, 200)}` : ''}`);
  }
  return stdoutFile ? null : await new Response(proc.stdout).text();
}

export const ntsbAccidents = defineAdapter({
  name: 'ntsb-accidents',
  title: 'NTSB aviation accidents',
  collection: 'aviation',
  description:
    'Every civil aviation accident and incident the NTSB has investigated — 31,000 of them — with the aircraft, the operator, the injuries, the probable cause once it is ruled, and the weather at the moment it happened including the raw METAR. Read from the bulk Access database the NTSB rebuilds monthly, because its query API does not work. Keyless; needs mdbtools and unzip on the host.',
  docs: 'https://data.ntsb.gov/avdata',
  kinds: ['accident'],
  cadenceMinutes: 60,
  configFields: [
    {
      key: 'maxPerRun',
      label: 'Accidents per run',
      type: 'number',
      help: 'Bounded so a run stays inside the ingest deadline. Default 2,000.',
    },
    {
      key: 'minYear',
      label: 'Earliest year',
      type: 'number',
      help: 'Skip events before this year.',
    },
    {
      key: 'accidentsOnly',
      label: 'Accidents only',
      type: 'select',
      options: ['', 'yes'],
      help: 'Leave incidents out. An incident is the far more common and far less serious half.',
    },
    {
      key: 'cacheDir',
      label: 'Working directory',
      help: 'Where the archive is unpacked. A temp directory unless set.',
    },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'ntsb-accidents', name: 'NTSB aviation accidents and incidents' },
    {
      slug: 'ntsb-fatal-accidents',
      name: 'NTSB fatal aviation accidents',
      config: { accidentsOnly: 'yes', minYear: 2010 },
      cadenceMinutes: 60 * 6,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const maxPerRun = Math.max(50, Math.min(Number(config.maxPerRun) || 2000, 5000));
    const minYear = Number(config.minYear) || 0;
    const accidentsOnly = String(config.accidentsOnly ?? '') === 'yes';
    const dir = clean(config.cacheDir) ?? join(tmpdir(), 'nichedb-ntsb');

    const listing = await http.text(LISTING, { timeoutMs: 60_000 });
    const published = archiveDate(listing);
    if (!published) throw new Error('could not read the archive date from the NTSB listing');

    /* A new file resets the walk; the same file continues it. The offset lives
     * in the cursor rather than in the directory, because the directory is a
     * cache that a container restart is allowed to lose and the walk is not. */
    const fresh = cursor.fileDate !== published;
    const offset = fresh ? 0 : Number(cursor.offset) || 0;

    if (!fresh && cursor.done) {
      log(`archive unchanged (${published}) and fully read; nothing to do`);
      return { items: [], cursor, note: 'unchanged' };
    }

    await mkdir(dir, { recursive: true });
    const stamp = join(dir, `avall-${published}`);
    const eventsFile = `${stamp}.events.ndjson`;
    /*
     * The cache is ready when this marker exists, and NOT when the first
     * extract does.
     *
     * Two sources read this archive -- every accident, and the fatal ones --
     * and they share the directory, which is the point: one 96 MB download
     * serves both. But `events` is written first and `narratives` last, so a
     * second source arriving mid-extraction saw `events.ndjson`, concluded the
     * cache was warm, skipped the download and then failed with ENOENT on a
     * file still being written. That is exactly what `ntsb-fatal-accidents`
     * did on its first real run. The marker is written after every table, so
     * "ready" means all of them.
     */
    const marker = `${stamp}.complete`;

    if (!(await exists(marker))) {
      log(`fetching the ${published} archive (96 MB)`);
      const zip = join(dir, `avall-${published}.zip`);
      const res = await http.request(ARCHIVE, { timeoutMs: 15 * 60_000 });
      if (!res.ok) throw new Error(`${res.status} fetching the NTSB archive`);
      await writeFile(zip, Buffer.from(await res.arrayBuffer()));

      await run('unzip', ['-o', '-q', zip, '-d', dir]);
      const mdb = join(dir, 'avall.mdb');
      for (const table of TABLES) {
        await run('mdb-json', [mdb, table], { stdoutFile: `${stamp}.${table}.ndjson` });
      }
      // The 558 MB database and the archive are not needed once exported, and a
      // container that keeps both has 650 MB of disk it cannot use for anything.
      await rm(mdb, { force: true });
      await rm(zip, { force: true });
      await writeFile(marker, `${TABLES.join(',')}\n`);
      log(`extracted ${TABLES.join(', ')} from the ${published} archive`);
    }

    /* Belt and braces: the marker can only be missing above, never wrong, but a
     * container that died between two exports leaves a directory that looks
     * warm to nothing and cold to everything. If a table is genuinely absent
     * here, say which one rather than letting `readFile` raise a bare ENOENT
     * against a path nobody can interpret. */
    for (const table of TABLES) {
      if (!(await exists(`${stamp}.${table}.ndjson`))) {
        await rm(marker, { force: true });
        throw new Error(`the ${published} extract is missing ${table}; it will be re-fetched`);
      }
    }

    const events = newestFirst(
      parseNdjson(await readFile(eventsFile, 'utf8')).filter((e) => {
        if (accidentsOnly && clean(e.ev_type) !== 'ACC') return false;
        if (minYear && Number(e.ev_year) < minYear) return false;
        return true;
      }),
    );

    const slice = events.slice(offset, offset + maxPerRun);
    if (!slice.length) {
      log(`all ${events.length} event(s) from the ${published} archive are stored`);
      return { items: [], cursor: { fileDate: published, offset, done: true }, note: 'complete' };
    }

    const wanted = new Set(slice.map((e) => clean(e.ev_id)).filter(Boolean));
    const only = (rows) => rows.filter((r) => wanted.has(clean(r?.ev_id)));
    const aircraft = indexByEvent(
      only(parseNdjson(await readFile(`${stamp}.aircraft.ndjson`, 'utf8'))),
    );
    const narratives = indexByEvent(
      only(parseNdjson(await readFile(`${stamp}.narratives.ndjson`, 'utf8'))),
      hasCause,
    );

    const items = [];
    for (const ev of slice) {
      if (Date.now() > deadline) {
        log(`out of time after ${items.length} of ${slice.length}`);
        break;
      }
      const item = toItem(ev, {
        aircraft: aircraft.get(clean(ev.ev_id)) ?? null,
        narrative: narratives.get(clean(ev.ev_id)) ?? null,
      });
      if (item) items.push(item);
    }

    const next = offset + items.length;
    const done = next >= events.length;
    log(
      `${items.length} accident(s) from the ${published} archive, ${next} of ${events.length} read${
        done ? ' — complete' : ''
      }`,
    );
    return {
      items,
      cursor: { fileDate: published, offset: next, done },
      // Keep walking straight away while there is more of the file to read.
      nextInMinutes: done ? undefined : 5,
      note: `${items.length} accidents (${next}/${events.length})`,
    };
  },
});
