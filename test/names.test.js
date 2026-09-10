import { describe, expect, test } from 'bun:test';
import {
  cleanChannelName,
  cleanReleaseName,
  extractYear,
  parseName,
} from '../packages/core/src/names.js';

describe('a name taken apart', () => {
  test('a film release name is a title and a year', () => {
    expect(parseName('Top.Gun.Maverick.2022.1080p.WEB-DL.x265-FLUX.mkv')).toMatchObject({
      name: 'Top Gun Maverick',
      year: 2022,
      season: null,
      episode: null,
      kind: 'movie',
    });
    expect(parseName('Oppenheimer (2023) 1080p V2 HDTS ENG x264 AAC - HushRips.mkv')).toMatchObject(
      {
        name: 'Oppenheimer',
        year: 2023,
        kind: 'movie',
      },
    );
    expect(
      parseName('www.UIndex.org - The Prestige 2006 1080p BluRay DDP 5 1 10bit H 265-iVy'),
    ).toMatchObject({
      name: 'The Prestige',
      year: 2006,
    });
  });

  test('an episode is a series with a season and an episode', () => {
    expect(
      parseName('Severance.S02E03.2160p.ATVP.WEB-DL.DDP5.1.Atmos.x265-FLUX.mkv'),
    ).toMatchObject({
      name: 'Severance',
      season: 2,
      episode: 3,
      kind: 'series',
    });
    expect(
      parseName('Pluribus (2025) Season 1 S01 (2160p ATVP WEB-DL x265 HEVC 10bit DDP 5.1 Vyndros)'),
    ).toMatchObject({
      name: 'Pluribus',
      year: 2025,
      season: 1,
      kind: 'series',
    });
    expect(parseName('The Bear 3x04 HDTV')).toMatchObject({
      name: 'The Bear',
      season: 3,
      episode: 4,
    });
  });

  test('a playlist entry is a channel, without the feed decorations', () => {
    expect(parseName('US: ESPN2 HD')).toMatchObject({ name: 'ESPN2', kind: 'channel', year: null });
    expect(parseName('TF1 FHD [Backup]')).toMatchObject({ name: 'TF1', kind: 'channel' });
    expect(parseName('30A TV Classic Movies (720p)')).toMatchObject({
      name: '30A TV Classic Movies',
      kind: 'channel',
    });
    expect(cleanChannelName('UK | Sky Sports Main Event HD')).toBe('Sky Sports Main Event');
  });

  test('a song file is music with the artist left in the name', () => {
    expect(parseName('02 - ...And Justice For All.mp3')).toMatchObject({
      name: 'And Justice For All',
      kind: 'music',
    });
    expect(parseName('Metallica - Discography [320kbps]')).toMatchObject({
      name: 'Metallica',
      kind: 'music',
    });
  });

  test('the year is the last plausible one, so a title with a number keeps it', () => {
    expect(extractYear('2001 A Space Odyssey 1968 1080p')).toBe(1968);
    expect(extractYear('Blade Runner 2049 2017')).toBe(2017);
    expect(extractYear('Nothing here')).toBeNull();
    expect(cleanReleaseName('Blade.Runner.2049.2017.1080p')).toBe('Blade Runner 2049 2017');
  });

  test('nothing in is nothing out, never a crash', () => {
    expect(parseName('')).toMatchObject({ name: '', kind: 'other' });
    expect(parseName(null)).toMatchObject({ name: '', kind: 'other' });
  });
});
