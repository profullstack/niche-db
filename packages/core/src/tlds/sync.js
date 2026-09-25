import { config } from '@nichedb/config';
import * as store from '@nichedb/db/tlds';
import { makeHttp } from '../http.js';
import {
  diffList,
  IANA_LIST_URL,
  IANA_RDAP_URL,
  IANA_ROOT_DB_URL,
  openTldRegistrar,
  parseRdapBootstrap,
  parseRootDb,
  parseTldList,
  REGISTRARS,
  unicodeOf,
} from './sources.js';

/**
 * The daily top-level domain sync.
 *
 * 1. IANA's list, diffed against the table: new labels added, gone ones
 *    marked removed, both written to the change log. Skipped when the list's
 *    version is the one already applied.
 * 2. The root zone database for each label's type and manager.
 * 3. The RDAP bootstrap for each label's server.
 * 4. Every registrar's price list, labels outside IANA's root dropped (Porkbun
 *    also sells Handshake names), and a list much shorter than the last good
 *    one refused as a broken page rather than taken as a mass withdrawal.
 *
 * Each step is its own try: a registrar that fails leaves yesterday's prices
 * and today's list still lands. The result is a summary for the worker log.
 */
export async function syncTlds({
  log = console.log,
  http = makeHttp({
    userAgent: `niche-db/0.1 (+${config.siteUrl}${config.contactEmail ? `; ${config.contactEmail}` : ''})`,
    log,
  }),
  db,
  registrars = [...REGISTRARS, ...(config.tlds?.openTldUrls ?? []).map(openTldRegistrar)],
  force = false,
} = {}) {
  const opt = db ? { db } : {};
  const summary = { list: null, root: null, rdap: null, registrars: {} };

  /* 1. the list */
  let root = null;
  try {
    const { version, labels } = parseTldList(await http.text(IANA_LIST_URL));
    if (!version || labels.length === 0) throw new Error('IANA list had no version or no labels');
    const prior = await store.getSync('iana-list', opt);
    const held = await store.heldLabels(opt);
    if (!force && prior?.version === version && held.length > 0) {
      summary.list = { version, unchanged: true };
    } else {
      const diff = diffList(held, labels);
      const unicode = Object.fromEntries(diff.added.map((t) => [t, unicodeOf(t)]));
      await store.applyListDiff({ version, ...diff, unicode }, opt);
      summary.list = {
        version,
        baseline: diff.baseline,
        added: diff.added.length,
        returned: diff.returned.length,
        removed: diff.removed.length,
      };
      if (!diff.baseline && (diff.added.length || diff.removed.length || diff.returned.length))
        log(
          `[tlds] ${version}: +${diff.added.join(' +') || '0'} -${diff.removed.join(' -') || '0'}${diff.returned.length ? ` returned ${diff.returned.join(' ')}` : ''}`,
        );
    }
    await store.setSync({ source: 'iana-list', version, count: labels.length }, opt);
    root = new Set(labels);
  } catch (err) {
    summary.list = { error: err.message };
    await store.setSync({ source: 'iana-list', error: err.message }, opt).catch(() => {});
    log(`[tlds] list failed: ${err.message}`);
  }
  if (!root)
    root = new Set(
      (await store.heldLabels(opt)).filter((r) => r.status === 'delegated').map((r) => r.tld),
    );

  /* 2. type and manager */
  try {
    const rows = parseRootDb(
      await http.text(IANA_ROOT_DB_URL, { headers: { accept: 'text/html' } }),
    );
    if (rows.length < 1000) throw new Error(`root zone database parsed to ${rows.length} rows`);
    const changed = await store.updateRootInfo(rows, opt);
    const retired = await store.addRetired(
      rows
        .filter((r) => !root.has(r.tld) && /not assigned/i.test(r.manager ?? ''))
        .map((r) => ({ ...r, unicode: unicodeOf(r.tld) })),
      opt,
    );
    summary.root = { rows: rows.length, changed, retired };
    await store.setSync({ source: 'iana-root-db', count: rows.length }, opt);
  } catch (err) {
    summary.root = { error: err.message };
    await store.setSync({ source: 'iana-root-db', error: err.message }, opt).catch(() => {});
    log(`[tlds] root zone database failed: ${err.message}`);
  }

  /* 3. RDAP servers */
  try {
    const json = await http.json(IANA_RDAP_URL);
    const rows = parseRdapBootstrap(json);
    if (rows.length < 500) throw new Error(`RDAP bootstrap parsed to ${rows.length} labels`);
    const changed = await store.updateRdap(rows, opt);
    summary.rdap = { labels: rows.length, changed, published: json.publication ?? null };
    await store.setSync(
      { source: 'iana-rdap', version: json.publication ?? null, count: rows.length },
      opt,
    );
  } catch (err) {
    summary.rdap = { error: err.message };
    await store.setSync({ source: 'iana-rdap', error: err.message }, opt).catch(() => {});
    log(`[tlds] RDAP bootstrap failed: ${err.message}`);
  }

  /* 4. prices */
  const known = new Map((await store.listRegistrars(opt).catch(() => [])).map((r) => [r.slug, r]));
  for (const reg of registrars) {
    try {
      await store.upsertRegistrar(reg, opt);
      const rows = await reg.read(http);
      if (reg.opentld && rows.registrar?.name) {
        await store.upsertRegistrar(
          {
            ...reg,
            name: rows.registrar.name,
            web: rows.registrar.web ?? reg.web,
            currency: rows[0]?.currency ?? null,
          },
          opt,
        );
      }
      // The registrar's currency is what it answered in today, not what it
      // answered in last time: Dynadot changes it without being asked.
      const answered = [...new Set(rows.map((r) => r.currency))];
      if (answered.length === 1 && answered[0] !== reg.currency && !reg.opentld)
        await store.upsertRegistrar({ ...reg, currency: answered[0] }, opt);
      const inRoot = rows.filter((r) => root.has(r.tld));
      const outside = rows.length - inRoot.length;
      const last = known.get(reg.slug)?.last_count ?? 0;
      if (last > 50 && inRoot.length < last * 0.5) {
        throw new Error(
          `read ${inRoot.length} prices against ${last} last time; keeping the last good list`,
        );
      }
      const { written, gone } = await store.replacePrices(reg.slug, inRoot, opt);
      await store.recordRegistrarRead(reg.slug, { count: written }, opt);
      summary.registrars[reg.slug] = { written, gone, outside };
      log(
        `[tlds] ${reg.slug}: ${written} prices, ${gone} gone${outside ? `, ${outside} labels outside the IANA root skipped` : ''}`,
      );
    } catch (err) {
      summary.registrars[reg.slug] = { error: err.message };
      await store.recordRegistrarRead(reg.slug, { error: err.message }, opt).catch(() => {});
      log(`[tlds] ${reg.slug} failed: ${err.message}`);
    }
  }
  return summary;
}
