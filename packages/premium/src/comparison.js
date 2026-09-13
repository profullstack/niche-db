/** Verified against Reddit's own web pricing and help page on the date below. */
export const REDDIT = Object.freeze({
  name: 'Reddit Premium',
  monthlyCents: 599,
  yearlyCents: 4999,
  entryCents: 599,
  capturedOn: '2026-09-13',
  sources: Object.freeze([
    { title: 'Reddit Premium — web pricing and benefits', url: 'https://www.reddit.com/premium' },
    {
      title: 'What is a Reddit Premium subscription?',
      url: 'https://support.reddithelp.com/hc/en-us/articles/360043034412-What-is-a-Reddit-Premium-subscription',
    },
  ]),
  benefits: Object.freeze([
    'Ad-free browsing',
    'New comment highlighting',
    'Higher content limits',
    '100 daily AI search questions',
    'Account performance analytics',
    'Custom app icons and exclusive avatar accessories',
    'Access to r/lounge',
  ]),
});

/** Comparisons describe shipped features; an unlisted competitor perk is not a claimed absence. */
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
      reddit: `${money(REDDIT.entryCents)} for the shortest term: one month`,
      ours: `${money(dayCents)} for one day of Premium, including account perks`,
      wins: dayCents < REDDIT.entryCents,
    },
    {
      feature: 'Price',
      reddit: `${money(REDDIT.monthlyCents)} a month, ${money(REDDIT.yearlyCents)} a year`,
      ours: `${money(dayCents)} a day, ${money(monthCents)} a month, ${money(yearCents)} a year`,
      wins: monthCents < REDDIT.monthlyCents && yearCents < REDDIT.yearlyCents,
      note: 'At our standard rates, the month and year cost more than Reddit. Compare what you will use.',
    },
    {
      feature: 'Renewal',
      reddit: 'Automatically renews monthly or yearly',
      ours: 'Prepaid access. No automatic renewal; extend when you choose',
      wins: true,
    },
    {
      feature: 'Ad-free',
      reddit: 'Included',
      ours: 'Included on pages and in authenticated RSS and JSON feeds',
      wins: true,
    },
    {
      feature: 'No tracking',
      reddit: 'Tracker removal is not listed as a Premium benefit',
      ours: 'Our advertising and analytics scripts are disabled for members',
      wins: true,
    },
    {
      feature: 'Members-only room',
      reddit: 'r/lounge',
      ours: 'The Lounge: member collections, the member directory and awarded items',
      wins: true,
    },
    {
      feature: 'Monthly credits',
      reddit: 'No monthly credit allowance listed',
      ours: `${monthlyCredits.toLocaleString('en-US')} award credits, granted on your first visit each calendar month while a member`,
      wins: true,
    },
    {
      feature: 'Awards',
      reddit: 'No award budget listed in Premium',
      ours: 'Spend included credits on Useful, Verified and Scoop awards',
      wins: true,
    },
    {
      feature: 'Themes and icons',
      reddit: 'Special app icons and avatar accessories',
      ours: 'Six themes, five app icons and a Premium badge on your contributions',
      wins: true,
    },
    {
      feature: 'Early access',
      reddit: 'Not listed as a Premium benefit',
      ours: 'Access to collections marked for members before their public release',
      wins: true,
    },
    {
      feature: 'Higher limits',
      reddit: 'Larger posts, longer videos and more saved avatar outfits',
      ours: `${apiPremiumPerHour.toLocaleString('en-US')} API requests an hour, unlimited feeds, your own sources and vehicle lookups included`,
      wins: true,
    },
    {
      feature: 'New comment highlighting',
      reddit: 'Marks comments added since your previous visit',
      ours: 'Not included. Member contributions get a visual highlight; this does not mark unread comments',
      wins: false,
    },
    {
      feature: 'AI search',
      reddit: '100 questions daily; availability varies by language and location',
      ours: 'Search, API, CLI and MCP access. A hosted AI question allowance is not included',
      wins: false,
    },
    {
      feature: 'Performance analytics',
      reddit: 'Account-level content analytics',
      ours: 'Public award counts and your credit history. A content analytics dashboard is not included',
      wins: false,
    },
    {
      feature: 'Data and automation',
      reddit: 'Developer API access is not listed in the Premium bundle',
      ours: `Read ${siteName} through web, RSS, JSON Feed, API, CLI and MCP. Automated crawl passes are sold separately or included with Pro`,
      wins: true,
    },
  ];
}

/** Retained for API consumers; the page leaves the value judgement to the reader. */
export function scoreboard(rows) {
  return {
    total: rows.length,
    ours: rows.filter((r) => r.wins).length,
    theirs: rows.filter((r) => !r.wins).length,
  };
}
