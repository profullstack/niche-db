import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/** Scryfall: Magic sets and their newest printings, with images and prices. Keyless, 10 req/s. */
export function setItem(s) {
  const when = looseDate(s.released_at ?? '');
  return {
    externalId: `set:${s.code}`,
    kind: 'set',
    title: `${s.name} (${s.code.toUpperCase()})`,
    summary: `${s.set_type.replace(/_/g, ' ')} · ${s.card_count} cards${s.digital ? ' · digital' : ''}`,
    url: s.scryfall_uri,
    imageUrl: s.icon_svg_uri ?? null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: ['scryfall', 'mtg', s.set_type, s.digital ? 'digital' : 'paper'],
    data: {
      code: s.code,
      type: s.set_type,
      cards: s.card_count,
      released: s.released_at ?? null,
      block: s.block ?? null,
    },
  };
}

export function cardItem(c) {
  const when = looseDate(c.released_at ?? '');
  const face = c.image_uris ?? c.card_faces?.[0]?.image_uris ?? {};
  const colors = (c.colors ?? c.card_faces?.[0]?.colors ?? []).map(
    (x) => ({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' })[x] ?? x,
  );
  return {
    externalId: `card:${c.id}`,
    kind: 'card',
    title: `${c.name} (${c.set.toUpperCase()} ${c.collector_number})`,
    summary: [c.type_line, c.oracle_text ? c.oracle_text.slice(0, 200) : null]
      .filter(Boolean)
      .join(' — '),
    url: c.scryfall_uri,
    imageUrl: face.normal ?? face.large ?? null,
    publishedAt: when.publishedAt,
    timeKnown: false,
    precision: when.precision,
    tags: [
      'scryfall',
      'mtg',
      c.set,
      c.rarity,
      ...colors,
      ...(c.type_line ?? '')
        .split(' — ')[0]
        .split(' ')
        .map((t) => t.toLowerCase()),
    ].filter(Boolean),
    data: {
      name: c.name,
      set: c.set,
      setName: c.set_name,
      rarity: c.rarity,
      mana: c.mana_cost ?? null,
      cmc: c.cmc ?? null,
      prices: c.prices ?? {},
      artist: c.artist ?? null,
      released: c.released_at ?? null,
    },
  };
}

export const scryfallSets = defineAdapter({
  name: 'scryfall-sets',
  title: 'Scryfall: Magic sets',
  collection: 'tabletop',
  description:
    'Every Magic: The Gathering set, upcoming ones first, with release dates and card counts. Keyless.',
  docs: 'https://scryfall.com/docs/api/sets',
  kinds: ['set'],
  cadenceMinutes: 360,
  configFields: [],
  defaultSources: [{ slug: 'mtg-sets', name: 'Magic: sets and release dates' }],
  async pull({ http, log }) {
    const res = await http.json('https://api.scryfall.com/sets');
    const cutoff = Date.now() - 365 * 86_400_000;
    const items = (res.data ?? [])
      .filter((s) => s.released_at && new Date(s.released_at).getTime() > cutoff)
      .map(setItem);
    log(`${items.length} sets in the last year or upcoming`);
    return { items, note: `${items.length} sets` };
  },
});

export const scryfallCards = defineAdapter({
  name: 'scryfall-cards',
  title: 'Scryfall: newest cards',
  collection: 'tabletop',
  description:
    'The newest Magic printings, with images, oracle text and prices. Keyless. Narrow with any Scryfall search.',
  docs: 'https://scryfall.com/docs/syntax',
  kinds: ['card'],
  cadenceMinutes: 120,
  configFields: [
    {
      key: 'q',
      label: 'Scryfall search',
      placeholder: 'r:mythic',
      help: 'Optional; combined with a recent-release filter.',
    },
    { key: 'days', label: 'Released within days', type: 'number', placeholder: '60' },
    { key: 'pages', label: 'Pages of 175', type: 'number', placeholder: '2' },
  ],
  defaults: { days: 60, pages: 2 },
  defaultSources: [{ slug: 'mtg-new-cards', name: 'Magic: newest cards' }],
  async pull({ config, http, log }) {
    const since = new Date(Date.now() - (Number(config.days) || 60) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const q = `date>=${since}${config.q ? ` ${config.q}` : ''}`;
    const pages = Math.min(Math.max(1, Number(config.pages) || 2), 5);
    const items = [];
    let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=released&dir=desc&unique=prints`;
    for (let p = 0; p < pages && url; p++) {
      const res = await http.json(url);
      for (const c of res.data ?? []) items.push(cardItem(c));
      url = res.has_more ? res.next_page : null;
      await Bun.sleep(120);
    }
    log(`${items.length} cards`);
    return { items, note: `${items.length} cards` };
  },
});
