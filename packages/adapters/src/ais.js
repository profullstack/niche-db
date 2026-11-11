import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Ships and boats, from AIS.
 *
 * AIS is the radio every ship over 300 tonnes (and every passenger ship, and
 * plenty of yachts and fishing boats) broadcasts: who it is (MMSI, IMO, name,
 * call sign, type, size), where it is, and where it says it is going. There is
 * no keyless worldwide AIS feed: the global ones (MarineTraffic, VesselFinder,
 * Spire) are paid, and the community ones (AISHub, aisstream.io) want an
 * account or a receiver of your own.
 *
 * DIGITRAFFIC
 *
 * Finland's transport agency (Fintraffic) publishes its coastal AIS network as
 * open data under CC BY 4.0, keyless: about 19,500 vessels it has heard and
 * the latest position of each one in range. That covers the northern Baltic
 * (Finland, Sweden, Estonia, the Gulf of Finland and Bothnia), which is a
 * slice of the world, not the world. The adapter is written against AIS
 * itself, so another open network can be added beside it as a source.
 *
 * Two traps: Digitraffic answers 406 unless the request says
 * `Accept-Encoding: gzip`, and it asks every client to name itself in a
 * `Digitraffic-User` header.
 *
 * A POSITION IS NOT HISTORY
 *
 * One row per vessel, keyed on MMSI, carrying its last known position. Every
 * run rewrites the rows whose position moved; a track of positions is what
 * nobody asked for and what would fill the table.
 */

export const DIGITRAFFIC = 'https://meri.digitraffic.fi/api/ais/v1';
export const DIGITRAFFIC_HEADERS = {
  'accept-encoding': 'gzip',
  'digitraffic-user': 'nichedb.dev',
};

/** ITU-R M.1371 ship and cargo type, by the code's tens or the exact code. */
export function shipType(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return null;
  const exact = {
    30: 'fishing',
    31: 'towing',
    32: 'towing',
    33: 'dredging',
    34: 'diving',
    35: 'military',
    36: 'sailing',
    37: 'pleasure craft',
    50: 'pilot vessel',
    51: 'search and rescue',
    52: 'tug',
    53: 'port tender',
    54: 'anti-pollution',
    55: 'law enforcement',
    58: 'medical transport',
    59: 'noncombatant',
  };
  if (exact[n]) return exact[n];
  const tens = Math.floor(n / 10);
  return (
    {
      2: 'wing in ground',
      4: 'high-speed craft',
      6: 'passenger',
      7: 'cargo',
      8: 'tanker',
      9: 'other',
    }[tens] ?? null
  );
}

export const NAV_STATUS = {
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
  14: 'AIS-SART active',
};

/**
 * Flag state by Maritime Identification Digits (the first three of a ship's
 * MMSI). Not every MID: the flags that show up in the Baltic and the big open
 * registries. An MID not here is kept as its number.
 */
