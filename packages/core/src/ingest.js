import { ADAPTERS, adapterByName } from '@nichedb/adapters';
import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { normaliseItem } from './adapter.js';
import { makeHttp } from './http.js';

const UA = () =>
  `niche-db/0.1 (+${config.siteUrl}${config.contactEmail ? `; ${config.contactEmail}` : ''})`;

/** Deployment secrets adapters may ask for, by the keys their configFields name. */
function envFor() {
  return {
    igdbClientId: config.adapters.igdbClientId,
    igdbClientSecret: config.adapters.igdbClientSecret,
    githubToken: config.adapters.githubToken,
    courtlistenerToken: config.adapters.courtlistenerToken,
    contactEmail: config.contactEmail,
  };
}

/**
 * Run one source once: ask its adapter what is new, write it, record the run.
 *
 * Bounded by a wall-clock deadline the adapter is handed and by a batch size
 * per write. A failure records the error on the source and leaves the cursor
 * where it was, so the next run resumes rather than skips.
 */
export async function runSource(sourceId, { log = console.log } = {}) {
  const source = await q.getSourceById(sourceId);
  if (!source) return { skipped: 'no such source' };
  if (!source.enabled) return { skipped: 'disabled' };

  const adapter = adapterByName(source.adapter);
  if (!adapter) {
    await q.finishRun({
      runId: await q.startRun(source.id),
      sourceId: source.id,
      status: 'error',
      error: `unknown adapter ${source.adapter}`,
    });
    return { error: 'unknown adapter' };
  }

  const runId = await q.startRun(source.id);
  const started = Date.now();
  const tag = `[ingest ${source.slug}]`;
  const l = (m) => log(`${tag} ${m}`);
  const storedConfig =
    typeof source.config === 'string' ? JSON.parse(source.config) : source.config;
  const cursor = typeof source.cursor === 'string' ? JSON.parse(source.cursor) : source.cursor;

  try {
    const result = await adapter.pull({
      config: { ...adapter.defaults, ...(storedConfig ?? {}) },
      cursor: cursor ?? {},
      env: envFor(),
      http: makeHttp({ userAgent: UA(), log: l }),
      log: l,
      budget: config.ingest.budget,
      deadline: started + config.ingest.runDeadlineMs,
    });

    const items = (result?.items ?? []).map(normaliseItem).filter(Boolean);
    let added = 0;
    let updated = 0;
    for (let i = 0; i < items.length; i += 200) {
      const r = await q.upsertItems({
        collectionId: source.collection_id,
        sourceId: source.id,
        items: items.slice(i, i + 200),
      });
      added += r.added;
      updated += r.updated;
    }

    const nextRunAt = result?.nextInMinutes
      ? new Date(Date.now() + result.nextInMinutes * 60_000)
      : null;
    await q.finishRun({
      runId,
      sourceId: source.id,
      status: 'ok',
      seen: items.length,
      added,
      updated,
      note: result?.note ?? null,
      cursor: result?.cursor,
      nextRunAt,
    });
    l(`seen ${items.length}, added ${added}, updated ${updated} in ${Date.now() - started}ms`);
    return { seen: items.length, added, updated };
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 1000);
    await q.finishRun({ runId, sourceId: source.id, status: 'error', error: message });
    l(`failed: ${message}`);
    return { error: message };
  }
}

/** Every adapter, for the add-source page and the API. Nothing secret in here. */
export function describeAdapters() {
  return ADAPTERS.map((a) => ({
    name: a.name,
    title: a.title,
    collection: a.collection,
    description: a.description,
    docs: a.docs ?? null,
    kinds: a.kinds,
    cadenceMinutes: a.cadenceMinutes,
    configFields: a.configFields,
    needsEnv: a.needsEnv ?? [],
  }));
}

export { ADAPTERS, adapterByName };
