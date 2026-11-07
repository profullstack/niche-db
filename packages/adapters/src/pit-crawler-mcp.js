import { defineAdapter } from '@nichedb/core/adapter';

/**
 * MCP servers pit.world's crawler found on the open web and proved with a live
 * handshake. Nothing to pull: the crawler writes here through
 * POST /api/v1/mcp/records. Registered after the published catalogs, so a server
 * a registry already lists keeps the registry's row.
 */
export const pitCrawlerMcp = defineAdapter({
  name: 'pit-crawler-mcp',
  title: 'Found by the pit.world crawler',
  collection: 'mcp',
  description:
    'MCP servers pitbot found while reading the web (a descriptor, a server card, a link or a config block on a page), each proved by a live initialize and tools/list before it is kept. Nothing to pull: the crawler pushes them with POST /api/v1/mcp/records.',
  docs: 'https://pit.world/bot',
  kinds: ['mcp-server'],
  defaultSources: [
    {
      slug: 'pit-crawler-mcp',
      name: 'MCP: found by the pit.world crawler',
      description:
        'Servers pitbot found on the open web and proved with a live handshake. Nothing to pull: the crawler writes here.',
      enabled: false,
    },
  ],
  async pull() {
    return { items: [], note: 'the crawler pushes these' };
  },
});
