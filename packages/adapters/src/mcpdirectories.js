import { decodeEntities, defineAdapter } from '@nichedb/core/adapter';
import { cleanText, repoSlug, repoUrl } from './catalogs.js';

/**
 * The MCP directories that publish only web pages: mcp.so, mcpmarket.com and
 * mcpservers.org.
 *
 * None of the three has a public API. Each publishes a sitemap of its server
 * pages, and each server page carries its facts in a machine-readable form:
 * mcpmarket.com a schema.org `SoftwareApplication` whose `url` IS the
 * repository, mcp.so the server record its page hydrates from (`repoUrl`,
 * `authorName`, `runtime`, ...), mcpservers.org the repository link beside an
 * `<h1>` and tagline. So an adapter here walks the sitemap and reads one page
 * per server.
 *
 * WHY THESE AND NOT OTHERS (checked 2026-11-22). Each site's robots.txt allows
 * its server pages to every crawler, and none of their terms forbids automated
 * reading (mcp.so's terms have no such clause at all, mcpmarket.com's only bar
 * reselling access to its hosting, mcpservers.org publishes none). Two
 * directories were left out on their terms: Cline's marketplace API (the terms
 * at cline.bot/tos limit use to personal or internal purposes and forbid
 * copying or distributing any part of the service, scraped or not) and LobeHub
 * (lobehub.com/terms reserves the data within the service and forbids copying
 * it). Claude's and ChatGPT's directories sit behind a sign-in.
 *
 * THE KEY IS THE REPOSITORY. Every row's URL is the server's repository folded
 * by `repoUrl`, when the page names one, so the same server from the registry,
 * an awesome list or Smithery lands on the row that is already there:
 * `dedupe_urls` keeps the first writer, and these sources are registered after
 * all the others. What they add is the servers nobody else lists. A page with
 * no repository keys on its own listing URL, which is unique per server. Every
 * row also carries `data.credit` with the listing, so it links back to the
 * directory's page wherever it is shown.
 *
 * THE WALK. Each run reads the sitemap index, then works through one child
 * sitemap after another from a cursor saved after every batch:
 * `{ v, mode, child, at, counts, since, walkStarted, fullAt }`. A run reads at
 * most `pagesPerRun` pages with `delayMs` between them (two seconds where the
 * site asks for a crawl delay), stops at the deadline, and comes back in
 * `WALK_AGAIN_MINUTES` until the walk is done. The first walk reads every
 * page. After it, a daily walk reads only what changed: a URL whose sitemap
 * `lastmod` is newer than the start of the previous walk, or, where the site
 * gives no `lastmod`, a URL past where that child sitemap ended last time
 * (`counts`). Every `FULL_WALK_DAYS` the whole site is read again so edits on
 * sites without `lastmod`, and anything the tail rule missed, still land.
 *
 * FAILURES, per the fleet crawler rule: the sitemap index failing, or the
 * first page of a run, throws, so a dead site is flagged for 30 days. A 403 or
 * 429 (or a Cloudflare challenge) mid-run ends the run where it is, cursor
 * kept, back in an hour: pressing on is how a rate limit becomes a ban. Any
 * other failing page is retried once and then skipped (a 404 is a server that
 * was removed), and five failures in a row end the run at its cursor.
 */

export const FULL_WALK_DAYS = 30;
export const WALK_AGAIN_MINUTES = 10;
const BLOCKED_AGAIN_MINUTES = 60;
const MAX_FAILURES_IN_A_ROW = 5;
const DEADLINE_MARGIN_MS = 15_000;
const CHUNK = 25;

const sleep = (ms) => (ms > 0 ? Bun.sleep(ms) : Promise.resolve());

/**
 * `<sitemap>` and `<url>` entries of a sitemap or sitemap index.
 *
 * @param {string} xml
 * @returns {{ sitemaps: string[], urls: { loc: string, lastmod: string|null }[] }}
 */
