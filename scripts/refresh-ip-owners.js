#!/usr/bin/env bun
/**
 * Refresh the published address ranges in
 * packages/core/src/traffic/owners-data.json: crawlers and CDNs that publish
 * their own lists. Run it when one of them changes, then commit the result.
 *
 *   bun scripts/refresh-ip-owners.js
 */
const OUT = new URL('../packages/core/src/traffic/owners-data.json', import.meta.url);

/** Google-style lists: { prefixes: [{ ipv4Prefix } | { ipv6Prefix }] }. */
const prefixList = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const { prefixes = [] } = await res.json();
  return prefixes.map((p) => p.ipv4Prefix ?? p.ipv6Prefix).filter(Boolean);
};
const lineList = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.text()).split(/\s+/).filter(Boolean);
};

const SOURCES = {
  applebot: ['https://search.developer.apple.com/applebot.json', prefixList],
  googlebot: [
    'https://developers.google.com/static/search/apis/ipranges/googlebot.json',
    prefixList,
  ],
  bingbot: ['https://www.bing.com/toolbox/bingbot.json', prefixList],
  cloudflare: ['https://www.cloudflare.com/ips-v4', lineList],
  'cloudflare-v6': ['https://www.cloudflare.com/ips-v6', lineList],
};

const data = { fetched_at: new Date().toISOString(), ranges: {} };
for (const [key, [url, read]] of Object.entries(SOURCES)) {
  const ranges = await read(url);
  if (!ranges.length) throw new Error(`${url}: no ranges`);
  const slug = key.replace(/-v6$/, '');
  data.ranges[slug] = [...(data.ranges[slug] ?? []), ...ranges];
  console.log(`${slug}: ${ranges.length} from ${url}`);
}
await Bun.write(OUT, `${JSON.stringify(data, null, 2)}\n`);
