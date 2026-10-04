/**
 * The verdict at the top of /crawlstatus, and the JSON the page is made of.
 *
 * With hundreds of upstreams some are always failing: a vendor changed a page,
 * a key ran out. So one failing source is a row in the table, not the headline.
 * The headline is about the crawler itself: has it started anything lately, and
 * is a large share of the fleet failing or stuck in the queue at once.
 */

/** No run started in this long means the worker is down, not slow. */
export const STALL_MINUTES = 120;
/** This share of enabled sources failing, or overdue, is degraded. */
export const DEGRADED_SHARE = 0.25;

export function crawlHealth({ sources, recent }, now = Date.now()) {
  if (!sources.enabled) return { state: 'idle', label: 'No sources enabled' };
  const last = recent[0]?.started_at ? new Date(recent[0].started_at).getTime() : null;
  if (last === null || now - last > STALL_MINUTES * 60_000)
    return { state: 'stalled', label: `Stalled: no run started in ${STALL_MINUTES / 60} hours` };
  const share = (n) => n / sources.enabled;
  if (share(sources.failing) >= DEGRADED_SHARE)
    return { state: 'degraded', label: 'Degraded: many sources failing' };
  if (share(sources.overdue) >= DEGRADED_SHARE)
    return { state: 'degraded', label: 'Degraded: the queue is behind' };
  return { state: 'ok', label: 'Crawling' };
}

/**
 * The hours of the last day, oldest first, with the empty ones filled in: the
 * query only returns hours that had a run, and a gap is exactly what a reader
 * of this chart is looking for.
 */
export function fillHours(hourly, now = Date.now()) {
  const HOUR = 3_600_000;
  const byHour = new Map(hourly.map((h) => [new Date(h.hour).getTime(), h]));
  const current = Math.floor(now / HOUR) * HOUR;
  return Array.from({ length: 24 }, (_, i) => {
    const hour = current - (23 - i) * HOUR;
    const h = byHour.get(hour);
    return {
      hour: new Date(hour),
      ok: h?.ok ?? 0,
      errors: h?.errors ?? 0,
      running: h?.running ?? 0,
    };
  });
}

/** The same numbers the page shows, for /api/v1/crawlstatus. */
export function crawlStatusOut(status, now = Date.now()) {
  return {
    generated_at: new Date(now).toISOString(),
    health: crawlHealth(status, now),
    sources: status.sources,
    last_24h: status.day,
    hourly: fillHours(status.hourly, now),
    failing: status.failing,
    overdue: status.overdue,
    recent: status.recent,
  };
}
