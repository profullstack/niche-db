import { defineAdapter } from '@nichedb/core/adapter';

/**
 * The npm registry's CouchDB changes feed: every publish, in order, forever.
 *
 * The cursor is the sequence number. A first run starts at the tip rather than
 * at zero -- the registry has tens of millions of changes and nobody wants the
 * history -- and every run after that walks forward, spending the detail
 * budget on `/{name}/latest` documents, which are small. When more changed than
 * the budget allowed, the adapter asks to run again in a minute rather than
 * waiting for its cadence.
 */

const REPLICATE = 'https://replicate.npmjs.com/registry/_changes';
const REGISTRY = 'https://registry.npmjs.org';

export function toItem(name, doc, seenAt) {
  const scope = name.startsWith('@') ? name.slice(1, name.indexOf('/')) : null;
  const repo = typeof doc.repository === 'string' ? doc.repository : doc.repository?.url;
  return {
    externalId: `${name}@${doc.version}`,
    kind: 'version',
    title: `${name} ${doc.version}`,
    summary: doc.description ?? null,
    url: `https://www.npmjs.com/package/${name}/v/${doc.version}`,
    publishedAt: seenAt,
    tags: ['npm', ...(scope ? [`@${scope}`] : []), ...(doc.keywords ?? []).slice(0, 12)],
    data: {
      name,
      version: doc.version,
      license: doc.license ?? null,
      repository: repo
        ? String(repo)
            .replace(/^git\+/, '')
            .replace(/\.git$/, '')
        : null,
      homepage: doc.homepage ?? null,
      deprecated: doc.deprecated ? String(doc.deprecated).slice(0, 200) : null,
      bin: doc.bin ? Object.keys(typeof doc.bin === 'string' ? { [name]: doc.bin } : doc.bin) : [],
    },
  };
}

export const npm = defineAdapter({
  name: 'npm',
  title: 'npm registry',
  collection: 'packages',
  description:
    'Every package published to npm, as it happens, from the registry changes feed. Keyless. A first run starts from now rather than from the beginning of time.',
  docs: 'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md',
  kinds: ['version'],
  cadenceMinutes: 5,
  configFields: [
    {
      key: 'match',
      label: 'Only names matching',
      placeholder: 'mcp',
      help: 'Optional substring; leave empty for everything.',
    },
  ],
  defaults: {},
  defaultSources: [{ slug: 'npm', name: 'npm: every publish' }],
  async pull({ config, cursor, http, budget, deadline, log }) {
    let seq = cursor.seq;
    if (!seq) {
      const tip = await http.json(`${REPLICATE}?descending=true&limit=1`);
      seq = tip.last_seq;
      log(`starting at the tip, seq ${seq}`);
      return { items: [], cursor: { seq }, note: 'positioned at tip' };
    }
    const changes = await http.json(`${REPLICATE}?since=${seq}&limit=1000`);
    const results = changes.results ?? [];
    const match = String(config.match ?? '').toLowerCase();
    const items = [];
    let spent = 0;
    let last = seq;
    let backlog = false;
    const seenAt = new Date();
    for (const ch of results) {
      if (Date.now() > deadline || spent >= budget) {
        backlog = true;
        break;
      }
      last = ch.seq;
      if (ch.deleted || !ch.id || ch.id.startsWith('_design')) continue;
      if (match && !ch.id.toLowerCase().includes(match)) continue;
      spent++;
      const doc = await http.jsonOrNull(`${REGISTRY}/${ch.id}/latest`);
      if (doc?.version) items.push(toItem(ch.id, doc, seenAt));
    }
    if (!backlog && results.length > 0) last = changes.last_seq ?? last;
    const more = backlog || results.length >= 1000;
    log(`${results.length} change(s), ${items.length} version(s), seq ${seq} -> ${last}`);
    return {
      items,
      cursor: { seq: last },
      note: `${results.length} changes`,
      nextInMinutes: more ? 1 : undefined,
    };
  },
});
