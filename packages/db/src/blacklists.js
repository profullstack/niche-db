import { sql } from './index.js';

/**
 * Reads behind /blacklists/sms: the numbers the smshub-blacklist source saw on
 * smshub's export in the last `days` days. A number that left the export keeps
 * its row as history but drops off the list once `lastListed` is older.
 */
export async function listedSmsNumbers({ days = 1, limit = 5000 } = {}, { db = sql } = {}) {
  return db`
    select i.data, i.updated_at
    from items i join sources s on s.id = i.source_id
    where s.adapter = 'smshub-blacklist'
      and i.kind = 'phone-number'
      and (i.data->>'lastListed')::date >= current_date - ${days}::int
    order by (i.data->>'reporters')::int desc, i.data->>'lastFlaggedAt' desc nulls last
    limit ${limit}
  `;
}

/** One number's row, listed or not, so a lookup can say "was listed until". */
export async function smsNumber(number, { db = sql } = {}) {
  const [row] = await db`
    select i.data, i.updated_at
    from items i join sources s on s.id = i.source_id
    where s.adapter = 'smshub-blacklist' and i.external_id = ${`sms:${number}`}
    limit 1
  `;
  return row ?? null;
}
