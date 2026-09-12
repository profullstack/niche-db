import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { APP_ICONS, appIconFor } from '@nichedb/premium';
import { assetUrl, isCurrentVersion, loadAssetVersions } from '../lib/asset-version.js';
import { llmsTxt } from '../lib/llms.js';

const STATIC_FILES = [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/vendor-webauthn.js', 'vendor-webauthn.js', 'text/javascript'],
  ['/sw.js', 'sw.js', 'text/javascript'],
  ['/logo.svg', 'logo.svg', 'image/svg+xml'],
];
const VERSIONED_ICONS = [
  'icons/favicon-16.png',
  'icons/favicon-32.png',
  ...[76, 120, 144, 152, 180].map((s) => `icons/apple-touch-icon-${s}x${s}.png`),
  ...[48, 128, 192, 256, 384, 512].map((s) => `icons/icon-${s}x${s}.png`),
  ...[192, 512].map((s) => `icons/icon-${s}x${s}-maskable.png`),
  ...APP_ICONS.filter((i) => !i.free).map((i) => i.file),
];
const ICON_TYPES = {
  png: 'image/png',
  ico: 'image/x-icon',
  xml: 'application/xml',
  svg: 'image/svg+xml',
};

export function registerStatic(app, gateway) {
  loadAssetVersions([...STATIC_FILES.map(([, f]) => f), ...VERSIONED_ICONS]);

  for (const [route, file, type] of STATIC_FILES) {
    app.get(route, async (c) => {
      const f = Bun.file(new URL(`../../public/${file}`, import.meta.url).pathname);
      c.header('content-type', type);
      if (file === 'sw.js') c.header('cache-control', 'no-cache');
      else if (isCurrentVersion(file, c.req.query('v')))
        c.header('cache-control', 'public, max-age=31536000, immutable');
      else c.header('cache-control', 'public, max-age=60, must-revalidate');
      return c.body(await f.arrayBuffer());
    });
  }

  app.get('/icons/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9][a-z0-9._-]*\.(png|ico|xml|svg)$/i.test(file) || file.includes('..'))
      return c.notFound();
    const f = Bun.file(new URL(`../../public/icons/${file}`, import.meta.url).pathname);
    if (!(await f.exists())) return c.notFound();
    c.header(
      'content-type',
      ICON_TYPES[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream',
    );
    c.header(
      'cache-control',
      isCurrentVersion(`icons/${file}`, c.req.query('v'))
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, must-revalidate',
    );
    return c.body(await f.arrayBuffer());
  });

  app.get('/favicon.ico', async (c) => {
    const f = Bun.file(new URL('../../public/icons/favicon.ico', import.meta.url).pathname);
    c.header('content-type', 'image/x-icon');
    c.header('cache-control', 'public, max-age=604800');
    return c.body(await f.arrayBuffer());
  });

  /**
   * The installed app's manifest.
   *
   * A member's chosen icon is added at the front, which is what makes "and in
   * the installed app" true rather than decorative: an installed PWA takes its
   * home-screen icon from here, so the choice has to be in this document and
   * not only in the page's <link rel=icon>. The stock icons stay behind it, so
   * a lapsed membership installs exactly what it always did.
   */
  app.get('/manifest.webmanifest', (c) => {
    const chosen = appIconFor({
      plan: c.get('plan') ?? 'free',
      icon: c.get('user')?.premium_icon,
    });
    const memberIcon =
      chosen === APP_ICONS[0].file
        ? []
        : [{ src: assetUrl(chosen), sizes: 'any', type: 'image/svg+xml', purpose: 'any' }];
    return c.json({
      name: config.siteName,
      short_name: config.siteName,
      description: 'Sources in, feeds out. An open, ever-growing database of real-time data.',
      start_url: '/following',
      display: 'standalone',
      background_color: '#12161f',
      theme_color: '#12161f',
      icons: [
        ...memberIcon,
        ...[48, 128, 192, 256, 384, 512].map((s) => ({
          src: assetUrl(`icons/icon-${s}x${s}.png`),
          sizes: `${s}x${s}`,
          type: 'image/png',
          purpose: 'any',
        })),
        ...[192, 512].map((s) => ({
          src: assetUrl(`icons/icon-${s}x${s}-maskable.png`),
          sizes: `${s}x${s}`,
          type: 'image/png',
          purpose: 'maskable',
        })),
      ],
    });
  });

  app.get('/robots.txt', (c) =>
    c.text(
      `User-agent: AwarioBot\nDisallow: /\n\n${gateway.robotsTxt({
        disallow: [
          '/login',
          '/signup',
          '/auth/',
          '/api/',
          '/settings',
          '/sources/new',
          '/feeds/new',
        ],
      })}\nSitemap: ${config.siteUrl}/sitemap.xml\n`,
    ),
  );

  app.get('/llms.txt', async (c) => {
    c.header('content-type', 'text/plain; charset=utf-8');
    c.header('cache-control', 'public, max-age=300');
    return c.body(await llmsTxt());
  });

  /**
   * The OpenAccess descriptor (logicsrc.com/openaccess): what this site is,
   * where its OAuth 2.1 endpoints are and which scopes it grants, so a catalog
   * that fetches it from our own origin can list NicheDB and link an account.
   *
   * Checked in under public/, but STATIC_FILES is an allowlist rather than a
   * directory: a file dropped there is a 404 until a route names it, and this
   * is that route. Static bytes, so no version hash -- five minutes, like
   * llms.txt above.
   */
  app.get('/.well-known/openaccess.json', async (c) => {
    const f = Bun.file(
      new URL('../../public/.well-known/openaccess.json', import.meta.url).pathname,
    );
    c.header('content-type', 'application/json');
    c.header('cache-control', 'public, max-age=300');
    return c.body(await f.arrayBuffer());
  });

  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const urlset = (urls) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map(
        (u) =>
          `<url><loc>${xmlEsc(config.siteUrl + u.loc)}</loc>${u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString()}</lastmod>` : ''}</url>`,
      )
      .join('\n')}\n</urlset>`;

  app.get('/sitemap.xml', async (c) => {
    const [collections, sources, feeds] = await Promise.all([
      q.listCollections(),
      q.listSources({ all: false }),
      q.feedSlugs(),
    ]);
    const urls = [
      { loc: '/' },
      { loc: '/about' },
      { loc: '/sources' },
      { loc: '/feeds' },
      { loc: '/docs/api' },
      { loc: '/docs/cli' },
      { loc: '/docs/mcp' },
      ...collections.map((x) => ({ loc: `/c/${x.slug}` })),
      ...sources.map((x) => ({ loc: `/s/${x.slug}`, lastmod: x.updated_at })),
      ...feeds.map((x) => ({ loc: `/f/${x.slug}`, lastmod: x.updated_at })),
    ];
    c.header('content-type', 'application/xml');
    c.header('cache-control', 'public, max-age=3600');
    return c.body(urlset(urls));
  });
}
