import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * US consumer product recalls, from the CPSC.
 *
 * The other half of a parts collection. A model number on its own says what an
 * appliance is; a recall says the thing is dangerous and that the manufacturer
 * will pay to fix it — which is the single most valuable fact anybody
 * searching for a part for that model could be told, and it is free.
 *
 * The CPSC publishes every recall it announces as REST, keyless, JSON or XML.
 * Measured on 2026-09-25 it was running about fifty recalls a month with the
 * newest dated the previous day, so a daily read is never more than a day
 * behind the press release.
 *
 * Two fields make this joinable rather than merely readable. `Products[].Model`
 * carries the manufacturer's model numbers, which is what the ENERGY STAR
 * catalogue is keyed on, and `ProductUPCs` carries barcodes, which is what a
 * scan produces. Both are frequently empty — a recall is written for people,
 * not for databases, and plenty of them identify the product only in prose —
 * so both are kept as lists that are allowed to be empty rather than as a
 * single value that would have to be invented.
 *
 * The date fields are not interchangeable. `RecallDate` is when the recall was
 * announced and `LastPublishDate` is when the page was last edited, which
 * moves years later when a remedy changes. The feed is ordered on the
 * announcement, because that is the event; the edit date is carried in `data`
 * for anyone reconciling against a previous pull.
 */

const BASE = 'https://www.saferproducts.gov/RestWebServices/Recall';

