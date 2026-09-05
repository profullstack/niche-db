import { defineEnricher } from './enricher.js';

/** The company behind a filing: tickers, exchange, industry, state, from EDGAR's submissions API. */
export const secCompany = defineEnricher({
  name: 'sec-company',
  title: 'SEC company profile',
  description: 'Ticker, exchange, industry (SIC), state and website of the filer, from EDGAR.',
  collections: ['filings'],
  appliesTo: (item) => item.kind === 'filing' && /^\d{10}$/.test(String(item.data?.cik ?? '')),
  perRun: 60,
  async enrich(item, { http }) {
    const r = await http.jsonOrNull(`https://data.sec.gov/submissions/CIK${item.data.cik}.json`);
    if (!r) return null;
    await Bun.sleep(120);
    const tickers = r.tickers ?? [];
    return {
      name: r.name,
      tickers,
      exchanges: r.exchanges ?? [],
      sic: r.sic || null,
      industry: r.sicDescription || null,
      state: r.stateOfIncorporation || null,
      entityType: r.entityType || null,
      website: r.website || null,
      fiscalYearEnd: r.fiscalYearEnd || null,
      formerNames: (r.formerNames ?? []).slice(0, 3).map((f) => f.name),
      tags: [
        ...tickers.map((t) => t.toLowerCase()),
        r.sicDescription ? r.sicDescription.toLowerCase().slice(0, 40) : null,
        r.stateOfIncorporation ? r.stateOfIncorporation.toLowerCase() : null,
      ].filter(Boolean),
    };
  },
});
