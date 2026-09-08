import { defineAdapter } from '@nichedb/core/adapter';

/**
 * NOAA's Space Weather Prediction Center: geomagnetic storms and radio blackouts.
 *
 * Weather that arrives from the sun rather than the sky, and the one kind that
 * reaches everybody's infrastructure at once: power grids, GPS accuracy, HF
 * radio, satellite drag and the aurora. Keyless, US public domain.
 *
 * The payload is awkward on purpose. SWPC publishes the operational teleprinter
 * message as a single text blob, because that is what it has always been, so
 * the useful fields — the scale, the K-index, the validity window — have to be
 * read out of it. Parsing it here is the whole value: an item nobody can filter
 * by G-scale is a wall of telegrams.
 */

/** `Space Weather Message Code: WARK05` and friends: a line-oriented header block. */
export function parseMessage(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z .-]*?):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]
      .trim()
      .toLowerCase()
      .replace(/[\s.]+/g, '_');
    // A key repeats when the impact block restates it; the first wins, which
    // is the header rather than the prose.
    if (!(key in out)) out[key] = m[2].trim();
  }
  return out;
}

/**
 * The NOAA scale: G for geomagnetic, S for radiation, R for radio blackout,
 * each 1 to 5. It is the field a reader actually filters on, and it appears in
 * the message as "G1 - Minor" or occasionally only in the impacts block.
 */
export function scaleOf(text) {
  const m = /\b([GSR])([1-5])\b(?:\s*-\s*([A-Za-z]+))?/.exec(String(text ?? ''));
  if (!m) return null;
  const kinds = { G: 'geomagnetic storm', S: 'solar radiation storm', R: 'radio blackout' };
  return {
    code: `${m[1]}${m[2]}`,
    letter: m[1],
    level: Number(m[2]),
    kind: kinds[m[1]],
    label: m[3] ? m[3].toLowerCase() : null,
  };
}

/** WATCH, WARNING, ALERT or SUMMARY: how much has already happened. */
export function noticeOf(text) {
  const m = /^\s*(WATCH|WARNING|ALERT|SUMMARY|EXTENDED WARNING|CANCEL WARNING)\s*:/im.exec(
    String(text ?? ''),
  );
  return m ? m[1].toLowerCase().replace(/\s+/g, '-') : null;
}

/** SWPC timestamps read "2026 Sep 07 2001 UTC". */
export function swpcDate(s) {
  const m = /^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s*UTC$/.exec(
    String(s ?? '').trim(),
  );
  if (!m) return null;
  const months = 'JanFebMarAprMayJunJulAugSepOctNovDec';
  const month = months.indexOf(m[2]) / 3;
  if (!Number.isInteger(month) || month < 0) return null;
  return new Date(Date.UTC(+m[1], month, +m[3], +m[4], +m[5])).toISOString();
}

export function toItem(row) {
  const text = String(row.message ?? '');
  const fields = parseMessage(text);
  const scale = scaleOf(text);
  const notice = noticeOf(text);
  // The first line after the header block that reads like a sentence about
  // what is expected, which is what belongs in a title.
  const headline =
    /^(?:WATCH|WARNING|ALERT|SUMMARY|EXTENDED WARNING|CANCEL WARNING)\s*:\s*(.+)$/im.exec(
      text,
    )?.[1] ??
    fields.space_weather_message_code ??
    'Space weather message';

  return {
    externalId: `swpc-${row.product_id}-${row.issue_datetime}`,
    kind: 'space-weather',
    title: [
      scale ? `${scale.code}${scale.label ? ` ${scale.label}` : ''}` : null,
      headline.trim().replace(/\s+/g, ' ').slice(0, 300),
    ]
      .filter(Boolean)
      .join(': '),
    summary:
      [fields.potential_impacts, fields.comment, fields.warning_condition]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 800) || null,
    url: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings',
    publishedAt: swpcDate(fields.issue_time) ?? row.issue_datetime ?? null,
    tags: [
      'swpc',
      'space-weather',
      notice,
      scale?.code?.toLowerCase() ?? null,
      scale ? scale.kind.replace(/\s+/g, '-') : null,
      scale && scale.level >= 3 ? 'severe' : null,
      // The one everybody actually wants a notification for.
      scale?.letter === 'G' && scale.level >= 3 ? 'aurora-likely' : null,
    ].filter(Boolean),
    data: {
      productId: row.product_id,
      messageCode: fields.space_weather_message_code ?? null,
      serialNumber: fields.serial_number ?? null,
      notice,
      scale,
      validFrom: swpcDate(fields.valid_from) ?? null,
      validTo: swpcDate(fields.valid_to) ?? null,
      condition: fields.warning_condition ?? null,
      impacts: fields.potential_impacts ?? null,
      // The operational message, kept whole. It is the primary source and it
      // is short, and every parse above is a guess we might have got wrong.
      message: text.slice(0, 4000),
    },
  };
}

export const swpcSpaceWeather = defineAdapter({
  name: 'swpc-space-weather',
  title: 'NOAA space weather alerts',
  collection: 'weather',
  description:
    'Geomagnetic storm watches, warnings and alerts from NOAA’s Space Weather Prediction Center, with the NOAA G, S and R scale parsed out of the operational message, the validity window and the stated impacts on power grids, GPS, HF radio and satellites. Keyless, US public domain.',
  docs: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings',
  kinds: ['space-weather'],
  cadenceMinutes: 20,
  configFields: [
    {
      key: 'minimumLevel',
      label: 'Minimum NOAA scale level',
      type: 'select',
      options: ['', '1', '2', '3', '4', '5'],
      help: 'Empty for everything, or 3 for the storms that reach power grids and drop the aurora into the mid-latitudes.',
    },
  ],
  defaultSources: [{ slug: 'space-weather', name: 'Space weather: storms, flares and blackouts' }],
  async pull({ config, http, log }) {
    const rows = await http.json('https://services.swpc.noaa.gov/products/alerts.json', {
      timeoutMs: 30_000,
    });
    const floor = Number(config.minimumLevel) || 0;
    const items = (Array.isArray(rows) ? rows : [])
      .map(toItem)
      // A message with no scale at all is kept unless a floor was asked for:
      // "cancel warning" carries no G number and is still worth having.
      .filter((i) => !floor || (i.data.scale?.level ?? 0) >= floor);
    log(`${items.length} space weather message(s)`);
    return { items, note: `${items.length} messages` };
  },
});