const MID_RANGES = [
  [[205], 'BE', 'Belgium'],
  [[209, 210, 212], 'CY', 'Cyprus'],
  [[211, 218], 'DE', 'Germany'],
  [[215, 229, 248, 249, 256], 'MT', 'Malta'],
  [[219, 220], 'DK', 'Denmark'],
  [[224, 225], 'ES', 'Spain'],
  [[226, 227, 228], 'FR', 'France'],
  [[230], 'FI', 'Finland'],
  [[231], 'FO', 'Faroe Islands'],
  [[232, 233, 234, 235], 'GB', 'United Kingdom'],
  [[236], 'GI', 'Gibraltar'],
  [[237, 239, 240, 241], 'GR', 'Greece'],
  [[238], 'HR', 'Croatia'],
  [[244, 245, 246], 'NL', 'Netherlands'],
  [[247], 'IT', 'Italy'],
  [[250], 'IE', 'Ireland'],
  [[251], 'IS', 'Iceland'],
  [[255], 'PT', 'Portugal (Madeira)'],
  [[257, 258, 259], 'NO', 'Norway'],
  [[261], 'PL', 'Poland'],
  [[263], 'PT', 'Portugal'],
  [[265, 266], 'SE', 'Sweden'],
  [[271], 'TR', 'Turkey'],
  [[272], 'UA', 'Ukraine'],
  [[273], 'RU', 'Russia'],
  [[275], 'LV', 'Latvia'],
  [[276], 'EE', 'Estonia'],
  [[277], 'LT', 'Lithuania'],
  [[304, 305], 'AG', 'Antigua and Barbuda'],
  [[308, 309, 311], 'BS', 'Bahamas'],
  [[310], 'BM', 'Bermuda'],
  [[312], 'BZ', 'Belize'],
  [[316], 'CA', 'Canada'],
  [[338, 366, 367, 368, 369], 'US', 'United States'],
  [[351, 352, 353, 354, 355, 356, 357, 370, 371, 372, 373, 374], 'PA', 'Panama'],
  [[375, 376, 377], 'VC', 'Saint Vincent and the Grenadines'],
  [[412, 413, 414], 'CN', 'China'],
  [[419], 'IN', 'India'],
  [[431, 432], 'JP', 'Japan'],
  [[440, 441], 'KR', 'South Korea'],
  [[477], 'HK', 'Hong Kong'],
  [[503], 'AU', 'Australia'],
  [[518], 'CK', 'Cook Islands'],
  [[538], 'MH', 'Marshall Islands'],
  [[563, 564, 565, 566], 'SG', 'Singapore'],
  [[572], 'TV', 'Tuvalu'],
  [[636, 637], 'LR', 'Liberia'],
  [[667], 'SL', 'Sierra Leone'],
  [[671], 'TG', 'Togo'],
  [[710], 'BR', 'Brazil'],
];
const MID = new Map(
  MID_RANGES.flatMap(([mids, code, name]) => mids.map((m) => [m, { code, name }])),
);

/** The flag a ship's MMSI claims, or null for a non-ship MMSI (base station, SAR aircraft, buoy). */
export function flagOf(mmsi) {
  const s = String(mmsi ?? '');
  if (!/^[2-7]\d{8}$/.test(s)) return null;
  const mid = Number(s.slice(0, 3));
  return { mid, ...(MID.get(mid) ?? { code: null, name: null }) };
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.replace(/\s+/g, ' ') : null;
};

/** A course, speed or heading that AIS marks as unavailable with a sentinel. */
const sentinel = (v, na) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== na ? n : null;
};

/**
 * One vessel as an item: the register entry from `/vessels` and, when the
 * vessel is in range, its last position from `/locations`.
 */
