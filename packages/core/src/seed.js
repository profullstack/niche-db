import { ADAPTERS, CRIME_CITIES, UK_CRIME_PLACES } from '@nichedb/adapters';
import { createNiche, upsertOpportunity } from '@nichedb/db/knowledge';
import * as q from '@nichedb/db/queries';

/**
 * The three collections this deployment ships with, their default sources and
 * a few feeds worth following on day one. Idempotent: run on every boot.
 *
 * A source whose adapter needs a credential the deployment does not have is
 * still created, DISABLED, so the sources page shows what could be turned on
 * and what it needs.
 */
export const COLLECTIONS = [
  {
    slug: 'games',
    name: 'Games',
    description:
      'Video game releases and what is coming, from the Steam store and IGDB. Follow a genre, a platform or a store category.',
  },
  {
    slug: 'packages',
    name: 'Packages & models',
    description:
      'Every new version on npm, PyPI and crates.io, every model pushed to Hugging Face, every release on the GitHub repos you name.',
  },
  {
    slug: 'filings',
    name: 'Filings',
    description:
      'SEC EDGAR filings as they land (Form D raises, insider trades, 8-K events), Federal Register documents, and court opinions.',
  },
  {
    slug: 'music',
    name: 'Music',
    description:
      'Upcoming album and single releases from MusicBrainz, with cover art, videos and artist pages.',
  },
  {
    slug: 'books',
    name: 'Books',
    description:
      'New books as they are catalogued at Open Library, with covers, descriptions and subjects.',
  },
  {
    slug: 'tabletop',
    name: 'Tabletop',
    description:
      'Magic: The Gathering sets and the newest cards, with images, oracle text and prices.',
  },
  {
    slug: 'space',
    name: 'Space',
    description:
      'Every upcoming rocket launch worldwide: net time, provider, pad, mission and webcast.',
  },
  {
    slug: 'chess',
    name: 'Chess',
    description: 'Official tournaments relayed live on Lichess, one row per event and per round.',
  },
  {
    slug: 'alerts',
    name: 'Alerts',
    description:
      'Earthquakes and global disaster alerts, minutes after they are issued. Weather has a collection of its own.',
  },
  {
    slug: 'weather',
    name: 'Weather',
    description:
      'Weather as it is issued rather than forecast: every active US warning, watch and advisory from the National Weather Service, the tropical cyclones the National Hurricane Center is tracking advisory by advisory, geomagnetic storms from NOAA, and the wildfires, floods and severe storms NASA tracks worldwide.',
  },
  {
    slug: 'outages',
    name: 'Outages',
    description:
      'Incidents from the status pages of the platforms developers depend on, as they are posted and resolved.',
  },
  {
    slug: 'extensions',
    name: 'Extensions',
    description:
      'New Firefox add-ons, VS Code extensions and MCP servers, with icons, categories and repo stats.',
  },
  {
    slug: 'health',
    name: 'Health',
    description:
      'FDA recalls and clinical trials as they are posted, with sponsor, phase and reason.',
  },
  {
    slug: 'research',
    name: 'Research',
    description: 'New preprints and DOIs with abstracts, authors, TL;DRs and citation counts.',
  },
  {
    slug: 'automotive',
    name: 'Automotive',
    description:
      'Every make, model and year sold in the US, and what is known about each one: safety recalls, what owners report going wrong, crash-test ratings, engines and mpg. Decode a VIN and get all of it for one car.',
  },
  {
    slug: 'markets',
    name: 'Markets',
    description:
      'Every market venue in the world from the ISO 10383 register, across 149 countries, and the events that move the ones we have data for: US dividends, splits, mergers and spin-offs, trading halts as they are declared, the market news wire, and the ECB’s daily euro reference rates.',
  },
  {
    slug: 'crime',
    name: 'Crime',
    description:
      'Crime reports as police departments publish them: incident-level records from seven US city open-data portals, street-level crime across England, Wales and Northern Ireland, and the FBI’s state-by-state estimates. Every row carries its country, state or force area, city and neighbourhood, so it can be read by place rather than only as a stream.',
  },
  {
    slug: 'public-money',
    name: 'Public money',
    description:
      'Who is getting paid by governments, and for what: every US federal contract, grant and loan, every above-threshold tender in the European Union, and UK procurement from both national portals. Three governments, one shape, so an award in Ohio and a tender in Estonia can be read side by side.',
  },
  {
    slug: 'housing',
    name: 'Housing',
    description:
      'What homes cost and what is being built: every property sold in England and Wales with its address and price, harmonised house price indices across Europe, the weekly US mortgage rate, and the building permits US cities issue months before ground is broken.',
  },
  {
    slug: 'jobs',
    name: 'Jobs',
    description:
      'The labour market as governments measure it: the US jobs report series from the BLS, harmonised unemployment and employment rates across Europe, and the WARN notices employers must file before a mass layoff — the one public, named record of jobs actually being cut.',
  },
  {
    slug: 'ai-incidents',
    name: 'AI incidents',
    description:
      'What autonomous AI agents have actually been caught doing, and the harms AI systems have caused in the world, each entry linked to the primary source that evidenced it.',
  },
  {
    slug: 'news',
    name: 'News',
    description:
      'The story and the screen: wire copy read straight from newsroom RSS, worldwide coverage from GDELT in 65 languages, and the live news channels you can actually watch, each with its public stream. Every source is free and keyless.',
  },
  {
    slug: 'domains',
    name: 'Domains',
    description:
      'The domain name industry, counted daily from ICANN and IANA public data: how many names exist across the new gTLDs and which way each is moving, who operates every TLD and on whose backend, the sunrise and claims windows registries have filed, and the operators and registrars quietly changing hands. Aggregate figures only — zone data may be analysed but not redistributed.',
  },
  {
    slug: 'podcasts',
    name: 'Podcasts',
    description:
      'Podcast shows split the one way no podcast app will split them: by who serves the feed. On one side the shows on a commercial host, a network or a broadcaster — 94% of the medium. On the other the shows published from the maker’s own domain, which is where the independent 6% is, and which nothing else lists separately because nobody sells it.',
  },
  {
    slug: 'aviation',
    name: 'Aviation',
    description:
      'Why flights are late, what is flying, and what happens when it goes wrong. The traffic management initiatives the FAA has in force right now — ground stops, ground delay programs, airport closures — each written once more when it ends with how long it ran, which the FAA itself never publishes. Every SIGMET and AIRMET in the air over the country, and the decoded observation at the airport underneath. And every one of the 31,000 accidents the NTSB has investigated, each carrying the raw weather observation at the moment it happened — the same field, from the same service, that the hourly feed publishes today. All keyless.',
  },
  {
    slug: 'water',
    name: 'Water',
    description:
      'Too much water and too little, measured rather than forecast: every NOAA river gauge at or above its action stage with the height in feet and the flood category behind the warning, the observed level at tide stations on every US coast against the height at which each one floods, and the US Drought Monitor’s weekly read on how much of each state is dry and how badly. Then the sea itself — every NOAA buoy’s wave height, period and direction, which is what a surf report is made of, beside the National Weather Service’s own surf zone forecast saying what it means for anyone standing on the beach.',
  },
  {
    slug: 'consumer-finance',
    name: 'Consumer finance',
    description:
      'What Americans say their banks, lenders, credit bureaus and debt collectors are doing to them, and who those companies actually are. Around ten thousand complaints a day from the Consumer Financial Protection Bureau, a third of them carrying the consumer’s own account; every FDIC-insured institution with its charter, regulator and assets; and every merger, failure, conversion and branch opening or closing on the FDIC register — which is the only public record of which bank a complaint about a vanished bank now belongs to.',
  },
  {
    slug: 'sports',
    name: 'Sports',
    description:
      'Every fixture across 17 sports and 350 leagues: schedule, live score, line, venue and broadcast, with the leagues and teams behind them, and tennis by tournament. The data tipoffwatch.com is built on, kept here so every site and player can read it.',
  },
  {
    slug: 'screen',
    name: 'Screen',
    description:
      'Films, TV and anime: what is coming to cinemas, to rent, to a streaming service and to air, with posters, genres and IMDb ratings for 400,000 titles. The data genrewatch.com is built on.',
  },
  {
    slug: 'channels',
    name: 'Channels',
    description:
      'The whole iptv-org directory: 31,000 television channels worldwide with logo, country, language, category and network, and the public stream where one exists. What a player matches a playlist entry against.',
  },
];

