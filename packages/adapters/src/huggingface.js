import { defineAdapter } from '@nichedb/core/adapter';

/** The Hugging Face Hub: models and datasets, newest change first. Keyless. */
export function toItem(m, type) {
  const kind = type === 'datasets' ? 'dataset' : type === 'spaces' ? 'space' : 'model';
  const tags = (m.tags ?? [])
    .filter((t) => !t.startsWith('region:') && !t.startsWith('arxiv:'))
    .slice(0, 15);
  return {
    externalId: `${kind}:${m.id}`,
    kind,
    title: m.id,
    summary: [m.pipeline_tag, m.library_name].filter(Boolean).join(' · ') || null,
    url: `https://huggingface.co/${kind === 'model' ? '' : `${type}/`}${m.id}`,
    publishedAt: m.lastModified ?? m.createdAt,
    tags: ['huggingface', ...(m.pipeline_tag ? [m.pipeline_tag] : []), ...tags],
    data: {
      likes: m.likes ?? 0,
      downloads: m.downloads ?? 0,
      pipeline: m.pipeline_tag ?? null,
      library: m.library_name ?? null,
      created: m.createdAt ?? null,
      author: m.id.includes('/') ? m.id.split('/')[0] : null,
    },
  };
}

export const huggingface = defineAdapter({
  name: 'huggingface',
  title: 'Hugging Face Hub',
  collection: 'packages',
  description:
    'Models, datasets or spaces on the Hugging Face Hub, most recently changed first. Keyless. Filter to a pipeline or a search term.',
  docs: 'https://huggingface.co/docs/hub/api',
  kinds: ['model', 'dataset', 'space'],
  cadenceMinutes: 10,
  configFields: [
    {
      key: 'type',
      label: 'What',
      type: 'select',
      options: ['models', 'datasets', 'spaces'],
      required: true,
    },
    {
      key: 'search',
      label: 'Search',
      placeholder: 'llama',
      help: 'Optional: only ids containing this.',
    },
    {
      key: 'pipeline',
      label: 'Pipeline',
      placeholder: 'text-generation',
      help: 'Optional pipeline tag filter (models only).',
    },
  ],
  defaults: { type: 'models' },
  defaultSources: [
    { slug: 'huggingface-models', name: 'Hugging Face: new models', config: { type: 'models' } },
    {
      slug: 'huggingface-datasets',
      name: 'Hugging Face: new datasets',
      config: { type: 'datasets' },
      cadenceMinutes: 30,
    },
  ],
  async pull({ config, http, log }) {
    const type = ['models', 'datasets', 'spaces'].includes(config.type) ? config.type : 'models';
    const params = new URLSearchParams({ sort: 'lastModified', direction: '-1', limit: '200' });
    if (config.search) params.set('search', String(config.search));
    if (config.pipeline && type === 'models') params.set('pipeline_tag', String(config.pipeline));
    const list = await http.json(`https://huggingface.co/api/${type}?${params}`);
    const items = (list ?? []).map((m) => toItem(m, type));
    log(`${items.length} ${type}`);
    return { items, note: `${items.length} ${type}` };
  },
});
