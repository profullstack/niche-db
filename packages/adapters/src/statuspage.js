import { defineAdapter, stripHtml } from '@nichedb/core/adapter';

/**
 * Vendor status pages on Atlassian Statuspage, which all expose the same
 * public JSON. One source watches a list of hosts; each incident is an item
 * whose content changes as updates are posted, so followers see the story.
 */
export const DEFAULT_HOSTS = [
  'www.githubstatus.com',
  'status.openai.com',
  'status.claude.com',
  'status.npmjs.org',
  'www.cloudflarestatus.com',
  'www.vercel-status.com',
  'status.digitalocean.com',
  'status.atlassian.com',
];

export function toItem(host, page, inc) {
  const vendor = (page?.name ?? host)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const latest = inc.incident_updates?.[0];
  const components = (inc.components ?? []).map((c) => c.name).slice(0, 6);
  return {
    externalId: `${host}:${inc.id}`,
    kind: 'incident',
    title: `${page?.name ?? host}: ${inc.name}`,
    summary: latest?.body
      ? `${latest.status}: ${stripHtml(latest.body).slice(0, 500)}`
      : inc.status,
    url: inc.shortlink ?? `https://${host}/incidents/${inc.id}`,
    publishedAt: inc.created_at,
    tags: [
      'statuspage',
      vendor,
      inc.status,
      inc.impact ? `impact-${inc.impact}` : null,
      ...components.map((c) => c.toLowerCase()),
    ].filter(Boolean),
    data: {
      vendor: page?.name ?? host,
      host,
      status: inc.status,
      impact: inc.impact ?? null,
      components,
      updates: (inc.incident_updates ?? []).length,
      resolvedAt: inc.resolved_at ?? null,
      updatedAt: inc.updated_at ?? null,
    },
  };
}

export const statuspage = defineAdapter({
  name: 'statuspage',
  title: 'Vendor status pages',
  collection: 'outages',
  description:
    'Incidents from any status page built on Atlassian Statuspage (GitHub, OpenAI, Claude, npm, Cloudflare, Vercel, DigitalOcean, Atlassian…). Keyless. Add any host that serves /api/v2/incidents.json.',
  docs: 'https://metastatuspage.com/api',
  kinds: ['incident'],
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'hosts',
      label: 'Status page hosts',
      type: 'list',
      required: true,
      placeholder: DEFAULT_HOSTS.join(', '),
      help: 'Hostnames only; each must answer /api/v2/incidents.json.',
    },
  ],
  defaults: { hosts: DEFAULT_HOSTS },
  defaultSources: [
    {
      slug: 'vendor-status',
      name: 'Outages: developer platforms',
      config: { hosts: DEFAULT_HOSTS },
    },
  ],
  async pull({ config, http, log, deadline }) {
    const hosts = (
      Array.isArray(config.hosts) ? config.hosts : String(config.hosts ?? '').split(',')
    )
      .map((h) =>
        String(h)
          .trim()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, ''),
      )
      .filter((h) => /^[a-z0-9.-]+$/i.test(h))
      .slice(0, 40);
    const items = [];
    const failed = [];
    for (const host of hosts) {
      if (Date.now() > deadline) break;
      try {
        const res = await http.json(`https://${host}/api/v2/incidents.json`, { timeoutMs: 15_000 });
        for (const inc of (res.incidents ?? []).slice(0, 50))
          items.push(toItem(host, res.page, inc));
      } catch (err) {
        failed.push(`${host} (${err.message.slice(0, 40)})`);
      }
    }
    log(
      `${hosts.length} hosts, ${items.length} incidents${failed.length ? `, failed: ${failed.join(', ')}` : ''}`,
    );
    return {
      items,
      note: `${items.length} incidents from ${hosts.length - failed.length} hosts${failed.length ? `; ${failed.length} failed` : ''}`,
    };
  },
});
