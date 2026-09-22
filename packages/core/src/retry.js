/**
 * When a failed run is tried again.
 *
 * `startRun` pushes `next_run_at` a full cadence out, and a failure used to
 * leave it there: one 429 from TheSportsDB, one slow answer from the launch
 * library, one timed-out SPARQL window parked the source for a day, and a
 * dump reader with a month's cadence for a month -- after runs every ten
 * minutes that had all been fine. Most failures are the upstream's moment,
 * not ours, so the retry starts short and doubles on each consecutive
 * failure (15 min, 30, 1 h, 2, 4 ...) until it reaches the cadence, where a
 * source that is really broken (a key the deployment does not have) settles
 * at the rate it would have run anyway.
 *
 * On its own, with no imports, because both the ingest loop and the seed need
 * it and the seed must not load the ingest loop's dependencies to get one
 * number.
 */

/** The first retry, in minutes. */
export const RETRY_MINUTES = 15;

/**
 * Minutes until the next try, after `errorsBefore` consecutive failures
 * preceding the one being recorded, never past `cadenceMinutes`.
 */
export function retryMinutes(errorsBefore, cadenceMinutes) {
  const cadence = Math.max(1, Number(cadenceMinutes) || 1);
  const before = Math.max(0, Math.min(Number(errorsBefore) || 0, 20));
  return Math.min(cadence, RETRY_MINUTES * 2 ** before);
}
