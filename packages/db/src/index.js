import { config } from '@nichedb/config';
import { SQL } from 'bun';

/**
 * One pool per process. Bun's native Postgres client, so the container ships one
 * runtime and no native addons. `max` and the worker concurrency are chosen
 * together: every BullMQ slot can hold a connection.
 */
export function connect({
  url = config.databaseUrl,
  max = Number(process.env.DB_POOL_MAX ?? 12),
  /*
   * No idle timer. Bun's pool kills an in-flight query when the timer fires
   * rather than draining the connection (oven-sh/bun#30646), and the error it
   * throws, "Idle timeout reached after 30s", landed on exactly the sources
   * that are quiet for a while between writes: a dump reader streaming eleven
   * million lines before its first batch, a paged walk sleeping between pages.
   * Twelve open connections per process on a private network cost nothing.
   */
  idleTimeout = 0,
} = {}) {
  return new SQL({
    url,
    max,
    idleTimeout,
    connectionTimeout: 15,
    tls: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });
}

export const sql = connect();

export async function healthcheck() {
  const [row] = await sql`select 1 as ok`;
  return row?.ok === 1;
}

export async function close() {
  await sql.end();
}
