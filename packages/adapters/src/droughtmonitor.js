import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The US Drought Monitor: how much of a place is in drought, and how badly,
 * redrawn every Thursday.
 *
 * This is the slow half of the water collection and the reason the collection
 * is about water rather than about floods. A river gauge says what is happening
 * this hour; the Drought Monitor says what the last six months did to the
 * ground that river runs through, which is what decides whether the next storm
 * runs off or soaks in. The two are read together or neither is worth much.
 *
 * WHAT THE NUMBERS MEAN
 *
 * The API answers with the share of an area in each drought class, and the
 * classes are cumulative: `d0` is the share at D0 or worse, `d1` the share at
 * D1 or worse, and so on to `d4`, exceptional drought. So `d0: 79, d4: 1.7`
 * does not mean 80.7% of the state is in drought -- it means 79% of it is in
 * some drought and 1.7% of that is in the worst class there is. Reported here
 * as both the cumulative shares the API sends and the share in each class on
 * its own, because every mistake anyone makes with this dataset is that one.
 *
 * WHY BY STATE
 *
 * The county service exists and would be 3,144 requests for one weekly map;
 * the state service is 52 and carries the same story at the resolution a feed
 * can be read at. A deployment that wants counties names them in the config and
 * gets one row each.
 *
 * The area of interest is a FIPS number, not a postal code. `aoi=IA` is
 * accepted, returns `[]` and looks exactly like a week with no drought in Iowa,
 * so the state codes below are numeric and the config field says so.
 */

const BASE = 'https://usdmdataservices.unl.edu/api';

/** State and territory FIPS, which is what the service means by an area of interest. */
export const STATE_FIPS = {
  '01': 'Alabama',
  '02': 'Alaska',
  '04': 'Arizona',
  '05': 'Arkansas',
  '06': 'California',
  '08': 'Colorado',
  '09': 'Connecticut',
  10: 'Delaware',
  11: 'District of Columbia',
  12: 'Florida',
  13: 'Georgia',
  15: 'Hawaii',
  16: 'Idaho',
  17: 'Illinois',
  18: 'Indiana',
  19: 'Iowa',
  20: 'Kansas',
  21: 'Kentucky',
  22: 'Louisiana',
  23: 'Maine',
  24: 'Maryland',
  25: 'Massachusetts',
  26: 'Michigan',
  27: 'Minnesota',
  28: 'Mississippi',
  29: 'Missouri',
  30: 'Montana',
  31: 'Nebraska',
  32: 'Nevada',
  33: 'New Hampshire',
  34: 'New Jersey',
  35: 'New Mexico',
  36: 'New York',
  37: 'North Carolina',
  38: 'North Dakota',
  39: 'Ohio',
  40: 'Oklahoma',
  41: 'Oregon',
  42: 'Pennsylvania',
  44: 'Rhode Island',
  45: 'South Carolina',
  46: 'South Dakota',
  47: 'Tennessee',
  48: 'Texas',
  49: 'Utah',
  50: 'Vermont',
  51: 'Virginia',
  53: 'Washington',
  54: 'West Virginia',
  55: 'Wisconsin',
  56: 'Wyoming',
  72: 'Puerto Rico',
};

/** The classes, worst last, with the words the Monitor itself uses. */
export const CLASSES = [
  ['d0', 'abnormally dry'],
  ['d1', 'moderate drought'],
  ['d2', 'severe drought'],
  ['d3', 'extreme drought'],
  ['d4', 'exceptional drought'],
];

export function pct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

/**
 * The share in each class on its own, from the cumulative shares the API sends.
 *
 * D4 is already exclusive; every other class is itself minus the next one up.
 * Clamped at zero because the source rounds each share independently and two
 * rounded numbers can cross by a hundredth.
 */
export function byClass(row) {
  const out = {};
  for (let i = 0; i < CLASSES.length; i += 1) {
    const [key] = CLASSES[i];
    const here = pct(row[key]) ?? 0;
    const worse = i === CLASSES.length - 1 ? 0 : (pct(row[CLASSES[i + 1][0]]) ?? 0);
    out[key] = Number(Math.max(0, here - worse).toFixed(2));
  }
  return out;
}

/** The worst class with any area in it, which is the headline. */
export function worstClass(row) {
  for (let i = CLASSES.length - 1; i >= 0; i -= 1) {
    const [key, label] = CLASSES[i];
    if ((pct(row[key]) ?? 0) > 0) return { key, label, share: pct(row[key]) };
  }
  return null;
}

