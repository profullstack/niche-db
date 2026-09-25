import { adsbFlights } from './adsb.js';
import { agenticjobs } from './agenticjobs.js';
import { aiid } from './aiid.js';
import { aiornot } from './aiornot.js';
import {
  aitmplAgents,
  aitmplCommands,
  aitmplComponents,
  aitmplHooks,
  aitmplMcps,
  aitmplSkills,
} from './aitmpl.js';
import { alpacaCorporateActions, alpacaNews } from './alpaca.js';
import { firefoxAddons } from './amo.js';
import { anilistAiring } from './anilist.js';
import { arxiv } from './arxiv.js';
import { aviationHazards, aviationMetar } from './aviationweather.js';
import { awesomeAgents } from './awesomeagents.js';
import { awesomeClaudeCode, awesomeClaudeCodeSkills } from './awesomeclaudecode.js';
import { awesomeMcp } from './awesomemcp.js';
import { bensbargains } from './bensbargains.js';
import { bittorrentedDht } from './bittorrented.js';
import { bl0ggers } from './bl0ggers.js';
import { blsSeries } from './bls.js';
import { brisk } from './brisk.js';
import { buyvps } from './buyvps.js';
import { c0upons } from './c0upons.js';
import { cfpbComplaints } from './cfpb.js';
import { channels } from './channels.js';
import { clinicalTrials } from './clinicaltrials.js';
import { coopsWaterLevels } from './coops.js';
import { courtlistener, courtlistenerApi, courtlistenerOralArguments } from './courtlistener.js';
import { courtlistenerCatalog } from './courtlistener-catalog.js';
import { cpscRecalls } from './cpsc.js';
import { crates } from './crates.js';
import { crossref } from './crossref.js';
import { coingeckoAssets, cryptoPairs } from './crypto.js';
import { d0rz } from './d0rz.js';
import { dealcatcher } from './dealcatcher.js';
import { dealnews } from './dealnews.js';
import { digitaloceanSizes } from './digitalocean.js';
import { discogsCatalog } from './discogs-catalog.js';
import { dockerMcp } from './dockermcp.js';
import { droughtMonitor } from './droughtmonitor.js';
import { ecbFxRates } from './ecb.js';
import { edgar } from './edgar.js';
import { energyStarModels } from './energystar.js';
import { eonetEvents } from './eonet.js';
import { alpacaAssets, equityHistory, secFundamentals } from './equities.js';
import { espnCatalogue, espnLive, espnSchedule } from './espn.js';
import { espnPlays } from './espnplays.js';
import { eurostat } from './eurostat.js';
import { faaAirportStatus } from './faanas.js';
import { fbiCrimeEstimates } from './fbicrime.js';
import { fdicInstitutions, fdicStructureChanges } from './fdic.js';
import { federalRegister } from './federalregister.js';
import { findhost } from './findhost.js';
import { freddieMacRates } from './freddiemac.js';
import { fueleconomyCatalog } from './fueleconomy.js';
import { gdacs } from './gdacs.js';
import { gdelt } from './gdelt.js';
import { githubAgentTopics, githubMcpTopics } from './ghtopics.js';
import { githubReleases } from './github.js';
import { goModules } from './golang.js';
import { gutenbergCatalog } from './gutenberg-catalog.js';
import { hetznerPlans } from './hetzner.js';
import { huggingface } from './huggingface.js';
import { igdb } from './igdb.js';
import { igdbCatalog } from './igdb-catalog.js';
import { imdbRatings } from './imdb.js';
import { kitsuAnime } from './kitsu-anime.js';
import { landRegistrySales } from './landregistry.js';
import { launchLibrary } from './launchlibrary.js';
import { librivoxCatalog } from './librivox-catalog.js';
import { lichessBroadcasts } from './lichess.js';
import { linodeTypes } from './linode.js';
import { livetennis } from './livetennis.js';
import { lowendbox } from './lowendbox.js';
import { mcpRegistry } from './mcpregistry.js';
import { isoMicExchanges } from './mic.js';
import { modelsdev } from './modelsdev.js';
import { musicbrainz } from './musicbrainz.js';
import { musicbrainzCatalog } from './musicbrainz-catalog.js';
import { nasdaqHalts } from './nasdaqhalts.js';
import { ndbcBuoys } from './ndbc.js';
import { newsChannels } from './newschannels.js';
import { newsfeed } from './newsfeed.js';
import { nhcCyclones } from './nhc.js';
import { nhtsaComplaints, nhtsaRatings, nhtsaRecalls } from './nhtsa.js';
import { nistCsrcDrafts } from './nist-csrc.js';
import { nistDads } from './nist-dads.js';
import { nistDatasets } from './nist-data.js';
import { npm } from './npm.js';
import { ntldChanges, ntldLaunches, ntldTlds, ntldTotals } from './ntlddata.js';
import { ntsbAccidents } from './ntsb.js';
import { nvd } from './nvd.js';
import { nwpsRiverGauges } from './nwps.js';
import { nws } from './nws.js';
import { ocdsTenders } from './ocds.js';
import { openalex } from './openalex.js';
import { openfda } from './openfda.js';
import { openlibrary } from './openlibrary.js';
import { openlibraryCatalog } from './openlibrary-catalog.js';
import { openmodel } from './openmodel.js';
import { openprofiles } from './openprofiles.js';
import { opensaas } from './opensaas.js';
import { openserver } from './openserver.js';
import { opensite } from './opensite.js';
import { openthreat } from './openthreat.js';
import { openwebring } from './openwebring.js';
import { outreachgraph } from './outreachgraph.js';
import { ovhVps } from './ovh.js';
import { p0dcasters } from './p0dcasters.js';
import { buildingPermits } from './permits.js';
import { pluginMarketplaces } from './pluginmarketplaces.js';
import { podcastindexCatalog } from './podcastindex-catalog.js';
import { podcasts } from './podcasts.js';
import { policeUpdates } from './police-updates.js';
import { proscanDirectory } from './proscan.js';
import { pwcArchive } from './pwc-archive.js';
import { pypi } from './pypi.js';
import { redditDeals } from './redditdeals.js';
import { redditWorkflows } from './redditworkflows.js';
import { rogueIncidents, rogueResearch } from './rogueaitracker.js';
import { rosettaCode } from './rosetta-code.js';
import { rssamplifier } from './rssamplifier.js';
import { ruuster } from './ruuster.js';
import { saasrow } from './saasrow.js';
import { scalewayInstances } from './scaleway.js';
import { scannerDirectory } from './scanners.js';
import { scryfallCards, scryfallSets } from './scryfall.js';
import { slickdeals } from './slickdeals.js';
import { smithery } from './smithery.js';
import { socrataCrime } from './socratacrime.js';
import { sportarrPersons } from './sportarr-persons.js';
import { sportsdbTv } from './sportsdb.js';
import { sportsdbLeagues } from './sportsdb-leagues.js';
import { sportsdbLive } from './sportsdb-live.js';
import { sportsdbPlayers } from './sportsdb-players.js';
import { sportsdbTeams } from './sportsdb-teams.js';
import { statuspage } from './statuspage.js';
import { steam, steamNews } from './steam.js';
import { steamCatalog } from './steam-catalog.js';
import { storefront } from './storefront.js';
import { surbl } from './surbl.js';
import { nwsSurfZone } from './surfzone.js';
import { swpcSpaceWeather } from './swpc.js';
import { tedNotices } from './ted.js';
import { theAlgorithms } from './thealgorithms.js';
import { thetvdbCatalog } from './thetvdb-catalog.js';
import { tmdbReleases } from './tmdb.js';
import { tsbb } from './tsbb.js';
import { tvmazeSchedule } from './tvmaze.js';
import { tvmazeCatalog } from './tvmaze-catalog.js';
import { ukPoliceCrime } from './ukpolice.js';
import { upcloudPlans } from './upcloud.js';
import { usaspendingAwards } from './usaspending.js';
import { usgs } from './usgs.js';
import { vscodeExtensions } from './vscode.js';
import { vultrPlans } from './vultr.js';
import { warnLayoffs } from './warn.js';
import { wikidataAlgorithms } from './wikidata-algorithms.js';
import { wikidataFilms } from './wikidata-films.js';
import { wikidataGames } from './wikidata-games.js';

