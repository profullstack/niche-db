import { config } from '@nichedb/config';
import { createGateway } from '@profullstack/x402-gateway';
import { x402Gateway } from '@profullstack/x402-gateway/hono';
import { Hono } from 'hono';
import { loadUser, render, wantsJson } from './lib/http.js';
import { Denied } from './lib/service.js';
import { registerApi } from './routes/api.js';
import { registerAuth } from './routes/auth.js';
import { registerManage } from './routes/manage.js';
import { registerMcp } from './routes/mcp.js';
import { registerPages } from './routes/pages.js';
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
 */
export const gateway = createGateway({
  siteUrl: config.siteUrl,
  siteName: config.siteName,
  coinpay: { apiKey: config.x402.coinpayKey },
  payTo: config.x402.payTo,
  priceCents: config.x402.priceCents,
  passMinutes: config.x402.passMinutes,
  contact: config.x402.contact || undefined,
  openPaths: ['/llms.txt', '/mcp', '/api/', '/healthz', '/manifest.webmanifest'],
  onSale: (sale) => console.log('[x402] sold a pass', { payer: sale.payer, ua: sale.userAgent }),
});
app.use('*', x402Gateway(gateway));

app.use('*', loadUser);

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
registerMcp(app);

app.notFound(async (c) => {
  if (wantsJson(c)) return c.json({ error: 'not found' }, 404);
  return c.html(await render(<NotFound user={c.get('user')} />), 404);
});
