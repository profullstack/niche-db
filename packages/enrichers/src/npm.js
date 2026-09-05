import { defineEnricher } from './enricher.js';

/** Weekly downloads for an npm package, from the public downloads API. */
export const npmStats = defineEnricher({
  name: 'npm-stats',
  title: 'npm downloads',
  description: "Last week's download count for the package.",
  collections: ['packages'],
  appliesTo: (item) =>
    item.kind === 'version' && item.tags?.includes('npm') && Boolean(item.data?.name),
  perRun: 60,
  async enrich(item, { http }) {
    const r = await http.jsonOrNull(
      `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(item.data.name)}`,
    );
    if (!r || typeof r.downloads !== 'number') return null;
    return {
      weeklyDownloads: r.downloads,
      from: r.start,
      to: r.end,
      tags: r.downloads >= 1_000_000 ? ['popular'] : [],
    };
  },
});