export function toItem(v, loc = null) {
  const mmsi = Number(v?.mmsi);
  if (!Number.isFinite(mmsi) || mmsi <= 0) return null;
  const name = clean(v.name) ?? `MMSI ${mmsi}`;
  const type = shipType(v.shipType);
  const flag = flagOf(mmsi);
  const imo = Number(v.imo) > 0 ? Number(v.imo) : null;
  const length =
    Number(v.referencePointA) + Number(v.referencePointB) > 0
      ? Number(v.referencePointA) + Number(v.referencePointB)
      : null;
  const beam =
    Number(v.referencePointC) + Number(v.referencePointD) > 0
      ? Number(v.referencePointC) + Number(v.referencePointD)
      : null;
  const draught = Number(v.draught) > 0 ? Number(v.draught) / 10 : null;
  const p = loc?.properties ?? null;
  const [lon, lat] = loc?.geometry?.coordinates ?? [];
  const nav = p ? (NAV_STATUS[p.navStat] ?? null) : null;
  const speed = p ? sentinel(p.sog, 102.3) : null;
  const seenAt = p?.timestampExternal
    ? new Date(p.timestampExternal).toISOString()
    : v.timestamp
      ? new Date(v.timestamp).toISOString()
      : null;
  const destination = clean(v.destination);

  return {
    externalId: `mmsi-${mmsi}`,
    kind: 'vessel',
    title: `${name}${type ? ` (${type})` : ''}`,
    summary: [
      name,
      type ? `, a ${type} vessel` : '',
      flag?.name ? ` flagged in ${flag.name}` : '',
      `, MMSI ${mmsi}`,
      imo ? `, IMO ${imo}` : '',
      length ? `, ${length} m long` : '',
      seenAt ? `. Last heard ${seenAt.slice(0, 16).replace('T', ' ')} UTC` : '',
      nav ? `, ${nav}` : '',
      speed !== null && speed > 0.5 ? ` at ${speed} kn` : '',
      Number.isFinite(lat) && Number.isFinite(lon)
        ? ` near ${lat.toFixed(3)}, ${lon.toFixed(3)}`
        : '',
      destination ? `; stated destination ${destination}` : '',
      '.',
    ].join(''),
    url: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}`,
    publishedAt: seenAt,
    timeKnown: Boolean(seenAt),
    precision: 'minute',
    tags: [
      'ships',
      'ais',
      type ? slugify(type) : 'type-unknown',
      flag?.code ? `flag-${flag.code.toLowerCase()}` : null,
      flag ? `mid-${flag.mid}` : null,
      nav ? `nav-${slugify(nav)}` : null,
      imo ? `imo-${imo}` : null,
      p ? 'in-range' : null,
    ].filter(Boolean),
    data: {
      mmsi,
      imo,
      name: clean(v.name),
      callSign: clean(v.callSign),
      shipType: type,
      shipTypeCode: Number(v.shipType) || null,
      flag: flag?.name ?? null,
      flagCode: flag?.code ?? null,
      mid: flag?.mid ?? null,
      lengthM: length,
      beamM: beam,
      draughtM: draught,
      destination,
      navStatus: nav,
      speedKn: speed,
      courseDeg: p ? sentinel(p.cog, 360) : null,
      headingDeg: p ? sentinel(p.heading, 511) : null,
      place: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      positionAt: p?.timestampExternal ? new Date(p.timestampExternal).toISOString() : null,
      registerAt: v.timestamp ? new Date(v.timestamp).toISOString() : null,
      network: 'Digitraffic (Fintraffic) coastal AIS, northern Baltic',
      source: 'Digitraffic marine AIS, Fintraffic, CC BY 4.0',
      dataset: `${DIGITRAFFIC}/vessels`,
    },
  };
}

export const digitrafficAis = defineAdapter({
  name: 'digitraffic-ais',
  title: 'Ships on AIS (Digitraffic)',
  collection: 'ships',
  description:
    'Every vessel Finland’s coastal AIS network has heard, about 19,500 ships and boats in the northern Baltic: name, MMSI, IMO, call sign, type, flag, size and stated destination, with the last position, speed and navigation status of each one in range. Open data from Fintraffic’s Digitraffic, CC BY 4.0, keyless.',
  docs: 'https://www.digitraffic.fi/en/marine-traffic/',
  kinds: ['vessel'],
  cadenceMinutes: 6 * 60,
  budgetMs: 20 * 60_000,
  defaultSources: [
    { slug: 'digitraffic-ais-vessels', name: 'Ships and boats: northern Baltic AIS' },
  ],

  async *pull({ http, log }) {
    const headers = DIGITRAFFIC_HEADERS;
    const vessels = await http.json(`${DIGITRAFFIC}/vessels?from=0`, {
      headers,
      timeoutMs: 120_000,
    });
    const locations = await http
      .json(`${DIGITRAFFIC}/locations`, { headers, timeoutMs: 120_000 })
      .catch((err) => {
        log(`locations failed (${err.message}); writing the register without positions`);
        return { features: [] };
      });
    const byMmsi = new Map((locations?.features ?? []).map((f) => [Number(f.mmsi), f]));
    let batch = [];
    let wrote = 0;
    for (const v of Array.isArray(vessels) ? vessels : []) {
      const item = toItem(v, byMmsi.get(Number(v.mmsi)));
      if (!item) continue;
      batch.push(item);
      if (batch.length >= 1000) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    }
    if (batch.length) {
      wrote += batch.length;
      yield { items: batch };
    }
    log(`${wrote} vessels, ${byMmsi.size} with a position`);
    return { note: `${wrote} vessels, ${byMmsi.size} in range` };
  },
});
