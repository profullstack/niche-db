import { aiid } from './aiid.js';
import { firefoxAddons } from './amo.js';
import { arxiv } from './arxiv.js';
import { clinicalTrials } from './clinicaltrials.js';
import { courtlistener } from './courtlistener.js';
import { crates } from './crates.js';
import { crossref } from './crossref.js';
import { edgar } from './edgar.js';
import { eonetEvents } from './eonet.js';
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
import { musicbrainz } from './musicbrainz.js';
import { nhcCyclones } from './nhc.js';
import { nhtsaComplaints, nhtsaRatings, nhtsaRecalls } from './nhtsa.js';
import { npm } from './npm.js';
import { nws } from './nws.js';
import { openfda } from './openfda.js';
import { openlibrary } from './openlibrary.js';
import { pypi } from './pypi.js';
import { rogueIncidents, rogueResearch } from './rogueaitracker.js';
import { scryfallCards, scryfallSets } from './scryfall.js';
import { statuspage } from './statuspage.js';
import { steam, steamNews } from './steam.js';
import { swpcSpaceWeather } from './swpc.js';
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

const byName = new Map(ADAPTERS.map((a) => [a.name, a]));

export function adapterByName(name) {
  return byName.get(String(name)) ?? null;
}
