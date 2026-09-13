import { companyTicker } from './company-ticker.js';
import { githubRepo } from './github.js';
import { npmStats } from './npm.js';
import { opengraph } from './opengraph.js';
import { openlibraryWork } from './openlibrary.js';
import { secCompany } from './sec.js';
import { semanticScholar } from './semanticscholar.js';
import { tmdbArtwork } from './tmdb-artwork.js';
import { wikipedia } from './wikipedia.js';
import { youtube } from './youtube.js';

/** Every enricher, in the order the feed form lists them. */
export const ENRICHERS = [
  youtube,
  wikipedia,
  githubRepo,
  npmStats,
  secCompany,
  companyTicker,
  semanticScholar,
  openlibraryWork,
  opengraph,
  tmdbArtwork,
];

const byName = new Map(ENRICHERS.map((e) => [e.name, e]));
export const enricherByName = (name) => byName.get(String(name)) ?? null;

/** The enrichers a collection turns on unless a feed says otherwise. */
export function defaultEnrichers(collectionSlug) {
  return ENRICHERS.filter((e) => e.collections.includes(collectionSlug)).map((e) => e.name);
}

/** The enrichers that could ever apply to a collection, for the feed form. */
export function enrichersFor(collectionSlug) {
  return ENRICHERS.filter((e) => e.collections.includes(collectionSlug)).map((e) => ({
    name: e.name,
    title: e.title,
    description: e.description,
    needsEnv: e.needsEnv,
  }));
}

export { defineEnricher, searchTitle } from './enricher.js';
