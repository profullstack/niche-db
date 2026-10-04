import * as q from '@nichedb/db/queries';
import { crawlStatusOut } from '../lib/crawlstatus.js';
import { cached, render, wantsJson } from '../lib/http.js';
import { CrawlStatusPage } from '../views/crawlstatus.jsx';

/**
 * The crawler status board. /crawlstatus is the address the footer and the
 * sister sites link; /crawlstats is what rssamplifier and p0dcasters call
 * theirs, so it redirects here rather than 404.
 *
 * Cached for the usual short TTL like any public page: a minute stale is fine
 * for a board whose stall threshold is two hours, and it keeps a refresh-happy
 * reader from re-running six aggregates a second.
 */
export function registerCrawlStatus(app, deps = {}) {
  const read = deps.read ?? (() => q.crawlStatus());

  app.get('/crawlstatus', async (c) => {
    if (wantsJson(c)) return c.json(crawlStatusOut(await read()));
    return cached(c, 'crawlstatus', async () =>
      render(<CrawlStatusPage user={c.get('user')} status={await read()} />),
    );
  });
  app.get('/crawlstats', (c) => c.redirect('/crawlstatus', 301));
  app.get('/api/v1/crawlstatus', async (c) => c.json(crawlStatusOut(await read())));
}
