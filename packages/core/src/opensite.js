/**
 * OpenSite: one record about a page, read the way the spec says.
 *
 * https://logicsrc.com/opensite. A chat app, a social network and a search
 * engine each read a page's card tags their own way and cache what they read;
 * this is the reading written down, so the index can keep it, show it, and
 * hand it to anyone. Everything here is pure except `readUrl`, which fetches
 * with whatever `http` it is given, so the adapter and the web page share one
 * reader and the tests never touch the network.
 *
 * The rules, in the order the spec lists them: fetch within limits, refuse
 * politely (robots.txt and the site's own descriptor), then first answer wins
 * for each key. `cards` keeps every og:, twitter: and other prefixed tag
 * verbatim, because the consumers do not agree and a person checking a card
 * wants to see what each one saw.
 */

export const VERSION = '0.1';
export const SPEC = 'https://logicsrc.com/opensite';
export const AGENT = `OpenSite/${VERSION} (+${SPEC})`;
export const WELL_KNOWN = '/.well-known/opensite.json';

export const KINDS = [
  'site',
  'page',
  'article',
  'profile',
  'product',
  'event',
  'video',
  'audio',
  'podcast',
  'episode',
  'stream',
  'feed',
  'other',
];

/** The limits the spec sets on a read. */
export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
/** A record is never bigger than this; JSON-LD is the first thing cut. */
export const MAX_RECORD_BYTES = 256 * 1024;

const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);

/* ------------------------------------------------------------- parsing -- */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML entities in an attribute or a title, decoded once. */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** The attributes of one tag, lower-cased keys, decoded values. */
export function attributesOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9:-]+/, '').replace(/\/?>$/, '');
  for (const m of inner.matchAll(re)) {
    const key = m[1].toLowerCase();
    if (key === '/' || key === '') continue;
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

const clean = (s) =>
  decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What the head of a page says: the title, the language, every meta tag
 * that names itself, every link, and the JSON-LD blocks that parse. Nothing
 * is interpreted here; that is `readRecord`'s job.
 */
export function parseHead(html) {
  const text = String(html ?? '').slice(0, MAX_BYTES);
  const metas = [];
  for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributesOf(m[0]);
    const name = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    const content = a.content ?? a.value;
    if (name && content !== undefined) metas.push({ name, content: content.trim() });
  }
  const links = [];
  for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributesOf(m[0]);
    if (!a.href) continue;
    links.push({
      rel: (a.rel ?? '').toLowerCase().split(/\s+/).filter(Boolean),
      href: a.href,
      type: (a.type ?? '').toLowerCase() || null,
      title: a.title ?? null,
      sizes: a.sizes ?? null,
    });
  }
  const jsonld = [];
  for (const m of text.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) jsonld.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        // A @graph is several things in one block.
        if (Array.isArray(parsed['@graph'])) jsonld.push(...parsed['@graph']);
        else jsonld.push(parsed);
      }
    } catch {
      // Not JSON; the page's problem, not the reader's.
    }
  }
  const title = clean(text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const lang =
    clean(attributesOf(text.match(/<html\b[^>]*>/i)?.[0] ?? '<html>').lang ?? '') || null;
  return { title, lang, metas, links, jsonld };
}

/**
 * The card tags by prefix, verbatim: `og:image:width` becomes
 * `cards.og["image:width"]`. A tag repeated (several og:image) keeps the
 * first, which is what every consumer does.
 */
export function cardsOf(metas) {
  const cards = {};
  for (const { name, content } of metas) {
    const colon = name.indexOf(':');
    if (colon <= 0) continue;
    const prefix = name.slice(0, colon);
    const key = name.slice(colon + 1);
    if (!/^[a-z][a-z0-9_-]*$/.test(prefix) || key === '') continue;
    cards[prefix] ??= {};
    if (!(key in cards[prefix])) cards[prefix][key] = content;
  }
  return cards;
}

/* ------------------------------------------------------------- reading -- */

/** An http(s) address resolved against the page, or null. */
export function webUrl(value, base) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

