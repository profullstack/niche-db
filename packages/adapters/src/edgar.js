import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/**
 * SEC EDGAR's "latest filings" Atom feed, per form type, keyless. The SEC asks
 * every client to identify itself in the User-Agent (name and email), which the
 * core's HTTP helper does from CONTACT_EMAIL.
 */

export const FORMS = {
  D: 'Form D: exempt offerings (who raised money)',
  4: 'Form 4: insider transactions',
  '8-K': '8-K: material events',
  'S-1': 'S-1: IPO registrations',
  'F-1': 'F-1: foreign IPO registrations',
  '13F-HR': '13F: institutional holdings',
  '10-K': '10-K: annual reports',
  '10-Q': '10-Q: quarterly reports',
  'SC 13D': 'Schedule 13D: 5%+ activist stakes',
  'SC 13G': 'Schedule 13G: 5%+ passive stakes',
};

/** "D - Balto Series, a series of Legacy Knight (0002153540) (Filer)" */
export function parseTitle(title) {
  const m = String(title).match(/^(.+?) - (.+?) \((\d{10})\) \((\w+)\)\s*$/);
  if (!m) return { form: null, company: title, cik: null, role: null };
  return { form: m[1].trim(), company: m[2].trim(), cik: m[3], role: m[4] };
}

export function parseFeed(xml) {
  const out = [];
  for (const e of xmlItems(xml, 'entry')) {
    const id = first(e.id)?.text ?? '';
    const acc = id.match(/accession-number=([\d-]+)/)?.[1];
    if (!acc) continue;
    const { form, company, cik, role } = parseTitle(first(e.title)?.text ?? '');
    const summary = stripHtml(first(e.summary)?.text ?? '');
    const filed = summary.match(/Filed:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
    const size = summary.match(/Size:\s*([\d.]+ ?[KMG]?B)/)?.[1] ?? null;
    const link = Array.isArray(e.link) ? e.link[0] : e.link;
    const term = first(e.category)?.attrs?.term ?? form;
    out.push({
      externalId: acc,
      kind: 'filing',
      title: `${term ?? form ?? '?'}: ${company}`,
      summary: summary.replace(/^Filed:.*?(Size:\s*\S+ ?\S*)?\s*/, '').trim() || null,
      url:
        link?.attrs?.href ??
        `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/`,
      publishedAt: first(e.updated)?.text ?? null,
      tags: [
        'edgar',
        String(term ?? form ?? '').toLowerCase(),
        role ? role.toLowerCase() : null,
      ].filter(Boolean),
      data: { form: term ?? form, company, cik, role, accession: acc, filed, size },
    });
  }
  return out;
}

export const edgar = defineAdapter({
  name: 'edgar',
  title: 'SEC EDGAR filings',
  collection: 'filings',
  description:
    "The SEC's latest-filings feed for one or more form types, as they are accepted. Keyless. Set CONTACT_EMAIL on the deployment: the SEC requires every client to say who it is.",
  docs: 'https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data',
  kinds: ['filing'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'forms',
      label: 'Form types',
      type: 'list',
      required: true,
      placeholder: 'D, 4, 8-K',
      help: Object.entries(FORMS)
        .map(([k, v]) => `${k}: ${v}`)
        .join('. '),
    },
  ],
  defaults: { forms: ['D'] },
  defaultSources: [
    { slug: 'edgar-form-d', name: 'EDGAR: Form D (raises)', config: { forms: ['D', 'D/A'] } },
    { slug: 'edgar-form-4', name: 'EDGAR: Form 4 (insider trades)', config: { forms: ['4'] } },
    { slug: 'edgar-8k', name: 'EDGAR: 8-K (material events)', config: { forms: ['8-K'] } },
    {
      slug: 'edgar-s1',
      name: 'EDGAR: S-1 and F-1 (IPOs)',
      config: { forms: ['S-1', 'F-1'] },
      cadenceMinutes: 30,
    },
    {
      slug: 'edgar-13d',
      name: 'EDGAR: 13D and 13G (5% stakes)',
      config: { forms: ['SC 13D', 'SC 13G'] },
      cadenceMinutes: 30,
    },
  ],
  async pull({ config, http, log, deadline }) {
    const forms = (
      Array.isArray(config.forms) ? config.forms : String(config.forms ?? '').split(',')
    )
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 10);
    const items = [];
    for (const form of forms) {
      if (Date.now() > deadline) break;
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&count=100&output=atom`;
      const xml = await http.text(url, { headers: { accept: 'application/atom+xml, text/xml' } });
      const parsed = parseFeed(xml);
      items.push(...parsed);
      await Bun.sleep(150);
    }
    log(`${forms.join(', ')}: ${items.length} filing(s)`);
    return { items, note: `${items.length} filings across ${forms.length} form type(s)` };
  },
});
