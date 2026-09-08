import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * ISO 10383: every market venue in the world, from the registry that defines them.
 *
 * A Market Identifier Code is the answer to "which exchange", and the ISO 10383
 * register is where the answer is decided rather than guessed. It is maintained
 * by SWIFT as the registration authority, published monthly as a CSV, and it
 * holds roughly 2,300 active codes across 149 countries: the Nairobi Securities
 * Exchange and the Bolsa de Valores de Lima are in it on exactly the same terms
 * as NASDAQ.
 *
 * This is the one source here that genuinely spans the world's exchanges, and
 * it is a register rather than a ticker feed. That is a real distinction and
 * the collection is careful about it: nichedb can tell you that XNAI is the
 * Nairobi Securities Exchange, that it is a regulated market operating in
 * Kenya, and who the legal entity behind it is. It cannot tell you what a share
 * did there today, because nobody gives that away.
 *
 * The register is also a history. Codes expire when an exchange closes or
 * merges, and an EXPIRED row is not noise to be filtered out — an exchange
 * shutting down is exactly the kind of thing a feed should carry — so status
 * changes are published as items rather than dropped.
 */

/** The market categories ISO 10383 uses, spelled out. `RMKT` tells nobody anything. */
const CATEGORIES = {
  APPA: 'approved publication arrangement',
  ATSS: 'alternative trading system',
  CASP: 'crypto asset service provider',
  DCMS: 'designated contract market',
  IDQS: 'inter-dealer quotation system',
  MLTF: 'multilateral trading facility',
  NSPD: 'not specified',
  OTFS: 'organised trading facility',
  OTHR: 'other',
  RMKT: 'regulated market',
  RMOS: 'risk management or settlement',
  SEFS: 'swap execution facility',
  SINT: 'systematic internaliser',
  TRFS: 'trade reporting facility',
};

/**
 * A CSV reader that survives a quoted comma.
 *
 * Exchange names are full of them ("OMIP - POLO PORTUGUES, S.G.M.R., S.A."),
 * so splitting on commas would silently shift every column after the name and
 * file a Portuguese energy market in the wrong country. Small, and worth
 * having rather than a dependency.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // A blank trailing line is not a row of one empty column.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** ISO 10383 dates are YYYYMMDD, with no separators and often blank. */
export function micDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The register writes websites without a scheme, in capitals. */
export function website(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s || s === 'n/a') return null;
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

