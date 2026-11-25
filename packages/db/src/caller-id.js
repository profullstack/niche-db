import { sql } from './index.js';

/**
 * Caller ID (CNAM) answers behind /phone, cached per number. See migration
 * 0048 for why these never live in `items`.
 */

/** The cached answer for a number, or null. */
export async function cachedCallerId(e164, { db = sql } = {}) {
  const [row] = await db`
    select e164, caller_name, line_type, carrier, ocn, ported, looked_up_at
    from phone_caller_id where e164 = ${e164} limit 1
  `;
  return row ?? null;
}

/** Store (or refresh) the answer for a number. */
export async function saveCallerId(row, { db = sql } = {}) {
  await db`
    insert into phone_caller_id (e164, caller_name, line_type, carrier, ocn, ported, raw, looked_up_at)
    values (${row.e164}, ${row.callerName}, ${row.lineType}, ${row.carrier}, ${row.ocn},
            ${row.ported}, ${JSON.stringify(row.raw ?? {})}::jsonb, now())
    on conflict (e164) do update set
      caller_name = excluded.caller_name, line_type = excluded.line_type,
      carrier = excluded.carrier, ocn = excluded.ocn, ported = excluded.ported,
      raw = excluded.raw, looked_up_at = now()
  `;
}

/** How many paid lookups were made since midnight UTC, for the daily cap. */
export async function callerIdLookupsToday({ db = sql } = {}) {
  const [row] = await db`
    select count(*)::int as n from phone_caller_id
    where looked_up_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  `;
  return row?.n ?? 0;
}
