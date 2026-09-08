import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * WARN notices: the layoffs an employer is legally required to announce.
 *
 * The Worker Adjustment and Retraining Notification Act makes an employer of
 * a hundred or more people give sixty days' notice before a mass layoff or a
 * plant closing, and the notice goes to the state. That makes WARN the only
 * public, named, dated, counted record of job losses in the United States —
 * everything else in the jobs collection is a statistic about the labour
 * market, and this is a list of specific companies letting specific numbers of
 * people go on a specific date.
 *
 * The coverage here is honest about being thin. Every state receives WARN
 * notices and publishes them somehow; almost all of them publish a PDF, an
 * XLSX or an HTML table that changes shape without warning, and searching
 * every Socrata portal for WARN data turns up exactly one state with a proper
 * API. So Texas is what ships, the adapter is written so any other state on a
 * Socrata portal is a source's config rather than a code change, and the
 * collection does not pretend the other forty-nine are covered.
 *
 * The dates matter and there are two. The notice date is when the employer
 * told the state; the layoff date is when people actually lose their jobs, and
 * it is typically sixty days later. A feed keyed on the layoff date would go
 * quiet for two months and then report the news late, so items are filed under
 * the notice date and carry both.
 */

/**
 * The states with a machine-readable WARN feed, checked 2026-09-08.
 *
 * `newestSeen` is what the portal actually returned when the preset was
 * written, for the same reason the crime portals carry one: a state that stops
 * publishing looks exactly like a state where nobody is being laid off.
 */
export const STATES = {
  texas: {
    state: 'TX',
    stateName: 'Texas',
    domain: 'data.texas.gov',
    dataset: '8w53-c4f6',
    employerField: 'job_site_name',
    noticeDateField: 'notice_date',
    layoffDateField: 'layoff_date',
    countField: 'total_layoff_number',
    cityField: 'city_name',
    countyField: 'county_name',
    areaField: 'wda_name',
    newestSeen: '2026-06-23',
  },
};

export const STATE_KEYS = Object.keys(STATES);

const clean = (v) => {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
};

/** Portals write dates several ways; keep what parses and say nothing otherwise. */
export function warnDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) {
    const p = (n) => String(n).padStart(2, '0');
    return `${us[3]}-${p(us[1])}-${p(us[2])}`;
  }
  return null;
}

export function toItem(row, place) {
  const employer = clean(row[place.employerField]);
  const noticed = warnDate(row[place.noticeDateField]);
  if (!employer || !noticed) return null;

  const count = Number(String(row[place.countField] ?? '').replace(/[^\d.-]/g, ''));
  const workers = Number.isFinite(count) && count > 0 ? count : null;
  const layoffDate = warnDate(row[place.layoffDateField]);
  const city = place.cityField ? clean(row[place.cityField]) : null;
  const county = place.countyField ? clean(row[place.countyField]) : null;
  const area = place.areaField ? clean(row[place.areaField]) : null;

  return {
    // Employer, place, notice date and the layoff date. One employer can file
    // two notices on the same day for the same city covering separate sites or
    // separate waves, and keying without the layoff date collapsed those into
    // one row that overwrote itself.
    externalId: [
      'warn',
      place.state.toLowerCase(),
      slugify(employer).slice(0, 60),
      noticed,
      slugify(city ?? ''),
      layoffDate ?? 'x',
      workers ?? 'x',
      // Socrata's own row identifier, where the portal exposes one, as the
      // tiebreaker for two notices identical in every other field. Texas does
      // not expose it and does publish one byte-identical duplicate row, and
      // those two collapse into a single item deliberately: rows that differ
      // in nothing a reader can see are one notice as far as anybody can tell,
      // and separating them would take inventing a difference or keying on a
      // position in the result set that moves on the next read.
      row[':id'] ?? '',
    ]
      .filter((p) => p !== '' && p !== null && p !== undefined)
      .join('-')
      .slice(0, 200),
    kind: 'layoff-notice',
    title: `${employer}: ${workers ? `${workers.toLocaleString('en-US')} jobs` : 'layoffs'} in ${city ?? county ?? place.stateName}`,
    summary: [
      `${employer} filed a WARN notice with ${place.stateName} on ${noticed}`,
      workers ? `covering ${workers.toLocaleString('en-US')} workers` : null,
      city || county
        ? `at ${[city, county ? `${county} County` : null].filter(Boolean).join(', ')}`
        : null,
      layoffDate ? `with the layoffs taking effect ${layoffDate}` : null,
    ]
      .filter(Boolean)
      .join(', ')
      .concat(
        '. Employers of a hundred or more must give sixty days’ notice of a mass layoff or plant closing, so a notice is usually filed well before anyone loses their job.',
      ),
    url: `https://${place.domain}/d/${place.dataset}`,
    // Filed under the notice, not the layoff: the news is the announcement.
    publishedAt: noticed,
    timeKnown: false,
    precision: 'day',
    tags: [
      'jobs',
      'us',
      'layoffs',
      'warn',
      place.state.toLowerCase(),
      city ? slugify(city).slice(0, 40) : null,
      county ? slugify(county).slice(0, 40) : null,
      workers && workers >= 1000 ? 'thousand-plus' : null,
      workers && workers >= 100 ? 'hundred-plus' : null,
    ].filter(Boolean),
    data: {
      place: {
        country: 'US',
        state: place.state,
        city,
        area: county ?? area,
      },
      employer,
      workers,
      // Both dates, because they are two different facts about one event and
      // the gap between them is the notice period the law requires.
      noticeDate: noticed,
      layoffDate,
      workforceArea: area,
      basis: 'warn-notice',
      note: 'A WARN notice is a legal filing about a planned layoff, not a count of jobs already lost. Numbers are the employer’s own estimate at the time of filing and are sometimes revised or withdrawn.',
      source: `${place.stateName} WARN notices`,
      raw: row,
    },
  };
}

