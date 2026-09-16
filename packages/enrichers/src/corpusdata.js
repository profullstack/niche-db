import { matchCorpusArticles } from './corpusdata-match.js';
import { defineEnricher, searchTitle } from './enricher.js';

/**
 * CorpusData does not expose a supported API. Keep the enrichment honest: add
 * a stable NOW Corpus lookup for the item's main term, rather than scraping
 * the interactive site or inventing frequency values.
 */
export const corpusdata = defineEnricher({
  name: 'corpusdata',
  title: 'CorpusData',
  description: 'A NOW Corpus lookup for the item title or primary term.',
  collections: ['news', 'research', 'books', 'ai-media', 'packages'],
  appliesTo: (item) => Boolean(searchTitle(item)),
  perRun: 100,
  async enrich(item) {
    const query = searchTitle(item);
    if (!query) return null;
    const articles = item.data?.corpusdata?.articles;
    if (Array.isArray(articles)) {
      const match = matchCorpusArticles(item, articles);
      return match
        ? {
            corpus: 'NOW',
            match: match.article,
            confidence: match.confidence,
            reasons: match.reasons,
            source: 'https://www.corpusdata.org/now_corpus.asp',
          }
        : null;
    }
    return {
      corpus: 'NOW',
      query,
      url: 'https://www.english-corpora.org/now/',
      source: 'https://www.corpusdata.org/now_corpus.asp',
      note: 'CorpusData provides interactive lookup and monthly downloadable updates; it has no supported live API.',
    };
  },
});
