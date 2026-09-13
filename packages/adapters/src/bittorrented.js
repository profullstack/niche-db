import { defineAdapter } from '@nichedb/core/adapter';

/**
 * Torrents as the bittorrented.com crawler sees them on the BitTorrent DHT.
 *
 * bittorrented.com runs bitmagnet as a passive DHT crawler and keeps what it
 * observes in the site's own Supabase Postgres. There is no submit endpoint and
 * no export; what there is, is `browse_dht_torrents`, the function the site's
 * own /dht page reads through, callable over PostgREST with the publishable key
 * the browser bundle already carries. So this reads the same rows the site
 * does, in the order they were observed, and remembers where it got to.
 *
 * A page is 500 rows and comes back in well under a second sorted by date from
 * a cursor, which is the one shape the function has an index for: sorted by
 * seeders it hits its 15s statement timeout on a table this size. Rows sharing
 * a timestamp (the crawler writes in batches) are paged by offset inside that
 * timestamp, so the cursor is a timestamp and how many rows at it were read.
 * Seeder and leecher counts are what the crawler saw and are not refreshed.
 *
 * Adult material stays out. The crawler classes what it finds (movie, tv_show,
 * music, xxx ...), and a torrent it calls xxx is skipped, as is one whose name
 * says so in plain words when the classifier has not caught up. nichedb.dev is
 * a public site read through family DNS filters; the site this reads from went
 * members-only for the same reason.
 */

export const PAGE = 500;
/** Where the read starts the first time: a day back, not the whole crawl. */
export const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RPC = '/rest/v1/rpc/browse_dht_torrents';
const SITE = 'https://bittorrented.com';

/** Plain words that put a name past the classifier. Kept short: a false hit hides one torrent, a miss shows one to a family. */
const EXPLICIT =
  /\b(xxx|porno?|hentai|nsfw|onlyfans|brazzers|milf|anal|blowjob|fuck\w*|erotic\w*|sextape)\b/i;

const HEX40 = /^[0-9a-f]{40}$/;

export function isAdult(row) {
  if (String(row?.content_type ?? '').toLowerCase() === 'xxx') return true;
  return EXPLICIT.test(String(row?.name ?? ''));
}

export function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One row of `browse_dht_torrents`, or null when it is malformed or adult. */
export function toItem(row) {
  const infohash = String(row?.infohash ?? '').toLowerCase();
  if (!HEX40.test(infohash)) return null;
  const name = String(row.name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || isAdult(row)) return null;

  const type = row.content_type ? String(row.content_type).toLowerCase() : null;
  const size = Number(row.size) > 0 ? Number(row.size) : null;
  const files = Number(row.files_count) > 0 ? Number(row.files_count) : null;
  const seeders = Math.max(0, Number(row.seeders) || 0);
  const leechers = Math.max(0, Number(row.leechers) || 0);

  const parts = [];
  if (files) parts.push(plural(files, 'file'));
  if (size) parts.push(humanSize(size));
  parts.push(`${plural(seeders, 'seeder')}, ${plural(leechers, 'leecher')} when crawled`);

  return {
    externalId: infohash,
    kind: 'torrent',
    title: name,
    summary: parts.join(', '),
    url: `${SITE}/dht/${infohash}`,
    imageUrl: null,
    publishedAt: row.created_at ?? null,
    tags: ['dht', `type:${type ?? 'unknown'}`, seeders > 0 ? 'seeded' : 'unseeded'],
    data: {
      infohash,
      // Built here rather than copied: the function's magnet carries the raw
      // name, and a display name with spaces is not a valid magnet.
      magnet: `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(name)}`,
      sizeBytes: size,
      filesCount: files,
      seeders,
      leechers,
      contentType: type,
      crawler: 'bitmagnet',
      site: SITE,
    },
  };
}

/**
 * Where the next read starts, given the page just read. Rows sharing a
 * timestamp are paged by offset inside it; a page that ends on a new timestamp
 * moves the cursor there and counts the rows already read at it, since the
 * function's `date_from` is inclusive.
 */