export function toItem(row, { area, areaType, fips }) {
  const date = String(row.mapDate ?? '').slice(0, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const worst = worstClass(row);
  const inDrought = pct(row.d1) ?? 0;
  const any = pct(row.d0) ?? 0;
  const exclusive = byClass(row);

  return {
    externalId: `usdm-${areaType}-${fips}-${date}`,
    kind: 'drought',
    title: worst
      ? `${area}: ${any}% abnormally dry or worse, ${inDrought}% in drought, ${worst.share}% ${worst.label}`
      : `${area}: no drought`,
    summary: worst
      ? [
          `${any}% of ${area} was abnormally dry or worse in the US Drought Monitor map of ${date},`,
          `${inDrought}% was in moderate drought or worse,`,
          `and ${worst.share}% was in ${worst.label}, the worst class the map put it in.`,
        ].join(' ')
      : `No part of ${area} was abnormally dry in the US Drought Monitor map of ${date}.`,
    url: `https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?${
      areaType === 'state' ? String(row.stateAbbreviation ?? '').toUpperCase() : 'conus'
    }`,
    publishedAt: date,
    timeKnown: false,
    precision: 'day',
    tags: [
      'water',
      'drought',
      'us',
      areaType,
      String(row.stateAbbreviation ?? '').toLowerCase() || null,
      worst ? `drought:${worst.key}` : 'drought:none',
      (pct(row.d3) ?? 0) > 0 ? 'extreme-drought' : null,
    ].filter(Boolean),
    data: {
      area,
      areaType,
      fips,
      state: row.stateAbbreviation ?? null,
      county: row.county ?? null,
      mapDate: date,
      validFrom: row.validStart ? String(row.validStart).slice(0, 10) : null,
      validTo: row.validEnd ? String(row.validEnd).slice(0, 10) : null,
      none: pct(row.none),
      cumulative: Object.fromEntries(CLASSES.map(([k]) => [k, pct(row[k])])),
      inClass: exclusive,
      cumulativeNote:
        'The `cumulative` shares are the area at that class OR WORSE, which is how the Drought Monitor publishes them; `inClass` is the area in that class alone. d0 is abnormally dry, d4 exceptional drought.',
      worstClass: worst?.key ?? null,
      worstClassLabel: worst?.label ?? null,
      source: 'US Drought Monitor (NDMC, USDA, NOAA)',
      dataset: `${BASE}/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent`,
    },
  };
}

export const droughtMonitor = defineAdapter({
  name: 'drought-monitor',
  title: 'US Drought Monitor',
  collection: 'water',
  description:
    'How much of each state is in drought and how badly, from the map the National Drought Mitigation Center, the USDA and NOAA redraw every Thursday. Cumulative shares as published and the share in each class on its own, because conflating the two is the standard mistake with this dataset. Keyless.',
  docs: 'https://droughtmonitor.unl.edu/DmData/DataDownload/WebServiceInfo.aspx',
  kinds: ['drought'],
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'areaType',
      label: 'Area',
      type: 'select',
      options: ['state', 'national', 'county'],
      help: 'National is one row a week for the country.',
    },
    {
      key: 'counties',
      label: 'County FIPS',
      type: 'list',
      help: 'Five-digit county FIPS, for areaType=county. Numeric, not postal codes.',
    },
    { key: 'weeks', label: 'Weeks to read', type: 'number', help: 'Default 6.' },
  ],
  defaults: {},
  defaultSources: [
    { slug: 'drought-by-state', name: 'Drought by state' },
    {
      slug: 'drought-national',
      name: 'Drought across the country',
      config: { areaType: 'national' },
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const areaType = String(config.areaType ?? 'state').toLowerCase();
    const weeks = Math.max(1, Math.min(Number(config.weeks) || 6, 52));
    const end = new Date();
    const start = new Date(end.getTime() - weeks * 7 * 24 * 3_600_000);
    const fmt = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

    const targets =
      areaType === 'national'
        ? [
            {
              service: 'USStatistics',
              aoi: 'us',
              area: 'the continental United States',
              fips: 'us',
            },
          ]
        : areaType === 'county'
          ? (config.counties ?? [])
              .map((c) => String(c).trim())
              .filter(Boolean)
              .map((fips) => ({
                service: 'CountyStatistics',
                aoi: fips,
                area: `county ${fips}`,
                fips,
              }))
          : Object.entries(STATE_FIPS).map(([fips, area]) => ({
              service: 'StateStatistics',
              aoi: fips,
              area,
              fips,
            }));

    if (!targets.length) throw new Error('drought-monitor has no area to read');

    const items = [];
    for (const t of targets) {
      if (Date.now() > deadline) {
        log(`out of time after ${items.length} row(s)`);
        break;
      }
      const url =
        `${BASE}/${t.service}/GetDroughtSeverityStatisticsByAreaPercent` +
        `?aoi=${encodeURIComponent(t.aoi)}&startdate=${fmt(start)}&enddate=${fmt(end)}&statisticsType=1`;
      const rows = await http.json(url, {
        headers: { accept: 'application/json' },
        timeoutMs: 30_000,
      });
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        /* The national service answers with several areas of interest in one
         * list -- CONUS, Total, and the territories -- so the row's own label
         * is used where it has one rather than the name that was asked for. */
        const area = row.areaOfInterest ?? row.county ?? t.area;
        const fips = row.fips ?? t.fips;
        const item = toItem(row, { area, areaType, fips: `${fips}-${slugify(area)}` });
        if (item) items.push(item);
      }
    }

    log(`${items.length} drought row(s) across ${targets.length} area(s)`);
    return {
      items,
      cursor: { ...cursor, lastRun: new Date().toISOString() },
      note: `${items.length} rows`,
    };
  },
});