export const DEFAULT_FEEDS = [
  {
    collection: 'games',
    slug: 'new-on-steam',
    name: 'New on Steam',
    query: { sources: ['steam-new-releases'] },
  },
  {
    collection: 'games',
    slug: 'coming-soon-steam',
    name: 'Coming soon on Steam',
    query: { sources: ['steam-coming-soon'], upcoming: true },
  },
  {
    collection: 'games',
    slug: 'steam-top-sellers',
    name: 'Steam top sellers',
    query: { sources: ['steam-top-sellers'] },
  },
  {
    collection: 'packages',
    slug: 'npm-latest',
    name: 'npm: latest versions',
    query: { sources: ['npm'] },
  },
  {
    collection: 'packages',
    slug: 'pypi-latest',
    name: 'PyPI: latest releases',
    query: { sources: ['pypi'] },
  },
  {
    collection: 'packages',
    slug: 'crates-latest',
    name: 'crates.io: latest',
    query: { sources: ['crates'] },
  },
  {
    collection: 'packages',
    slug: 'huggingface-models',
    name: 'Hugging Face: new models',
    query: { sources: ['huggingface-models'] },
  },
  {
    collection: 'packages',
    slug: 'mcp-packages',
    name: 'MCP servers on npm and PyPI',
    query: { q: 'mcp', sources: ['npm', 'pypi'] },
  },
  {
    collection: 'filings',
    slug: 'form-d-raises',
    name: 'Form D: who raised money',
    query: { sources: ['edgar-form-d'] },
  },
  {
    collection: 'filings',
    slug: 'insider-trades',
    name: 'Form 4: insider trades',
    query: { sources: ['edgar-form-4'] },
  },
  {
    collection: 'filings',
    slug: 'material-events',
    name: '8-K: material events',
    query: { sources: ['edgar-8k'] },
  },
  {
    collection: 'filings',
    slug: 'federal-register',
    name: 'Federal Register: newest documents',
    query: { sources: ['federal-register'] },
  },
  {
    collection: 'music',
    slug: 'new-albums',
    name: 'Upcoming albums',
    query: { tags: ['album'], upcoming: true },
  },
  {
    collection: 'music',
    slug: 'new-singles',
    name: 'Upcoming singles',
    query: { tags: ['single'], upcoming: true },
  },
  { collection: 'books', slug: 'new-books', name: 'New books', query: {} },
  {
    collection: 'tabletop',
    slug: 'mtg-set-calendar',
    name: 'Magic sets and release dates',
    query: { kinds: ['set'] },
  },
  {
    collection: 'tabletop',
    slug: 'mtg-mythics',
    name: 'Magic: new mythics and rares',
    query: { kinds: ['card'], tags: ['mythic', 'rare'] },
  },
  { collection: 'space', slug: 'launches', name: 'Rocket launches', query: { upcoming: true } },
  {
    collection: 'space',
    slug: 'spacex-launches',
    name: 'SpaceX launches',
    query: { tags: ['spacex'], upcoming: true },
  },
  { collection: 'chess', slug: 'chess-live', name: 'Chess: tournaments and rounds', query: {} },
  {
    collection: 'alerts',
    slug: 'big-earthquakes',
    name: 'Earthquakes M5+',
    query: { kinds: ['earthquake'], tags: ['moderate', 'strong', 'major'] },
  },
  {
    collection: 'alerts',
    slug: 'disasters',
    name: 'Global disasters',
    query: { kinds: ['disaster'] },
  },
  { collection: 'outages', slug: 'outages-all', name: 'Vendor incidents', query: {} },
  {
    collection: 'outages',
    slug: 'ai-outages',
    name: 'AI platform incidents',
    query: { tags: ['openai', 'claude'] },
  },
  {
    collection: 'extensions',
    slug: 'new-firefox-addons',
    name: 'New Firefox add-ons',
    query: { sources: ['firefox-new-extensions'] },
  },
  {
    collection: 'extensions',
    slug: 'new-vscode-extensions',
    name: 'New VS Code extensions',
    query: { sources: ['vscode-new-extensions'] },
  },
  {
    collection: 'extensions',
    slug: 'new-mcp-servers',
    name: 'New MCP servers',
    query: { kinds: ['mcp-server'] },
  },
  { collection: 'health', slug: 'fda-recalls', name: 'FDA recalls', query: { kinds: ['recall'] } },
  {
    collection: 'health',
    slug: 'trials-recruiting',
    name: 'Clinical trials now recruiting',
    query: { sources: ['clinical-trials-recruiting'] },
  },
  {
    collection: 'research',
    slug: 'ai-papers',
    name: 'New AI papers',
    query: { sources: ['arxiv-ai'] },
  },
  {
    collection: 'research',
    slug: 'security-papers',
    name: 'New security papers',
    query: { sources: ['arxiv-security'] },
  },
  {
    collection: 'packages',
    slug: 'go-tagged',
    name: 'Go: tagged module versions',
    query: { sources: ['go-modules'] },
  },
  {
    collection: 'automotive',
    slug: 'do-not-drive',
    name: 'Do not drive: the urgent recalls',
    description: 'Recalls where NHTSA’s advice is to stop driving the car or park it outside.',
    query: { kinds: ['recall'], tags: ['do-not-drive', 'park-outside'] },
  },
  {
    collection: 'automotive',
    slug: 'vehicle-recalls',
    name: 'Vehicle recalls',
    query: { kinds: ['recall'] },
  },
  {
    collection: 'automotive',
    slug: 'owner-complaints',
    name: 'What owners report going wrong',
    query: { kinds: ['complaint'] },
  },
  {
    collection: 'automotive',
    slug: 'crashes-and-fires',
    name: 'Complaints involving a crash or a fire',
    query: { kinds: ['complaint'], tags: ['crash', 'fire', 'injury', 'fatality'] },
  },
  {
    collection: 'automotive',
    slug: 'crash-test-ratings',
    name: 'Crash-test ratings',
    query: { kinds: ['safety-rating'] },
  },
  {
    collection: 'automotive',
    slug: 'vehicle-catalog',
    name: 'Makes, models and years',
    query: { kinds: ['model'] },
  },
  /* Markets. The first two are the worldwide half and the rest are US, which
     is the shape of what is actually given away: the register of the world's
     venues is public, and their prices are not. */
  {
    collection: 'markets',
    slug: 'world-exchanges',
    name: 'World exchanges',
    description:
      'Every operating market venue on earth from the ISO 10383 register, across 149 countries, with its operator, LEI, category and city.',
    query: { kinds: ['exchange'] },
  },
  {
    collection: 'markets',
    slug: 'exchange-changes',
    name: 'Exchanges opening, closing and renaming',
    description:
      'Market identifier codes newly registered, updated or expired. An expired code is an exchange that closed or merged.',
    query: { kinds: ['exchange'], tags: ['expired', 'updated'] },
  },
  {
    collection: 'markets',
    slug: 'fx-rates',
    name: 'Euro FX reference rates',
    query: { kinds: ['fx-rate'] },
  },
  {
    collection: 'markets',
    slug: 'us-dividends',
    name: 'US dividends',
    query: { kinds: ['dividend'] },
  },
  {
    collection: 'markets',
    slug: 'stock-splits',
    name: 'Stock splits',
    query: { kinds: ['split'] },
  },
  {
    collection: 'markets',
    slug: 'reverse-splits',
    name: 'Reverse splits',
    description:
      'A reverse split usually follows a long fall in the share price, and often precedes a delisting notice.',
    query: { kinds: ['split'], tags: ['reverse-split'] },
  },
  {
    collection: 'markets',
    slug: 'mergers-and-spinoffs',
    name: 'Mergers, acquisitions and spin-offs',
    query: { kinds: ['merger', 'spin-off'] },
  },
  {
    collection: 'markets',
    slug: 'delistings',
    name: 'Delistings and ticker changes',
    query: { kinds: ['delisting', 'name-change'] },
  },
  {
    collection: 'markets',
    slug: 'trading-halts',
    name: 'US trading halts',
    query: { kinds: ['halt'] },
  },
  {
    collection: 'markets',
    slug: 'regulatory-halts',
    name: 'SEC suspensions and listing-rule halts',
    description: 'The halts that are a regulator acting rather than a price moving quickly.',
    query: { kinds: ['halt'], tags: ['regulatory'] },
  },
  {
    collection: 'markets',
    slug: 'market-news',
    name: 'Market news',
    query: { kinds: ['market-news'] },
  },
  /* Crime. Cut three ways, because there are three questions people arrive
     with: what happened near me, what kind of thing is happening, and how does
     a whole place compare. The per-city feeds are generated from the adapter's
     own city list further down rather than written out twice. */
  {
    collection: 'crime',
    slug: 'crime-reports',
    name: 'Crime reports',
    description: 'Every incident-level report the collection ingests, newest first.',
    query: { kinds: ['crime-report'] },
  },
  {
    collection: 'crime',
    slug: 'violent-crime',
    name: 'Violent crime',
    query: { kinds: ['crime-report'], tags: ['homicide', 'assault', 'robbery', 'sex-offense'] },
  },
  {
    collection: 'crime',
    slug: 'homicides',
    name: 'Homicides',
    query: { kinds: ['crime-report'], tags: ['homicide'] },
  },
  {
    collection: 'crime',
    slug: 'burglary-and-theft',
    name: 'Burglary and theft',
    query: { kinds: ['crime-report'], tags: ['burglary', 'theft', 'vehicle-theft'] },
  },
  {
    collection: 'crime',
    slug: 'crime-uk',
    name: 'Crime in England, Wales and Northern Ireland',
    query: { kinds: ['crime-report'], tags: ['gb'] },
  },
  {
    collection: 'crime',
    slug: 'crime-by-state',
    name: 'US crime by state and year',
    description:
      'The FBI’s estimates, which are comparable between states in a way that summing city portals is not.',
    query: { kinds: ['crime-estimate'] },
  },
  /* Public money. Cut by what a reader is: a supplier looking for work wants
     tenders, a journalist wants awards, and both want the big ones. */
  {
    collection: 'public-money',
    slug: 'public-contracts',
    name: 'Public contracts awarded',
    description: 'Money committed: contracts and grants that have been awarded to somebody.',
    query: { kinds: ['contract-award', 'grant-award'] },
  },
  {
    collection: 'public-money',
    slug: 'open-tenders',
    name: 'Tenders open for bidding',
    description: 'Money about to be spent, and still open to bid on.',
    query: { kinds: ['tender'] },
  },
  {
    collection: 'public-money',
    slug: 'big-awards',
    name: 'The eight-figure awards',
    query: { tags: ['million-plus'] },
  },
  {
    collection: 'public-money',
    slug: 'us-federal-spending',
    name: 'US federal contracts and grants',
    query: { kinds: ['contract-award', 'grant-award', 'loan', 'direct-payment'], tags: ['us'] },
  },
  {
    collection: 'public-money',
    slug: 'eu-procurement',
    name: 'EU procurement',
    query: { tags: ['eu'] },
  },
  {
    collection: 'public-money',
    slug: 'uk-procurement',
    name: 'UK procurement',
    query: { tags: ['gb'] },
  },

  /* Housing. The events first, then the series: a sale and a permit are things
     that happened, and an index is a summary of many of them. */
  {
    collection: 'housing',
    slug: 'property-sales',
    name: 'Property sales',
    description:
      'Every home sold in England and Wales, with the address and the price actually paid.',
    query: { kinds: ['property-sale'] },
  },
  {
    collection: 'housing',
    slug: 'million-pound-homes',
    name: 'Homes sold for £1m and up',
    query: { kinds: ['property-sale'], tags: ['million-plus'] },
  },
  {
    collection: 'housing',
    slug: 'new-builds',
    name: 'New-build sales',
    query: { kinds: ['property-sale'], tags: ['new-build'] },
  },
  {
    collection: 'housing',
    slug: 'building-permits',
    name: 'Building permits',
    description: 'What is about to be built, months before ground is broken.',
    query: { kinds: ['building-permit'] },
  },
  {
    collection: 'housing',
    slug: 'new-construction',
    name: 'New construction permits',
    query: { kinds: ['building-permit'], tags: ['new-construction'] },
  },
  {
    collection: 'housing',
    slug: 'house-prices',
    name: 'House prices and mortgage rates',
    query: { kinds: ['housing-statistic'] },
  },
  {
    collection: 'housing',
    slug: 'mortgage-rates',
    name: 'US mortgage rates',
    query: { kinds: ['housing-statistic'], tags: ['mortgage'] },
  },

  /* Jobs. A statistic describes the market; a WARN notice names a company. */
  {
    collection: 'jobs',
    slug: 'jobs-report',
    name: 'The jobs numbers',
    description:
      'Unemployment, payrolls, openings, quits and earnings as the statistical agencies publish them.',
    query: { kinds: ['labour-statistic'] },
  },
  {
    collection: 'jobs',
    slug: 'us-jobs-report',
    name: 'US jobs report',
    query: { kinds: ['labour-statistic'], tags: ['bls'] },
  },
  {
    collection: 'jobs',
    slug: 'unemployment',
    name: 'Unemployment',
    query: { kinds: ['labour-statistic'], tags: ['unemployment', 'unemployment-rate'] },
  },
  {
    collection: 'jobs',
    slug: 'layoffs',
    name: 'Layoffs',
    description: 'WARN notices: the companies actually cutting jobs, named, counted and dated.',
    query: { kinds: ['layoff-notice'] },
  },
  {
    collection: 'jobs',
    slug: 'big-layoffs',
    name: 'Layoffs of 100 or more',
    query: { kinds: ['layoff-notice'], tags: ['hundred-plus'] },
  },

  /* Weather. `severe-weather-us` keeps its slug from when it lived under
     `alerts`, because it is a feed people may already be following and a feed
     URL is a promise. Migration 0010 moves the row rather than replacing it. */
  {
    collection: 'weather',
    slug: 'severe-weather-us',
    name: 'Severe weather (US)',
    description: 'Every active US warning, watch and advisory, minutes after the NWS issues it.',
    query: { kinds: ['alert'] },
  },
  {
    collection: 'weather',
    slug: 'tornadoes-and-thunderstorms',
    name: 'Tornadoes and severe thunderstorms',
    query: {
      kinds: ['alert'],
      tags: ['tornado-warning', 'tornado-watch', 'severe-thunderstorm-warning'],
    },
  },
  {
    collection: 'weather',
    slug: 'winter-storms',
    name: 'Winter storms and ice',
    query: {
      kinds: ['alert'],
      tags: ['winter-storm-warning', 'blizzard-warning', 'ice-storm-warning'],
    },
  },
  {
    collection: 'weather',
    slug: 'flooding',
    name: 'Flooding',
    query: { kinds: ['alert', 'flood'], tags: ['flash-flood-warning', 'flood-warning', 'flood'] },
  },
  {
    collection: 'weather',
    slug: 'hurricanes',
    name: 'Tropical cyclones',
    description:
      'Every advisory on every storm the National Hurricane Center is tracking, Atlantic and Pacific.',
    query: { kinds: ['cyclone'] },
  },
  {
    collection: 'weather',
    slug: 'major-hurricanes',
    name: 'Major hurricanes (category 3 and up)',
    query: { kinds: ['cyclone'], tags: ['major-hurricane'] },
  },
  {
    collection: 'weather',
    slug: 'space-weather',
    name: 'Space weather',
    description:
      'Geomagnetic storms, solar radiation storms and radio blackouts, with the NOAA scale and the stated impact on grids, GPS and HF radio.',
    query: { kinds: ['space-weather'] },
  },
  {
    collection: 'weather',
    slug: 'aurora-watch',
    name: 'Aurora watch',
    description: 'The G3 and stronger geomagnetic storms that drop the aurora into mid-latitudes.',
    query: { kinds: ['space-weather'], tags: ['aurora-likely'] },
  },
  {
    collection: 'weather',
    slug: 'wildfires',
    name: 'Wildfires worldwide',
    query: { kinds: ['wildfire'] },
  },
  {
    collection: 'weather',
    slug: 'natural-events',
    name: 'Natural events worldwide',
    description:
      'Storms, floods, drought, dust, snow and sea ice as NASA tracks them, each linked to the agency that reported it.',
    query: { kinds: ['storm', 'flood', 'drought', 'dust-and-haze', 'snow', 'sea-and-lake-ice'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'rogue-agent-incidents',
    name: 'Rogue agent incidents',
    query: { kinds: ['incident'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'ai-harms',
    name: 'AI harms as they are reported',
    query: { kinds: ['incident-report'] },
  },
  {
    collection: 'ai-incidents',
    slug: 'agent-research',
    name: 'Research on agents and multi-agent systems',
    query: { kinds: ['research'] },
  },
  {
    collection: 'news',
    slug: 'world-headlines',
    name: 'World headlines',
    query: { sources: ['news-world'] },
  },
  {
    collection: 'news',
    slug: 'news-global-beats',
    name: 'Global beats: elections, economy, conflict, climate, health',
    query: { sources: ['news-global'] },
  },
  {
    collection: 'news',
    slug: 'live-news-channels',
    name: 'Live news channels you can watch',
    query: { kinds: ['channel'] },
  },
  // One per desk. The section is a tag on every story, so these are plain tag
  // queries rather than a second source per section.
  { collection: 'news', slug: 'news-us', name: 'US news', query: { tags: ['us'] } },
  { collection: 'news', slug: 'news-politics', name: 'Politics', query: { tags: ['politics'] } },
  { collection: 'news', slug: 'news-business', name: 'Business', query: { tags: ['business'] } },
  {
    collection: 'news',
    slug: 'news-technology',
    name: 'Technology',
    query: { tags: ['technology'] },
  },
  { collection: 'news', slug: 'news-sport', name: 'Sport', query: { tags: ['sport'] } },
  { collection: 'news', slug: 'news-climate', name: 'Climate', query: { tags: ['climate'] } },
  /*
   * Three desks the directory covers and no newsroom feed we list does, so they
   * have no address until the directory supplies one.
   */
  {
    collection: 'news',
    slug: 'news-entertainment',
    name: 'Entertainment',
    query: { tags: ['entertainment'] },
  },
  { collection: 'news', slug: 'news-food', name: 'Food', query: { tags: ['food'] } },
  { collection: 'news', slug: 'news-travel', name: 'Travel', query: { tags: ['travel'] } },
  /*
   * Not a desk any newsroom publishes: the small web is one writer per feed, so
   * it gets its own address rather than being mixed into a section a reader
   * opened expecting the wire.
   */
  {
    collection: 'news',
    slug: 'news-independent',
    name: 'The small web',
    query: { tags: ['independent'] },
  },
  {
    collection: 'domains',
    slug: 'new-tlds',
    name: 'New TLDs in the root zone',
    query: { kinds: ['delegation'] },
  },
  {
    collection: 'domains',
    slug: 'tld-launches',
    name: 'Sunrise and claims windows',
    query: { kinds: ['launch-phase'] },
  },
  {
    collection: 'domains',
    slug: 'tld-pipeline',
    name: 'Contracted and transitioning TLDs',
    query: { kinds: ['contracted', 'transition'] },
  },
  {
    collection: 'domains',
    slug: 'registry-changes',
    name: 'Registries and registrars changing hands',
    query: { kinds: ['registry-change'] },
  },
  {
    collection: 'domains',
    slug: 'growing-tlds',
    name: 'Fastest growing TLDs',
    query: { sources: ['fastest-growing-tlds'] },
  },
  {
    collection: 'domains',
    slug: 'declining-tlds',
    name: 'TLDs losing domains',
    query: { sources: ['shrinking-tlds'] },
  },
  {
    collection: 'domains',
    slug: 'domain-totals',
    name: 'How many domains exist',
    query: { kinds: ['domain-count'] },
  },
  {
    collection: 'domains',
    slug: 'brand-tlds',
    name: 'Brand TLDs',
    query: { kinds: ['tld'], tags: ['brand'] },
  },
  /*
   * The split itself is two feeds, because the split is the product. Everything
   * below them is a cut of the independent side: the commercial half is already
   * addressable in every podcast app there is, and a language feed over it would
   * be a worse Apple. The half worth slicing is the one nothing else lists.
   */
  {
    collection: 'podcasts',
    slug: 'self-hosted-podcasts',
    name: 'Self-hosted podcasts',
    query: { sources: ['podcasts-self-hosted'] },
  },
  {
    collection: 'podcasts',
    slug: 'commercially-hosted-podcasts',
    name: 'Podcasts on a commercial host',
    query: { sources: ['podcasts-commercial'] },
  },
  {
    collection: 'podcasts',
    slug: 'self-hosted-podcasts-en',
    name: 'Self-hosted podcasts in English',
    query: { sources: ['podcasts-self-hosted'], tags: ['lang:en'] },
  },
  {
    collection: 'podcasts',
    slug: 'self-hosted-podcasts-de',
    name: 'Self-hosted podcasts in German',
    query: { sources: ['podcasts-self-hosted'], tags: ['lang:de'] },
  },
  {
    collection: 'podcasts',
    slug: 'self-hosted-podcasts-es',
    name: 'Self-hosted podcasts in Spanish',
    query: { sources: ['podcasts-self-hosted'], tags: ['lang:es'] },
  },
  {
    collection: 'podcasts',
    slug: 'self-hosted-podcasts-fr',
    name: 'Self-hosted podcasts in French',
    query: { sources: ['podcasts-self-hosted'], tags: ['lang:fr'] },
  },
  /*
   * Aviation reads as one story per airport, so the feeds are cuts of the
   * cause rather than of the source: the delays, the weather that explains
   * them, and the airports where the weather is actually in the way.
   */
  {
    collection: 'aviation',
    slug: 'ground-stops-and-delays',
    name: 'Ground stops and delay programs',
    query: { kinds: ['ground-stop', 'ground-delay', 'airspace-flow', 'trajectory-options'] },
  },
  {
    collection: 'aviation',
    slug: 'weather-delays',
    name: 'Delays caused by weather',
    query: { sources: ['faa-nas-status'], tags: ['weather'] },
  },
  {
    collection: 'aviation',
    slug: 'airport-closures',
    name: 'Airport closures',
    query: { kinds: ['airport-closure'] },
  },
  {
    collection: 'aviation',
    slug: 'aviation-hazards',
    name: 'SIGMETs and AIRMETs in force',
    query: { kinds: ['aviation-hazard'] },
  },
  {
    collection: 'aviation',
    slug: 'airports-below-vfr',
    name: 'Airports below VFR',
    query: { kinds: ['observation'], tags: ['below-vfr'] },
  },
  {
    collection: 'aviation',
    slug: 'aviation-accidents',
    name: 'NTSB accidents and incidents',
    query: { kinds: ['accident'] },
  },
  {
    collection: 'aviation',
    slug: 'fatal-aviation-accidents',
    name: 'Fatal aviation accidents',
    query: { kinds: ['accident'], tags: ['fatal'] },
  },
  {
    collection: 'aviation',
    slug: 'accidents-in-instrument-conditions',
    name: 'Accidents in instrument conditions',
    query: { kinds: ['accident'], tags: ['instrument-conditions'] },
  },
  {
    collection: 'water',
    slug: 'rivers-in-flood',
    name: 'Rivers in flood',
    query: { kinds: ['river-gauge'], tags: ['flood:minor', 'flood:moderate', 'flood:major'] },
  },
  {
    collection: 'water',
    slug: 'major-flooding',
    name: 'Major and moderate flooding',
    query: { tags: ['significant-flooding'] },
  },
  {
    collection: 'water',
    slug: 'river-forecasts',
    name: 'Rivers forecast to flood',
    query: { kinds: ['river-forecast'] },
  },
  {
    collection: 'water',
    slug: 'coastal-flooding',
    name: 'Coastal flooding',
    query: { kinds: ['water-level'], tags: ['flooding'] },
  },
  {
    collection: 'water',
    slug: 'drought',
    name: 'Drought by state',
    query: { kinds: ['drought'] },
  },
  {
    collection: 'water',
    slug: 'extreme-drought',
    name: 'Extreme and exceptional drought',
    query: { tags: ['extreme-drought'] },
  },
  {
    collection: 'water',
    slug: 'surf-report',
    name: 'Surf report',
    query: { kinds: ['sea-state'], tags: ['waves'] },
  },
  {
    collection: 'water',
    slug: 'big-surf',
    name: 'Big surf',
    query: { tags: ['big-surf'] },
  },
  {
    collection: 'water',
    slug: 'groundswell',
    name: 'Long-period groundswell',
    query: { tags: ['groundswell'] },
  },
  {
    collection: 'water',
    slug: 'surf-forecasts',
    name: 'Surf zone forecasts',
    query: { kinds: ['surf-forecast'] },
  },
  {
    collection: 'water',
    slug: 'high-surf-advisories',
    name: 'High surf advisories and warnings',
    query: { tags: ['high-surf-advisory', 'high-surf-warning'] },
  },
  {
    collection: 'water',
    slug: 'rip-current-risk',
    name: 'High rip current risk',
    query: { tags: ['rip-current-risk:high'] },
  },
  {
    collection: 'water',
    slug: 'sea-temperature',
    name: 'Buoys and sea temperature',
    query: { kinds: ['sea-state', 'marine-observation'] },
  },
  {
    collection: 'aviation',
    slug: 'aircraft-emergencies',
    name: 'Aircraft declaring an emergency',
    query: { kinds: ['aircraft-emergency'] },
  },
  {
    collection: 'aviation',
    slug: 'military-aircraft',
    name: 'Military aircraft airborne',
    query: { kinds: ['aircraft-sighting'], tags: ['military'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'consumer-complaints',
    name: 'Consumer complaints',
    query: { kinds: ['complaint'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'complaints-in-their-own-words',
    name: 'Complaints in the consumer’s own words',
    query: { kinds: ['complaint'], tags: ['has-narrative'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'mortgage-complaints',
    name: 'Mortgage complaints',
    query: { kinds: ['complaint'], tags: ['mortgage'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'debt-collection-complaints',
    name: 'Debt collection complaints',
    query: { kinds: ['complaint'], tags: ['debt-collection'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'bank-mergers-and-failures',
    name: 'Bank mergers and failures',
    query: { kinds: ['structure-change'], tags: ['merger', 'establishment'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'branch-closings',
    name: 'Branches opening and closing',
    query: { kinds: ['structure-change'], tags: ['branch-closing', 'branch-opening'] },
  },
  {
    collection: 'consumer-finance',
    slug: 'insured-banks',
    name: 'FDIC-insured banks',
    query: { kinds: ['institution'] },
  },
  // Sports: fixtures by state, the way the site's pages ask for them.
  {
    collection: 'sports',
    slug: 'live-now',
    name: 'Live now',
    query: { kinds: ['fixture'], tags: ['state:in'] },
  },
  {
    collection: 'sports',
    slug: 'upcoming-fixtures',
    name: 'Upcoming fixtures',
    query: { kinds: ['fixture'], tags: ['state:pre'], upcoming: true },
  },
  {
    collection: 'sports',
    slug: 'final-scores',
    name: 'Final scores',
    query: { kinds: ['fixture'], tags: ['state:post'] },
  },
  { collection: 'sports', slug: 'leagues', name: 'Leagues', query: { kinds: ['league'] } },
  {
    collection: 'sports',
    slug: 'play-by-play',
    name: 'Play-by-play and recaps',
    query: { kinds: ['plays'] },
  },
  {
    collection: 'sports',
    slug: 'tv-listings',
    name: 'TV listings',
    query: { kinds: ['broadcast'], upcoming: true },
  },
  // Screen: the calendar, by how a title arrives.
  {
    collection: 'screen',
    slug: 'in-cinemas',
    name: 'Coming to cinemas',
    query: { kinds: ['release'], tags: ['type:theatrical'], upcoming: true },
  },
  {
    collection: 'screen',
    slug: 'home-releases',
    name: 'To rent, buy or stream',
    query: { kinds: ['release'], tags: ['type:digital', 'type:stream'], upcoming: true },
  },
  {
    collection: 'screen',
    slug: 'on-air',
    name: 'Episodes airing',
    query: { kinds: ['release'], tags: ['type:episode', 'type:airing'], upcoming: true },
  },
  { collection: 'screen', slug: 'titles', name: 'Titles', query: { kinds: ['title'] } },
  // Channels: what can be watched, and everything else by name.
  {
    collection: 'channels',
    slug: 'streamable-channels',
    name: 'Channels with a public stream',
    query: { kinds: ['channel'], tags: ['streamable'] },
  },
  {
    collection: 'channels',
    slug: 'all-channels',
    name: 'Every channel',
    query: { kinds: ['channel'] },
  },
];

/**
 * A feed per place, from the same lists the adapters seed their sources from.
 *
 * "Crime near me" is the question this collection is actually for, and a feed
 * per city is how a person subscribes to it. Written out by hand these would
 * be fifteen near-identical blocks that drift the first time a city is added
 * to an adapter and not to this file, so they are generated from the adapters'
 * own place lists and cannot disagree with them.
 *
 * Every crime row is tagged with its city slug, its state or force area and
 * its country, which is what makes a query this short sufficient.
 */
for (const [key, c] of Object.entries(CRIME_CITIES)) {
  DEFAULT_FEEDS.push({
    collection: 'crime',
    slug: `crime-${key}`,
    name: `Crime: ${c.city}, ${c.state}`,
    query: { kinds: ['crime-report'], tags: [key] },
  });
}
for (const p of UK_CRIME_PLACES) {
  DEFAULT_FEEDS.push({
    collection: 'crime',
    slug: `crime-uk-${p.key}`,
    name: `Crime: ${p.city}, ${p.region}`,
    query: { kinds: ['crime-report'], tags: [p.key] },
  });
}

/**
 * A niche for every collection this deployment ships.
 *
 * A niche is a market someone can know, and the markets this site already
 * holds data about are the ones worth offering first: whoever knows how
 * package registries or SEC filings are actually used can improve what is
 * here today. Nothing invented, nothing scored — an opportunity score nobody
 * has measured is left null and the page says so rather than printing a
 * number it cannot defend.
 *
 * Every one is created `open`, so the marketplace has something real on it
 * and an admin can archive or add to the list without a migration.
 */
async function ensureNiches(byCollection, log) {
  let created = 0;
  for (const c of COLLECTIONS) {
    const collection = byCollection[c.slug];
    if (!collection) continue;
    const niche = await createNiche({
      slug: c.slug,
      name: c.name,
      description: c.description,
      collectionId: collection.id,
    }).catch(() => null);
    if (!niche) continue;
    await upsertOpportunity({ nicheId: niche.id, score: null });
    created++;
  }
  if (created) log(`[seed] opened ${created} niche(s) for Knowledge Influencers`);
  return created;
}

export async function ensureDefaults({ env = {}, log = console.log } = {}) {
  const byCollection = {};
  for (const c of COLLECTIONS) byCollection[c.slug] = await q.upsertCollection(c);

  let created = 0;
  for (const adapter of ADAPTERS) {
    for (const s of adapter.defaultSources ?? []) {
      const collection = byCollection[s.collection ?? adapter.collection];
      if (!collection) continue;
      const missingEnv = (adapter.needsEnv ?? []).filter((k) => !env[k]);
      const row = await q.insertSource({
        collectionId: collection.id,
        adapter: adapter.name,
        slug: s.slug,
        name: s.name,
        description: s.description ?? adapter.description,
        config: s.config ?? {},
        cadenceMinutes: s.cadenceMinutes ?? adapter.cadenceMinutes,
        enabled: missingEnv.length === 0,
      });
      if (row.created) created++;
    }
  }

  for (const f of DEFAULT_FEEDS) {
    const collection = byCollection[f.collection];
    if (!collection) continue;
    await q.insertFeed({
      collectionId: collection.id,
      slug: f.slug,
      name: f.name,
      description: f.description ?? null,
      query: f.query,
    });
  }
  if (created) log(`[seed] created ${created} default source(s)`);

  /*
   * Anything parked on `unknown adapter` for an adapter this build has is
   * brought forward. That error is written when a container still draining
   * takes the first run of a source the new one just seeded, and because
   * `startRun` pushes `next_run_at` a full cadence out before the lookup
   * fails, the source forfeits its whole slot over a rollout that lasted
   * seconds -- up to a day for the register sources. This is the repair, and
   * it runs here because boot is exactly when the adapter has just appeared.
   */
  const revived = await q.rescheduleKnownAdapters(ADAPTERS.map((a) => a.name));
  if (revived) log(`[seed] brought ${revived} source(s) forward after a rollout`);

  const niches = await ensureNiches(byCollection, log);
  return { created, niches, revived };
}
