import * as items from '@nichedb/db/reputation';
import * as traffic from '@nichedb/db/traffic';
import { render } from '../lib/http.js';
import { parseIndicator, reputationReport } from '../lib/reputation.js';
import { ReputationPage } from '../views/reputation.jsx';
import { meterLookup } from './traffic.js';

/**
 * Reputation: /reputation, /reputation/<ip-or-domain> and
 * /api/v1/reputation/<ip-or-domain>. One answer from /traffic, abuse.ch and
 * SURBL; metered with the /traffic lookups (one allowance, not two).
 */

const deps = {
  items: (probes) => items.itemsByAdapterIds(probes),
  traffic: (ip) => traffic.lookupIp(ip),
};

export function registerReputation(app) {
  app.get('/reputation', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q) return c.redirect(`/reputation/${encodeURIComponent(q)}`, 303);
    return c.html(await render(<ReputationPage user={c.get('user')} />));
  });

  app.get('/reputation/:q', async (c) => {
    const query = c.req.param('q');
    const user = c.get('user');
    const parsed = parseIndicator(query);
    if (parsed.error)
      return c.html(
        await render(<ReputationPage user={user} query={query} error={parsed.error} />),
        400,
      );
    const blocked = await meterLookup(c);
    if (blocked)
      return c.html(
        await render(<ReputationPage user={user} query={parsed.value} error={blocked} />),
        402,
      );
    const report = await reputationReport(parsed.value, deps);
    return c.html(
      await render(<ReputationPage user={user} query={parsed.value} report={report} />),
    );
  });

  app.get('/api/v1/reputation/:q', async (c) => {
    const parsed = parseIndicator(c.req.param('q'));
    if (parsed.error) return c.json({ error: parsed.error }, 400);
    const blocked = await meterLookup(c);
    if (blocked) return c.json({ error: blocked }, 402);
    return c.json(await reputationReport(parsed.value, deps));
  });
}