export function toItem(r) {
  const mic = r.MIC;
  const operating = r['OPERATING MIC'];
  const isSegment = r['OPRT/SGMT'] === 'SGMT';
  const country = r['ISO COUNTRY CODE (ISO 3166)'];
  const category = r['MARKET CATEGORY CODE'];
  const status = String(r.STATUS ?? '').toUpperCase();
  const name = r['MARKET NAME-INSTITUTION DESCRIPTION'] || mic;
  // The register's last word on the row, whichever field carries it. A status
  // change and a detail correction both land here, and the item is keyed on it
  // so a row that changed is news and a row that did not is not.
  const changed = micDate(r['LAST UPDATE DATE']) ?? micDate(r['CREATION DATE']);

  return {
    // MIC plus the date the register last touched it. An exchange that closed,
    // renamed or moved country produces a new row; one that sat still does not.
    externalId: changed ? `${mic}@${changed}` : mic,
    kind: 'exchange',
    title: `${mic} — ${name}${status !== 'ACTIVE' ? ` (${status.toLowerCase()})` : ''}`,
    summary: [
      `${name} is ${isSegment ? 'a market segment' : 'an operating market'}`,
      CATEGORIES[category] ? `registered as ${CATEGORIES[category]}` : null,
      r.CITY ? `in ${titleCase(r.CITY)}` : null,
      country ? `(${country})` : null,
      isSegment && operating && operating !== mic ? `, operated under ${operating}` : null,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(' ,', ',')
      .concat('.'),
    url: website(r.WEBSITE),
    publishedAt: changed,
    timeKnown: false,
    precision: 'day',
    tags: [
      'mic',
      'exchange',
      country ? country.toLowerCase() : null,
      category ? category.toLowerCase() : null,
      CATEGORIES[category] ? slugify(CATEGORIES[category]) : null,
      status.toLowerCase(),
      isSegment ? 'segment' : 'operating',
      r.CITY ? slugify(r.CITY) : null,
      r.ACRONYM ? slugify(r.ACRONYM) : null,
    ].filter(Boolean),
    data: {
      mic,
      operatingMic: operating || null,
      segment: isSegment,
      name,
      legalEntity: r['LEGAL ENTITY NAME'] || null,
      // The LEI ties a venue to the global legal-entity register, which is how
      // an exchange here can be joined to company data anywhere else.
      lei: r.LEI || null,
      category,
      categoryName: CATEGORIES[category] ?? null,
      acronym: r.ACRONYM || null,
      country,
      city: r.CITY ? titleCase(r.CITY) : null,
      website: website(r.WEBSITE),
      status,
      created: micDate(r['CREATION DATE']),
      lastUpdated: micDate(r['LAST UPDATE DATE']),
      lastValidated: micDate(r['LAST VALIDATION DATE']),
      expires: micDate(r['EXPIRY DATE']),
      comments: r.COMMENTS || null,
    },
  };
}

/** The register shouts. "TORONTO" is a city; "Toronto" is a city in a sentence. */
function titleCase(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export const isoMicExchanges = defineAdapter({
  name: 'iso-mic-exchanges',
  title: 'World exchanges (ISO 10383 MIC)',
  collection: 'markets',
  description:
    'Every market venue in the world from the ISO 10383 register that defines them: about 2,300 active Market Identifier Codes across 149 countries, with the operating institution, its legal entity and LEI, market category, city, country and website. Maintained by SWIFT as the ISO registration authority. Keyless.',
  docs: 'https://www.iso20022.org/market-identifier-codes',
  kinds: ['exchange'],
  // The register is republished monthly. Daily is frequent enough to catch a
  // new edition promptly and rare enough to be a good citizen about a 600 KB
  // file that changes a few dozen rows a month.
  cadenceMinutes: 60 * 24,
  configFields: [
    {
      key: 'country',
      label: 'Country code',
      placeholder: 'KE',
      help: 'Optional ISO 3166 two-letter code; empty for the whole world.',
    },
    {
      key: 'category',
      label: 'Market category',
      type: 'select',
      options: ['', ...Object.keys(CATEGORIES)],
      help: 'RMKT is a regulated exchange. Empty for every category.',
    },
    {
      key: 'operatingOnly',
      label: 'Operating markets only',
      type: 'select',
      options: ['', 'yes'],
      help: 'Exclude the segments that trade under another venue’s code.',
    },
  ],
  defaults: {},
  defaultSources: [
    {
      slug: 'world-exchanges',
      name: 'World exchanges: every operating market venue',
      config: { operatingOnly: 'yes' },
    },
    {
      slug: 'regulated-exchanges',
      name: 'Regulated stock exchanges worldwide',
      config: { category: 'RMKT', operatingOnly: 'yes' },
    },
  ],
  async pull({ config, http, log }) {
    const text = await http.text(
      'https://www.iso20022.org/sites/default/files/ISO10383_MIC/ISO10383_MIC.csv',
      { headers: { accept: 'text/csv, */*' }, timeoutMs: 60_000 },
    );
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('the MIC register parsed to nothing');

    const country = String(config.country ?? '')
      .trim()
      .toUpperCase();
    const filtered = rows.filter((r) => {
      if (!r.MIC) return false;
      if (country && r['ISO COUNTRY CODE (ISO 3166)'] !== country) return false;
      if (config.category && r['MARKET CATEGORY CODE'] !== config.category) return false;
      if (config.operatingOnly === 'yes' && r['OPRT/SGMT'] === 'SGMT') return false;
      return true;
    });

    const items = filtered.map(toItem);
    log(`${items.length} market identifier code(s) of ${rows.length} in the register`);
    return {
      items,
      note: `${items.length} of ${rows.length}`,
      // The register is one file republished whole, so there is no cursor to
      // keep: the content hash decides what is actually a change.
    };
  },
});
