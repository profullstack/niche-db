import { config } from '@nichedb/config';
import { Layout } from './Layout.jsx';

/**
 * /privacy and /terms.
 *
 * Every sentence is meant to be true of this repository: the account tables
 * (packages/db/migrations), the cookies the routes set, what account deletion
 * removes (packages/db/src/account.js) and what it does not, the services the
 * site calls (Resend, CoinPay, CrawlProof, jsDelivr, browser push services),
 * the people profiles in /c/profiles, and the MCP tools in lib/mcp/tools.js.
 * Change the code, change this page.
 */

export const LEGAL_EFFECTIVE_DATE = 'November 11, 2026';
export const LEGAL_PATHS = ['/privacy', '/terms'];
const OPERATOR = 'Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA';
const CONTACT = 'support@profullstack.com';

const Mail = () => <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;

export const Privacy = ({ user }) => {
  const site = config.siteUrl;
  return (
    <Layout user={user} title="Privacy Policy" canonical="/privacy">
      <h1>Privacy Policy</h1>
      <p class="lede">
        Effective date: {LEGAL_EFFECTIVE_DATE}. What {config.siteName} stores, why, and who else is
        involved.
      </p>
      <div class="legal">
        <p>
          This policy covers nichedb.dev, its API, CLI and MCP server. NicheDB is run by {OPERATOR}.
        </p>

        <h2>1. Without an account</h2>
        <p>
          Reading collections, items, feeds and profiles needs no account. API and MCP requests
          without a key are counted per IP address in hourly buckets for the free allowance, and the
          site and its sign-in forms apply short rate limits by address. A vehicle lookup is counted
          the same way. A "near me" search sends its location, rounded to a map tile, to
          OpenStreetMap's Overpass service.
        </p>

        <h2>2. What an account stores</h2>
        <ul>
          <li>
            <strong>Your email address</strong>, which is how you sign in: we email you a link, and
            there is no password. A sign-in link is stored only as a hash and expires after 20
            minutes.
          </li>
          <li>
            <strong>Your profile:</strong> handle, display name and time zone, and the fields asked
            for at sign-up (first and last name, company domain, job title, LinkedIn URL). Those
            sign-up fields are private to your account.
          </li>
          <li>
            <strong>Sign-in records:</strong> sessions (a random ID, expiry of 90 days, and your
            browser's user agent); passkeys if you add one (the public key, a signature counter and
            transports; the private key never leaves your device); API keys (a hash, prefix, name,
            permissions, and when last used).
          </li>
          <li>
            <strong>Sign in with CoinPay:</strong> the identifier and email CoinPay gives us for
            your CoinPay account, and whether you hold an active Profullstack Pass.
          </li>
          <li>
            <strong>What you set up:</strong> feeds (saved queries), follows and how you want to be
            told (web push, email or webhook), push subscriptions (your browser's push endpoint and
            keys), webhook endpoints with their signing secrets and a log of deliveries, sources you
            add, and feed suggestions you send.
          </li>
          <li>
            <strong>Payments and programs:</strong> memberships and premium credits, the checkout
            record CoinPay returns for each payment, referral, invite and credit-code records, and,
            if you join the partner or niche programs, your partner details and payout wallet
            address, niche membership, claims, contributions and scores.
          </li>
          <li>
            <strong>When you were last active</strong>, and your role.
          </li>
        </ul>

        <h2>3. Cookies</h2>
        <p>
          Signing in sets one session cookie (90 days). Short-lived cookies carry a passkey
          challenge (5 minutes) and a CoinPay sign-in in progress (10 minutes). Arriving through a
          referral link stores the code for 30 days, and an invite link keeps its code until it is
          used. All are HttpOnly and SameSite=Lax, and sent only over HTTPS. NicheDB sets no
          advertising cookies of its own.
        </p>

        <h2>4. Who else is involved</h2>
        <ul>
          <li>
            <strong>Resend</strong> delivers the site's email: sign-in and account-deletion links,
            feed alerts, and replies about feed suggestions.
          </li>
          <li>
            <strong>CoinPay</strong> (coinpayportal.com) handles Sign in with CoinPay, membership
            checkout (it receives your email and account ID) and x402 crawl passes. We never see
            wallet keys or card details.
          </li>
          <li>
            <strong>CrawlProof</strong> (crawlproof.com) supplies page statistics and one text ad on
            inner pages for the free tier. Members see neither.
          </li>
          <li>
            <strong>jsDelivr</strong> serves the WebMCP script, which offers NicheDB's tools to an
            AI agent running in your browser. The transit map loads Leaflet from cdnjs.
          </li>
          <li>
            <strong>Browser push services</strong> deliver the web push notifications you turn on,
            and <strong>your webhook endpoints</strong> receive the events you subscribe them to.
          </li>
          <li>
            Some outbound links to shops are affiliate links (for example Amazon Associates), so the
            shop knows the visit came from us.
          </li>
        </ul>
        <p>
          Scripts loaded from other services receive your IP address and browser details when your
          browser loads them. Nothing is sold, no advertising profile is built from you, and no
          account data is sent to an AI provider.
        </p>

        <h2>5. What is public</h2>
        <p>
          Collections, items and the public data dumps contain no account data. Feeds are public
          unless you make them private. If you join the partner or niche programs, your handle,
          display name, join date, niche roles, tiers and contribution counts are public, and the
          leaderboard shows your display name or handle, never your email.
        </p>
        <p>
          <strong>People profiles</strong> (<a href="/c/profiles">/c/profiles</a>) are built from
          OpenProfile documents people have published on other sites, matched by account URL, never
          by name, and are public. If a profile is about you, you can claim it (when your email is
          listed on it, or your own site links back to it), edit it (your edits win over any source)
          and hide it. To have a profile removed, email <Mail />.
        </p>

        <h2>6. AI agents and MCP</h2>
        <p>
          The MCP server is at <code>{site}/mcp</code> (also <code>{site}/api/mcp</code>), over
          Streamable HTTP. Without a key, an MCP client can use the read-only tools: collections,
          sources, feeds, items, search, people profiles, domains and TLDs, and lookups for books,
          aircraft, satellites, ships, trains, transit, businesses, reputation and vulnerabilities.
          It can also suggest a feed, which an admin reviews. These count against the hourly
          allowance for your IP address, or the allowance of an x402 pass. With an API key (
          <code>Authorization: Bearer ndb_...</code>, made on your settings page) it can also act on
          your account: create and follow feeds, manage webhooks, claim and edit a people profile,
          redeem a credit code, list and create invites, and (for owners, admins and Pro members)
          add and run sources.
        </p>
        <p>
          MCP and API requests are logged (time, tool or route, IP address, and the account or key
          if any) for abuse prevention and rate limiting. No MCP data is sold or used for
          advertising.
        </p>

        <h2>7. Keeping and deleting it</h2>
        <p>
          Sign-in links expire after 20 minutes and sessions after 90 days. You can export your
          account at <a href="/account/export">/account/export</a> and delete it at{' '}
          <a href="/account/delete">/account/delete</a>. Deleting removes your account, profile,
          sessions, passkeys, keys, feeds and follows, memberships and payments, push subscriptions,
          referral and CoinPay records, and contributions; a people profile you claimed goes back to
          unclaimed. Some records are not removed automatically yet: webhook endpoints and their
          deliveries, partner and payout records, credit-code and invite records, and sign-in link
          records. Email <Mail /> and we will remove them.
        </p>

        <h2>8. Security</h2>
        <p>
          Data travels over TLS. Sign-in links, account links and API keys are stored only as
          hashes. No system is perfectly secure, and we cannot guarantee absolute security.
        </p>

        <h2>9. Children</h2>
        <p>
          NicheDB is not directed at children under 13, and we do not knowingly collect personal
          information from them.
        </p>

        <h2>10. Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, delete or export
          your personal data. Contact us to exercise them.
        </p>

        <h2>11. Changes</h2>
        <p>
          If NicheDB changes what it collects, this page changes with it. The effective date above
          says when it last did.
        </p>

        <h2>12. Contact</h2>
        <p>
          {OPERATOR}. Email <Mail />.
        </p>
      </div>
    </Layout>
  );
};

