import { Layout } from './Layout.jsx';

/** The gateway owns prices and settlement; this view supplies the site's shell. */
export function CrawlPage(ctx) {
  const {
    price,
    total = price,
    days = 1,
    minutes,
    maxDays,
    buyUrl,
    siteUrl,
    header,
    enabled,
  } = ctx;
  const term = minutes === 1440 ? 'day' : `${minutes} minutes`;
  const purchaseUrl = days > 1 ? `${buyUrl}?days=${days}` : buyUrl;
  return (
    <Layout
      title="Crawl access"
      canonical="/crawl"
      noindex
      description="Automated access to NicheDB. Buy a prepaid crawl pass for your agent or data pipeline."
    >
      <div class="premium-page crawl-page">
        <section class="premium-hero">
          <div>
            <p class="premium-eyebrow">NicheDB · Crawl access</p>
            <h1>
              Access for your agents.
              <br />
              <span>On your terms.</span>
            </h1>
            <p class="lede">
              Give your crawler prepaid access to the database. Pay for the time you need, then use
              one pass across your requests.
            </p>
            <p class="small muted">
              No account required. No automatic renewal. People and search engines can still read
              for free.
            </p>
          </div>
          <div class="premium-hero-price">
            <p class="premium-eyebrow">{days > 1 ? `${days} prepaid terms` : 'Crawl pass'}</p>
            <p>
              <strong>{total.endsWith(' USD') ? `$${total.slice(0, -4)}` : total}</strong>
              <span> / {days > 1 ? `${days} × ${term}` : term}</span>
            </p>
            {enabled ? (
              <a class="cta button" href="#get-pass">
                Get a crawl pass
              </a>
            ) : (
              <p class="feedback">Crawl-pass payments are currently unavailable.</p>
            )}
            <p class="small muted">Paid in USDC through CoinPay.</p>
          </div>
        </section>
        {ctx.quota?.exceeded ? (
          <p class="feedback">
            Your free allowance of {ctx.quota.requests} requests per {ctx.quota.windowSeconds}{' '}
            seconds has been reached.{' '}
            {ctx.quota.resetSeconds ? `It resets in ${ctx.quota.resetSeconds} seconds. ` : ''}A paid
            pass lifts this limit.
          </p>
        ) : null}
        <section class="premium-section">
          <h2>Built for automated access.</h2>
          <div class="premium-perks">
            <article class="premium-perk">
              <h3>One reusable pass</h3>
              <p>
                Send your pass with each request until it expires. You pay for access time, rather
                than each page.
              </p>
            </article>
            <article class="premium-perk">
              <h3>Choose your duration</h3>
              <p>
                Start with one {term}, or buy up to {maxDays} terms at {price} each. Add{' '}
                <code>?days=7</code> for seven terms.
              </p>
            </article>
            <article class="premium-perk">
              <h3>Keep your own tools</h3>
              <p>
                Use the CoinPay CLI or your existing x402 client. The payment receipt contains
                everything your crawler needs.
              </p>
            </article>
          </div>
        </section>
        <section class="premium-section" id="get-pass">
          <p class="premium-eyebrow">Get started</p>
          <h2>Buy once. Send the pass with your requests.</h2>
          <p>
            The CLI opens your wallet to approve the payment and saves the receipt to{' '}
            <code>pass.json</code>.
          </p>
          <pre>
            <code>{`npm install -g @profullstack/coinpay\ncoinpay x402 pay "${purchaseUrl}" --output pass.json`}</code>
          </pre>
          <p>
            Read the pass from your receipt and include it in the <code>{header}</code> header:
          </p>
          <pre>
            <code>{`PASS=$(node -p "require('./pass.json').pass")\ncurl -H "${header}: $PASS" "${siteUrl}/"`}</code>
          </pre>
          <details>
            <summary>Use your own x402 client</summary>
            <p>
              Request the offer as JSON, sign one of its payment options, then retry with the proof
              in the <code>X-PAYMENT</code> header. A successful response contains your pass and its
              expiration.
            </p>
            <pre>
              <code>{`curl -H "Accept: application/json" "${purchaseUrl}"\ncurl -H "X-PAYMENT: <base64 proof>" "${purchaseUrl}"`}</code>
            </pre>
          </details>
        </section>
        <section class="premium-section">
          <h2>Who needs a pass?</h2>
          <p>
            Training crawlers pay for access. Search engines, retrieval crawlers and people read
            free within the free request allowance.
          </p>
          <details>
            <summary>See crawler access rules</summary>
            <p>
              <strong>Paid training crawlers:</strong>{' '}
              {(ctx.training ?? []).join(', ') || 'None configured'}.
            </p>
            <p>
              <strong>Free retrieval crawlers:</strong>{' '}
              {(ctx.retrieval ?? []).join(', ') || 'See robots.txt'}.
            </p>
            <p>
              <a href="/robots.txt">Read robots.txt</a>
            </p>
          </details>
        </section>
        <section class="premium-close">
          <div>
            <p class="premium-eyebrow">Reading and building?</p>
            <h2>A membership includes crawl access.</h2>
            <p class="muted">
              Premium and Pro include a crawl pass for the membership term, alongside your account
              benefits.
            </p>
          </div>
          <a class="cta button" href="/premium">
            Compare memberships
          </a>
        </section>
      </div>
    </Layout>
  );
}

export const renderCrawlPage = (ctx) => `<!doctype html>${CrawlPage(ctx).toString()}`;
