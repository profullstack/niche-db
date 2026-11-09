import { describe, expect, test } from 'bun:test';
import {
  parseSocialUrl,
  profileAccounts,
  scrapeExchange,
  summariseSeries,
} from '../packages/enrichers/src/scrape-exchange.js';

describe('scrape-exchange enricher', () => {
  test('parses the four supported networks and nothing else', () => {
    expect(parseSocialUrl('https://www.instagram.com/NASA/?hl=en')).toMatchObject({
      platform: 'instagram',
      handle: 'nasa',
    });
    expect(parseSocialUrl('https://www.tiktok.com/@nba')).toMatchObject({
      platform: 'tiktok',
      handle: 'nba',
    });
    expect(parseSocialUrl('https://twitch.tv/shroud')).toMatchObject({
      platform: 'twitch',
      handle: 'shroud',
    });
    expect(parseSocialUrl('https://www.youtube.com/@mkbhd')).toMatchObject({
      platform: 'youtube',
      entity: 'channel',
      handle: 'mkbhd',
    });
    expect(
      parseSocialUrl('https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ'),
    ).toMatchObject({
      id: 'UCBJycsmduvYEL83R_U4JriQ',
    });
    expect(parseSocialUrl('https://www.instagram.com/p/abc123/')).toBeNull();
    expect(parseSocialUrl('https://www.youtube.com/watch?v=x')).toBeNull();
    expect(parseSocialUrl('https://onlyfans.com/someone')).toBeNull();
    expect(parseSocialUrl('not a url')).toBeNull();
  });

  test('reads accounts from both profile row shapes, deduped', () => {
    const person = {
      data: {
        accounts: [
          { url: 'https://www.wikidata.org/wiki/Q1' },
          { url: 'https://www.instagram.com/nasa/' },
        ],
      },
    };
    expect(profileAccounts(person).map((a) => a.handle)).toEqual(['nasa']);
    const doc = {
      data: {
        doc: '# X\n\n- **Web**: https://www.instagram.com/nasa/\n- **Twitch**: https://www.twitch.tv/shroud\n\n- [IG](https://instagram.com/NASA)\n- **Avatar**: https://cdn.example/a.jpg',
      },
    };
    expect(profileAccounts(doc).map((a) => `${a.platform}:${a.handle}`)).toEqual([
      'instagram:nasa',
      'twitch:shroud',
    ]);
    expect(scrapeExchange.appliesTo({ data: { doc: '# Nobody' } })).toBe(false);
  });

  test('summarises the latest point per metric; an empty series is unknown', () => {
    const m = summariseSeries({
      series: [
        {
          metric: 'follower_count',
          data_points: [
            { timestamp: 1789879631, value: 110 },
            { timestamp: 1789705278, value: 100 },
          ],
        },
        { metric: 'video_count', data_points: [] },
      ],
    });
    expect(m.follower_count.value).toBe(110);
    expect(m.follower_count.change).toBe(10);
    expect(m.video_count).toBeUndefined();
    expect(summariseSeries({ series: [] })).toEqual({});
  });

  test('enrich asks for the handle, then that record uploader series', async () => {
    const calls = [];
    const http = {
      async jsonOrNull(url, opts) {
        calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/filter')) {
          return {
            edges: [
              {
                node: {
                  platform_content_id: '37402112',
                  platform_creator_id: 'shroud',
                  username: 'drand',
                  source_url: 'https://www.twitch.tv/shroud',
                },
              },
            ],
          };
        }
        return {
          series: [
            { metric: 'follower_count', data_points: [{ timestamp: 1790313321, value: 11293095 }] },
          ],
        };
      },
    };
    const out = await scrapeExchange.enrich(
      { data: { doc: 'https://www.twitch.tv/shroud' } },
      { http },
    );
    expect(calls[0].body).toMatchObject({
      platform: 'twitch',
      entity: 'creator',
      platform_creator_id: 'shroud',
    });
    expect(calls[1].url).toContain('platform_content_id=37402112');
    expect(calls[1].url).toContain('uploader=drand');
    expect(out.accounts[0]).toMatchObject({
      network: 'twitch',
      handle: 'shroud',
      audience: 11293095,
    });
    expect(out.audience).toBe(11293095);
    expect(out.tags).toEqual(['audience-1m']);
  });

  test('nothing found is null', async () => {
    const http = { jsonOrNull: async () => null };
    expect(
      await scrapeExchange.enrich({ data: { doc: 'https://www.tiktok.com/@nobody' } }, { http }),
    ).toBeNull();
  });
});
