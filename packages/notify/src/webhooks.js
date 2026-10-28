import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { postgresStore } from '@profullstack/webhooks';
import { createHub } from './hub.js';

export * from './hub.js';

/**
 * Bun's native Postgres client as the pg-style pool postgresStore wants:
 * `query(text, params) -> { rows }`. The tables come from migration 0041.
 */
export const bunPool = (db) => ({
  query: async (text, params = []) => ({ rows: await db.unsafe(text, params) }),
});

/**
 * The one hub this deployment uses. Constructing it starts nothing: the
 * worker role calls hooks.start() once at boot, and every process (web for
 * the API and tests sends, worker for feed items) emits through it.
 */
export const hooks = createHub({
  store: postgresStore(bunPool(sql)),
  siteUrl: config.siteUrl,
  log: (...a) => console.log('[webhooks]', ...a),
});

/** Emit without letting a webhook problem fail the action that caused it. */
export async function emitSafely(owner, type, data, opts) {
  if (!owner) return null;
  try {
    return await hooks.emit(String(owner), type, data, opts);
  } catch (err) {
    console.error(`[webhooks] emit ${type} failed: ${err?.message ?? err}`);
    return null;
  }
}
