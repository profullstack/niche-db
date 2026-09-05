import { createHash } from 'node:crypto';
import { config } from '@nichedb/config';
import { sql } from '@nichedb/db';
import { createApiKeyManager } from '@profullstack/api-key-manager';

/**
 * API keys through @profullstack/api-key-manager, stored in Postgres.
 *
 * The manager generates, validates, expires and rate-limits; this adapter is
 * the storage it asks for. One deliberate difference from its memory adapter:
 * the key value is never stored. `saveKey` keeps a SHA-256 of it and a short
 * prefix for display, and `getKeyByValue` hashes what it is handed. A copy of
 * the database therefore cannot call the API.
 */

const hash = (key) => createHash('sha256').update(String(key)).digest();

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    // The manager strips `key` from what it returns; we never had it anyway.
    key: null,
    userId: row.user_id,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions ?? {},
    isActive: row.is_active && !row.revoked_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    metadata: row.metadata ?? {},
  };
}

export class PostgresAdapter {
  async saveKey(apiKey) {
    await sql`
      insert into api_keys (id, user_id, name, prefix, key_hash, permissions, is_active,
                            expires_at, metadata, created_at)
      values (${apiKey.id}, ${apiKey.userId}::uuid, ${apiKey.name}, ${apiKey.key.slice(0, 12)},
              ${hash(apiKey.key)}, ${JSON.stringify(apiKey.permissions ?? {})}::jsonb,
              ${apiKey.isActive !== false}, ${apiKey.expiresAt ?? null},
              ${JSON.stringify(apiKey.metadata ?? {})}::jsonb, ${apiKey.createdAt ?? new Date()})
    `;
  }

  async getKeyById(id) {
    const [row] = await sql`select * from api_keys where id = ${String(id)}`;
    return toRecord(row);
  }

  async getKeyByValue(value) {
    if (!value) return null;
    const [row] = await sql`select * from api_keys where key_hash = ${hash(value)}`;
    return toRecord(row);
  }

  async getKeysByUserId(userId) {
    const rows = await sql`
      select * from api_keys where user_id = ${userId}::uuid and is_active
      order by created_at
    `;
    return rows.map(toRecord);
  }

  async updateKey(id, updated) {
    const [row] = await sql`
      update api_keys set
        name = coalesce(${updated.name ?? null}, name),
        is_active = coalesce(${updated.isActive ?? null}, is_active),
        revoked_at = case when ${updated.isActive === false} then now() else revoked_at end,
        last_used_at = coalesce(${updated.lastUsedAt ?? null}, last_used_at),
        expires_at = ${updated.expiresAt ?? null},
        permissions = coalesce(${updated.permissions ? JSON.stringify(updated.permissions) : null}::jsonb, permissions),
        metadata = coalesce(${updated.metadata ? JSON.stringify(updated.metadata) : null}::jsonb, metadata)
      where id = ${String(id)}
      returning *
    `;
    return toRecord(row);
  }

  async deleteKey(id) {
    const rows = await sql`delete from api_keys where id = ${String(id)} returning id`;
    return rows.length > 0;
  }

  /**
   * Fixed-window counting in the api_usage table, so the limit survives a
   * restart and is shared across instances. The window is the manager's
   * `windowMs`, aligned to the epoch.
   */
  async checkRateLimit(keyId, rateLimit) {
    if (!rateLimit?.maxRequests) return true;
    const windowMs = rateLimit.windowMs ?? 3600_000;
    const at = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const [row] = await sql`
      insert into api_usage (bucket, hour, count) values (${`key:${keyId}`}, ${at}, 1)
      on conflict (bucket, hour) do update set count = api_usage.count + 1
      returning count
    `;
    return row.count <= rateLimit.maxRequests;
  }
}

/** Keys look like `ndb_<64 hex>`: the prefix makes a leaked one greppable. */
export const keys = createApiKeyManager({
  adapter: new PostgresAdapter(),
  prefix: 'ndb_',
  keyLength: 32,
  rateLimit: { windowMs: 3600_000, maxRequests: config.api.freePerHour },
});

export async function createApiKey({ userId, name }) {
  const created = await keys.createKey({
    userId,
    name: name || 'default',
    permissions: { read: true, write: true },
  });
  return { key: created.key, id: created.id, prefix: created.key.slice(0, 12) };
}

export async function listApiKeys(userId) {
  return keys.getKeys(userId);
}

export async function revokeApiKey({ userId, id }) {
  return keys.updateKey(id, userId, { isActive: false });
}

/** The key record for a bearer value, or null. Touches last_used_at. */
export async function validateApiKey(value) {
  if (!value || !String(value).startsWith('ndb_')) return null;
  return keys.validateKey(String(value));
}
