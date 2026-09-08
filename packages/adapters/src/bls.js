import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * The US Bureau of Labor Statistics: the jobs report, as a feed.
 *
 * The first Friday of each month the BLS publishes the employment situation
 * and a good deal of the financial world stops to read it. This takes that,
 * and the series around it — the unemployment rate, payrolls, job openings,
 * quits, average earnings, the participation rate, CPI — one item per series
 * per month.
 *
 * Version 1 of the API is used deliberately. Version 2 is better in every
 * respect and needs a registration key; version 1 needs nothing at all, and
 * its limits (25 queries a day per address, 25 series a query, ten years of
 * history) are far above what this does, because everything wanted here fits
 * in one query a day. A deployment that outgrows it registers a key and gets
 * v2 by setting one variable.
 *
 * The one trap is that a BLS period is not a date. `M08` is August, `M13` is
 * the annual average and is not a month at all, `Q01` is a quarter and `S01`
 * is a half-year. Filing M13 as a thirteenth month produces an invalid date;
 * filing it as December silently doubles December. It is dropped, and said.
 */

const V1 = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';
const V2 = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

/**
 * The series worth following, with what each one actually measures.
 *
 * A BLS series id is opaque by design — `LNS14000000` is the unemployment
 * rate and nothing about the string says so — so the label, the unit and the
 * direction that counts as good news all live here rather than being inferred.
 */
export const SERIES = {
  LNS14000000: {
    label: 'Unemployment rate',
    unit: '%',
    frequency: 'monthly',
    tags: ['unemployment', 'headline'],
  },
  CES0000000001: {
    label: 'Total nonfarm payrolls',
    unit: 'thousands of jobs',
    frequency: 'monthly',
    tags: ['payrolls', 'headline'],
  },
  LNS11300000: {
    label: 'Labor force participation rate',
    unit: '%',
    frequency: 'monthly',
    tags: ['participation'],
  },
  LNS12300000: {
    label: 'Employment-population ratio',
    unit: '%',
    frequency: 'monthly',
    tags: ['employment'],
  },
  CES0500000003: {
    label: 'Average hourly earnings, private',
    unit: 'dollars an hour',
    frequency: 'monthly',
    tags: ['earnings', 'wages'],
  },
  JTS000000000000000JOL: {
    label: 'Job openings',
    unit: 'thousands of openings',
    frequency: 'monthly',
    tags: ['openings', 'jolts'],
  },
  JTS000000000000000QUL: {
    label: 'Quits',
    unit: 'thousands of quits',
    frequency: 'monthly',
    tags: ['quits', 'jolts'],
  },
  JTS000000000000000LDL: {
    label: 'Layoffs and discharges',
    unit: 'thousands',
    frequency: 'monthly',
    tags: ['layoffs', 'jolts'],
  },
  CUUR0000SA0: {
    label: 'Consumer Price Index, all items',
    unit: 'index, 1982-84 = 100',
    frequency: 'monthly',
    tags: ['cpi', 'inflation'],
  },
};

export const SERIES_IDS = Object.keys(SERIES);

/**
 * A BLS period to a month, or nothing.
 *
 * M01-M12 are months. M13 is the annual average, Q01-Q05 are quarters and
 * S01-S03 are half-years, and none of those is a month however much the code
 * looks like one. Returning null rather than guessing is what stops an annual
 * average being filed as a thirteenth month or, worse, as December.
 */