const TYPE_KINDS = {
  article: 'article',
  newsarticle: 'article',
  blogposting: 'article',
  techarticle: 'article',
  report: 'article',
  person: 'profile',
  organization: 'profile',
  product: 'product',
  event: 'event',
  videoobject: 'video',
  movie: 'video',
  audioobject: 'audio',
  musicrecording: 'audio',
  podcastseries: 'podcast',
  podcastepisode: 'episode',
  broadcastevent: 'stream',
  website: 'site',
  webpage: 'page',
};

function typeOf(node) {
  const t = node?.['@type'];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  for (const one of list) {
    const kind = TYPE_KINDS[String(one).toLowerCase()];
    if (kind) return kind;
  }
  return null;
}

/** The kind of a page: JSON-LD's word for it, else og:type's, else page. */
export function kindOf({ jsonld = [], og = {} } = {}) {
  for (const node of jsonld) {
    const kind = typeOf(node);
    if (kind) return kind;
  }
  const type = String(og.type ?? '').toLowerCase();
  if (type === '') return 'page';
  if (type === 'website') return 'page';
  if (type.startsWith('video')) return 'video';
  if (type.startsWith('music')) return 'audio';
  if (KINDS.includes(type)) return type;
  return 'page';
}

const firstString = (...values) => {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return clean(v);
    if (Array.isArray(v)) {
      const s = firstString(...v);
      if (s) return s;
    }
  }
  return '';
};

/** The first JSON-LD node that names a thing, and its field. */
function ld(jsonld, key) {
  for (const node of jsonld) {
    const v = node?.[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'object') return v;
  }
  return null;
}

function ldImage(jsonld) {
  const v = ld(jsonld, 'image');
  if (!v) return null;
  if (typeof v === 'string') return { url: v };
  const one = Array.isArray(v) ? v[0] : v;
  if (!one) return null;
  if (typeof one === 'string') return { url: one };
  const width = Number(one.width);
  const height = Number(one.height);
  return {
    url: one.url ?? one.contentUrl ?? null,
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
  };
}

function ldAuthor(jsonld) {
  const v = ld(jsonld, 'author');
  if (!v) return null;
  const one = Array.isArray(v) ? v[0] : v;
  if (typeof one === 'string') return { name: clean(one) };
  if (one && typeof one === 'object') {
    const name = firstString(one.name);
    return name ? { name, ...(webUrl(one.url) ? { web: webUrl(one.url) } : {}) } : null;
  }
  return null;
}

