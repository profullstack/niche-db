import { sql } from './index.js';

/**
 * Reads and writes for the top-level domain tables (migration 0034).
 *
 * Every bulk write goes in as one JSON document unpacked by
 * `jsonb_to_recordset`, never as JS arrays: Bun's client stringifies an array
 * parameter as `a,b` rather than a Postgres array (see the bun-sql-array-params
 * note), and one document is also one round trip for fourteen hundred rows.
 * Every function takes `{ db }` so a test can hand it PGlite.
 */

const doc = (rows) => JSON.stringify(rows ?? []);

/* ------------------------------------------------------------ sync state -- */

export async function getSync(source, { db = sql } = {}) {
  const [row] = await db`select * from tld_sync where source = ${source}`;
  return row ?? null;
}

export async function setSync(
  { source, version = null, count = null, error = null },
  { db = sql } = {},
) {
  await db`
    insert into tld_sync (source, version, fetched_at, count, error)
    values (${source}, ${version}, now(), ${count}, ${error})
    on conflict (source) do update set
      version    = coalesce(excluded.version, tld_sync.version),
      fetched_at = now(),
      count      = coalesce(excluded.count, tld_sync.count),
      error      = excluded.error
  `;
}

export async function listSync({ db = sql } = {}) {
  return db`select * from tld_sync order by source`;
}

/* ------------------------------------------------------------------ list -- */

/** Every label held, with its status: what the next list is diffed against. */
export async function heldLabels({ db = sql } = {}) {
  return db`select tld, status from tlds`;
}

/**
 * Apply one day's diff. `added` are labels never seen, `returned` were removed
 * and are back, `removed` have left the list. A baseline (the very first
 * read) adds rows without writing change rows, so the change log starts with
 * real changes rather than fourteen hundred "added".
 */
export async function applyListDiff(
  { version, added = [], returned = [], removed = [], unicode = {}, baseline = false },
  { db = sql } = {},
) {
  if (added.length) {
    await db`
      insert into tlds (tld, unicode, first_seen, list_version)
      select x.tld, x.unicode, ${version}, ${version}
        from jsonb_to_recordset(${doc(added.map((tld) => ({ tld, unicode: unicode[tld] ?? null })))}::text::jsonb)
             as x(tld text, unicode text)
      on conflict (tld) do nothing
    `;
  }
  if (returned.length) {
    await db`
      update tlds set status = 'delegated', removed = null, removed_at = null, updated_at = now()
       where tld in (select value from jsonb_array_elements_text(${doc(returned)}::text::jsonb))
    `;
  }
  if (removed.length) {
    await db`
      update tlds set status = 'removed', removed = ${version}, removed_at = now(), updated_at = now()
       where tld in (select value from jsonb_array_elements_text(${doc(removed)}::text::jsonb))
    `;
  }
  await db`update tlds set list_version = ${version} where status = 'delegated'`;
  if (baseline) return;
  const changes = [
    ...added.map((tld) => ({ tld, change: 'added' })),
    ...returned.map((tld) => ({ tld, change: 'returned' })),
    ...removed.map((tld) => ({ tld, change: 'removed' })),
  ];
  if (changes.length) {
    await db`
      insert into tld_changes (tld, change, list_version)
      select x.tld, x.change, ${version}
        from jsonb_to_recordset(${doc(changes)}::text::jsonb) as x(tld text, change text)
    `;
  }
}

/** Type and manager from the root zone database. Only labels already held are touched. */
export async function updateRootInfo(rows, { db = sql } = {}) {
  if (!rows.length) return 0;
  const out = await db`
    update tlds t set type = x.type, manager = x.manager, updated_at = now()
      from jsonb_to_recordset(${doc(rows)}::text::jsonb) as x(tld text, type text, manager text)
     where t.tld = x.tld
       and (t.type is distinct from x.type or t.manager is distinct from x.manager)
    returning t.tld
  `;
  return out.length;
}

/**
 * Labels IANA's root zone database still lists as "Not assigned": retired
 * before this table began, so no list version saw them go. Kept as removed
 * rows, so the table holds every top-level domain there has been.
 */
export async function addRetired(rows, { db = sql } = {}) {
  if (!rows.length) return 0;
  const out = await db`
    insert into tlds (tld, unicode, type, manager, status)
    select x.tld, x.unicode, x.type, x.manager, 'removed'
      from jsonb_to_recordset(${doc(rows)}::text::jsonb)
           as x(tld text, unicode text, type text, manager text)
    on conflict (tld) do nothing
    returning tld
  `;
  return out.length;
}

/** RDAP base per label from the bootstrap file; a label it no longer lists loses its server. */
export async function updateRdap(rows, { db = sql } = {}) {
  const out = await db`
    update tlds t set rdap = x.rdap, updated_at = now()
      from (
        select t2.tld, m.rdap
          from tlds t2
          left join jsonb_to_recordset(${doc(rows)}::text::jsonb) as m(tld text, rdap text)
            on m.tld = t2.tld
      ) x
     where t.tld = x.tld and t.rdap is distinct from x.rdap
    returning t.tld
  `;
  return out.length;
}

/* ------------------------------------------------------------ registrars -- */

export async function upsertRegistrar(r, { db = sql } = {}) {
  await db`
    insert into tld_registrars (slug, name, web, source_url, source_kind, currency, attribution)
    values (${r.slug}, ${r.name}, ${r.web ?? null}, ${r.sourceUrl ?? null}, ${r.sourceKind ?? null},
            ${r.currency ?? null}, ${r.attribution ?? null})
    on conflict (slug) do update set
      name = excluded.name, web = excluded.web, source_url = excluded.source_url,
      source_kind = excluded.source_kind, currency = excluded.currency,
      attribution = excluded.attribution
  `;
}

