import { describe, expect, test } from 'bun:test';
import {
  nixleDate,
  POLICE_CITIES,
  POLICE_SCOPE,
  parseNixleAlert,
  parseNixleArchive,
  policeItem,
  policeUpdates,
} from '../packages/adapters/src/police-updates.js';
import { normaliseItem } from '../packages/core/src/adapter.js';

const city = POLICE_CITIES.find((c) => c.name === 'Palo Alto');
const source = city.ingestion;
const archive = `<html><title>Messages from Palo Alto Police Department : Nixle</title>
<ol id="wire"><li id="pub_123"><p class="headline_agency">Traffic advisory
<a href="https://nixle.us/example">More&nbsp;&raquo;</a></p></li></ol></html>`;
const detail = (date = 'Wednesday June 24th, 2026 :: 04:27 p.m. PDT') => `<html>
<div id="fullpubhd"><dl class="first"><dd class="certified"><a href="/palo-alto-police-department/">Palo Alto Police Department</a></dd></dl>
<dl class="last clearfix"><dd>${date}</dd></dl></div>
<div id="alert-body"><p>Road closure.<br>Follow the signed detour.</p><div><p>Update: Road reopened.</p></div></div>
<p class="agency">Address/Location: Police headquarters, not the incident.</p></html>`;
const entry = { id: '123', title: 'Traffic advisory', url: 'https://local.nixle.com/alert/123/' };

describe('police announcements', () => {
  test('coverage page exposes the 100k option and distinguishes references from reviewed feeds', async () => {
    process.env.DATABASE_URL ??= 'postgres://localhost/unused';
    const { PoliceCoveragePage } = await import('../apps/web/src/views/police-coverage.jsx');
    const html = await PoliceCoveragePage({ minimum: 100000 }).toString();
    expect(html).toContain('76 cities');
    expect(html).toContain('Fremont');
    expect(html).not.toContain('<strong>Palo Alto</strong>');
    const pending = await PoliceCoveragePage({ search: 'San Jose', pending: true }).toString();
    expect(pending).toContain('Source leads only');
    expect(pending).not.toContain('Reviewed Nixle feed');
  });
  test('Census cutoff is strict; discovery does not activate every city or county publisher', () => {
    expect(POLICE_SCOPE.minimumPopulation).toBe(50000);
    expect(POLICE_CITIES).toHaveLength(177);
    expect(POLICE_CITIES.filter((c) => c.population > 100000)).toHaveLength(76);
    expect(POLICE_CITIES.every((c) => c.state === 'CA' && c.population > 50000)).toBe(true);
    expect(new Set(POLICE_CITIES.map((c) => c.geoid)).size).toBe(177);
    expect(POLICE_CITIES.every((c) => c.references.length > 0)).toBe(true);
    expect(POLICE_CITIES.find((c) => c.name === 'Chino').ingestion).toBeNull();
    expect(POLICE_CITIES.find((c) => c.name === 'Chino Hills').ingestion).toBeTruthy();
    expect(POLICE_CITIES.find((c) => c.name === 'Los Angeles').ingestion).toBeNull();
    expect(POLICE_CITIES.find((c) => c.name === 'Burbank').ingestion).toBeNull();
    expect(policeUpdates.defaultSources.every((s) => s.cadenceMinutes === 60)).toBe(true);
    expect(policeUpdates.defaultSources.length).toBeLessThan(POLICE_CITIES.length);
  });
  test('archive rejects login and another agency; follows real stable alert IDs', () => {
    expect(parseNixleArchive(archive, source)).toEqual([entry]);
    expect(() => parseNixleArchive('<html>Sign in</html>', source)).toThrow('publisher archive');
    expect(() =>
      parseNixleArchive(archive.replaceAll('Palo Alto', 'Other City'), source),
    ).toThrow();
  });
  test('publication date uses explicit California timezone, never relative age or incident text', () => {
    expect(nixleDate('Wednesday June 24th, 2026 :: 04:27 p.m. PDT')).toBe(
      '2026-06-24T23:27:00.000Z',
    );
    expect(nixleDate('Monday January 5th, 2026 :: 12:01 a.m. PST')).toBe(
      '2026-01-05T08:01:00.000Z',
    );
    expect(nixleDate('Entered: 2 weeks ago')).toBeNull();
    expect(nixleDate('Monday January 5th, 2026 :: 13:01 p.m. PST')).toBeNull();
  });
  test('nested alert body excludes headquarters address; unknown date stays unknown', async () => {
    const raw = await parseNixleAlert(detail(), entry, source);
    expect(raw.summary).toContain('Road reopened');
    expect(raw.summary).not.toContain('headquarters');
    expect(raw.publishedAt).toBe('2026-06-24T23:27:00.000Z');
    const item = normaliseItem(
      policeItem(await parseNixleAlert(detail('Unknown'), entry, source), city),
    );
    expect(item.publishedAt).toBeNull();
    expect(item.timeKnown).toBe(false);
    expect(item.kind).toBe('police-update');
    expect(item.data.occurred_at).toBeNull();
    expect(item.data.location_precision).toBe('jurisdiction');
    expect(item.data.coverage).toEqual({ type: 'Point', coordinates: [city.lon, city.lat] });
    await expect(
      parseNixleAlert(
        detail().replace('/palo-alto-police-department/', '/another-agency/'),
        entry,
        source,
      ),
    ).rejects.toThrow('publisher');
  });
  test('fetch failures retry on the next pull; known announcements are bounded correction reads', async () => {
    let fail = true;
    let details = 0;
    const ctx = {
      config: { city: city.slug },
      budget: 1,
      previous: async () => new Map(),
      http: {
        request: async () => new Response('User-agent: *\nAllow: /'),
        text: async (url) => {
          if (!url.includes('/alert/')) return archive;
          details++;
          if (fail) throw new Error('503');
          return detail();
        },
      },
    };
    await expect(policeUpdates.pull(ctx)).rejects.toThrow('503');
    fail = false;
    const result = await policeUpdates.pull(ctx);
    expect(result.items[0].externalId).toBe('nixle:123');
    expect(details).toBe(2);
    const hash = normaliseItem(result.items[0]).contentHash;
    ctx.previous = async () => new Map([['nixle:123', result.items[0].data]]);
    const repeat = await policeUpdates.pull(ctx);
    expect(normaliseItem(repeat.items[0]).contentHash).toBe(hash);
  });
  test('blocked robots and non-feed HTML fail visibly; empty RSS is a valid empty result', async () => {
    const rssCity = POLICE_CITIES.find((c) => c.ingestion?.format === 'rss');
    let content = '<html><title>Access denied</title></html>';
    const ctx = {
      config: { city: rssCity.slug },
      http: {
        request: async () => new Response('', { status: 403 }),
        text: async () => content,
      },
    };
    await expect(policeUpdates.pull(ctx)).rejects.toThrow('Robots check');
    ctx.http.request = async () => new Response('User-agent: *\nDisallow: /');
    await expect(policeUpdates.pull(ctx)).rejects.toThrow('disallows');
    ctx.http.request = async () => new Response('', { status: 404 });
    await expect(policeUpdates.pull(ctx)).rejects.toThrow('Expected RSS');
    content = '<rss version="2.0"><channel><title>Police</title></channel></rss>';
    expect((await policeUpdates.pull(ctx)).items).toEqual([]);
  });
});