const iso = (s) => {
  const d = new Date(String(s ?? ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The largest icon a page links, for a card with nothing better. */
function largestIcon(links, base) {
  let best = null;
  let size = -1;
  for (const l of links) {
    if (!l.rel.includes('icon') && !l.rel.includes('apple-touch-icon')) continue;
    const px =
      Number(String(l.sizes ?? '').split('x')[0]) ||
      (l.rel.includes('apple-touch-icon') ? 180 : 16);
    if (px > size) {
      const u = webUrl(l.href, base);
      if (u) {
        best = u;
        size = px;
      }
    }
  }
  return best;
}

/**
 * A record from what a fetch produced. `html` may be '' for a response that
 * was not a page; `status` decides gone; `contentType` decides the kind of a
 * media file. Pure, so a fixture proves every rule.
 */
export function readRecord({
  url,
  finalUrl = url,
  status = 200,
  contentType = 'text/html',
  html = '',
  fetchedAt = new Date(),
  blocked = false,
  site = null,
}) {
  const asked = webUrl(url) ?? String(url);
  const landed = webUrl(finalUrl) ?? asked;
  const fetched = fetchedAt instanceof Date ? fetchedAt.toISOString() : String(fetchedAt);
  const base = { opensite: VERSION, url: asked, fetched_at: fetched, source: 'read' };
  const siteOf = (canonical) => {
    if (site?.name && site?.web) return { name: site.name, web: site.web };
    try {
      const u = new URL(canonical);
      return { name: site?.name ?? u.hostname.replace(/^www\./, ''), web: `${u.origin}` };
    } catch {
      return { name: 'unknown', web: '' };
    }
  };
  if (blocked) {
    return {
      ...base,
      canonical: landed,
      site: siteOf(landed),
      kind: 'page',
      title: '',
      status: 'blocked',
    };
  }
  const type = String(contentType ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (status === 404 || status === 410) {
    return {
      ...base,
      canonical: landed,
      site: siteOf(landed),
      kind: 'page',
      title: '',
      status: 'gone',
    };
  }
  if (type && !/html|xhtml/.test(type)) {
    const kind = type.startsWith('video/')
      ? 'video'
      : type.startsWith('audio/')
        ? 'audio'
        : FEED_TYPES.has(type) || /xml/.test(type)
          ? 'feed'
          : 'other';
    return {
      ...base,
      canonical: landed,
      site: siteOf(landed),
      kind,
      title: decodeURIComponent(landed.split('/').filter(Boolean).pop() ?? '') || landed,
      status: 'live',
      content_type: type,
    };
  }

  const head = parseHead(html);
  const cards = cardsOf(head.metas);
  const og = cards.og ?? {};
  const twitter = cards.twitter ?? {};
  const article = cards.article ?? {};
  const meta = (name) => head.metas.find((m) => m.name === name)?.content ?? '';
  const jsonld = head.jsonld;

  const canonicalLink = head.links.find((l) => l.rel.includes('canonical'))?.href;
  const canonical = webUrl(canonicalLink, landed) ?? webUrl(og.url, landed) ?? landed;
  let status_ = 'live';
  try {
    if (new URL(canonical).origin !== new URL(landed).origin) status_ = 'moved';
  } catch {
    // landed is a URL; canonical came through webUrl.
  }

  const title = firstString(
    ld(jsonld, 'headline'),
    ld(jsonld, 'name'),
    og.title,
    twitter.title,
    head.title,
  );
  const description = firstString(
    ld(jsonld, 'description'),
    og.description,
    twitter.description,
    meta('description'),
  );

  let image = null;
  const ogImage = webUrl(og.image ?? og['image:url'] ?? og['image:secure_url'], landed);
  if (ogImage) {
    const width = Number(og['image:width']);
    const height = Number(og['image:height']);
    image = {
      url: ogImage,
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      ...(og['image:alt'] ? { alt: clean(og['image:alt']) } : {}),
    };
  } else {
    const tw = webUrl(twitter.image ?? twitter['image:src'], landed);
    if (tw)
      image = { url: tw, ...(twitter['image:alt'] ? { alt: clean(twitter['image:alt']) } : {}) };
    else {
      const fromLd = ldImage(jsonld);
      const u = fromLd ? webUrl(fromLd.url, landed) : null;
      if (u) image = { ...fromLd, url: u };
      else {
        const icon = largestIcon(head.links, landed);
        if (icon) image = { url: icon, icon: true };
      }
    }
  }

  const author = (() => {
    const fromLd = ldAuthor(jsonld);
    const name = fromLd?.name || firstString(article.author, meta('author'));
    const me = head.links.find(
      (l) => (l.rel.includes('me') || l.rel.includes('author')) && /openprofile\.md$/i.test(l.href),
    );
    if (!name && !me) return null;
    return {
      ...(name ? { name } : {}),
      ...(me ? { profile: webUrl(me.href, landed) } : {}),
      ...(fromLd?.web ? { web: fromLd.web } : {}),
    };
  })();

  const feeds = head.links
    .filter((l) => l.rel.includes('alternate') && l.type && FEED_TYPES.has(l.type))
    .map((l) => webUrl(l.href, landed))
    .filter(Boolean);

  const tags = [
    ...String(article.tag ?? '').split(','),
    ...String(meta('keywords')).split(','),
    ...(Array.isArray(ld(jsonld, 'keywords'))
      ? ld(jsonld, 'keywords')
      : String(ld(jsonld, 'keywords') ?? '').split(',')),
  ]
    .map((t) => clean(t).toLowerCase())
    .filter((t) => t !== '' && t.length <= 60);

  const record = {
    ...base,
    canonical,
    site: siteOf(canonical),
    kind: kindOf({ jsonld, og }),
    title,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(head.lang || og.locale
      ? { language: head.lang ?? String(og.locale).replace('_', '-') }
      : {}),
    ...(author ? { author } : {}),
    tags: [...new Set(tags)].slice(0, 40),
    feeds: [...new Set(feeds)].slice(0, 10),
    published_at: iso(ld(jsonld, 'datePublished') ?? article.published_time),
    modified_at: iso(ld(jsonld, 'dateModified') ?? article.modified_time),
    status: status_,
    cards,
    jsonld,
  };
  if (og.site_name) record.site.name = clean(og.site_name);
  return fit(record);
}

/** A record no bigger than the spec allows; JSON-LD goes first, then cards. */
export function fit(record) {
  let out = record;
  if (JSON.stringify(out).length > MAX_RECORD_BYTES) out = { ...out, jsonld: [] };
  if (JSON.stringify(out).length > MAX_RECORD_BYTES) out = { ...out, cards: {} };
  return out;
}

/* ---------------------------------------------------------------- paths -- */

/**
 * Where a record lives on the index: `/c/sites/<host>/<path>` with the query
 * kept, because a page's identity can be in its query (nixamp's share links
 * are). The scheme is dropped; a lookup tries https then http.
 */
export function recordPath(canonical) {
  try {
    const u = new URL(canonical);
    const path = `${u.pathname}${u.search}`.replace(/^\/+/, '');
    return path ? `${u.host}/${path}` : u.host;
  } catch {
    return null;
  }
}

/** The addresses a path may stand for, https first. */
export function urlsForPath(rest) {
  const clean_ = String(rest ?? '').replace(/^\/+/, '');
  if (clean_ === '' || /[\s<>"']/.test(clean_)) return [];
  const slash = clean_.indexOf('/');
  const host = slash === -1 ? clean_ : clean_.slice(0, slash);
  const path = slash === -1 ? '' : clean_.slice(slash);
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return [];
  const out = [];
  for (const scheme of ['https', 'http']) {
    out.push(`${scheme}://${host}${path || ''}`);
    if (path === '') out.push(`${scheme}://${host}/`);
  }
  return out;
}

/* ---------------------------------------------------------------- items -- */

/** The row the table stores for a record: keyed by its canonical address. */
export function recordItem(record) {
  if (!record?.canonical) return null;
  const host = (() => {
    try {
      return new URL(record.canonical).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  })();
  const title = record.title || record.site?.name || host || record.canonical;
  const published = record.published_at ?? null;
  return {
    externalId: `opensite:${record.canonical}`.slice(0, 500),
    kind: record.kind,
    title,
    summary: record.description ?? null,
    url: record.canonical,
    imageUrl: record.image?.url && !record.image.icon ? record.image.url : null,
    publishedAt: published,
    timeKnown: Boolean(published),
    precision: 'minute',
    tags: [
      `kind:${record.kind}`,
      host ? `site:${host}` : null,
      `status:${record.status}`,
      record.source === 'declared' ? 'declared' : null,
      ...(record.tags ?? []).map((t) => `topic:${t}`),
    ].filter(Boolean),
    data: { record, path: recordPath(record.canonical), spec: SPEC },
  };
}

/* ---------------------------------------------------------------- fetch -- */

/**
 * Whether robots.txt lets this agent read the path. The Google reading: the
 * group naming our token, else `*`; longest match wins; Allow beats Disallow
 * on a tie. No rule is permission.
 */
export function robotsAllows(robotsTxt, path, userAgent = AGENT) {
  const groups = [];
  let current = null;
  for (const raw of String(robotsTxt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const token = String(userAgent).toLowerCase().split(/[\s/]/)[0];
  const pick =
    groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ??
    groups.find((g) => g.agents.includes('*'));
  if (!pick) return true;
  let winner = null;
  for (const rule of pick.rules) {
    if (rule.pattern === '') continue;
    const re = new RegExp(
      `^${rule.pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$')}`,
    );
    if (!re.test(path)) continue;
    if (
      !winner ||
      rule.pattern.length > winner.pattern.length ||
      (rule.pattern.length === winner.pattern.length && rule.allow)
    )
      winner = rule;
  }
  return winner ? winner.allow : true;
}

/** The first `max` bytes of a response body as text, then the rest is dropped. */
async function readBody(res, max = MAX_BYTES) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  while (bytes < max) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    // A page's head is what matters; the body can be long.
    if (out.includes('</head>') && bytes > 256 * 1024) break;
  }
  reader.cancel().catch(() => {});
  return out;
}

/**
 * A site's descriptor and robots, read once per origin per reader and kept
 * in `cache` (a Map the caller owns, so a run shares one).
 */
async function policyFor(origin, { http, cache }) {
  if (cache.has(origin)) return cache.get(origin);
  const policy = { robots: '', descriptor: null };
  try {
    const r = await http.request(`${origin}/robots.txt`, {
      headers: { accept: 'text/plain' },
      timeoutMs: 8_000,
    });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('text'))
      policy.robots = (await readBody(r, 256 * 1024)).slice(0, 256 * 1024);
  } catch {
    // No robots is permission.
  }
  try {
    const r = await http.request(`${origin}${WELL_KNOWN}`, {
      headers: { accept: 'application/json' },
      timeoutMs: 8_000,
    });
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
      const doc = await r.json();
      if (doc && typeof doc === 'object' && doc.site && typeof doc.site === 'object')
        policy.descriptor = doc;
    }
  } catch {
    // No descriptor is the ordinary case.
  }
  cache.set(origin, policy);
  return policy;
}

/**
 * One URL, read as the spec says, with the `http` the caller provides (the
 * core client for a run, or a stub in a test). Never throws: a page that
 * cannot be read is a record that says so.
 */
export async function readUrl(url, { http, cache = new Map(), now = () => new Date() } = {}) {
  const asked = webUrl(url);
  if (!asked) return null;
  const origin = new URL(asked).origin;
  const policy = await policyFor(origin, { http, cache });
  const site = policy.descriptor?.site
    ? { name: policy.descriptor.site.name, web: policy.descriptor.site.web }
    : null;
  const path = `${new URL(asked).pathname}${new URL(asked).search}`;
  if (policy.descriptor?.index?.allow === false || !robotsAllows(policy.robots, path)) {
    return readRecord({ url: asked, fetchedAt: now(), blocked: true, site });
  }
  let res;
  try {
    res = await http.request(asked, {
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return {
      ...readRecord({ url: asked, fetchedAt: now(), status: 404, site }),
      status: 'gone',
      error: String(err?.message ?? err).slice(0, 200),
    };
  }
  const contentType = res.headers.get('content-type') ?? '';
  const html = /html|xhtml/i.test(contentType) && res.ok ? await readBody(res) : '';
  if (!/html|xhtml/i.test(contentType) && res.body) res.body.cancel?.().catch?.(() => {});
  return readRecord({
    url: asked,
    finalUrl: res.url || asked,
    status: res.status,
    contentType,
    html,
    fetchedAt: now(),
    site,
  });
}

/**
 * The page addresses a sitemap names, and the sitemaps a sitemap index
 * names, one level deep, bounded.
 */
export async function readSitemap(url, { http, max = 500 } = {}) {
  const asked = webUrl(url);
  if (!asked) return { urls: [], sitemaps: [] };
  let text = '';
  try {
    const r = await http.request(asked, {
      headers: { accept: 'application/xml,text/xml,*/*' },
      timeoutMs: TIMEOUT_MS,
    });
    if (!r.ok) return { urls: [], sitemaps: [] };
    text = await readBody(r, 8 * 1024 * 1024);
  } catch {
    return { urls: [], sitemaps: [] };
  }
  const urls = [];
  const sitemaps = [];
  const isIndex = /<sitemapindex/i.test(text);
  for (const m of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const u = webUrl(decodeEntities(m[1]));
    if (!u) continue;
    (isIndex ? sitemaps : urls).push(u);
    if (urls.length >= max) break;
  }
  return { urls: [...new Set(urls)].slice(0, max), sitemaps: [...new Set(sitemaps)].slice(0, 50) };
}