export function advance(cursor, rows) {
  const first = rows[0]?.created_at ?? null;
  const last = rows[rows.length - 1]?.created_at ?? null;
  if (!last) return cursor;
  if (first === last && cursor.since === last) {
    return { since: last, offset: (Number(cursor.offset) || 0) + rows.length };
  }
  if (first === last) return { since: last, offset: rows.length };
  return { since: last, offset: rows.filter((r) => r.created_at === last).length };
}

export const bittorrentedDht = defineAdapter({
  name: 'bittorrented-dht',
  title: 'bittorrented.com DHT crawl',
  collection: 'dht',
  description:
    "Torrents as the bittorrented.com crawler observes them on the BitTorrent DHT, read from the site's own database: infohash, name, size, file count, the swarm as it stood when crawled and the content class the crawler gave it. Adult material is left out. Needs the site's Supabase URL and publishable key (BITTORRENTED_SUPABASE_URL, BITTORRENTED_SUPABASE_KEY).",
  docs: `${SITE}/dht`,
  kinds: ['torrent'],
  cadenceMinutes: 15,
  needsEnv: ['bittorrentedSupabaseUrl', 'bittorrentedSupabaseKey'],
  configFields: [
    {
      key: 'minSeeders',
      label: 'Minimum seeders',
      type: 'number',
      help: 'Skip torrents the crawler saw with fewer seeders than this. 0 keeps everything it observes.',
    },
    {
      key: 'pagesPerRun',
      label: 'Pages per run',
      type: 'number',
      help: `Pages of ${PAGE} rows read each run. The crawl can add a great many rows a day; this is the cap on how fast the collection grows.`,
    },
  ],
  defaults: { minSeeders: 0, pagesPerRun: 10 },
  defaultSources: [
    {
      slug: 'bittorrented-dht',
      name: 'DHT: the bittorrented.com crawl',
      config: { minSeeders: 0, pagesPerRun: 10 },
    },
  ],
  async pull({ config, cursor, env, http, log, deadline }) {
    if (!env.bittorrentedSupabaseUrl || !env.bittorrentedSupabaseKey) {
      throw new Error('BITTORRENTED_SUPABASE_URL and BITTORRENTED_SUPABASE_KEY are not set');
    }
    const url = `${String(env.bittorrentedSupabaseUrl).replace(/\/+$/, '')}${RPC}`;
    const headers = {
      apikey: env.bittorrentedSupabaseKey,
      authorization: `Bearer ${env.bittorrentedSupabaseKey}`,
      'content-type': 'application/json',
    };
    const minSeeders = Math.max(0, Number(config.minSeeders) || 0);
    const pagesPerRun = Math.max(1, Number(config.pagesPerRun) || 10);

    let at = {
      since: cursor.since ?? new Date(Date.now() - FIRST_LOOKBACK_MS).toISOString(),
      offset: Number(cursor.offset) || 0,
    };
    const items = [];
    let read = 0;
    let skipped = 0;
    let pages = 0;
    while (pages < pagesPerRun && Date.now() < deadline) {
      const rows = await http.json(url, {
        method: 'POST',
        headers,
        timeoutMs: 60_000,
        body: JSON.stringify({
          result_limit: PAGE,
          result_offset: at.offset,
          sort_by: 'date',
          sort_order: 'asc',
          date_from: at.since,
        }),
      });
      pages++;
      if (!Array.isArray(rows) || rows.length === 0) break;
      read += rows.length;
      for (const row of rows) {
        const item = toItem(row);
        if (item && item.data.seeders >= minSeeders) items.push(item);
        else skipped++;
      }
      at = advance(at, rows);
      if (rows.length < PAGE) break;
    }
    log(`${items.length} torrents from ${read} rows over ${pages} page(s); ${skipped} skipped`);
    return {
      items,
      cursor: at,
      note: `${items.length} torrents, ${skipped} skipped (adult, malformed or under ${minSeeders} seeders), cursor ${at.since}+${at.offset}`,
    };
  },
});
