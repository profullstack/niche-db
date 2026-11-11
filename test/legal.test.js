import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
const { config } = await import('../packages/config/src/index.js');
// Signed-out pages render through Redis otherwise, and there is none here.
config.cache.enabled = false;
const { render } = await import('../apps/web/src/lib/http.js');
const { LEGAL_EFFECTIVE_DATE, Privacy, Terms } = await import('../apps/web/src/views/legal.jsx');
const { isReservedNicheSlug } = await import('../packages/knowledge/src/index.js');

/** /privacy and /terms, rendered without a database the way the routes render them. */
const app = new Hono();
app.get('/privacy', async (c) => c.html(await render(Privacy({ user: null }))));
app.get('/terms', async (c) => c.html(await render(Terms({ user: null }))));

describe('legal pages', () => {
  for (const [path, heading] of [
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
  ]) {
    test(`${path} is a full page headed "${heading}" with no ad and no dashes`, async () => {
      const r = await app.request(path);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toMatch(new RegExp(`<title>${heading}[^<]*</title>`));
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(LEGAL_EFFECTIVE_DATE).toBe('November 11, 2026');
      expect(html).toContain(`Effective date: ${LEGAL_EFFECTIVE_DATE}`);
      expect(html).toContain('Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA');
      expect(html).toContain('support@profullstack.com');
      expect(html).toContain(`${config.siteUrl}/mcp`);
      expect(html).not.toContain('data-cp-ad');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
      const main = html.match(/<main[\s\S]*<\/main>/)?.[0] ?? '';
      expect(main.length).toBeGreaterThan(0);
      expect(main).not.toMatch(/[–—]/);
    });
  }

  test('the privacy policy has the AI agents and MCP section', async () => {
    const html = await (await app.request('/privacy')).text();
    expect(html).toContain('AI agents and MCP');
    expect(html).toContain('MCP and API requests are logged');
    expect(html).toContain('No MCP data is sold or used for advertising');
  });

  test('no niche can take either path', () => {
    expect(isReservedNicheSlug('privacy')).toBe(true);
    expect(isReservedNicheSlug('terms')).toBe(true);
  });
});
