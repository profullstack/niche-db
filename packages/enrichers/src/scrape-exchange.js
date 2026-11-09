import { defineEnricher } from './enricher.js';

/**
 * Audience size for the social accounts a profile already names, from
 * scrape.exchange (CC BY-SA 4.0, keyless reads).
 *
 * Only accounts the profile itself links are looked up: a person's own
 * OpenProfile, or the Wikidata/Sportarr record behind an athlete. Nothing is
 * searched by name and nothing about anyone else is read. What is kept is the
 * public number the platform shows on the account page (subscribers,
 * followers, views, video count) and when it was read; never a bio, pronouns,
 * post text or anything from the account's full record.
 *
 * Two calls per account: `POST /api/v1/filter` by handle (or by channel id for
 * a `/channel/UC...` YouTube URL) finds the record and who uploaded it, then
 * `GET /api/v1/stats/metrics` returns that account's count time series. The
 * record's `data_url` (the full scraped JSON) answers 404, so the series is
 * the only place the numbers live. An empty series is unknown, never zero:
 * Instagram accounts last read months ago come back with no points.
 *
 * Instagram, TikTok, Twitch and YouTube only. OnlyFans is in the exchange and
 * is deliberately never queried.
 */

const API = 'https://api.scrape.exchange/api/v1';
const MAX_ACCOUNTS = 4;
const RESERVED = new Set([
  'p',
  'reel',
  'reels',
  'explore',
  'stories',
  'tv',
  'watch',
  'videos',
  'directory',
  'results',
  'playlist',
  'shorts',
  'embed',
  'share',
  'tag',
  'discover',
]);

const HANDLE = /^[A-Za-z0-9._-]{2,64}$/;

/**
 * A supported social URL as { platform, entity, handle?, id?, url }, or null.
 * YouTube /channel/UC... is a channel id; /@name, /c/name and /user/name are handles.
 */
export function parseSocialUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  const ok = (h) => HANDLE.test(h) && !RESERVED.has(h.toLowerCase());
  if (host === 'instagram.com' && ok(first)) {
    return {
      platform: 'instagram',
      entity: 'creator',
      handle: first.toLowerCase(),
      url: `https://www.instagram.com/${first.toLowerCase()}/`,
    };
  }
  if (host === 'tiktok.com' && first.startsWith('@') && ok(first.slice(1))) {
    const h = first.slice(1).toLowerCase();
    return {
      platform: 'tiktok',
      entity: 'creator',
      handle: h,
      url: `https://www.tiktok.com/@${h}`,
    };
  }
  if (host === 'twitch.tv' && ok(first)) {
    return {
      platform: 'twitch',
      entity: 'creator',
      handle: first.toLowerCase(),
      url: `https://www.twitch.tv/${first.toLowerCase()}`,
    };
  }
  if (host === 'youtube.com') {
    if (first === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] ?? '')) {
      return {
        platform: 'youtube',
        entity: 'channel',
        id: parts[1],
        url: `https://www.youtube.com/channel/${parts[1]}`,
      };
    }
    const h = first.startsWith('@')
      ? first.slice(1)
      : ['c', 'user'].includes(first)
        ? (parts[1] ?? '')
        : '';
    if (h && ok(h)) {
      return {
        platform: 'youtube',
        entity: 'channel',
        handle: h.toLowerCase(),
        url: `https://www.youtube.com/@${h}`,
      };
    }
  }
  return null;
}

/** The distinct supported accounts a profile row names, from its accounts list and its OpenProfile text. */
export function profileAccounts(item) {
  const d = item?.data ?? {};
  const texts = [];
  for (const a of Array.isArray(d.accounts) ? d.accounts : [])
    if (a?.url) texts.push(String(a.url));
  if (typeof d.doc === 'string') texts.push(d.doc);
  if (typeof d.openprofile === 'string') texts.push(d.openprofile);
  if (typeof d.web === 'string') texts.push(d.web);
  const seen = new Set();
  const out = [];
  for (const t of texts) {
    for (const m of t.matchAll(/https?:\/\/[^\s)<>\]"'`,]+/g)) {
      const a = parseSocialUrl(m[0]);
      if (!a) continue;
      const key = `${a.platform}:${a.id ?? a.handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out.slice(0, MAX_ACCOUNTS);
}

/** The latest point (and the earliest in the window, for change) of each metric in a series answer. */
export function summariseSeries(resp) {
  const metrics = {};
  for (const s of Array.isArray(resp?.series) ? resp.series : []) {
    const pts = (Array.isArray(s?.data_points) ? s.data_points : []).filter(
      (p) => Number.isFinite(p?.value) && Number.isFinite(p?.timestamp),
    );
    if (!s?.metric || pts.length === 0) continue;
    pts.sort((a, b) => a.timestamp - b.timestamp);
    const last = pts[pts.length - 1];
    const firstPt = pts[0];
    metrics[s.metric] = {
      value: last.value,
      at: new Date(last.timestamp * 1000).toISOString(),
      change: pts.length > 1 ? last.value - firstPt.value : null,
      since: pts.length > 1 ? new Date(firstPt.timestamp * 1000).toISOString() : null,
    };
  }
  return metrics;
}

const HEADLINE = {
  youtube: 'subscriber_count',
  instagram: 'follower_count',
  tiktok: 'follower_count',
  twitch: 'follower_count',
};

export const scrapeExchange = defineEnricher({
  name: 'scrape-exchange',
  title: 'Social audience (scrape.exchange)',
  description:
    'Subscriber and follower counts for the YouTube, Instagram, TikTok and Twitch accounts a profile links, with when they were read. Public counts only, from scrape.exchange (CC BY-SA 4.0).',
  collections: ['profiles'],
  appliesTo: (item) => profileAccounts(item).length > 0,
  perRun: 30,
  async enrich(item, { http }) {
    const found = [];
    for (const a of profileAccounts(item)) {
      const filter = { platform: a.platform, entity: a.entity, first: 1 };
      if (a.id) filter.platform_content_id = a.id;
      else filter.platform_creator_id = a.handle;
      const hit = await http.jsonOrNull(`${API}/filter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(filter),
      });
      const node = hit?.edges?.[0]?.node;
      if (!node?.platform_content_id || !node?.username) continue;
      const params = new URLSearchParams({
        platform: a.platform,
        platform_content_id: node.platform_content_id,
        uploader: node.username,
        datapoint_count: '30',
      });
      const series = await http.jsonOrNull(`${API}/stats/metrics?${params}`);
      const metrics = summariseSeries(series);
      if (Object.keys(metrics).length === 0) continue;
      const head = metrics[HEADLINE[a.platform]] ?? null;
      found.push({
        network: a.platform,
        handle: node.platform_creator_id ?? a.handle ?? null,
        url: node.source_url ?? a.url,
        audience: head?.value ?? null,
        metrics,
      });
    }
    if (found.length === 0) return null;
    const total = found.reduce((n, f) => n + (f.audience ?? 0), 0);
    return {
      accounts: found,
      audience: total || null,
      credit: 'scrape.exchange, CC BY-SA 4.0',
      tags: total >= 1_000_000 ? ['audience-1m'] : total >= 100_000 ? ['audience-100k'] : [],
    };
  },
});