/** The API writes dates as `2026-09-24T00:00:00`, with no zone. */
export function recallDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/** `YYYY-MM-DD`, n days on from a date. */
export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The `Name` off a list of `{ Name }`, dropped if empty. */
export function names(list, key = 'Name') {
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list
        .map((e) =>
          String(e?.[key] ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

/**
 * The model numbers a recall names, split out of the free-text cell.
 *
 * `Model` is one string holding anything from `` to `YD-001` to
 * `WRF535SWHZ00, WRF535SWHZ01 and WRF535SWHZ02`. Splitting on separators and
 * the word "and" gets the individual numbers out; anything that is plainly
 * prose rather than a model number is dropped, because a "model" of `and the
 * following` would match nothing and pollute every join made against it.
 */
export function modelNumbers(products) {
  if (!Array.isArray(products)) return [];
  const out = new Set();
  for (const p of products) {
    const raw = String(p?.Model ?? '').trim();
    if (!raw) continue;
    for (const part of raw.split(/[,;/|]|\band\b/i)) {
      const model = part.replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
      // A model number has a digit in it and is not a sentence.
      if (!model || model.length > 60) continue;
      if (!/\d/.test(model)) continue;
      if (model.split(' ').length > 4) continue;
      out.add(model);
    }
  }
  return [...out];
}

/** Barcodes a recall lists, kept only at lengths a GTIN actually has. */
export function upcs(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const e of list) {
    const digits = String(e?.UPC ?? e?.Name ?? '').replace(/\D/g, '');
    if ([8, 12, 13, 14].includes(digits.length)) out.add(digits);
  }
  return [...out];
}

/** How many units, as the CPSC writes it: "About 324". Prose, kept as prose. */
export function units(products) {
  if (!Array.isArray(products)) return null;
  for (const p of products) {
    const u = String(p?.NumberOfUnits ?? '').trim();
    if (u) return u;
  }
  return null;
}

export function toItem(r) {
  const id = String(r?.RecallNumber ?? r?.RecallID ?? '').trim();
  const title = String(r?.Title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!id || !title) return null;

  const when = recallDate(r.RecallDate);
  const products = Array.isArray(r.Products) ? r.Products : [];
  const models = modelNumbers(products);
  const codes = upcs(r.ProductUPCs);
  const hazards = names(r.Hazards);
  const remedies = names(r.RemedyOptions, 'Option');
  const types = [...new Set(products.map((p) => String(p?.Type ?? '').trim()).filter(Boolean))];
  const count = units(products);

  const summaryBits = [
    hazards[0] ? hazards[0].slice(0, 300) : null,
    remedies.length ? `Remedy: ${remedies.join(', ')}.` : null,
    count ? `${count} units.` : null,
    models.length ? `Models: ${models.slice(0, 8).join(', ')}.` : null,
  ].filter(Boolean);

  return {
    externalId: `cpsc-${id}`,
    kind: 'recall',
    title,
    summary: summaryBits.join(' ') || String(r.Description ?? '').slice(0, 400),
    url: String(r.URL ?? '').trim() || null,
    imageUrl: (Array.isArray(r.Images) && String(r.Images[0]?.URL ?? '').trim()) || null,
    publishedAt: when,
    timeKnown: false,
    precision: 'day',
    tags: [
      'recall',
      'safety',
      'us',
      ...types.map((t) => slugify(t)).filter(Boolean),
      ...remedies.map((t) => slugify(t)).filter(Boolean),
    ],
    data: {
      recallNumber: r.RecallNumber ?? null,
      recallId: r.RecallID ?? null,
      recallDate: when,
      // When the page was last edited, which is not when the recall happened.
      lastPublishDate: recallDate(r.LastPublishDate),
      description:
        String(r.Description ?? '')
          .replace(/\s+/g, ' ')
          .trim() || null,
      // The join keys. Both are routinely empty: a recall is written for
      // people, and many identify the product only in prose.
      modelNumbers: models,
      upcs: codes,
      productNames: names(products),
      productTypes: types,
      unitsAffected: count,
      hazards,
      remedies: names(r.Remedies),
      remedyOptions: remedies,
      injuries: names(r.Injuries),
      manufacturers: names(r.Manufacturers),
      importers: names(r.Importers),
      distributors: names(r.Distributors),
      retailers: names(r.Retailers),
      manufacturerCountries: names(r.ManufacturerCountries, 'Country'),
      consumerContact:
        String(r.ConsumerContact ?? '')
          .replace(/\s+/g, ' ')
          .trim() || null,
      source: 'US Consumer Product Safety Commission (public domain)',
    },
  };
}

export const cpscRecalls = defineAdapter({
  name: 'cpsc-recalls',
  title: 'Product recalls (CPSC)',
  collection: 'parts',
  description:
    'Every consumer product recall the US Consumer Product Safety Commission announces, with the model numbers and barcodes affected, the hazard, and the remedy the manufacturer owes. Keyless, public domain, about fifty a month.',
  docs: 'https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information',
  kinds: ['recall'],
  cadenceMinutes: 60 * 12,
  configFields: [
    {
      key: 'backfillFrom',
      label: 'Backfill from',
      placeholder: '2015-01-01',
      help: 'The earliest recall date to walk back to on a first run. The archive goes back decades.',
    },
    {
      key: 'windowDays',
      label: 'Days per request',
      type: 'number',
      placeholder: '90',
    },
  ],
  defaults: { backfillFrom: '2015-01-01', windowDays: 90 },
  defaultSources: [{ slug: 'cpsc-recalls', name: 'US product recalls' }],
  async *pull({ config, cursor, http, log, deadline }) {
    const today = new Date().toISOString().slice(0, 10);
    const floor = recallDate(config.backfillFrom) ?? '2015-01-01';
    const window = Math.min(Math.max(Number(config.windowDays) || 90, 1), 365);

    /*
     * The walk goes backwards from today to the floor on a first run, then on
     * later runs re-reads only from the newest recall already seen. `>=` on
     * that date rather than `>`: these are dates, so a second recall announced
     * the same day would fall through a strict comparison. Upserts are
     * idempotent, so the overlap costs no writes.
     */
    const highWater = cursor?.highWater ?? null;
    let end = cursor?.backfillDone === true ? today : (cursor?.end ?? today);
    const stopAt = cursor?.backfillDone === true ? (highWater ?? floor) : floor;

    let seen = 0;
    let newest = highWater;

    while (end >= stopAt) {
      if (Date.now() > deadline) {
        log(`deadline reached at ${end}`);
        return {
          cursor: { end, highWater: newest, backfillDone: cursor?.backfillDone ?? false },
          note: `${seen} recall(s), stopped at ${end}`,
        };
      }

      const start = (() => {
        const back = addDays(end, -(window - 1));
        return back && back > stopAt ? back : stopAt;
      })();

      const params = new URLSearchParams({
        format: 'json',
        RecallDateStart: start,
        RecallDateEnd: end,
      });
      const rows = await http.json(`${BASE}?${params}`, {
        headers: { accept: 'application/json' },
        timeoutMs: 45_000,
      });

      if (!Array.isArray(rows)) throw new Error('CPSC returned something other than an array');

      const items = [];
      for (const r of rows) {
        const item = toItem(r);
        if (!item) continue;
        items.push(item);
        if (item.publishedAt && (!newest || item.publishedAt > newest)) newest = item.publishedAt;
      }
      seen += items.length;

      const nextEnd = addDays(start, -1);
      const done = !nextEnd || start <= stopAt;
      const nextCursor = done
        ? { end: today, highWater: newest, backfillDone: true }
        : { end: nextEnd, highWater: newest, backfillDone: cursor?.backfillDone ?? false };

      if (items.length) yield { items, cursor: nextCursor };
      if (done) {
        log(`walk complete through ${newest ?? 'nothing'}`);
        return { cursor: nextCursor, note: `${seen} recall(s), newest ${newest ?? 'none'}` };
      }
      end = nextEnd;
    }

    return {
      cursor: { end: today, highWater: newest, backfillDone: true },
      note: `${seen} recall(s), newest ${newest ?? 'none'}`,
    };
  },
});