export const Terms = ({ user }) => {
  const site = config.siteUrl;
  return (
    <Layout user={user} title="Terms of Service" canonical="/terms">
      <h1>Terms of Service</h1>
      <p class="lede">
        Effective date: {LEGAL_EFFECTIVE_DATE}. The terms for using {config.siteName}, its API and
        its MCP server.
      </p>
      <div class="legal">
        <h2>1. Acceptance of terms</h2>
        <p>
          By using nichedb.dev, its API, CLI or MCP server (the "Service"), run by {OPERATOR}, you
          agree to these Terms of Service. If you do not agree, do not use the Service.
        </p>

        <h2>2. The Service</h2>
        <p>
          NicheDB collects public data from many upstream sources into collections, with feeds,
          search, an API, a CLI and an MCP server. Reading is free. A free account adds API keys,
          feeds, follows and webhooks; paid memberships raise limits and remove ads and tracking.
        </p>

        <h2>3. Accounts</h2>
        <p>
          Your account is your email address or linked CoinPay account. You are responsible for
          keeping it, your passkeys and your API keys safe, and for all activity under your account.
          Tell us at once if you think someone else is using it.
        </p>

        <h2>4. Payments</h2>
        <p>
          Memberships and x402 crawl passes are paid through CoinPay. They are prepaid for the term
          shown at checkout and do not renew themselves.
        </p>

        <h2>5. The data</h2>
        <p>
          Items come from upstream sources and belong to their publishers, under their own terms.
          They can be stale, wrong or missing, and nothing here is a recommendation or an
          endorsement. If something about you or your work is here and should not be, tell us.
        </p>

        <h2>6. What you add</h2>
        <p>
          When you add a source, suggest a feed, or edit a profile you claimed, you confirm you may
          share it, and you allow us to store and show it as part of the Service. Admins may decline
          or remove what breaks these terms.
        </p>

        <h2>7. Acceptable use</h2>
        <p>
          Do not use the Service for anything unlawful, and do not send automated traffic heavy
          enough to degrade it for anyone else. The API, feeds and data dumps are there so you do
          not have to scrape; AI training crawlers pay for a pass at <a href="/crawl">/crawl</a>.
        </p>

        <h2>8. MCP and API use</h2>
        <p>
          The same rules apply to the API and the MCP server at <code>{site}/mcp</code>. An agent
          using your key acts as you, and what it does is your responsibility. Requests are
          rate-limited, and keys used for abuse may be revoked.
        </p>

        <h2>9. Intellectual property</h2>
        <p>
          The NicheDB name, site and service belong to Profullstack, Inc. or its licensors. The
          NicheDB source code is open source under the MIT license.
        </p>

        <h2>10. Disclaimer of warranties</h2>
        <p>
          The Service is provided "as is" without warranties of any kind. We do not guarantee that
          it will be uninterrupted, secure or error-free.
        </p>

        <h2>11. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any
          indirect, incidental, special, consequential or punitive damages arising out of your use
          of the Service.
        </p>

        <h2>12. Changes to these terms</h2>
        <p>
          We may update these Terms from time to time. Continued use of the Service after a change
          means you accept the revised Terms.
        </p>

        <h2>13. Contact</h2>
        <p>
          Questions about these Terms? Email <Mail />.
        </p>
      </div>
    </Layout>
  );
};