/** Every adapter this deployment knows, in the order the add-source page lists them. */
export const ADAPTERS = [
  steam,
  steamNews,
  igdb,
  igdbCatalog,
  wikidataFilms,
  wikidataGames,
  sportsdbTeams,
  sportsdbPlayers,
  kitsuAnime,
  gutenbergCatalog,
  librivoxCatalog,
  steamCatalog,
  npm,
  pypi,
  crates,
  goModules,
  huggingface,
  githubReleases,
  edgar,
  federalRegister,
  // Law: CourtListener's feeds and API for what is new, and its bulk dumps for the rest.
  courtlistener,
  courtlistenerOralArguments,
  courtlistenerApi,
  courtlistenerCatalog,
  isoMicExchanges,
  alpacaCorporateActions,
  alpacaNews,
  alpacaAssets,
  equityHistory,
  secFundamentals,
  coingeckoAssets,
  cryptoPairs,
  nasdaqHalts,
  ecbFxRates,
  socrataCrime,
  policeUpdates,
  scannerDirectory,
  proscanDirectory,
  ukPoliceCrime,
  fbiCrimeEstimates,
  usaspendingAwards,
  ocdsTenders,
  tedNotices,
  newsfeed,
  gdelt,
  rssamplifier,
  brisk,
  newsChannels,
  musicbrainz,
  openlibrary,
  scryfallSets,
  scryfallCards,
  launchLibrary,
  lichessBroadcasts,
  usgs,
  gdacs,
  nws,
  nhcCyclones,
  swpcSpaceWeather,
  eonetEvents,
  faaAirportStatus,
  aviationHazards,
  aviationMetar,
  ntsbAccidents,
  adsbFlights,
  nwpsRiverGauges,
  coopsWaterLevels,
  droughtMonitor,
  ndbcBuoys,
  nwsSurfZone,
  cfpbComplaints,
  fdicInstitutions,
  fdicStructureChanges,
  // Deals: what is on sale and which codes work, from the communities and desks that publish feeds.
  slickdeals,
  dealnews,
  dealcatcher,
  bensbargains,
  redditDeals,
  statuspage,
  firefoxAddons,
  vscodeExtensions,
  /*
   * MCP servers. The registry runs first on purpose: the collection drops an
   * item whose URL another source already carries, so the order these are
   * listed in is the order in which a duplicate server's account of itself is
   * decided. Published beats packaged beats curated beats tagged.
   */
  mcpRegistry,
  dockerMcp,
  smithery,
  awesomeMcp,
  aitmplMcps,
  githubMcpTopics,
  /*
   * Agent workflows, and the four things people install, each in the
   * collection somebody looking for one would open: skills, subagents, slash
   * commands, hooks and plugins. Curated lists before bulk catalogues, for
   * the same reason as above.
   */
  redditWorkflows,
  awesomeClaudeCode,
  aitmplComponents,
  githubAgentTopics,
  awesomeClaudeCodeSkills,
  aitmplSkills,
  awesomeAgents,
  aitmplAgents,
  aitmplCommands,
  aitmplHooks,
  pluginMarketplaces,
  openfda,
  clinicalTrials,
  arxiv,
  crossref,
  // NIST: the datasets it publishes and the security drafts it has out for comment.
  nistDatasets,
  nistCsrcDrafts,
  blsSeries,
  eurostat,
  warnLayoffs,
  landRegistrySales,
  freddieMacRates,
  buildingPermits,
  ruuster,
  fueleconomyCatalog,
  nhtsaRecalls,
  nhtsaComplaints,
  nhtsaRatings,
  rogueIncidents,
  rogueResearch,
  aiid,
  ntldTotals,
  ntldTlds,
  ntldLaunches,
  ntldChanges,
  podcasts,
  // Sports: every league, team and fixture ESPN publishes, and tennis by tour.
  espnCatalogue,
  espnSchedule,
  espnLive,
  espnPlays,
  livetennis,
  sportsdbTv,
  sportsdbLeagues,
  sportsdbLive,
  sportarrPersons,
  // Screen: films, TV and anime, and the IMDb ratings behind 400k titles.
  tmdbReleases,
  tvmazeSchedule,
  tvmazeCatalog,
  thetvdbCatalog,
  musicbrainzCatalog,
  openlibraryCatalog,
  podcastindexCatalog,
  discogsCatalog,
  anilistAiring,
  imdbRatings,
  // Channels: the whole iptv-org directory, for matching a playlist by name.
  channels,
  // House aggregators: the directories, boards and marketplaces we run, read
  // from their own public feeds and APIs.
  p0dcasters,
  saasrow,
  d0rz,
  bl0ggers,
  buyvps,
  aiornot,
  agenticjobs,
  tsbb,
  c0upons,
  // Hosting: who sells servers, at what price, and the deals the small ones announce.
  findhost,
  vultrPlans,
  linodeTypes,
  scalewayInstances,
  ovhVps,
  hetznerPlans,
  digitaloceanSizes,
  upcloudPlans,
  storefront,
  lowendbox,
  openserver,
  // Threats: what OpenThreat reporters found in the open, read off each one's own descriptor.
  openthreat,
  // The NVD's CVE catalogue, and SURBL's lists with watched domains checked against them.
  nvd,
  surbl,
  // Webrings: the rings a host runs and who is in them, read off the host's own descriptor.
  openwebring,
  // SaaS: the way in and the way out of a service's plans, read off its own OpenSaaS descriptor.
  opensaas,
  // People: one entry per person, read off the apps that serve their OpenProfile.md.
  openprofiles,
  opensite,
  outreachgraph,
  bittorrentedDht,
  // Research: OpenAlex works, newest first, under a topic or a search.
  openalex,
  // Algorithms: the NIST dictionary, Wikidata's algorithms and data structures, the Papers With Code
  // archive, Rosetta Code's tasks and The Algorithms' implementations.
  nistDads,
  wikidataAlgorithms,
  pwcArchive,
  rosettaCode,
  theAlgorithms,
  // Models: every AI model and what each provider charges, from models.dev, and
  // the same rows served by a provider itself as an OpenModel descriptor.
  modelsdev,
  openmodel,
  // Parts: the appliance models a part has to fit, and the recalls against them.
  energyStarModels,
  cpscRecalls,
];

/**
 * The place lists two adapters seed their sources from, re-exported so the
 * seed can build a feed per city from the same list rather than a second copy
 * of it that drifts the first time a city is added to one and not the other.
 */
export { CATALOGUES as ENERGYSTAR_CATALOGUES } from './energystar.js';
export { isPlatformHosted, PLATFORM_HOSTS } from './podcastplatforms.js';
export { normaliseTitle, normTitleOrNull, titleKey } from './screen-titles.js';
export { CITIES as CRIME_CITIES } from './socratacrime.js';
export { UK_PLACES as UK_CRIME_PLACES } from './ukpolice.js';

const byName = new Map(ADAPTERS.map((a) => [a.name, a]));

export function adapterByName(name) {
  return byName.get(String(name)) ?? null;
}

export { POLICE_CITIES, POLICE_SCOPE } from './police-updates.js';
