#!/usr/bin/env bun
/**
 * riotcoder's /traffic review job (see packages/core/src/traffic/review.js
 * for the rules). Runs inside the nichedb app container, which has the code
 * and DATABASE_URL; ops/traffic-review/run.sh drives it hourly as root on
 * dev2, because the nginx and sshd evidence is root-only.
 *
 *   bun apps/worker/src/traffic-review.js --pending          print the queue's addresses
 *   bun apps/worker/src/traffic-review.js [--dry-run] < ev   decide with the evidence on stdin
 *                                                    ({ ip: { n, status, paths, ssh_* } })
 *                                                    and write the decisions as riotcoder
 */
import { reviewAddress } from '@nichedb/core/traffic/review';
import * as store from '@nichedb/db/traffic';

const args = new Set(process.argv.slice(2));
const queue = await store.pendingForReview();

if (args.has('--pending')) {
  process.stdout.write(`${queue.map((r) => r.ip).join('\n')}\n`);
  process.exit(0);
}

const text = await Bun.stdin.text();
const evidence = text.trim() ? JSON.parse(text) : {};
const decisions = queue.map((row) => ({ ip: row.ip, ...reviewAddress(row, evidence[row.ip]) }));
const count = (k) => decisions.filter((d) => d.decision === k).length;
const summary = {
  queue: queue.length,
  approve: count('approve'),
  reject: count('reject'),
  pending: count('pending'),
};

if (args.has('--dry-run')) {
  console.log(JSON.stringify({ ...summary, dryRun: true }));
  process.exit(0);
}
const changed = await store.applyReview(decisions);
console.log(JSON.stringify({ ...summary, changed }));
process.exit(0);
