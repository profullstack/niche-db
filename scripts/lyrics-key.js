#!/usr/bin/env bun
/**
 * Mint an API key that may write lyrics (POST and DELETE /api/v1/lyrics),
 * for the nixamp radio servers. Run where DATABASE_URL points at the
 * deployment, e.g. inside the app container:
 *
 *   bun scripts/lyrics-key.js [email] [name]
 *
 * The account (default nixamp@profullstack.com) is created as an ordinary
 * user if it does not exist; the key carries `lyrics: true` and nothing an
 * admin has. The key is printed once, alone on stdout, so it can be piped
 * straight into the vault; only its hash is stored.
 */
import { createApiKey } from '../packages/auth/src/index.js';
import { close } from '../packages/db/src/index.js';
import { findOrCreateUser } from '../packages/db/src/queries.js';

const email = process.argv[2] || 'nixamp@profullstack.com';
const name = process.argv[3] || 'lyrics';

const user = await findOrCreateUser(email);
const { key, prefix } = await createApiKey({
  userId: user.id,
  name,
  permissions: { lyrics: true },
});
console.error(`lyrics key ${prefix}… for ${email} (${user.id})`);
process.stdout.write(`${key}\n`);
await close();
