import { defineAdapter } from '@nichedb/core/adapter';

/** Go's module index: an append-only log of every module version, keyless. The cursor is a timestamp. */
export function toItem(m) {
  const parts = m.Path.split('/');
  return {
    externalId: `${m.Path}@${m.Version}`,
    kind: 'version',
    title: `${m.Path} ${m.Version}`,
    summary: null,
    url: `https://pkg.go.dev/${m.Path}@${m.Version}`,
    publishedAt: m.Timestamp,
    tags: ['go', parts[0], m.Version.includes('-') ? 'pseudo-version' : 'tagged'].filter(Boolean),
    data: { path: m.Path, version: m.Version, host: parts[0] },
  };
}

export const goModules = defineAdapter({
  name: 'go-modules',
  title: 'Go module index',
  collection: 'packages',
  description:
    'Every Go module version as the proxy indexes it, from index.golang.org. Keyless; starts from now.',
  docs: 'https://index.golang.org/',
  kinds: ['version'],
  cadenceMinutes: 10,
  configFields: [
    { key: 'match', label: 'Only paths matching', placeholder: 'github.com/hashicorp' },
    { key: 'tagged', label: 'Tagged versions only', type: 'select', options: ['yes', 'no'] },
  ],
  defaults: { tagged: 'yes' },
  defaultSources: [{ slug: 'go-modules', name: 'Go: tagged module versions' }],
  async pull({ config, cursor, http, log }) {
    const since = cursor.since ?? new Date(Date.now() - 3600_000).toISOString();
    const text = await http.text(
      `https://index.golang.org/index?since=${encodeURIComponent(since)}&limit=2000`,
    );
    const match = String(config.match ?? '').toLowerCase();
    const items = [];
    let last = since;
    let seen = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      seen++;
      last = m.Timestamp;
      if (config.tagged !== 'no' && /-\d{14}-[0-9a-f]{12}$/.test(m.Version)) continue;
      if (match && !m.Path.toLowerCase().includes(match)) continue;
      items.push(toItem(m));
    }
    log(`${seen} entries, ${items.length} kept, since ${since} -> ${last}`);
    return {
      items,
      cursor: { since: last },
      note: `${items.length} of ${seen}`,
      nextInMinutes: seen >= 2000 ? 1 : undefined,
    };
  },
});
