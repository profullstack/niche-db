import { aiid } from './aiid.js';
import { alpacaCorporateActions, alpacaNews } from './alpaca.js';
import { firefoxAddons } from './amo.js';
import { arxiv } from './arxiv.js';
import { clinicalTrials } from './clinicaltrials.js';
import { courtlistener } from './courtlistener.js';
import { crates } from './crates.js';
import { crossref } from './crossref.js';
import { ecbFxRates } from './ecb.js';
import { edgar } from './edgar.js';
import { fbiCrimeEstimates } from './fbicrime.js';
import { federalRegister } from './federalregister.js';
import { fueleconomyCatalog } from './fueleconomy.js';
import { gdacs } from './gdacs.js';
import { githubReleases } from './github.js';
import { goModules } from './golang.js';
import { huggingface } from './huggingface.js';
import { igdb } from './igdb.js';
import { launchLibrary } from './launchlibrary.js';
import { lichessBroadcasts } from './lichess.js';
import { mcpRegistry } from './mcpregistry.js';
import { isoMicExchanges } from './mic.js';
import { musicbrainz } from './musicbrainz.js';
import { nasdaqHalts } from './nasdaqhalts.js';
import { nhtsaComplaints, nhtsaRatings, nhtsaRecalls } from './nhtsa.js';
import { npm } from './npm.js';
import { nws } from './nws.js';
import { ocdsTenders } from './ocds.js';
import { openfda } from './openfda.js';
import { openlibrary } from './openlibrary.js';
import { pypi } from './pypi.js';
import { rogueIncidents, rogueResearch } from './rogueaitracker.js';
import { scryfallCards, scryfallSets } from './scryfall.js';
import { socrataCrime } from './socratacrime.js';
import { statuspage } from './statuspage.js';
import { steam, steamNews } from './steam.js';
import { tedNotices } from './ted.js';
import { ukPoliceCrime } from './ukpolice.js';
import { usaspendingAwards } from './usaspending.js';
import { usgs } from './usgs.js';
import { vscodeExtensions } from './vscode.js';

/** Every adapter this deployment knows, in the order the add-source page lists them. */
export const ADAPTERS = [
  steam,
  steamNews,
  igdb,
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
  nasdaqHalts,
  ecbFxRates,
  socrataCrime,
  ukPoliceCrime,
  fbiCrimeEstimates,
  usaspendingAwards,
  ocdsTenders,
  tedNotices,
  musicbrainz,
  openlibrary,
  scryfallSets,
  scryfallCards,
  launchLibrary,
  lichessBroadcasts,
  usgs,
  nws,
  gdacs,
  statuspage,
  firefoxAddons,
  vscodeExtensions,
  mcpRegistry,
  openfda,
  clinicalTrials,
  arxiv,
  crossref,
  fueleconomyCatalog,
  nhtsaRecalls,
  nhtsaComplaints,
  nhtsaRatings,
  rogueIncidents,
  rogueResearch,
  aiid,
];

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