export function periodDate(year, period) {
  const y = String(year ?? '').trim();
  if (!/^\d{4}$/.test(y)) return null;
  const m = /^M(\d{2})$/.exec(String(period ?? '').trim());
  if (m) {
    const month = Number(m[1]);
    // M13 is the annual average and is not a month.
    return month >= 1 && month <= 12 ? `${y}-${m[1]}-01` : null;
  }
  const q = /^Q0([1-4])$/.exec(String(period ?? '').trim());
  if (q) return `${y}-${String((Number(q[1]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  const a = /^A01$/.test(String(period ?? '').trim());
  if (a) return `${y}-01-01`;
  return null;
}

export function toItem(seriesId, point, spec) {
  const when = periodDate(point.year, point.period);
  if (!when) return null;
  const value = Number(point.value);
  if (!Number.isFinite(value)) return null;
  const label = spec?.label ?? seriesId;
  const unit = spec?.unit ?? '';
  const preliminary = (point.footnotes ?? []).some((f) => f?.code === 'P');

  return {
    externalId: `bls-${seriesId}-${point.year}-${point.period}`,
    kind: 'labour-statistic',
    title: `US ${label.toLowerCase()}, ${point.periodName} ${point.year}: ${point.value}${unit === '%' ? '%' : ''}`,
    summary: `The Bureau of Labor Statistics reports ${label.toLowerCase()} at ${point.value} ${unit} for ${point.periodName} ${point.year}${preliminary ? '. This figure is preliminary and will be revised' : ''}.`,
    url: `https://data.bls.gov/timeseries/${encodeURIComponent(seriesId)}`,
    publishedAt: when,
    timeKnown: false,
    precision: 'month',
    tags: [
      'jobs',
      'us',
      'bls',
      'statistic',
      ...(spec?.tags ?? []),
      slugify(label).slice(0, 40),
      preliminary ? 'preliminary' : null,
      point.latest === 'true' ? 'latest' : null,
    ].filter(Boolean),
    data: {
      // The same measure shape the Eurostat rows use, so a US figure and a
      // European one can sit in one feed without the reader translating.
      measure: {
        name: label,
        value,
        unit,
        period: `${point.year}-${point.period}`,
        area: 'United States',
        areaCode: 'US',
        country: 'US',
      },
      seriesId,
      periodName: point.periodName,
      // A first estimate that will move. Saying so is the difference between a
      // number and a number somebody can rely on.
      preliminary,
      footnotes: (point.footnotes ?? []).filter((f) => f && Object.keys(f).length),
      source: 'US Bureau of Labor Statistics',
      licence: 'US public domain',
    },
  };
}

export const blsSeries = defineAdapter({
  name: 'bls-series',
  title: 'US labour statistics (BLS)',
  collection: 'jobs',
  description:
    'The US jobs numbers as they are published: unemployment rate, nonfarm payrolls, job openings, quits, layoffs, average hourly earnings, participation and CPI, one row per series per month. Keyless on the public v1 API; set BLS_API_KEY for the higher v2 limits.',
  docs: 'https://www.bls.gov/developers/api_signature.htm',
  kinds: ['labour-statistic'],
  // The employment situation lands monthly and JOLTS a few weeks later.
  // Twice a day finds a release promptly and stays far inside the v1 limit of
  // twenty-five queries a day, since every series is fetched in one query.
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'series',
      label: 'Series ids',
      type: 'list',
      help: `Empty for all of: ${SERIES_IDS.join(', ')}. Any BLS series id works.`,
    },
    {
      key: 'years',
      label: 'Years of history',
      type: 'number',
      placeholder: '2',
    },
  ],
  defaults: { years: 2 },
  defaultSources: [{ slug: 'us-jobs-report', name: 'US jobs report: the headline series' }],
  async pull({ config, env, http, log }) {
    const wanted = (Array.isArray(config.series) ? config.series : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const seriesid = (wanted.length ? wanted : SERIES_IDS).slice(0, 25);

    const now = new Date().getUTCFullYear();
    const years = Math.min(Math.max(Number(config.years) || 2, 1), 10);
    const body = {
      seriesid,
      startyear: String(now - (years - 1)),
      endyear: String(now),
    };
    // A registered key unlocks v2 and its far higher limits. Everything works
    // without one, which is the point of defaulting to v1.
    if (env.blsApiKey) body.registrationkey = env.blsApiKey;

    const res = await http.json(env.blsApiKey ? V2 : V1, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    });

    if (res?.status && res.status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS refused the request: ${(res.message ?? []).join('; ') || res.status}`);
    }

    const items = [];
    let skipped = 0;
    for (const s of res?.Results?.series ?? []) {
      const spec = SERIES[s.seriesID];
      for (const point of s.data ?? []) {
        const item = toItem(s.seriesID, point, spec);
        if (item) items.push(item);
        else skipped++;
      }
    }
    // Almost always the M13 annual averages, which are real data and simply
    // not monthly. Counted rather than silently dropped.
    if (skipped) log(`${skipped} non-monthly period(s) skipped (M13 annual averages and the like)`);
    log(`${items.length} observation(s) across ${seriesid.length} series`);
    return { items, note: `${items.length} points` };
  },
});
