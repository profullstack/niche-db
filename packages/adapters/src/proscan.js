import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { decodeEntities, defineAdapter, stripHtml } from '@nichedb/core/adapter';
import { publicWebUrl, robotsAllows } from '@nichedb/core/opensite';

export const DIRECTORY_URL = 'https://www.proscan.org/web_servers/list';
const AGENT = 'NicheDB/1.0 (+https://nichedb.dev; public scanner link index)';
const text = (s) => decodeEntities(stripHtml(s)).trim();
const attr = (tag, name) =>
  decodeEntities(
    tag
      .match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
      ?.slice(1)
      .find((s) => s !== undefined) ?? '',
  );
export function scannerUrl(value, base) {
  const u = publicWebUrl(value, base);
  if (!u) return null;
  const url = new URL(u);
  if (url.username || url.password) return null;
  url.hash = '';
  return url.href;
}
export function parseDirectory(html) {
  const entries = new Map();
  for (const row of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 9) continue;
    const anchor = cells[1].match(/<a\b[^>]*>/i)?.[0];
    const player = scannerUrl(anchor ? attr(anchor, 'href') : text(cells[1]));
    if (!player) continue;
    const location = text(cells[2]);
    const [country, region, ...areas] = location.split(',').map((s) => s.trim());
    const updated = Number(text(cells[8]));
    const description = text(cells[3]);
    const id = `proscan:${createHash('sha256').update(player).digest('hex').slice(0, 24)}`;
    entries.set(id, {
      id,
      player,
      name: text(cells[0]) || description || `${location || 'Public'} scanner`,
      description,
      country: country || null,
      region: region || null,
      area: areas.join(', ') || null,
      location,
      scanner: text(cells[4]),
      listedAt:
        Number.isFinite(updated) && updated > 0 && updated < 4102444800
          ? new Date(updated * 1000).toISOString()
          : null,
      reachable: cells[6].match(/class=['"]green['"]/i)
        ? text(cells[6]).trim().startsWith('1')
        : false,
    });
  }
  return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Extract only links explicitly advertised by the player; never guess /stream. */
export function audioLinks(html, base) {
  const streams = [];
  const playlists = [];
  const clean = String(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of clean.matchAll(/<audio\b[^>]*>/gi)) {
    const src = attr(tag[0], 'src');
    const url = src && scannerUrl(src, base);
    if (url) streams.push(url);
  }
  for (const audio of clean.matchAll(/<audio\b([^>]*)>([\s\S]*?)<\/audio>/gi)) {
    const own = scannerUrl(attr(audio[1], 'src'), base);
    if (attr(audio[1], 'src') && own) streams.push(own);
    for (const source of audio[2].matchAll(/<source\b[^>]*>/gi)) {
      const src = attr(source[0], 'src');
      const url = src && scannerUrl(src, base);
      if (url) streams.push(url);
    }
  }
  for (const a of clean.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(a[0], 'href');
    const url = href && scannerUrl(href, base);
    if (!url) continue;
    if (/\.(m3u8?|pls)(?:[?#]|$)/i.test(url)) playlists.push(url);
    else if (/\.(mp3|aac|ogg)(?:[?#]|$)/i.test(url)) streams.push(url);
  }
  return { stream_url: streams[0] ?? null, playlist_url: playlists[0] ?? null };
}

export function publicAddress(address) {
  if (
    !isIP(address) ||
    !publicWebUrl(`http://${address.includes(':') ? `[${address}]` : address}/`)
  )
    return false;
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    if (
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0)
    )
      return false;
  }
  if (isIP(address) === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  return true;
}

/** Pin DNS to a public address, recheck every redirect, cap body size and time.
 * No audio body is ever requested: this reader is for robots and HTML only.
 */
export async function readPublicText(
  url,
  {
    resolve = lookup,
    requestHttp = httpRequest,
    requestHttps = httpsRequest,
    timeoutMs = 5000,
    maxBytes = 512 * 1024,
  } = {},
) {
  const current = scannerUrl(url);
  const end = Date.now() + timeoutMs;
  if (!current) throw new Error('non-public scanner URL');
  const u = new URL(current);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const remaining = end - Date.now();
  if (remaining <= 0) throw new Error('scanner page timeout');
  let timer;
  const addresses = await Promise.race([
    resolve(hostname, { all: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('scanner DNS timeout')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error('non-public scanner address');
  const selected = addresses.find((a) => a.family === 4) ?? addresses[0];
  const response = await new Promise((resolveResponse, reject) => {
    const req = (u.protocol === 'https:' ? requestHttps : requestHttp)(
      u,
      {
        headers: { 'user-agent': AGENT, accept: 'text/html,text/plain;q=0.9' },
        lookup: (_host, options, callback) =>
          options?.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
      },
      (res) => {
        const status = res.statusCode;
        if ((status >= 300 && status < 400) || status >= 400) {
          res.destroy();
          clearTimeout(deadlineTimer);
          resolveResponse({ status, location: res.headers.location, body: '', url: current });
          return;
        }
        const ct = String(res.headers['content-type'] ?? '').toLowerCase();
        if (ct && !ct.startsWith('text/') && !ct.includes('xhtml')) {
          res.destroy();
          clearTimeout(deadlineTimer);
          reject(new Error('not a text page'));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error('scanner page too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(deadlineTimer);
          resolveResponse({ status, body: Buffer.concat(chunks).toString('utf8'), url: current });
        });
        res.on('error', reject);
      },
    );
    const deadlineTimer = setTimeout(
      () => req.destroy(new Error('scanner page timeout')),
      Math.max(1, end - Date.now()),
    );
    req.on('error', (e) => {
      clearTimeout(deadlineTimer);
      reject(e);
    });
    req.end();
  });
  return response;
}

export async function crawlPage(url, { read = readPublicText, policies = new Map() } = {}) {
  let current = scannerUrl(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!current) throw new Error('non-public scanner redirect');
    const u = new URL(current);
    if (!policies.has(u.origin)) {
      let robotsUrl = `${u.origin}/robots.txt`;
      let r;
      for (let hop = 0; hop < 4; hop++) {
        r = await read(robotsUrl);
        if (r.status >= 300 && r.status < 400 && r.location) {
          robotsUrl = scannerUrl(r.location, robotsUrl);
          if (!robotsUrl) throw new Error('non-public robots redirect');
        } else break;
      }
      if (r.status >= 500 || r.status === 429 || (r.status >= 300 && r.status < 400))
        throw new Error('robots unavailable; retry later');
      policies.set(u.origin, r.status === 200 ? r.body : '');
    }
    if (!robotsAllows(policies.get(u.origin), u.pathname + u.search, AGENT))
      throw new Error('robots disallows this page');
    const r = await read(current);
    if (r.status >= 300 && r.status < 400 && r.location) {
      current = scannerUrl(r.location, current);
      continue;
    }
    if (r.status !== 200) throw new Error(`player HTTP ${r.status}`);
    if (/cf-chl-|checking your browser|verify you are human/i.test(r.body))
      throw new Error('player challenge');
    return { ...r, url: current };
  }
  throw new Error('too many scanner redirects');
}

export function toItem(entry, details = {}) {
  return {
    externalId: entry.id,
    kind: 'scanner-stream',
    title: entry.name,
    url: entry.player,
    summary: [entry.description, entry.location].filter(Boolean).join(' — '),
    publishedAt: entry.listedAt,
    timeKnown: Boolean(entry.listedAt),
    tags: ['scanner', 'proscan', entry.country, entry.region, entry.area].filter(Boolean),
    data: {
      provider: 'ProScan public web-server directory',
      source_id: entry.id,
      directory_url: DIRECTORY_URL,
      player_url: entry.player,
      stream_url: details.stream_url ?? null,
      playlist_url: details.playlist_url ?? null,
      stream_access: details.stream_url ? 'publicly-advertised' : 'player-link',
      // Discovery describes a link, not a grant of redistribution rights.
      stream_reuse_allowed: false,
      link_basis: 'public-directory-and-player-html',
      country: entry.country,
      state: entry.region,
      area: entry.area,
      location_label: entry.location,
      scanner_model: entry.scanner,
      directory_updated_at: entry.listedAt,
      directory_reachable: entry.reachable,
      directory_present: true,
      coverage: null,
      coverage_basis: 'unknown',
      location_source: DIRECTORY_URL,
      last_checked: details.last_checked ?? null,
      stream_discovered_at: details.stream_discovered_at ?? null,
      discovery_status: details.discovery_status ?? 'pending',
    },
  };
}

export async function pullDirectory({
  cursor = {},
  previous = async () => new Map(),
  deadline = Date.now() + 90000,
  read = readPublicText,
  now = () => new Date(),
  maxPlayers = 12,
} = {}) {
  const policies = new Map();
  const listing = await crawlPage(DIRECTORY_URL, { read, policies });
  const entries = parseDirectory(listing.body);
  if (!entries.length)
    throw new Error('ProScan directory has no recognized rows; preserving existing entries');
  const old = await previous(entries.map((e) => e.id));
  // Recheck least recently visited players first, independent of directory ordering.
  const pending = [...entries].sort((a, b) =>
    String(old.get(a.id)?.last_checked ?? '').localeCompare(
      String(old.get(b.id)?.last_checked ?? ''),
    ),
  );
  const updates = new Map();
  let visited = 0;
  for (const entry of pending) {
    if (visited >= maxPlayers || Date.now() + 11000 > deadline) break;
    visited++;
    const checked = now().toISOString();
    try {
      const page = await crawlPage(entry.player, { read, policies });
      const links = audioLinks(page.body, page.url ?? entry.player);
      updates.set(entry.id, {
        ...links,
        last_checked: checked,
        stream_discovered_at: links.stream_url ? checked : null,
        discovery_status: links.stream_url ? 'advertised' : 'no-advertised-audio',
      });
    } catch (error) {
      const blocked = /robots disallows|challenge|HTTP (401|403)/.test(error.message);
      updates.set(entry.id, {
        ...old.get(entry.id),
        ...(blocked ? { stream_url: null, playlist_url: null } : {}),
        last_checked: checked,
        discovery_status: blocked ? 'restricted' : 'unreachable',
      });
    }
  }
  const ids = new Set(entries.map((e) => e.id));
  // Previously indexed servers leaving the directory become inactive records,
  // with obsolete live links cleared rather than looking current forever.
  const missing = (cursor.ids ?? []).filter((id) => !ids.has(id));
  const removed = missing.length ? await previous(missing) : new Map();
  const tombstones = missing
    .filter((id) => removed.has(id))
    .map((id) => ({
      externalId: id,
      kind: 'scanner-stream',
      title: removed.get(id).directory_title ?? 'Scanner no longer listed',
      url: removed.get(id).player_url,
      summary: 'This scanner is no longer listed in the ProScan directory.',
      tags: ['scanner', 'proscan', 'inactive'],
      data: {
        ...removed.get(id),
        directory_present: false,
        stream_url: null,
        playlist_url: null,
        discovery_status: 'unlisted',
      },
    }));
  const items = entries.map((entry) => {
    const item = toItem(entry, updates.get(entry.id) ?? old.get(entry.id));
    item.data.directory_title = entry.name;
    return item;
  });
  return {
    items: [...items, ...tombstones],
    cursor: { ids: [...ids] },
    note: `${entries.length} public scanner listings; ${visited} player pages checked; ${items.filter((i) => i.data.stream_url).length} advertised audio URLs`,
  };
}
export const proscanDirectory = defineAdapter({
  name: 'proscan-scanners',
  title: 'ProScan public scanner directory',
  collection: 'crime',
  description:
    'Public scanner servers and the live audio links advertised on their player pages. Preserves directory location labels and attribution; no audio recording or proxying.',
  docs: DIRECTORY_URL,
  kinds: ['scanner-stream'],
  cadenceMinutes: 15,
  defaultSources: [{ slug: 'scanners-proscan', name: 'Public scanner feeds: ProScan' }],
  async pull(ctx) {
    return pullDirectory(ctx);
  },
});
