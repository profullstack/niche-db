// Connect with the app's own pool (packages/db connect()) using DATABASE_URL,
// exactly as the service will after the cutover, and print the item count.
import { connect } from '../../../packages/db/src/index.js';

const sql = connect({ url: process.env.DATABASE_URL, max: 1 });
const [row] =
  await sql`select count(*)::int as n, (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl from items`;
console.log(`${row.n} ${row.ssl}`);
await sql.end();
