import { config } from '@nichedb/config';
import { Hono } from 'hono';
import { loadUser, render, wantsJson } from './lib/http.js';
import { leaderboard } from './lib/leaderboard.js';
import { modulesFor, withModules } from './lib/modules.js';
import { partners } from './lib/partners.js';
import { loadPlan } from './lib/premium.js';
import { gateway, gatewayFor } from './lib/pricing.js';
import { Denied } from './lib/service.js';
import { meter } from './lib/throttle.js';
import { registerAgents } from './routes/agents.js';
import { registerApi } from './routes/api.js';
import { registerAuth } from './routes/auth.js';
import { registerAutomotive } from './routes/automotive.js';
import { registerKnowledge } from './routes/knowledge.js';
import { registerManage } from './routes/manage.js';
import { registerMcp } from './routes/mcp.js';
import { registerPages } from './routes/pages.js';
import { registerPremium } from './routes/premium.js';
import { registerRevenue } from './routes/revenue.js';
import { registerStatic } from './routes/static.js';
import { NotFound } from './views/pages.jsx';

export const app = new Hono();

/**
 * Crawlers that are not welcome at all: brand-monitoring bots that ignore
 * robots.txt. 403 rather than 429, because there is no wait that makes this allowed.
 */
const BLOCKED_AGENTS = ['awariobot'];
app.use('*', async (c, next) => {
  const ua = (c.req.header('user-agent') ?? '').toLowerCase();
  if (BLOCKED_AGENTS.some((bot) => ua.includes(bot)))
    return c.text('Not available to this crawler.', 403);
  return next();
});

/**
 * Training crawlers pay by the day (@profullstack/x402-gateway). People, search
 * engines and retrieval crawlers pass through untouched. The machine surfaces
 * an agent needs in order to USE the data rather than copy it stay open.
 *
 * The price is the buyer's own: a dollar a day at list, less the more it has
 * spent here (lib/pricing.js), so the gateway is chosen per request.
 */
export { gateway };

app.use('*', async (c, next) => {
  const { gateway: chosen } = await gatewayFor(c.req.raw);
  const answer = await chosen.handle(c.req.raw);
  if (answer) return answer;

  /*
   * Then the site-wide allowance (lib/throttle.js), which meters every route:
   * 100 requests a minute per caller, answered 402 at this buyer's own price
   * rather than 429. The gate above sells to crawlers that say who they are;
   * this sells to the ones that do not, and nothing counted a page route
   * before it.
   */
  const overLimit = await meter(chosen, c.req.raw);
  if (overLimit) return overLimit;

  await next();
});

app.use('*', loadUser);

/**
 * The public board: partners earning on one side, agents spending on the
 * other, kept apart. Serves its own pages, JSON, RSS, per-player share cards
 * and the embed widget under /leaderboard.
 */
app.use('*', async (c, next) => {
  const answer = await leaderboard.handle(c.req.raw);
  return answer ?? next();
});

/**
 * The seller side: where the people whose writing is in this index sign up,
 * prove they own a site, and get paid a share of what crawlers pay for access.
 * Null when PARTNER_VERIFY_SECRET is unset, in which case /sell does not exist.
 */
if (partners)
  app.use('*', async (c, next) => {
    const answer = await partners.handle(c.req.raw);
    return answer ?? next();
  });

/**
 * The plan first, then the modules that follow from it: ads and tracking on
 * for free, off for anyone paying, the buyer's own choice with a crawl pass.
 */
app.use('*', loadPlan);
app.use('*', async (c, next) => {
  const modules = await modulesFor(c, c.get('plan'));
  c.set('modules', modules);
  await withModules(modules, next);
});

app.onError((err, c) => {
  if (err.redirect) return c.redirect(err.redirect, 303);
  if (err instanceof Denied) {
    if (wantsJson(c)) return c.json({ error: err.message }, err.status);
    const back = new URL(c.req.header('referer') ?? '/', config.siteUrl);
    back.searchParams.set('error', err.message);
    return c.redirect(back.pathname + back.search, 303);
  }
  console.error('[web]', err);
  if (wantsJson(c)) return c.json({ error: 'internal' }, 500);
  return c.text('Something went wrong.', 500);
});

app.get('/healthz', (c) => c.text('ok'));

registerStatic(app, gateway);
registerAuth(app);
registerPages(app);
registerManage(app);
registerApi(app);
registerPremium(app);
registerAutomotive(app);
registerMcp(app);

/**
 * The agent question loop. Before the niche routes, because its dashboard and
 * API paths are literal and must be matched before `/:slug` is asked.
 */
registerAgents(app);

/** The revenue ledger: what a niche earned and whose share of it is whose. */
registerRevenue(app);

/**
 * Last, because a niche's page is served from the site root: every other
 * route is registered before `/:slug` can be asked. A niche may not take a
 * slug the site already uses, so the two can never compete for a name.
 */
registerKnowledge(app);

app.notFound(async (c) => {
  if (wantsJson(c)) return c.json({ error: 'not found' }, 404);
  return c.html(await render(<NotFound user={c.get('user')} />), 404);
});
