import { config } from '@nichedb/config';
import { Notice } from './components.jsx';
import { Layout } from './Layout.jsx';

export const dataPrice = () =>
  (config.dataDumps.priceCents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const DataDumpsOffer = ({ access = false }) => (
  <section class="premium-close data-dumps-offer" id="data-dumps">
    <div>
      <p class="premium-eyebrow">For teams that need the whole dataset</p>
      <h2>Hourly data dumps</h2>
      <p class="muted">
        Full snapshots of our public data, every hour. Download in bulk and build on your own
        infrastructure. Includes every Pro benefit.
      </p>
    </div>
    <div class="data-dumps-price">
      <p>
        <strong>${dataPrice()}</strong> / month
      </p>
      <a class="cta button" href="/dumps">
        {access ? 'Your data dumps' : 'Explore Data'}
      </a>
      <p class="small muted">30 days, paid upfront</p>
    </div>
  </section>
);

export const DataDumpsPage = ({ user, access, snapshot, ready, notice, error }) => (
  <Layout
    user={user}
    title="Hourly data dumps"
    canonical="/dumps"
    description={`Hourly snapshots of ${config.siteName}'s public data. $${dataPrice()}/month, including every Pro benefit.`}
  >
    <div class="premium-page">
      <section class="premium-hero">
        <div>
          <p class="premium-eyebrow">{config.siteName} Data</p>
          <h1>
            The whole dataset.
            <br />
            <span>Every hour.</span>
          </h1>
          <p class="lede">
            Keep a local copy of our public data for analytics, search and your own applications.
            Download full snapshots without paging through the API.
          </p>
          <p class="small muted">
            Includes every Pro benefit. 30 days of access, paid upfront. No automatic renewal.
          </p>
        </div>
        <div class="premium-hero-price data-dumps-price">
          <p class="premium-eyebrow">Hourly data dumps</p>
          <p>
            <strong>${dataPrice()}</strong>
            <span> / month</span>
          </p>
          {access ? (
            <a class="cta button" href="/api/v1/dumps/latest">
              Open latest manifest
            </a>
          ) : ready ? (
            user ? (
              <form method="post" action="/api/dumps/buy">
                <button class="cta" type="submit">
                  Get Data · ${dataPrice()}
                </button>
              </form>
            ) : (
              <a class="cta button" href="/login?next=%2Fdumps">
                Sign in to get Data
              </a>
            )
          ) : (
            <p class="muted">The first hourly snapshot is being prepared. Check back shortly.</p>
          )}
          <p class="small muted">Paid in crypto through CoinPay.</p>
        </div>
      </section>
      <Notice notice={notice} error={error} />
      {snapshot ? (
        <p class="feedback ok">
          Latest snapshot:{' '}
          <time datetime={snapshot.snapshot_at}>
            {new Date(snapshot.snapshot_at).toUTCString()}
          </time>{' '}
          · {Number(snapshot.rows).toLocaleString('en-US')} records · {snapshot.parts} download
          parts.
        </p>
      ) : null}
      <section class="premium-section">
        <h2>Ready for your data pipeline.</h2>
        <div class="premium-perks">
          <article class="premium-perk">
            <h3>Full snapshots, hourly</h3>
            <p>
              Each snapshot contains the public item records across our collections as they stood
              when the export began. Snapshot timestamps show exactly which version you are
              downloading.
            </p>
          </article>
          <article class="premium-perk">
            <h3>Gzip-compressed NDJSON</h3>
            <p>
              One JSON record per line, split into manageable files. Every record includes its
              collection, source, stable ID and last update time.
            </p>
          </article>
          <article class="premium-perk">
            <h3>Automated downloads</h3>
            <p>
              Use your account API key to retrieve the latest manifest and download each part. Each
              file has a SHA-256 checksum and row count.
            </p>
          </article>
          <article class="premium-perk">
            <h3>Every Pro benefit</h3>
            <p>
              Get the highest API allowance, a crawl pass, unlimited feeds, your own sources and all
              Premium member perks.
            </p>
          </article>
        </div>
      </section>
      <section class="premium-section">
        <h2>How delivery works</h2>
        <ol>
          <li>
            Purchase 30 days of Data access and create an API key in{' '}
            <a href="/settings">settings</a>.
          </li>
          <li>
            Fetch <code>/api/v1/dumps/latest</code> with your bearer key once an hour.
          </li>
          <li>
            Download the files listed in the manifest, verify their checksums and import the
            snapshot.
          </li>
        </ol>
        <pre class="data">
          <code>{`curl -H "Authorization: Bearer YOUR_API_KEY" \\\n  ${config.siteUrl}/api/v1/dumps/latest\n\n# Download a part using its URL from the manifest:\ncurl -L -H "Authorization: Bearer YOUR_API_KEY" \\\n  "PART_URL_FROM_MANIFEST" -o part.ndjson.gz`}</code>
        </pre>
        <p class="small muted">
          Completed snapshots are available for {config.dataDumps.retentionHours} hours. Download
          links expire after five minutes; request the file URL again for a fresh link. Exports run
          hourly; each source retains its own update schedule.
        </p>
        <p class="small muted">
          The dumps contain published collection items and source attribution. Private collections,
          member-only previews, accounts, credentials and billing records are excluded. Upstream
          attribution and license terms still apply.
        </p>
      </section>
      <p class="muted">
        Just need the API and member perks?{' '}
        <a href="/premium">Premium starts at ${(config.premium.dayCents / 100).toFixed(2)}/day</a>.
      </p>
    </div>
  </Layout>
);
