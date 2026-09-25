import { CHILD_LEVELS, LEVELS, normaliseKey, normaliseZip, zipKey } from '@nichedb/core/population';
import * as pop from '@nichedb/db/population';
import { render } from '../lib/http.js';
import { areaOut } from '../lib/population.js';
import { PopulationPage } from '../views/population.jsx';

/**
 * Population: the tree from the world to the ZIP code.
 *
 *   /population                          the world: countries, largest first
 *   /population/us                       a country: its states, its cities
 *   /population/us/ca                    a state: its cities, its ZIP codes
 *   /population/us/ca/los-angeles        a city: its ZIP codes
 *   /population/zip/90210                one ZIP code
 *   /population/area/<key>               any area by key (a city with no state)
 *
 * and the same under /api/v1/population as JSON. The rows are ordinary items
 * in the `population` collection, so feeds, search and the item API see them
 * too; what lives here is the walk, which needs AND over tags where a feed
 * query has ANY.
 */

const PAGE = 50;

const int = (v, fallback, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
};

/** The child levels worth offering for an area, those that have rows first. */
function childLevels(level, counts) {
  const offered = CHILD_LEVELS[level ?? 'world'] ?? [];
  return offered.filter((l) => (counts[l] ?? 0) > 0);
}

async function areaPage(c, key) {
  const row = await pop.areaByKey(key);
  if (!row) return c.notFound();
  const counts = await pop.childCounts(key);
  const levels = childLevels(row.data?.level, counts);
  const asked = c.req.query('level');
  const level = levels.includes(asked) ? asked : levels[0];
  const offset = int(c.req.query('offset'), 0, 1_000_000);
  const list = level ? await pop.areasIn({ within: key, level, limit: PAGE, offset }) : null;
  return c.html(
    await render(
      <PopulationPage
        user={c.get('user')}
        row={row}
        level={level}
        levels={levels}
        counts={counts}
        list={list}
        offset={offset}
        limit={PAGE}
      />,
    ),
  );
}

export function registerPopulation(app) {
  /* ------------------------------------------------------------ pages -- */

  app.get('/population', async (c) => {
    const q = String(c.req.query('q') ?? '').trim();
    const zip = normaliseZip(q);
    if (zip) return c.redirect(`/population/zip/${zip}`, 302);

    const offset = int(c.req.query('offset'), 0, 1_000_000);
    const [stats, list, results] = await Promise.all([
      pop.populationStats(),
      pop.areasIn({ level: 'country', limit: PAGE, offset }),
      q ? pop.areasNamed(q, { limit: 40 }) : null,
    ]);
    return c.html(
      await render(
        <PopulationPage
          user={c.get('user')}
          level="country"
          levels={['country']}
          counts={{ country: stats.country }}
          list={list}
          offset={offset}
          limit={PAGE}
          stats={stats}
          q={q}
          results={results}
        />,
      ),
    );
  });

  app.get('/population/zip/:zip', async (c) => {
    const zip = normaliseZip(c.req.param('zip'));
    if (!zip) return c.notFound();
    return areaPage(c, zipKey(zip));
  });

  app.get('/population/area/:key', async (c) => {
    const key = normaliseKey(c.req.param('key'));
    return key ? areaPage(c, key) : c.notFound();
  });

  app.get('/population/:country', async (c) => {
    const key = normaliseKey(c.req.param('country'));
    return key ? areaPage(c, key) : c.notFound();
  });

  app.get('/population/:country/:state', async (c) => {
    const key = normaliseKey(`${c.req.param('country')}-${c.req.param('state')}`);
    return key ? areaPage(c, key) : c.notFound();
  });

  app.get('/population/:country/:state/:city', async (c) => {
    const key = normaliseKey(
      `${c.req.param('country')}-${c.req.param('state')}-${c.req.param('city')}`,
    );
    return key ? areaPage(c, key) : c.notFound();
  });

  /* -------------------------------------------------------------- API -- */

  /** The world: counts per level and the countries, largest first. */
  app.get('/api/v1/population', async (c) => {
    const limit = int(c.req.query('limit'), 50, 500);
    const offset = int(c.req.query('offset'), 0, 1_000_000);
    const [stats, list] = await Promise.all([
      pop.populationStats(),
      pop.areasIn({ level: 'country', limit, offset }),
    ]);
    return c.json({
      levels: stats,
      total: list.total,
      offset,
      countries: list.areas.map(areaOut),
      next: 'GET /api/v1/population/{key} for one area and its children; /api/v1/population/areas?within={key}&level={level} to page a level.',
    });
  });

  /** One level inside an area, paged: ?within=us-ca&level=zip&limit=100&offset=0&order=population|name */
  app.get('/api/v1/population/areas', async (c) => {
    const level = c.req.query('level');
    if (!LEVELS.includes(level))
      return c.json({ error: `level must be one of ${LEVELS.join(', ')}` }, 400);
    const within = c.req.query('within') ? normaliseKey(c.req.query('within')) : null;
    const limit = int(c.req.query('limit'), 50, 500);
    const offset = int(c.req.query('offset'), 0, 1_000_000);
    const order = c.req.query('order') === 'name' ? 'name' : 'population';
    const list = await pop.areasIn({ within, level, limit, offset, order });
    return c.json({
      within,
      level,
      order,
      total: list.total,
      offset,
      areas: list.areas.map(areaOut),
    });
  });

  /** Areas by name: ?q=springfield. A ZIP code answers with that ZIP. */
  app.get('/api/v1/population/search', async (c) => {
    const q = String(c.req.query('q') ?? '').trim();
    if (!q) return c.json({ error: 'Needs ?q=' }, 400);
    const zip = normaliseZip(q);
    if (zip) {
      const row = await pop.areaByKey(zipKey(zip));
      return c.json({ q, areas: row ? [areaOut(row)] : [] });
    }
    const rows = await pop.areasNamed(q, { limit: int(c.req.query('limit'), 20, 100) });
    return c.json({ q, areas: rows.map(areaOut) });
  });

  app.get('/api/v1/population/zip/:zip', async (c) => {
    const zip = normaliseZip(c.req.param('zip'));
    if (!zip) return c.json({ error: 'Not a ZIP code' }, 400);
    const row = await pop.areaByKey(zipKey(zip));
    if (!row) return c.json({ error: `No ZIP code ${zip}` }, 404);
    return c.json({ area: areaOut(row) });
  });

  /** One area, how many of each level it holds, and the largest of its first child level. */
  app.get('/api/v1/population/:key', async (c) => {
    const key = normaliseKey(c.req.param('key'));
    if (!key) return c.json({ error: 'Not an area key' }, 400);
    const row = await pop.areaByKey(key);
    if (!row) return c.json({ error: `No area ${key}` }, 404);
    const counts = await pop.childCounts(key);
    const levels = childLevels(row.data?.level, counts);
    const asked = c.req.query('level');
    const level = levels.includes(asked) ? asked : (levels[0] ?? null);
    const limit = int(c.req.query('limit'), 20, 500);
    const list = level ? await pop.areasIn({ within: key, level, limit }) : null;
    return c.json({
      area: areaOut(row),
      contains: counts,
      children: level ? { level, total: list.total, areas: list.areas.map(areaOut) } : null,
    });
  });
}
