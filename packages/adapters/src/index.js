import { courtlistener } from './courtlistener.js';
import { crates } from './crates.js';
import { edgar } from './edgar.js';
import { federalRegister } from './federalregister.js';
import { githubReleases } from './github.js';
import { huggingface } from './huggingface.js';
import { igdb } from './igdb.js';
import { npm } from './npm.js';
import { pypi } from './pypi.js';
import { steam, steamNews } from './steam.js';

/** Every adapter this deployment knows, in the order the add-source page lists them. */
export const ADAPTERS = [
  steam,
  steamNews,
  igdb,
  npm,
  pypi,
  crates,
  huggingface,
  githubReleases,
  edgar,
  federalRegister,
  courtlistener,
];

const byName = new Map(ADAPTERS.map((a) => [a.name, a]));

export function adapterByName(name) {
  return byName.get(String(name)) ?? null;
}