export async function recordRegistrarRead(slug, { count = null, error = null }, { db = sql } = {}) {
  await db`
    update tld_registrars
       set last_read_at = now(),
           last_count = coalesce(${count}, last_count),
           last_error = ${error}
     where slug = ${slug}
  `;
}

export async function listRegistrars({ db = sql } = {}) {
  return db`
    select r.*,
           (select count(*)::int from tld_prices p where p.registrar = r.slug and p.gone_at is null) as tlds
      from tld_registrars r
     order by r.name
  `;
}

/* ---------------------------------------------------------------- prices -- */

/**
 * One registrar's whole price list. Rows present are upserted and revived;
 * rows the registrar no longer lists are marked gone, not deleted. Returns
 * how many were written and how many went.
 */
export async function replacePrices(registrar, rows, { db = sql } = {}) {
  const clean = rows.map((p) => ({
    tld: p.tld,
    currency: p.currency,
    register: p.register ?? null,
    renew: p.renew ?? null,
    transfer: p.transfer ?? null,
    restore: p.restore ?? null,
    promo: p.promo ?? null,
    privacy: p.privacy ?? null,
    idn: p.idn ?? null,
    premium: p.premium ?? null,
    restrictions: p.restrictions ?? null,
    url: p.url ?? null,
    extra: p.extra ?? {},
  }));
  if (clean.length) {
    await db`
      insert into tld_prices
        (registrar, tld, currency, register, renew, transfer, restore, promo, privacy, idn,
         premium, restrictions, url, extra, seen_at, gone_at)
      select ${registrar}, x.tld, x.currency, x.register, x.renew, x.transfer, x.restore, x.promo,
             x.privacy, x.idn, x.premium, x.restrictions, x.url, coalesce(x.extra, '{}'::jsonb),
             now(), null
        from jsonb_to_recordset(${doc(clean)}::text::jsonb) as x(
          tld text, currency text, register numeric, renew numeric, transfer numeric,
          restore numeric, promo jsonb, privacy text, idn boolean, premium text,
          restrictions text, url text, extra jsonb)
      on conflict (registrar, tld) do update set
        currency = excluded.currency, register = excluded.register, renew = excluded.renew,
        transfer = excluded.transfer, restore = excluded.restore, promo = excluded.promo,
        privacy = excluded.privacy, idn = excluded.idn, premium = excluded.premium,
        restrictions = excluded.restrictions, url = excluded.url, extra = excluded.extra,
        seen_at = now(), gone_at = null
    `;
  }
  const gone = await db`
    update tld_prices set gone_at = now()
     where registrar = ${registrar} and gone_at is null
       and tld not in (select x.tld from jsonb_to_recordset(${doc(clean)}::text::jsonb) as x(tld text))
    returning tld
  `;
  return { written: clean.length, gone: gone.length };
}

/* ----------------------------------------------------------------- reads -- */

const tldColumns = (db) => db`
  tld, unicode, type, manager, rdap, status, first_seen, first_seen_at, removed, removed_at,
  list_version, updated_at
`;

const priceColumns = (db) => db`
  p.registrar, r.name as registrar_name, r.web as registrar_web, p.tld, p.currency,
  p.register::float8 as register, p.renew::float8 as renew, p.transfer::float8 as transfer,
  p.restore::float8 as restore, p.promo, p.privacy, p.idn, p.premium, p.restrictions, p.url,
  p.extra, p.seen_at, p.first_seen_at
`;

/** Everything a listing needs, in two reads: the table is small enough to facet in memory. */
export async function catalogue({ db = sql } = {}) {
  const [tlds, prices] = await Promise.all([
    db`select ${tldColumns(db)} from tlds`,
    db`select ${priceColumns(db)}
         from tld_prices p join tld_registrars r on r.slug = p.registrar
        where p.gone_at is null`,
  ]);
  return { tlds, prices };
}

export async function getTld(tld, { db = sql } = {}) {
  const [row] = await db`select ${tldColumns(db)} from tlds where tld = ${tld}`;
  if (!row) return null;
  const [prices, changes] = await Promise.all([
    db`select ${priceColumns(db)}, p.gone_at
         from tld_prices p join tld_registrars r on r.slug = p.registrar
        where p.tld = ${tld}
        order by p.gone_at nulls first, p.renew nulls last`,
    db`select tld, change, list_version, at from tld_changes where tld = ${tld} order by at desc`,
  ]);
  return { ...row, prices, changes };
}

export async function listChanges(
  { limit = 100, since = null, change = null } = {},
  { db = sql } = {},
) {
  return db`
    select c.tld, c.change, c.list_version, c.at, t.unicode, t.type, t.manager
      from tld_changes c left join tlds t on t.tld = c.tld
     where (${since}::timestamptz is null or c.at > ${since}::timestamptz)
       and (${change}::text is null or c.change = ${change}::text)
     order by c.at desc, c.id desc
     limit ${Math.min(Math.max(Number(limit) || 100, 1), 1000)}
  `;
}

export async function tldStats({ db = sql } = {}) {
  const [row] = await db`
    select (select count(*)::int from tlds where status = 'delegated') as delegated,
           (select count(*)::int from tlds where status = 'removed') as removed,
           (select count(*)::int from tld_prices where gone_at is null) as prices,
           (select count(*)::int from tld_registrars) as registrars,
           (select count(*)::int from tld_changes) as changes,
           (select max(list_version) from tlds) as list_version
  `;
  return row;
}
