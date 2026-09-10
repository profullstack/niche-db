import { describe, expect, test } from 'bun:test';
import { buildItems, channels, indexLogos, toItem } from '../packages/adapters/src/channels.js';

/** Three channels as channels.json lists them (fields verified live 2026-09-10). */
const CHANNELS = [
  {
    id: 'ESPN2.us',
    name: 'ESPN2',
    alt_names: ['ESPN 2'],
    network: 'ESPN',
    owners: ['The Walt Disney Company'],
    country: 'US',
    categories: ['sports'],
    is_nsfw: false,
    launched: '1993-10-01',
    closed: null,
    replaced_by: null,
    website: 'https://www.espn.com/',
  },
  {
    id: 'TF1.fr',
    name: 'TF1',
    alt_names: [],
    network: null,
    owners: ['Groupe TF1'],
    country: 'FR',
    categories: ['general'],
    is_nsfw: false,
    launched: '1975-01-06',
    closed: null,
    replaced_by: null,
    website: 'https://www.tf1.fr/',
  },
  {
    id: 'OldChannel.uk',
    name: 'Old Channel',
    alt_names: [],
    network: null,
    owners: [],
    country: 'GB',
    categories: ['entertainment'],
    is_nsfw: false,
    launched: '2001-03-01',
    closed: '2023-06-30',
    replaced_by: 'NewChannel.uk',
    website: null,
  },
  { id: 'Adult.xx', name: 'Adult', categories: ['xxx'], is_nsfw: true, country: 'US' },
];
const STREAMS = [
  { channel: 'ESPN2.us', url: 'https://x.example/espn2.m3u8', quality: '720p', title: null },
  { channel: 'ESPN2.us', url: 'https://x.example/espn2-hd.m3u8', quality: '1080p', title: 'HD' },
  { channel: 'Adult.xx', url: 'https://x.example/adult.m3u8', quality: null, title: null },
];
const LOGOS = [
  { channel: 'ESPN2.us', width: 200, height: 100, url: 'https://logos.example/espn2-small.png' },
  { channel: 'ESPN2.us', width: 800, height: 400, url: 'https://logos.example/espn2.png' },
];

describe('the iptv-org directory as channel items', () => {
  test('every channel is kept, streamable or not, and the stream is a tag', () => {
    const { items, streamable } = buildItems(CHANNELS, STREAMS, LOGOS);
    expect(items.map((i) => i.externalId)).toEqual([
      'iptv-org:channel:ESPN2.us',
      'iptv-org:channel:TF1.fr',
      'iptv-org:channel:OldChannel.uk',
      'iptv-org:channel:Adult.xx',
    ]);
    expect(streamable).toBe(1);
    const espn = items[0];
    expect(espn.kind).toBe('channel');
    expect(espn.tags).toEqual(['channel', 'sports', 'country:us', 'network:espn', 'streamable']);
    expect(espn.data.streamUrl).toBe('https://x.example/espn2.m3u8');
    expect(espn.data.streams).toHaveLength(2);
    expect(espn.data.altNames).toEqual(['ESPN 2']);
    expect(espn.publishedAt).toBeTruthy();
    expect(espn.precision).toBe('day');
    // A channel with no stream is still an answer: logo, country, category.
    const tf1 = items[1];
    expect(tf1.tags).toEqual(['channel', 'general', 'country:fr']);
    expect(tf1.data.streamUrl).toBeNull();
    expect(tf1.summary).toContain('No public stream');
  });

  test('the widest logo wins, and a channel with none has no image', () => {
    const logos = indexLogos(LOGOS);
    expect(logos.get('ESPN2.us')?.url).toBe('https://logos.example/espn2.png');
    const { items } = buildItems(CHANNELS, STREAMS, LOGOS);
    expect(items[0].imageUrl).toBe('https://logos.example/espn2.png');
    expect(items[1].imageUrl).toBeNull();
  });

  test('a closed channel is kept and says so; an NSFW one never gets a stream', () => {
    const { items } = buildItems(CHANNELS, STREAMS, LOGOS);
    const old = items[2];
    expect(old.tags).toContain('closed');
    expect(old.summary).toContain('Closed 2023-06-30');
    expect(old.data.closed).toBe('2023-06-30');
    const adult = items[3];
    expect(adult.data.isNsfw).toBe(true);
    expect(adult.data.streamUrl).toBeNull();
    expect(adult.tags).not.toContain('streamable');
  });

  test('a record without an id or a name is skipped, and a bare one still parses', () => {
    expect(buildItems([{ name: 'no id' }, { id: 'x' }], [], []).items).toHaveLength(0);
    const item = toItem({ id: 'Bare.zz', name: 'Bare' });
    expect(item.tags).toEqual(['channel']);
    expect(item.publishedAt).toBeNull();
    expect(item.data.categories).toEqual([]);
  });

  test('the adapter is declared for the channels collection, daily', () => {
    expect(channels.collection).toBe('channels');
    expect(channels.cadenceMinutes).toBe(1440);
    expect(channels.defaultSources[0].slug).toBe('iptv-org-channels');
  });
});