export function parseSitemap(xml) {
  const s = String(xml ?? '');
  const loc = (block) => {
    const m = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(block);
    return m ? decodeEntities(m[1]) : null;
  };
  const sitemaps = [];
  for (const m of s.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)) {
    const l = loc(m[1]);
    if (l) sitemaps.push(l);
  }
  const urls = [];
  for (const m of s.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const l = loc(m[1]);
    if (!l) continue;
    const lm = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/.exec(m[1]);
    const t = lm ? Date.parse(lm[1]) : Number.NaN;
    urls.push({ loc: l, lastmod: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return { sitemaps, urls };
}

/** Every JSON-LD block of a page, parsed, with `@graph` flattened. */
export function jsonLd(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const v = JSON.parse(m[1]);
      for (const n of Array.isArray(v) ? v : [v]) {
        if (Array.isArray(n?.['@graph'])) out.push(...n['@graph']);
        else if (n && typeof n === 'object') out.push(n);
      }
    } catch {
      // A malformed block is someone else's bug; the rest of the page still counts.
    }
  }
  return out;
}

/** The content of a `<meta name|property="key">`, entity-decoded. */
export function meta(html, key) {
  const re = new RegExp(
    `<meta\\s+(?:name|property)=["']${key.replace(/[.:]/g, '\\$&')}["']\\s+content=["']([^"']*)["']`,
    'i',
  );
  const m = re.exec(String(html ?? ''));
  return m ? decodeEntities(m[1]).trim() || null : null;
}

