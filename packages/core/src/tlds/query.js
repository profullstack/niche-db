/**
 * The top-level domain listing: filter, facet, sort.
 *
 * The whole table is fourteen hundred labels and a few thousand prices, so it
 * is read once and cut in memory; a page, the API and the MCP tool all call
 * this one function and cannot disagree. Facet counts are computed the usual
 * way: each facet counts the rows that pass every other filter, so choosing a
 * type narrows the registrar counts but still shows the other types.
 *
 * Prices are compared within a currency and never converted. "Best" is the
 * cheapest USD price across registrars; with a registrar chosen it is that
 * registrar's own price in its own currency. The default order is by renewal,
 * because the first year is a promotion by another name (OpenTLD, directory
 * rule 3).
 */

export const COMPARE_CURRENCY = 'USD';

export const SORTS = [
  'renew',
  'register',
  'transfer',
  'restore',
  'tld',
  'registrars',
  'type',
  'manager',
  'first_seen',
  'ratio',
];

export const BANDS = [
  { key: 'under-10', label: 'under $10', test: (v) => v < 10 },
  { key: '10-20', label: '$10–20', test: (v) => v >= 10 && v < 20 },
  { key: '20-50', label: '$20–50', test: (v) => v >= 20 && v < 50 },
  { key: '50-100', label: '$50–100', test: (v) => v >= 50 && v < 100 },
  { key: '100-plus', label: '$100 and up', test: (v) => v >= 100 },
];

const cheapest = (prices, key) => {
  let best = null;
  for (const p of prices) {
    const v = p[key];
    if (v === null || v === undefined) continue;
    if (!best || v < best.amount)
      best = {
        amount: v,
        currency: p.currency,
        registrar: p.registrar,
        registrar_name: p.registrar_name,
      };
  }
  return best;
};

/** Join labels to their prices once per catalogue read. */
export function buildRows({ tlds, prices }) {
  const byTld = new Map();
  for (const p of prices) {
    const list = byTld.get(p.tld);
    if (list) list.push(p);
    else byTld.set(p.tld, [p]);
  }
  return tlds.map((t) => {
    const ps = (byTld.get(t.tld) ?? []).sort(
      (a, b) => (a.renew ?? Number.POSITIVE_INFINITY) - (b.renew ?? Number.POSITIVE_INFINITY),
    );
    const usd = ps.filter((p) => p.currency === COMPARE_CURRENCY);
    return {
      ...t,
      prices: ps,
      registrars: ps.map((p) => p.registrar),
      best: {
        register: cheapest(usd, 'register'),
        renew: cheapest(usd, 'renew'),
        transfer: cheapest(usd, 'transfer'),
        restore: cheapest(usd, 'restore'),
      },
    };
  });
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const listParam = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Normalise query parameters, from a URL or a tool call, into one shape. */
export function parseParams(p = {}) {
  const sort = SORTS.includes(p.sort) ? p.sort : 'renew';
  return {
    q: String(p.q ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\./, ''),
    type: listParam(p.type),
    manager: String(p.manager ?? '').trim(),
    registrar: String(p.registrar ?? '').trim(),
    status: ['delegated', 'removed', 'all'].includes(p.status) ? p.status : 'delegated',
    idn:
      p.idn === '1' || p.idn === 1 || p.idn === true
        ? 'yes'
        : p.idn === '0' || p.idn === 0 || p.idn === false
          ? 'no'
          : '',
    priced: p.priced === '1' || p.priced === 1 || p.priced === true,
    band: BANDS.some((b) => b.key === p.band) ? p.band : '',
    maxRenew: num(p.max_renew ?? p.maxRenew),
    maxRegister: num(p.max_register ?? p.maxRegister),
    trap: p.trap === '1' || p.trap === 1 || p.trap === true,
    sort,
    order:
      p.order === 'desc'
        ? 'desc'
        : p.order === 'asc'
          ? 'asc'
          : sort === 'registrars'
            ? 'desc'
            : 'asc',
    limit: Math.min(Math.max(num(p.limit) ?? 100, 1), 2000),
    offset: Math.min(Math.max(num(p.offset) ?? 0, 0), 100_000),
  };
}

/** The prices a row is judged on: the chosen registrar's, or the cheapest USD. */
export function viewOf(row, params) {
  if (params.registrar) {
    const p = row.prices.find((x) => x.registrar === params.registrar);
    if (!p) return { register: null, renew: null, transfer: null, restore: null };
    const at = (key) =>
      p[key] === null || p[key] === undefined
        ? null
        : {
            amount: p[key],
            currency: p.currency,
            registrar: p.registrar,
            registrar_name: p.registrar_name,
          };
    return {
      register: at('register'),
      renew: at('renew'),
      transfer: at('transfer'),
      restore: at('restore'),
    };
  }
  return row.best;
}

const ratioOf = (v) =>
  v.register?.amount && v.renew?.amount
    ? Math.round((v.renew.amount / v.register.amount) * 100) / 100
    : null;

/** Renewal at least twice the first year: the price that bites in year two. */
export const TRAP_RATIO = 2;

function filters(params) {
  const f = [];
  if (params.status !== 'all') f.push(['status', (r) => r.status === params.status]);
  if (params.q)
    f.push([
      'q',
      (r) =>
        r.tld.includes(params.q) ||
        (r.unicode ?? '').toLowerCase().includes(params.q) ||
        (r.manager ?? '').toLowerCase().includes(params.q),
    ]);
  if (params.type.length) f.push(['type', (r) => params.type.includes(r.type ?? 'unknown')]);
  if (params.manager) f.push(['manager', (r) => r.manager === params.manager]);
  if (params.registrar) f.push(['registrar', (r) => r.registrars.includes(params.registrar)]);
  if (params.idn === 'yes') f.push(['idn', (r) => r.tld.startsWith('xn--')]);
  if (params.idn === 'no') f.push(['idn', (r) => !r.tld.startsWith('xn--')]);
  if (params.priced) f.push(['priced', (r) => r.prices.length > 0]);
  if (params.band) {
    const band = BANDS.find((b) => b.key === params.band);
    f.push([
      'band',
      (r) => {
        const v = viewOf(r, params).renew?.amount ?? null;
        return v !== null && band.test(v);
      },
    ]);
  }
  if (params.maxRenew !== null)
    f.push([
      'maxRenew',
      (r) => (viewOf(r, params).renew?.amount ?? Number.POSITIVE_INFINITY) <= params.maxRenew,
    ]);
  if (params.maxRegister !== null)
    f.push([
      'maxRegister',
      (r) => (viewOf(r, params).register?.amount ?? Number.POSITIVE_INFINITY) <= params.maxRegister,
    ]);
  if (params.trap) f.push(['trap', (r) => (ratioOf(viewOf(r, params)) ?? 0) >= TRAP_RATIO]);
  return f;
}

const passes = (row, fs, except) => fs.every(([k, fn]) => k === except || fn(row));

const countBy = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows)
    for (const k of [].concat(keyOf(r)))
      if (k !== null && k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
};

