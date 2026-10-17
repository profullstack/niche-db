import { config } from '@nichedb/config';
import * as q from '@nichedb/db/queries';
import { callerAddress } from '../lib/auth-throttle.js';
import {
  businessReport,
  cachedReport,
  hasInput,
  normaliseInput,
  OFAC_SEARCH,
  rdapLookup as rdap,
} from '../lib/business.js';
import { render } from '../lib/http.js';
import { BusinessPage } from '../views/business.jsx';

/**
 * The business standing endpoints: /business and /api/v1/business.
 *
 * Metered the way the VIN lookups are, for the same reason: each report is
 * half a dozen live round trips to other people's services. A few an hour are
 * free; a crawl pass or Premium covers the rest. The same question asked again
 * within the hour is answered from the cache and costs nothing.
 */

const inputFrom = (c) =>
  normaliseInput({
    name: c.req.query('name') ?? c.req.query('q'),
    domain: c.req.query('domain'),
    ein: c.req.query('ein'),
    state: c.req.query('state'),
    number: c.req.query('number'),
  });

/** Count a stranger's report against the hour; null when it may go ahead. */
async function meter(c, input) {
  if (c.get('modules')?.paid) return null;
  const charge = !cachedReport(input);
  const bucket = `business:${c.get('user')?.id ?? callerAddress(c) ?? 'unknown'}`;
  const used = charge
    ? await q.bumpApiUsage(bucket).catch(() => 0)
    : await q.apiUsage(bucket).catch(() => 0);
  const limit = config.business.freeLookupsPerHour;
  c.header('x-business-limit', String(limit));
  c.header('x-business-remaining', String(Math.max(0, limit - used)));
  return used <= limit ? null : limit;
}

const priced = () => ({
  day: { cents: config.premium.dayCents, get: `${config.siteUrl}/api/v1/crawl-pass` },
  month: { cents: config.premium.monthCents, get: `${config.siteUrl}/premium` },
  note: 'A crawl pass is bought over x402 and presented as `x-crawl-pass`. Premium and Pro include these reports for the term.',
});

export function registerBusiness(app) {
  app.get('/business', async (c) => {
    const input = inputFrom(c);
    let report = null;
    let error = null;
    if (hasInput(input)) {
      const limit = await meter(c, input);
      if (limit) {
        error = `${limit} free reports an hour are used up. Premium is $${(config.premium.dayCents / 100).toFixed(2)} a day or $${(config.premium.monthCents / 100).toFixed(0)} a month and includes them.`;
      } else {
        report = await businessReport(input, { rdap }).catch((err) => {
          error = err.message;
          return null;
        });
      }
    }
    return c.html(
      await render(
        <BusinessPage user={c.get('user')} input={input} report={report} error={error} />,
      ),
    );
  });

  app.get('/api/v1/business', async (c) => {
    const input = inputFrom(c);
    if (!hasInput(input))
      return c.json(
        {
          name: 'Business standing',
          description:
            'Where one business stands on the lists a bank, a customer or a mail server checks: OFAC sanctions, GLEIF and SEC EDGAR registrations, state registry status and federal exclusions where keys are configured, and its domain over RDAP and the mail reputation lists.',
          usage: `${config.siteUrl}/api/v1/business?name=&domain=&ein=&state=&number=`,
          params: {
            name: 'The company name (q is accepted too).',
            domain: 'Its website or mail domain.',
            ein: 'Its US EIN; kept to identify it, never checked (there is no public EIN register).',
            state: 'Two-letter US state of registration.',
            number: 'The state entity number, e.g. 4218574 or C4218574.',
          },
          metered: { freePerHour: config.business.freeLookupsPerHour, pricing: priced() },
          configured: {
            blocklists: config.business.blocklists,
            spamhausDqs: Boolean(config.business.spamhausDqsKey),
            opencorporates: Boolean(config.business.openCorporatesToken),
            sam: Boolean(config.business.samApiKey),
          },
          sources: [
            {
              name: 'US Treasury OFAC',
              use: 'sanctions',
              licence: 'US public domain',
              selfCheck: OFAC_SEARCH,
            },
            { name: 'GLEIF', use: 'legal entity identifiers', licence: 'CC0' },
            { name: 'SEC EDGAR', use: 'filers', licence: 'US public domain' },
            { name: 'OpenCorporates', use: 'state registry status', licence: 'ODbL, keyed' },
            { name: 'SAM.gov', use: 'federal exclusions', licence: 'US public domain, keyed' },
            { name: 'RDAP', use: 'domain registration', licence: 'registry data' },
            {
              name: 'Spamhaus, URIBL, SURBL, Google Safe Browsing',
              use: 'domain and server reputation',
              licence: 'per each list’s terms; off unless BUSINESS_BLOCKLISTS is set',
            },
          ],
        },
        400,
      );
    const limit = await meter(c, input);
    if (limit)
      return c.json(
        {
          error: `${limit} business reports an hour are free. Past that a report needs a pass.`,
          pricing: priced(),
        },
        402,
      );
    try {
      return c.json(await businessReport(input, { rdap }));
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });
}