const clean = (s) => {
  const t = decodeEntities(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
};

const isRepoHost = (u) => /^https?:\/\/(www\.)?(github\.com|gitlab\.com|codeberg\.org)\//i.test(u);

/**
 * The common row. `page` is what a site parser found on one server page.
 *
 * @param {object} site    the site spec (`prefix`, `name`, `home`)
 * @param {string} listing the page's URL
 * @param {object} page    { name, summary, repository, image, author, category, tags, extra }
 */
export function rowFor(site, listing, page) {
  if (!page?.name) return null;
  const path = new URL(listing).pathname.replace(/^\/+|\/+$/g, '');
  const repo = page.repository && isRepoHost(page.repository) ? repoUrl(page.repository) : null;
  return {
    externalId: `${site.prefix}:${path}`,
    kind: 'mcp-server',
    title: String(page.name).slice(0, 200),
    summary: page.summary ?? null,
    url: repo ?? listing,
    imageUrl: page.image ?? null,
    tags: [
      'mcp',
      site.prefix,
      page.category ? String(page.category).toLowerCase() : null,
      ...(page.tags ?? []).map((t) => String(t).toLowerCase()),
    ]
      .filter(Boolean)
      .slice(0, 12),
    data: {
      listing,
      repository: page.repository ?? null,
      repo: repoSlug(repo ?? ''),
      author: page.author ?? null,
      category: page.category ?? null,
      ...(page.extra ?? {}),
      lastmod: page.lastmod ?? null,
      credit: { name: site.name, text: `Listed on ${site.name}`, url: site.home, listing },
    },
  };
}

/* ---------------------------------------------------------------- mcp.so */

/**
 * The flat record that starts at `at` in a hydration payload, read field by
 * field: `key:"string"`, `key:!0` / `!1`, `key:null`, `key:123`. Anything else
 * (a nested `$R[..]` reference or object) ends the read, which is fine: the
 * fields worth having come before it. Scanned rather than matched with a
 * window because `description` is often a whole README.
 *
 * @returns {Record<string, string|boolean|number|null>}
 */
export function readRecord(s, at) {
  const out = {};
  let i = at;
  const n = s.length;
  while (i < n) {
    const k = /^([A-Za-z_$][\w$]*):/.exec(s.slice(i, i + 80));
    if (!k) break;
    i += k[0].length;
    const ch = s[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const raw = s.slice(i + 1, j);
      try {
        out[k[1]] = JSON.parse(`"${raw}"`);
      } catch {
        out[k[1]] = raw;
      }
      i = j + 1;
    } else {
      const v = /^(!0|!1|null|-?\d+(?:\.\d+)?)/.exec(s.slice(i, i + 30));
      if (!v) break;
      out[k[1]] =
        v[1] === '!0' ? true : v[1] === '!1' ? false : v[1] === 'null' ? null : Number(v[1]);
      i += v[1].length;
    }
    if (s[i] !== ',') break;
    i += 1;
  }
  return out;
}

/** The first prose paragraph of a README-ish description, or the text itself. */
export function firstParagraph(md) {
  const text = String(md ?? '');
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p || /^(#|!\[|<|```|\||>)/.test(p)) continue;
    const c = cleanText(p);
    if (c) return c.length > 600 ? `${c.slice(0, 597)}...` : c;
  }
  return null;
}

/**
 * One mcp.so server page. The page hydrates from a record written as a JS
 * object literal (`slug:"redis",previousSlug:null,name:"Redis",...,repoUrl:"https://github.com/..."`),
 * which carries the repository; JSON-LD carries the category and dates.
 */
export function parseMcpSo(html, listing) {
  const slug = decodeURIComponent(new URL(listing).pathname.split('/').filter(Boolean).pop() ?? '');
  const s = String(html ?? '');
  const at = s.indexOf(`slug:${JSON.stringify(slug)}`);
  const r = at >= 0 ? readRecord(s, at) : {};
  const app = jsonLd(s).find((n) => n['@type'] === 'SoftwareApplication') ?? {};
  const name = clean(r.name) ?? clean(app.name);
  if (!name) return null;
  let tools = [];
  try {
    tools = JSON.parse(r.tools ?? '[]')
      .map((t) => t?.name)
      .filter(Boolean);
  } catch {
    tools = [];
  }
  let transports = [];
  try {
    transports = JSON.parse(r.transports ?? '[]').filter((x) => typeof x === 'string');
  } catch {
    transports = [];
  }
  const runtime = clean(r.runtime);
  const remote = r.isRemote === true;
  const license = clean(r.license);
  return {
    name,
    summary: firstParagraph(r.description) ?? clean(r.tagline) ?? clean(app.description),
    repository: clean(r.repoUrl),
    image: clean(r.iconUrl) ?? clean(app.image),
    author: clean(r.authorName) ?? clean(app.author?.name),
    category: clean(app.applicationCategory),
    tags: [runtime, remote ? 'remote' : null, tools.length ? 'tools' : null].filter(Boolean),
    extra: {
      website: clean(r.websiteUrl),
      license: license && license !== 'NOASSERTION' ? license : null,
      runtime,
      transports,
      remote,
      toolCount: tools.length,
      tools: tools.slice(0, 50),
      published: clean(app.datePublished),
      modified: clean(app.dateModified),
    },
  };
}

/* --------------------------------------------------------- mcpmarket.com */

/**
 * The page's link to `github.com/<owner>/<repo>` for the listed owner, or null.
 * mcpmarket's record names a website or an npm page as `url` for about a
 * quarter of servers (measured on 30 pages, 2026-11-22) while the page still
 * links the repository; only a repository belonging to the record's own
 * `author` is taken, so a link to somebody else's project never becomes the key.
 */
export function ownerRepoLink(html, owner) {
  if (!owner) return null;
  const want = String(owner).toLowerCase();
  for (const m of String(html ?? '').matchAll(
    /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?=["'\\\s<)])/g,
  )) {
    if (m[1].toLowerCase() === want) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}

/**
 * One mcpmarket.com server page: a schema.org SoftwareApplication whose `url`
 * is the repository, `author` its owner and `interactionStatistic` the likes.
 */
export function parseMcpMarket(html) {
  const app = jsonLd(html).find((n) => n['@type'] === 'SoftwareApplication');
  const name = clean(app?.name);
  if (!name) return null;
  const keywords = [
    ...new Set(
      String(app.keywords ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k && k.length <= 40 && !/^(mcp|model context protocol)$/i.test(k)),
    ),
  ];
  const likes = Number(app.interactionStatistic?.userInteractionCount);
  const related = (Array.isArray(app.isRelatedTo) ? app.isRelatedTo : []).find((r) =>
    /\/categories\//.test(r?.url ?? ''),
  );
  const category = related?.url ? related.url.split('/categories/')[1]?.split(/[/?#]/)[0] : null;
  const url = clean(app.url);
  const author = clean(app.author?.name);
  return {
    name,
    summary: clean(app.description) ?? meta(html, 'description'),
    repository: url && isRepoHost(url) ? url : ownerRepoLink(html, author),
    image: null,
    author,
    category,
    tags: keywords.slice(0, 5),
    extra: {
      website: url && !isRepoHost(url) ? url : null,
      likes: Number.isFinite(likes) ? likes : null,
      keywords: keywords.slice(0, 20),
    },
  };
}

/* -------------------------------------------------------- mcpservers.org */

/**
 * One mcpservers.org server page. No structured record: the `<h1>` is the
 * name, the paragraph after it the tagline, and the first repository link
 * after the heading is the server's own.
 */
export function parseMcpServers(html) {
  const s = String(html ?? '');
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
  const name = h1 ? clean(h1[1].replace(/<[^>]+>/g, ' ')) : null;
  if (!name) return null;
  const after = s.slice(h1.index, h1.index + 6000);
  const tagline = /<\/h1>[\s\S]{0,400}?<p[^>]*>([\s\S]*?)<\/p>/i.exec(after);
  const repo =
    /href="(https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org)\/[^"#?]+)"/i.exec(after);
  const crumbs = jsonLd(s).find((n) => n['@type'] === 'BreadcrumbList')?.itemListElement ?? [];
  const category = crumbs.find((c) => /\/category\//.test(c?.item ?? ''));
  return {
    name,
    summary: tagline ? clean(tagline[1].replace(/<[^>]+>/g, ' ')) : meta(s, 'og:description'),
    repository: repo ? decodeEntities(repo[1]) : null,
    image: null,
    author: null,
    category: category ? clean(category.name) : null,
    tags: [],
    extra: {},
  };
}

/* ------------------------------------------------------------------ walk */

/**
 * What this run does, from the cursor the last one left.
 *
 * @returns {{ start: boolean, state: object }} `start` when a new walk begins
 */
export function plan(cursor, now = Date.now()) {
  const c = cursor?.v === 1 ? cursor : {};
  if (c.walking) return { start: false, state: c };
  const full = !c.fullAt || now - Date.parse(c.fullAt) > FULL_WALK_DAYS * 86_400_000;
  return {
    start: true,
    state: {
      v: 1,
      walking: true,
      mode: full ? 'full' : 'delta',
      child: 0,
      at: 0,
      counts: c.counts ?? {},
      prevCounts: c.counts ?? {},
      since: full ? null : (c.since ?? null),
      walkStarted: new Date(now).toISOString(),
      fullAt: c.fullAt ?? null,
    },
  };
}

/**
 * The URLs of one child sitemap this walk should read, as [index, entry].
 * Full walk: all of them. Delta: newer than `since`, or, without a lastmod,
 * past where this child ended last time.
 */
export function wanted(urls, state, childUrl) {
  const prev = Number(state.prevCounts?.[childUrl] ?? 0);
  const since = state.since ? Date.parse(state.since) : null;
  const out = [];
  urls.forEach((u, i) => {
    if (state.mode === 'full' || since === null) out.push([i, u]);
    else if (u.lastmod ? Date.parse(u.lastmod) > since : i >= prev) out.push([i, u]);
  });
  return out;
}

const isBlocked = (res, body = '') =>
  res.status === 403 ||
  res.status === 429 ||
  res.headers?.get?.('cf-mitigated') === 'challenge' ||
  /<title>\s*Just a moment/i.test(body);

class Blocked extends Error {}

/** One page's HTML, retried once; null for a 404 (removed); throws Blocked on 403/429. */
async function fetchPage(http, url) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await http.request(url, { headers: { accept: 'text/html' } });
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (res.status === 403 || res.status === 429) {
        await res.body?.cancel().catch(() => {});
        throw new Blocked(`${res.status} from ${new URL(url).host}`);
      }
      const body = await res.text();
      if (isBlocked(res, body)) throw new Blocked(`challenge from ${new URL(url).host}`);
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return body;
    } catch (err) {
      if (err instanceof Blocked) throw err;
      last = err;
      if (attempt === 0) await sleep(1000);
    }
  }
  throw last;
}

/**
 * An adapter for one sitemap-only directory.
 *
 * @param {object} site
 * @param {string} site.adapter    adapter name
 * @param {string} site.slug       default source slug
 * @param {string} site.prefix     externalId prefix and tag
 * @param {string} site.name       display name ("mcp.so")
 * @param {string} site.home       https://host
 * @param {string} site.sitemap    the sitemap index
 * @param {(loc: string) => boolean} site.childFilter  which child sitemaps hold servers
 * @param {(loc: string) => boolean} site.pageFilter   which URLs are server pages
 * @param {(html: string, url: string) => object|null} site.parse
 * @param {number} [site.delayMs]
 */
export function directoryAdapter(site) {
  return defineAdapter({
    name: site.adapter,
    title: site.title,
    collection: 'mcp',
    description: site.description,
    docs: site.home,
    kinds: ['mcp-server'],
    cadenceMinutes: 60 * 24,
    attribution: { name: site.name, text: `Listed on ${site.name}`, url: site.home },
    configFields: [
      { key: 'pagesPerRun', label: 'Pages per run', type: 'number', placeholder: '100' },
      {
        key: 'delayMs',
        label: 'Pause between pages (ms)',
        type: 'number',
        placeholder: String(site.delayMs ?? 1000),
      },
    ],
    defaults: { pagesPerRun: 100, delayMs: site.delayMs ?? 1000 },
    defaultSources: [{ slug: site.slug, name: site.sourceName }],
    site,
    async *pull({ config, cursor, http, log, deadline = Infinity }) {
      const budget = Math.min(Math.max(Number(config.pagesPerRun) || 100, 1), 500);
      const delay = Math.max(Number(config.delayMs ?? site.delayMs ?? 1000) || 0, 0);
      const { state: initial } = plan(cursor);
      let s = initial;

      // The index failing is the site failing: throw, and let the crawler rule flag it.
      const index = parseSitemap(await http.text(site.sitemap, { timeoutMs: 15_000 }));
      const children = index.sitemaps.filter(site.childFilter);
      if (!children.length) throw new Error(`no server sitemaps in ${site.sitemap}`);

      let fetched = 0;
      let kept = 0;
      let skipped = 0;
      let failures = 0;
      const stop = (why, minutes) => {
        log(
          `${why}; ${kept} server(s) from ${fetched} page(s) this run, resuming at child ${s.child} url ${s.at}`,
        );
        return {
          cursor: s,
          note: `${s.mode} walk: ${kept} server(s) from ${fetched} page(s), ${why}`,
          nextInMinutes: minutes,
        };
      };

      while (s.child < children.length) {
        const childUrl = children[s.child];
        let urls;
        try {
          urls = parseSitemap(await http.text(childUrl, { timeoutMs: 20_000 })).urls.filter((u) =>
            site.pageFilter(u.loc),
          );
        } catch (err) {
          if (fetched === 0 && s.child === initial.child) throw err;
          return stop(`sitemap ${childUrl} failed (${err?.message ?? err})`, WALK_AGAIN_MINUTES);
        }
        s = { ...s, counts: { ...s.counts, [childUrl]: urls.length } };
        const todo = wanted(urls, s, childUrl).filter(([i]) => i >= s.at);

        for (let c = 0; c < todo.length; c += CHUNK) {
          const chunk = todo.slice(c, c + CHUNK);
          const items = [];
          for (const [i, u] of chunk) {
            if (fetched >= budget || Date.now() > deadline - DEADLINE_MARGIN_MS) {
              if (items.length) yield { items, cursor: s };
              return stop(fetched >= budget ? 'page budget spent' : 'deadline', WALK_AGAIN_MINUTES);
            }
            if (fetched > 0) await sleep(delay);
            let html;
            try {
              html = await fetchPage(http, u.loc);
              failures = 0;
            } catch (err) {
              if (err instanceof Blocked) {
                if (fetched === 0) throw err;
                if (items.length) yield { items, cursor: s };
                return stop(`blocked: ${err.message}`, BLOCKED_AGAIN_MINUTES);
              }
              failures++;
              log(`skipping ${u.loc}: ${err?.message ?? err}`);
              if (failures >= MAX_FAILURES_IN_A_ROW) {
                if (items.length) yield { items, cursor: s };
                return stop(`${failures} failing pages in a row`, WALK_AGAIN_MINUTES);
              }
              s = { ...s, at: i + 1 };
              fetched++;
              continue;
            }
            fetched++;
            s = { ...s, at: i + 1 };
            const row =
              html === null
                ? null
                : rowFor(site, u.loc, { ...site.parse(html, u.loc), lastmod: u.lastmod });
            if (row) {
              items.push(row);
              kept++;
            } else skipped++;
          }
          yield { items, cursor: s };
        }
        s = { ...s, child: s.child + 1, at: 0 };
      }

      // Walk complete: the next one, on the daily cadence, reads only what changed since this began.
      s = {
        v: 1,
        walking: false,
        counts: s.counts,
        since: s.walkStarted,
        fullAt: s.mode === 'full' ? s.walkStarted : s.fullAt,
        lastWalk: { mode: s.mode, finishedAt: new Date().toISOString() },
      };
      log(
        `walk complete: ${kept} server(s) from ${fetched} page(s) this run, ${skipped} without a server`,
      );
      return {
        cursor: s,
        note: `walk complete: ${kept} server(s) from ${fetched} page(s) this run`,
      };
    },
  });
}

/* ---------------------------------------------------------------- sites */

const pathParts = (loc) => {
  try {
    return new URL(loc).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
};

export const mcpSo = directoryAdapter({
  adapter: 'mcpso',
  title: 'mcp.so directory',
  slug: 'mcpso-servers',
  sourceName: 'MCP servers on mcp.so',
  prefix: 'mcpso',
  name: 'mcp.so',
  home: 'https://mcp.so',
  sitemap: 'https://mcp.so/sitemap.xml',
  description:
    "Servers listed on mcp.so, one of the largest community MCP directories, read from its sitemap and each server's page: repository, author, runtime, transport and tool names. Keyed on the folded repository URL so servers other sources already carry stay with them; every row links back to its mcp.so page. Keyless.",
  childFilter: (loc) => /[?&]section=servers\b/.test(loc),
  pageFilter: (loc) => {
    const p = pathParts(loc);
    return p.length === 2 && p[0] === 'servers';
  },
  parse: parseMcpSo,
  delayMs: 1000,
});

export const mcpMarket = directoryAdapter({
  adapter: 'mcpmarket',
  title: 'MCP Market directory',
  slug: 'mcpmarket-servers',
  sourceName: 'MCP servers on MCP Market',
  prefix: 'mcpmarket',
  name: 'MCP Market',
  home: 'https://mcpmarket.com',
  sitemap: 'https://mcpmarket.com/sitemap.xml',
  description:
    "Servers listed on MCP Market (mcpmarket.com), read from its sitemap and the schema.org record on each server's page: repository, owner, category, keywords and likes. Paced at the two-second crawl delay the site asks for. Keyed on the folded repository URL so servers other sources already carry stay with them; every row links back to its MCP Market page. Keyless.",
  childFilter: (loc) => /\/sitemap\/tools-\d+\.xml$/.test(loc),
  pageFilter: (loc) => {
    const p = pathParts(loc);
    return p.length === 2 && p[0] === 'server';
  },
  parse: parseMcpMarket,
  delayMs: 2000,
});

export const mcpServersOrg = directoryAdapter({
  adapter: 'mcpservers-org',
  title: 'mcpservers.org directory',
  slug: 'mcpservers-org-servers',
  sourceName: 'MCP servers on mcpservers.org',
  prefix: 'mcpservers',
  name: 'mcpservers.org',
  home: 'https://mcpservers.org',
  sitemap: 'https://mcpservers.org/sitemap.xml',
  description:
    "Servers listed on mcpservers.org, the site behind the wong2 awesome-mcp-servers list, including the community submissions the README never carried, read from its sitemap and each server's page. Keyed on the folded repository URL so servers other sources already carry stay with them; every row links back to its mcpservers.org page. Keyless.",
  childFilter: (loc) => /\/sitemaps\/servers\/\d+\.xml$/.test(loc),
  pageFilter: (loc) => {
    const p = pathParts(loc);
    return p.length === 3 && p[0] === 'servers';
  },
  parse: parseMcpServers,
  delayMs: 1000,
});