/** A source's config over its state preset, so a new state needs no code. */
export function placeFor(config) {
  const preset = STATES[String(config.state ?? '').toLowerCase()] ?? {};
  const pick = (k, fallback = null) => {
    const v = config[k];
    return v === undefined || v === '' ? (preset[k] ?? fallback) : v;
  };
  return {
    state: pick('stateCode', preset.state ?? 'ZZ'),
    stateName: pick('stateName', preset.stateName ?? 'Unknown'),
    domain: pick('domain'),
    dataset: pick('dataset'),
    employerField: pick('employerField', 'company'),
    noticeDateField: pick('noticeDateField', 'notice_date'),
    layoffDateField: pick('layoffDateField'),
    countField: pick('countField'),
    cityField: pick('cityField'),
    countyField: pick('countyField'),
    areaField: pick('areaField'),
  };
}

export const warnLayoffs = defineAdapter({
  name: 'warn-layoffs',
  title: 'WARN layoff notices',
  collection: 'jobs',
  description:
    'Mass layoffs and plant closings as employers file them with the state, naming the company, the site and the number of workers. The only public, named record of US job losses; everything else in this collection is a statistic. Texas ships by default because it is the one state with a proper API, and any other Socrata portal is a config away. Keyless.',
  docs: 'https://www.dol.gov/agencies/eta/layoffs/warn',
  kinds: ['layoff-notice'],
  cadenceMinutes: 60 * 6,
  configFields: [
    {
      key: 'state',
      label: 'State',
      type: 'select',
      options: ['', ...STATE_KEYS],
      help: 'One of the built-in states, or fill in the fields below for another Socrata portal.',
    },
    { key: 'domain', label: 'Portal domain', placeholder: 'data.texas.gov' },
    { key: 'dataset', label: 'Dataset id', placeholder: '8w53-c4f6' },
    { key: 'stateCode', label: 'State code', placeholder: 'TX' },
    { key: 'stateName', label: 'State name', placeholder: 'Texas' },
    { key: 'employerField', label: 'Employer field', placeholder: 'job_site_name' },
    { key: 'noticeDateField', label: 'Notice date field', placeholder: 'notice_date' },
    { key: 'layoffDateField', label: 'Layoff date field', placeholder: 'layoff_date' },
    { key: 'countField', label: 'Worker count field', placeholder: 'total_layoff_number' },
    { key: 'cityField', label: 'City field', placeholder: 'city_name' },
    { key: 'countyField', label: 'County field', placeholder: 'county_name' },
  ],
  defaults: {},
  defaultSources: STATE_KEYS.map((key) => ({
    slug: `warn-${key}`,
    name: `WARN layoff notices: ${STATES[key].stateName}`,
    config: { state: key },
  })),
  async pull({ config, http, log }) {
    const place = placeFor(config);
    for (const required of ['domain', 'dataset', 'employerField', 'noticeDateField']) {
      if (!place[required]) throw new Error(`warn-layoffs needs ${required}`);
    }

    const params = new URLSearchParams({
      $limit: '1000',
      $order: `${place.noticeDateField} DESC`,
    });
    const rows = await http.json(
      `https://${place.domain}/resource/${place.dataset}.json?${params}`,
      { headers: { accept: 'application/json' }, timeoutMs: 60_000 },
    );
    if (!Array.isArray(rows)) throw new Error('the portal did not return a list of rows');

    const items = rows.map((r) => toItem(r, place)).filter(Boolean);
    const workers = items.reduce((n, i) => n + (i.data.workers ?? 0), 0);
    log(
      `${items.length} WARN notice(s) in ${place.stateName}, ${workers.toLocaleString('en-US')} workers`,
    );
    return { items, note: `${items.length} notices` };
  },
});
