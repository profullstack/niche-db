/**
 * nichedb Premium beside Reddit Premium, line by line.
 *
 * Reddit is the reason this tier exists in the shape it does: it is the
 * subscription everybody has already been offered, so it is the one a buyer
 * measures ours against. The honest way to win that comparison is to put both
 * lists side by side and let the reader see which one is a product and which
 * one is an ad switch with cosmetics attached.
 *
 * Every Reddit fact here is dated and sourced. reddit.com/premium answers
 * anything that is not a logged-in browser with "You've been blocked by
 * network security", and the Reddit help centre returns 403 to the same
 * fetchers, so the figures below were taken on 2026-09-11 from two independent
 * write-ups published that month which agree on both the price and the list.
 * Re-check them before quoting them in an ad.
 */

export const REDDIT = Object.freeze({
  name: 'Reddit Premium',
  monthlyCents: 599,
  yearlyCents: 4999,
  /** The smallest amount of money that buys you anything at all. */
  entryCents: 599,
  capturedOn: '2026-09-11',
  sources: Object.freeze([
    {
      title: 'Reddit Is Still Free. The $5.99 Upsell Is Just Loud.',
      url: 'https://contextbolt.com/blog/reddit-premium-vs-free/',
      published: '2026-09-11',
    },
    {
      title: 'Is Reddit Premium Worth It? Features, Cost & Review (2026)',
      url: 'https://getupvotes.com/reddit-premium-guide/',
      published: '2026',
    },
  ]),
  /** What Reddit's own marketing lists, in its words as reported by those sources. */
  benefits: Object.freeze([
    'Ad-free browsing on desktop and the official apps',
    'r/lounge, a members-only subreddit',
    'Custom app icons and avatar gear',
    'Longer post bodies and longer video uploads',
    'New comments since your last visit flagged, and basic stats on your own posts',
    'A monthly Coin allowance (700 a month) — retired in 2023 and never replaced',
  ]),
  /** What it does not include, which is as much of the comparison as what it does. */
  excludes: Object.freeze([
    'Early access to new features',
    'Any access to the data itself',
    'Anything an agent or a script can use',
  ]),
});

/**
 * One row per thing a buyer is actually choosing between.
 *
 * `ours` is written against what this repo enforces, not against what would
 * sound good: every row here has a gate in code, and the test suite asserts
 * the pairing so a benefit cannot be added to the page without being added to
 * the entitlement table first.
 */
export function comparisonRows({
  dayCents = 100,
  monthCents = 3000,
  yearCents = 30000,
  apiPremiumPerHour = 30000,
  monthlyCredits = 1000,
  siteName = 'nichedb',
} = {}) {
  const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  return [
    {
      feature: 'What it costs to try',
      reddit: `${money(REDDIT.entryCents)}, and the smallest purchase is a month`,
      ours: `${money(dayCents)} for a day, no account and no subscription`,
      wins: true,
    },
    {
      feature: 'Price',
      reddit: `${money(REDDIT.monthlyCents)} a month, ${money(REDDIT.yearlyCents)} a year`,
      ours: `${money(dayCents)} a day, ${money(monthCents)} a month, ${money(yearCents)} a year`,
      wins: false,
      note: 'We cost more a month, and the rest of this table is why.',
    },
    {
      feature: 'Ad-free',
      reddit: 'Yes, on Reddit',
      ours: `Yes, on every page and inside every feed — the sponsored item is dropped from the RSS and JSON renderings too`,
      wins: true,
    },
    {
      feature: 'No tracking',
      reddit: 'No. The ads go; the analytics stay',
      ours: 'Yes. The tracker is not loaded for a paying reader',
      wins: true,
    },
    {
      feature: 'Members-only room',
      reddit: 'r/lounge',
      ours: 'The Lounge: early-access collections, the members roll, and what other members are awarding',
      wins: true,
    },
    {
      feature: 'Badge',
      reddit: 'A badge on your profile',
      ours: 'A badge on your profile, on every contribution you make, and in the API',
      wins: true,
    },
    {
      feature: 'Monthly credits',
      reddit: '700 Coins a month, retired in 2023',
      ours: `${monthlyCredits.toLocaleString('en-US')} credits a month, granted on the first of the month, spendable on awards`,
      wins: true,
    },
    {
      feature: 'Awards',
      reddit: 'Gone with the Coins',
      ours: 'Three awards you can give any item or contribution, counted publicly and paid out of your credits',
      wins: true,
    },
    {
      feature: 'Themes and icons',
      reddit: 'App icons and avatar gear, mobile only',
      ours: 'Six themes and five app icons, on the web and in the installed PWA',
      wins: true,
    },
    {
      feature: 'Early access',
      reddit: 'Explicitly not included',
      ours: 'Yes. New collections open to members first, before they are public',
      wins: true,
    },
    {
      feature: 'Higher limits',
      reddit: 'Longer posts and longer video uploads',
      ours: `${apiPremiumPerHour.toLocaleString('en-US')} API requests an hour, unlimited feeds, your own sources, and the metered vehicle lookups included`,
      wins: true,
    },
    {
      feature: 'The data',
      reddit: 'Nothing. Premium is an ad switch on a website you already read',
      ours: `Every row ${siteName} holds, by web, RSS, JSON Feed, API, CLI and MCP`,
      wins: true,
    },
    {
      feature: 'Usable by an agent',
      reddit: 'No',
      ours: 'Yes: the same access is buyable over x402 by the day, with no account at all',
      wins: true,
    },
  ];
}

/** How many rows we win, for the line above the table. Counted, never typed. */
export function scoreboard(rows) {
  return {
    total: rows.length,
    ours: rows.filter((r) => r.wins).length,
    theirs: rows.filter((r) => !r.wins).length,
  };
}
