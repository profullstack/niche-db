import { config } from '@nichedb/config';
import { SQL } from 'bun';

/**
 * One pool per process. Bun's native Postgres client, so the container ships one
 * runtime and no native addons. `max` and the worker concurrency are chosen
 * together: every BullMQ slot can hold a connection.
 */
export const sql = new SQL({
  url: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX ?? 12),
  idleTimeout: 30,
  connectionTimeout: 15,
  tls: config.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

export async function healthcheck() {
  const [row] = await sql`select 1 as ok`;
  return row?.ok === 1;
}

export async function close() {
  await sql.end();
}