const sortValue = (row, v, key) => {
  switch (key) {
    case 'tld':
      return row.tld;
    case 'type':
      return row.type ?? '';
    case 'manager':
      return (row.manager ?? '').toLowerCase();
    case 'registrars':
      return row.prices.length;
    case 'first_seen':
      return row.first_seen_at ? new Date(row.first_seen_at).getTime() : null;
    case 'ratio':
      return ratioOf(v);
    default:
      return v[key]?.amount ?? null;
  }
};

/**
 * Filter, facet, sort and page. `rows` is `buildRows(catalogue)`.
 * Returns the page of rows, the total that matched, and the facets.
 */
export function queryTlds(rows, raw = {}) {
  const params = parseParams(raw);
  const fs = filters(params);
  const matched = rows.filter((r) => passes(r, fs));

  const facet = (key, keyOf) =>
    countBy(
      rows.filter((r) => passes(r, fs, key)),
      keyOf,
    );
  const facets = {
    status: facet('status', (r) => r.status),
    type: facet('type', (r) => r.type ?? 'unknown'),
    registrar: facet('registrar', (r) => r.registrars),
    manager: facet('manager', (r) => r.manager).slice(0, 40),
    idn: facet('idn', (r) => (r.tld.startsWith('xn--') ? 'yes' : 'no')),
    band: BANDS.map((b) => ({
      value: b.key,
      label: b.label,
      count: rows.filter((r) => {
        if (!passes(r, fs, 'band')) return false;
        const v = viewOf(r, params).renew?.amount ?? null;
        return v !== null && b.test(v);
      }).length,
    })),
    trap: rows.filter(
      (r) => passes(r, fs, 'trap') && (ratioOf(viewOf(r, params)) ?? 0) >= TRAP_RATIO,
    ).length,
  };

  const dir = params.order === 'desc' ? -1 : 1;
  const decorated = matched.map((r) => {
    const v = viewOf(r, params);
    return { r, v, s: sortValue(r, v, params.sort) };
  });
  decorated.sort((a, b) => {
    // Unknown prices sort last in either direction: absence is not cheap.
    if (a.s === null && b.s === null) return a.r.tld.localeCompare(b.r.tld);
    if (a.s === null) return 1;
    if (b.s === null) return -1;
    if (a.s < b.s) return -dir;
    if (a.s > b.s) return dir;
    return a.r.tld.localeCompare(b.r.tld);
  });

  const page = decorated.slice(params.offset, params.offset + params.limit).map(({ r, v }) => ({
    ...r,
    view: v,
    ratio: ratioOf(v),
    trap: (ratioOf(v) ?? 0) >= TRAP_RATIO,
  }));
  return { params, total: matched.length, rows: page, facets };
}

/** One row as the API and MCP serve it. */
export function tldOut(row, siteUrl = '') {
  return {
    tld: row.tld,
    unicode: row.unicode ?? null,
    type: row.type ?? null,
    manager: row.manager ?? null,
    status: row.status,
    rdap: row.rdap ?? null,
    first_seen: row.first_seen ?? null,
    first_seen_at: row.first_seen_at ?? null,
    removed: row.removed ?? null,
    registrars: row.prices?.length ?? 0,
    best: row.view ?? row.best ?? null,
    renewal_ratio: row.ratio ?? null,
    renewal_trap: row.trap ?? false,
    prices: (row.prices ?? []).map(priceOut),
    page: `${siteUrl}/tlds/${row.tld}`,
  };
}

export function priceOut(p) {
  return {
    registrar: p.registrar,
    registrar_name: p.registrar_name ?? p.registrar,
    currency: p.currency,
    register: p.register ?? null,
    renew: p.renew ?? null,
    transfer: p.transfer ?? null,
    restore: p.restore ?? null,
    promo: p.promo ?? null,
    privacy: p.privacy ?? null,
    idn: p.idn ?? null,
    restrictions: p.restrictions ?? null,
    url: p.url ?? p.registrar_web ?? null,
    seen_at: p.seen_at ?? null,
    ...(p.gone_at ? { gone_at: p.gone_at } : {}),
  };
}
