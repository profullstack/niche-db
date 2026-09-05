import { defineAdapter, first, stripHtml, xmlItems } from '@nichedb/core/adapter';

/** GDACS: the global disaster alert feed (UN/EU): earthquakes, cyclones, floods, volcanoes, droughts, fires. Keyless RSS. */
const TYPES = {
  EQ: 'earthquake',
  TC: 'cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
  TS: 'tsunami',
};

export function parseFeed(xml) {
  const out = [];
  for (const it of xmlItems(xml, 'item')) {
    const guid = first(it.guid)?.text ?? first(it.link)?.text;
    if (!guid) continue;
    const type = first(it['gdacs:eventtype'])?.text ?? '';
    const level = (first(it['gdacs:alertlevel'])?.text ?? '').toLowerCase();
    const country = first(it['gdacs:country'])?.text ?? null;
    out.push({
      externalId: guid,
      kind: 'disaster',
      title: first(it.title)?.text ?? guid,
      summary: stripHtml(first(it.description)?.text ?? '').slice(0, 600) || null,
      url: first(it.link)?.text ?? null,
      imageUrl: first(it.enclosure)?.attrs?.url ?? null,
      publishedAt: first(it.pubDate)?.text ?? first(it['gdacs:fromdate'])?.text ?? null,
      tags: [
        'gdacs',
        TYPES[type] ?? type.toLowerCase(),
        level ? `${level}-alert` : null,
        country?.toLowerCase(),
      ].filter(Boolean),
      data: {
        type: TYPES[type] ?? type,
        level,
        country,
        severity: first(it['gdacs:severity'])?.text ?? null,
        population: first(it['gdacs:population'])?.text ?? null,
        from: first(it['gdacs:fromdate'])?.text ?? null,
        to: first(it['gdacs:todate'])?.text ?? null,
        lat: first(it['geo:lat'])?.text ?? null,
        lon: first(it['geo:long'])?.text ?? null,
      },
    });
  }
  return out;
}

export const gdacs = defineAdapter({
  name: 'gdacs',
  title: 'GDACS disaster alerts',
  collection: 'alerts',
  description:
    'The Global Disaster Alert and Coordination System feed: cyclones, floods, volcanoes, droughts, wildfires and major quakes, with alert level and affected population. Keyless.',
  docs: 'https://www.gdacs.org/',
  kinds: ['disaster'],
  cadenceMinutes: 15,
  configFields: [],
  defaultSources: [{ slug: 'disasters-gdacs', name: 'Disasters: GDACS global alerts' }],
  async pull({ http, log }) {
    const xml = await http.text('https://www.gdacs.org/xml/rss.xml', {
      headers: { accept: '*/*' },
    });
    const items = parseFeed(xml);
    log(`${items.length} alerts`);
    return { items, note: `${items.length} alerts` };
  },
});
