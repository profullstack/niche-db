/**
 * One place that reads the environment, so no other module ever touches process.env.
 *
 * Everything is read once at import. A missing *required* variable throws here, at
 * boot, rather than at the moment somebody clicks something.
 */

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}
const opt = (name, fallback = '') => process.env[name] ?? fallback;
const num = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${raw}`);
  return n;
};
const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};
const list = (name, fallback = '') =>
  opt(name, fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  env: opt('NODE_ENV', 'development'),
  isProd: opt('NODE_ENV', 'development') === 'production',

  /** Railway injects PORT. Never hardcode it. */
  port: num('PORT', 3000),

  /** Public origin. Passkey rpID is derived from this, so changing it invalidates
   *  every credential already registered. */
  siteUrl: opt('SITE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  siteName: opt('SITE_NAME', 'NicheDB'),

  /** No fallback, deliberately: a service deployed without it should say so at boot. */
  databaseUrl: req('DATABASE_URL'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),

  /** Which roles this process runs. One service runs "web,worker"; splitting them
   *  later is a variable change, not a code change. */
  roles: list('ROLES', 'web,worker'),

  /**
   * Who may do what.
   *
   * The first account ever created is an admin; so is any address listed here
   * the moment it signs in. Admins manage the system collections and sources.
   * Everyone signed in may create feeds. Adding a SOURCE -- something that
   * makes this deployment fetch from a third party on a schedule -- is admins
   * and Pro members unless OPEN_SOURCES lets everyone.
   */
  adminEmails: list('ADMIN_EMAILS').map((e) => e.toLowerCase()),
  openSources: bool('OPEN_SOURCES', false),

  /** Sent in the User-Agent to upstreams that ask who is calling (SEC does). */
  contactEmail: opt('CONTACT_EMAIL', ''),

  ingest: {
    /** How often the scheduler asks "is any source due". */
    tickSeconds: num('INGEST_TICK_SECONDS', 60),
    /** Sources fetched at once. Upstreams are rate limited individually inside adapters. */
    concurrency: num('INGEST_CONCURRENCY', 3),
    /** Wall-clock ceiling on one run; a run past this records what it has and stops. */
    runDeadlineMs: num('INGEST_RUN_DEADLINE_MS', 4 * 60_000),
    /** Detail lookups an adapter may spend per run (appdetails, package docs...). */
    budget: num('INGEST_DETAIL_BUDGET', 150),
    /** Sweep every enabled source on boot regardless of next_run_at. */
    onBoot: bool('INGEST_ON_BOOT', false),
  },

  enrich: {
    /** Enrichment runs after ingest: videos, Wikipedia, repo stats, company profiles. */
    enabled: bool('ENRICH', true),
    /** How often the worker looks for un-enriched items. */
    tickSeconds: num('ENRICH_TICK_SECONDS', 90),
    /** Items considered per tick. Each enricher also caps itself per run. */
    perRun: num('ENRICH_PER_RUN', 40),
    /** Optional: the YouTube Data API key; without it the public results page is read. */
    youtubeKey: opt('YOUTUBE_API_KEY'),
    /** Optional: Semantic Scholar key for a higher rate. */
    s2Key: opt('S2_API_KEY'),
  },

  feeds: {
    /** How often followed feeds are checked for new items. */
    scanSeconds: num('FEED_SCAN_SECONDS', 60),
    /** Items per feed per scan; more than this collapses into one digest line. */
    perScan: num('FEED_ITEMS_PER_SCAN', 20),
    /** Free accounts may own this many feeds. Pro and admins are unlimited. */
    freeLimit: num('FEED_FREE_LIMIT', 10),
  },

  api: {
    /** Requests per hour by tier. Anonymous is by address, keyed is by key. */
    anonPerHour: num('API_ANON_PER_HOUR', 600),
    freePerHour: num('API_FREE_PER_HOUR', 6000),
    proPerHour: num('API_PRO_PER_HOUR', 120_000),
  },

  adapters: {
    igdbClientId: opt('IGDB_CLIENT_ID'),
    igdbClientSecret: opt('IGDB_CLIENT_SECRET'),
    githubToken: opt('GITHUB_TOKEN'),
    courtlistenerToken: opt('COURTLISTENER_TOKEN'),
    /**
     * The BLS registration key, which is free and optional.
     *
     * Everything works without it on the public v1 API; a key switches the
     * adapter to v2 and its much higher daily limits. Registering is a form
     * and an email address: https://data.bls.gov/registrationEngine/
     */
    blsApiKey: opt('BLS_API_KEY'),
  },

  /**
   * Pro: the no-ads tier. A month at a time; no ads, no tracking, the high
   * API limit, unlimited feeds, own sources, and a crawl pass for the term so
   * the member's own agents walk through the paywall on their key.
   */
  membership: {
    priceCents: num('MEMBERSHIP_PRICE_CENTS', 12000),
    currency: opt('MEMBERSHIP_CURRENCY', 'USD'),
    termDays: num('MEMBERSHIP_TERM_DAYS', 30),
    get enabled() {
      return Boolean(config.coinpay.enabled);
    },
  },

  payments: {
    blockchain: opt('COINPAY_BLOCKCHAIN', 'BTC'),
    payoutAddress: opt('COINPAY_PAYOUT_ADDRESS'),
  },

  coinpay: {
    /* Read on use rather than snapshotted at import, so tests can set them. */
    get apiKey() {
      return opt('COINPAY_API_KEY');
    },
    get businessId() {
      return opt('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return opt('COINPAY_WEBHOOK_SECRET');
    },
    baseUrl: opt('COINPAY_BASE_URL', 'https://coinpayportal.com'),
    get enabled() {
      return Boolean(this.apiKey && this.businessId && this.webhookSecret);
    },
  },

  /** Selling crawl passes to training crawlers over x402. */
  x402: {
    get coinpayKey() {
      return opt('COINPAY_X402_KEY');
    },
    get payTo() {
      return opt('CRAWL_PAY_TO');
    },
    priceCents: num('CRAWL_PRICE_CENTS', 100),
    passMinutes: num('CRAWL_PASS_MINUTES', 1440),
    maxDays: num('CRAWL_MAX_DAYS', 30),
    /**
     * Loyalty: the more an agent has paid here, the less a day costs it.
     * "spent cents:percent off" pairs, ascending. The default takes a buyer
     * from $1 a day to 40¢ a day once it has spent $100.
     */
    loyalty: opt('CRAWL_LOYALTY', '1000:20,5000:40,10000:60'),
    floorCents: num('CRAWL_FLOOR_CENTS', 10),
    contact: opt('CRAWL_CONTACT'),
  },

  /**
   * The automotive lookups: VIN decode, the vehicle profile, mechanics and
   * parts. The feeds are free like every other collection — these are the
   * per-vehicle answers assembled live from four upstreams, and they are what
   * buyers have actually asked to pay for.
   *
   * A dollar a day is already the crawl-pass price, so a pass covers them.
   * `AUTOMOTIVE_MONTHLY_CENTS` is the month-at-a-time price quoted beside it.
   * Everyone gets a few an hour for nothing, so a person can try it.
   */
  automotive: {
    /* Generous enough that a person comparing a few cars never meets it, and
       only new decodes are counted at all. The meter is there for agents
       pulling thousands, not for someone shopping for a used car. */
    freeLookupsPerHour: num('AUTOMOTIVE_FREE_LOOKUPS_PER_HOUR', 25),
    dayCents: num('AUTOMOTIVE_DAY_CENTS', 100),
    monthlyCents: num('AUTOMOTIVE_MONTHLY_CENTS', 3000),
    /** Straight-line miles a mechanics search may cover. */
    maxRadiusMiles: num('AUTOMOTIVE_MAX_RADIUS_MILES', 50),
    /**
     * Affiliate tracking links for the parts vendors, as
     * `vendor=template,vendor=template`, where the template holds `{url}` and
     * the destination is url-encoded into it. Every network builds links that
     * way, so a new one needs no code — only the template it gave you. Empty
     * by default: until somebody is approved, every parts link is a plain one.
     */
    affiliateLinks: opt('AFFILIATE_LINKS'),
    /**
     * Amazon Associates. Not part of AFFILIATE_LINKS because Amazon does not
     * wrap a destination the way CJ, Rakuten and eBay do — the link is our own
     * amazon.com URL with `tag` on it, which is also what sh1pt's
     * `affiliate-amazon-associates` adapter does. `AMAZON_ASSOCIATE_TAG` is
     * the name the rest of the fleet already uses for it.
     *
     * The subtag is Amazon's own reporting dimension, so traffic from here is
     * separable in the Associates dashboard even while the tag is shared with
     * another property.
     */
    amazonTag: opt('AMAZON_ASSOCIATE_TAG'),
    amazonSubtag: opt('AMAZON_ASSOCIATE_SUBTAG', 'nichedb-vin'),
  },

  /** CrawlProof ads on the free tier: the publisher slot pages and feeds fill from. */
  ads: {
    get slot() {
      return opt('CRAWLPROOF_AD_SLOT');
    },
    get enabled() {
      return Boolean(this.slot);
    },
    /** Seconds a fetched feed ad is reused for, so a feed's fan-out is one impression. */
    feedTtlSeconds: num('ADS_FEED_TTL_SECONDS', 600),
  },

  push: {
    publicKey: opt('VAPID_PUBLIC_KEY'),
    privateKey: opt('VAPID_PRIVATE_KEY'),
    subject: opt('VAPID_SUBJECT', 'mailto:hello@example.com'),
    get enabled() {
      return Boolean(this.publicKey && this.privateKey);
    },
  },

  mail: {
    resendKey: opt('RESEND_API_KEY'),
    from: opt('MAIL_FROM', 'NicheDB <hello@example.com>'),
    get enabled() {
      return Boolean(this.resendKey);
    },
  },

  analytics: {
    get crawlproofSite() {
      return opt('CRAWLPROOF_SITE_ID');
    },
    get enabled() {
      return Boolean(this.crawlproofSite);
    },
  },

  cache: {
    ttlSeconds: num('CACHE_TTL', 60),
    enabled: bool('CACHE_ENABLED', true),
  },

  // Verification tokens for the partner program are HMACs under this. It has
  // no default: a guessable token would let anyone claim anyone's domain and
  // be paid for their work, and a weak fallback is how that ships by accident.
  partnerSecret: opt('PARTNER_VERIFY_SECRET', ''),

  // The agent question loop. The internal routes create scored work and move
  // somebody's revenue share, so they are signed rather than merely internal.
  // No default and no fallback: unset means the routes answer 503 and the
  // dashboard simply has no questions on it, which is a visible nothing rather
  // than an endpoint anyone who can reach the port may post to.
  chovy: {
    signingSecret: opt('CHOVY_SIGNING_SECRET', ''),
    // Where an answer is delivered back. Optional: the loop still records and
    // scores without it, the agent just has to come and read.
    webhookUrl: opt('CHOVY_WEBHOOK_URL', ''),
  },

  session: {
    cookie: 'ndb_session',
    ttlDays: num('SESSION_TTL_DAYS', 90),
  },
};

/** Asserted at boot by whichever process is about to depend on it. */
export function assertCoinpayMerchantKey() {
  const k = config.coinpay.apiKey;
  if (!k) return;
  if (!/^cp_(live|test)_[0-9a-f]{32}$/.test(k)) {
    throw new Error(
      'COINPAY_API_KEY is not a merchant API key. Expected cp_live_/cp_test_ + 32 hex.',
    );
  }
}
