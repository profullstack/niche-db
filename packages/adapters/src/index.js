import { adsbFlights } from './adsb.js';
import { agenticjobs } from './agenticjobs.js';
import { aiid } from './aiid.js';
import { aiornot } from './aiornot.js';
import { alpacaCorporateActions, alpacaNews } from './alpaca.js';
import { firefoxAddons } from './amo.js';
import { anilistAiring } from './anilist.js';
import { arxiv } from './arxiv.js';
import { aviationHazards, aviationMetar } from './aviationweather.js';
import { bensbargains } from './bensbargains.js';
import { bl0ggers } from './bl0ggers.js';
import { blsSeries } from './bls.js';
import { brisk } from './brisk.js';
import { cfpbComplaints } from './cfpb.js';
import { channels } from './channels.js';
import { clinicalTrials } from './clinicaltrials.js';
import { coopsWaterLevels } from './coops.js';
import { courtlistener } from './courtlistener.js';
import { crates } from './crates.js';
import { crossref } from './crossref.js';
import { coingeckoAssets, cryptoPairs } from './crypto.js';
import { d0rz } from './d0rz.js';
import { dealcatcher } from './dealcatcher.js';
import { dealnews } from './dealnews.js';
import { digitaloceanSizes } from './digitalocean.js';
import { droughtMonitor } from './droughtmonitor.js';
import { ecbFxRates } from './ecb.js';
import { edgar } from './edgar.js';
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
import { githubReleases } from './github.js';
import { goModules } from './golang.js';
import { hetznerPlans } from './hetzner.js';
import { huggingface } from './huggingface.js';
import { igdb } from './igdb.js';
import { igdbCatalog } from './igdb-catalog.js';
import { imdbRatings } from './imdb.js';
import { landRegistrySales } from './landregistry.js';
import { launchLibrary } from './launchlibrary.js';
import { lichessBroadcasts } from './lichess.js';
import { linodeTypes } from './linode.js';
import { livetennis } from './livetennis.js';
import { lowendbox } from './lowendbox.js';
import { mcpRegistry } from './mcpregistry.js';
import { isoMicExchanges } from './mic.js';
import { musicbrainz } from './musicbrainz.js';
import { nasdaqHalts } from './nasdaqhalts.js';
import { ndbcBuoys } from './ndbc.js';
import { newsChannels } from './newschannels.js';
import { newsfeed } from './newsfeed.js';
import { nhcCyclones } from './nhc.js';
import { nhtsaComplaints, nhtsaRatings, nhtsaRecalls } from './nhtsa.js';
import { npm } from './npm.js';
import { ntldChanges, ntldLaunches, ntldTlds, ntldTotals } from './ntlddata.js';
import { ntsbAccidents } from './ntsb.js';
import { nwpsRiverGauges } from './nwps.js';
import { nws } from './nws.js';
import { ocdsTenders } from './ocds.js';
import { openfda } from './openfda.js';
import { openlibrary } from './openlibrary.js';
import { openprofiles } from './openprofiles.js';
import { opensaas } from './opensaas.js';
import { openserver } from './openserver.js';
import { opensite } from './opensite.js';
import { openthreat } from './openthreat.js';
import { outreachgraph } from './outreachgraph.js';
import { ovhVps } from './ovh.js';
import { p0dcasters } from './p0dcasters.js';
import { buildingPermits } from './permits.js';
import { podcasts } from './podcasts.js';
import { pypi } from './pypi.js';
import { redditDeals } from './redditdeals.js';
import { rogueIncidents, rogueResearch } from './rogueaitracker.js';
import { rssamplifier } from './rssamplifier.js';
import { saasrow } from './saasrow.js';
import { scalewayInstances } from './scaleway.js';
import { scryfallCards, scryfallSets } from './scryfall.js';
import { slickdeals } from './slickdeals.js';
import { socrataCrime } from './socratacrime.js';
import { sportarrPersons } from './sportarr-persons.js';
import { sportsdbTv } from './sportsdb.js';
import { sportsdbLeagues } from './sportsdb-leagues.js';
import { statuspage } from './statuspage.js';
import { steam, steamNews } from './steam.js';
import { storefront } from './storefront.js';
import { nwsSurfZone } from './surfzone.js';
import { swpcSpaceWeather } from './swpc.js';
import { tedNotices } from './ted.js';
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

/** Every adapter this deployment knows, in the order the add-source page lists them. */
export const ADAPTERS = [
  steam,
  steamNews,
  igdb,
  igdbCatalog,
  npm,
  pypi,
  crates,
  goModules,
  huggingface,
  githubReleases,
  edgar,
  federalRegister,
  courtlistener,
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
  mcpRegistry,
  openfda,
  clinicalTrials,
  arxiv,
  crossref,
  blsSeries,
  eurostat,
  warnLayoffs,
  landRegistrySales,
  freddieMacRates,
  buildingPermits,
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
  sportarrPersons,
  // Screen: films, TV and anime, and the IMDb ratings behind 400k titles.
  tmdbReleases,
  tvmazeSchedule,
  tvmazeCatalog,
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
  aiornot,
  agenticjobs,
  tsbb,
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
  // SaaS: the way in and the way out of a service's plans, read off its own OpenSaaS descriptor.
  opensaas,
  // People: one entry per person, read off the apps that serve their OpenProfile.md.
  openprofiles,
  opensite,
  outreachgraph,
];

export { isPlatformHosted, PLATFORM_HOSTS } from './podcastplatforms.js';
export { normaliseTitle, normTitleOrNull, titleKey } from './screen-titles.js';
/**
 * The place lists two adapters seed their sources from, re-exported so the
 * seed can build a feed per city from the same list rather than a second copy
 * of it that drifts the first time a city is added to one and not the other.
 */
export { CITIES as CRIME_CITIES } from './socratacrime.js';
export { UK_PLACES as UK_CRIME_PLACES } from './ukpolice.js';

const byName = new Map(ADAPTERS.map((a) => [a.name, a]));

export function adapterByName(name) {
  return byName.get(String(name)) ?? null;
}
