import { config } from '@nichedb/config';
import { html } from 'hono/html';
import { assetUrl } from '../lib/asset-version.js';
import { currentModules } from '../lib/modules.js';

/** The single HTML shell. Every page renders through here. */
export const Layout = (props) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>
        {props.title
          ? `${props.title} · ${config.siteName}`
          : `${config.siteName} — sources in, feeds out`}
      </title>
      <meta
        name="description"
        content={
          props.description ??
          'An open, ever-growing database of real-time data. Follow a feed, get told. Web, RSS, API, CLI and MCP.'
        }
      />
      <meta name="theme-color" content="#12161f" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" type="image/svg+xml" href={assetUrl('logo.svg')} />
      <link rel="icon" type="image/png" sizes="32x32" href={assetUrl('icons/favicon-32.png')} />
      <link rel="icon" type="image/png" sizes="16x16" href={assetUrl('icons/favicon-16.png')} />
      {[180, 152, 144, 120, 76].map((s) => (
        <link
          key={s}
          rel="apple-touch-icon"
          sizes={`${s}x${s}`}
          href={assetUrl(`icons/apple-touch-icon-${s}x${s}.png`)}
        />
      ))}
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      <meta name="apple-mobile-web-app-title" content={config.siteName} />
      <meta name="mobile-web-app-capable" content="yes" />
      <link
        rel="alternate"
        type="application/rss+xml"
        title={`${config.siteName} — everything`}
        href="/f/everything.rss"
      />
      {props.feedUrl ? (
        <link
          rel="alternate"
          type="application/rss+xml"
          title={props.feedTitle ?? 'This feed'}
          href={props.feedUrl}
        />
      ) : null}
      <link rel="stylesheet" href={assetUrl('styles.css')} />
      {props.canonical ? (
        <link rel="canonical" href={`${config.siteUrl}${props.canonical}`} />
      ) : null}
      <meta property="og:title" content={props.title ?? config.siteName} />
      <meta property="og:type" content="website" />
      <meta property="og:image" content={`${config.siteUrl}/icons/icon-512x512.png`} />
      <meta name="twitter:card" content="summary" />
      {config.analytics.enabled && currentModules().tracking ? (
        <script
          src="https://crawlproof.com/stats.js"
          data-site={config.analytics.crawlproofSite}
          async
        />
      ) : null}
    </head>
    <body
      data-tz={props.user?.timezone ?? null}
      data-known-tz={props.user ? (props.user.timezone ?? 'UTC') : null}
    >
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        <a class="brand" href="/">
          <img src={assetUrl('logo.svg')} alt="" width="28" height="28" />
          <span>{config.siteName}</span>
        </a>
        <search class="topsearch">
          <form method="get" action="/search">
            <label class="visually-hidden" for="q">
              Search
            </label>
            <input
              id="q"
              type="search"
              name="q"
              value={props.q ?? ''}
              placeholder="Search everything"
              autocomplete="off"
              enterkeyhint="search"
            />
            <button type="submit" class="ghost">
              Go
            </button>
          </form>
        </search>
        <nav>
          <a href="/sources">Sources</a>
          <a href="/feeds">Feeds</a>
          {props.user ? <a href="/following">Following</a> : null}
          <a href="/docs/api">API</a>
          {props.user ? (
            <a href="/settings">Settings</a>
          ) : (
            <a class="cta" rel="nofollow" href="/login">
              Sign in
            </a>
          )}
        </nav>
      </header>

      <main id="main" class={props.wide ? 'wide' : ''}>
        {props.children}
      </main>

      {config.ads.enabled && currentModules().ads ? (
        <aside data-cp-ad data-slot={config.ads.slot} data-format="text_link" />
      ) : null}

      <footer>
        <p>
          {config.siteName} is open source:{' '}
          <a href="https://github.com/profullstack/niche-db">profullstack/niche-db</a>. Times are
          shown in <span data-tz-label>your device's</span> time zone.
        </p>
        <p class="muted">
          <a href="/about">About</a> · <a href="/docs/api">API</a> · <a href="/docs/cli">CLI</a> ·{' '}
          <a href="/docs/mcp">MCP</a> · <a href="/llms.txt">llms.txt</a> · <a href="/pro">Pro</a> ·{' '}
          <a href="/crawl">Crawl access</a>
        </p>
      </footer>

      <script src={assetUrl('vendor-webauthn.js')} defer />
      <script src={assetUrl('app.js')} defer />
      {config.ads.enabled && currentModules().ads ? (
        <script src="https://crawlproof.com/ad.js" async />
      ) : null}
      {props.vapidKey ? html`<script>window.__VAPID = "${props.vapidKey}";</script>` : null}
    </body>
  </html>
);
