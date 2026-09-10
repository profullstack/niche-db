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

describe('a matchup', () => {
  const fixture = (raw, teams, league = null) => {
    expect(parseName(raw)).toMatchObject({
      kind: 'fixture',
      name: `${teams[0]} vs ${teams[1]}`,
      teams,
      league,
      year: null,
      season: null,
      episode: null,
    });
  };

  test('two sides around vs, v, at or @ are a fixture, in the playlist forms', () => {
    fixture('Chiefs vs Bills', ['Chiefs', 'Bills']);
    fixture('Chiefs vs. Bills', ['Chiefs', 'Bills']);
    fixture('Chiefs VS Bills', ['Chiefs', 'Bills']);
    fixture('Lakers @ Celtics', ['Lakers', 'Celtics']);
    fixture('Arsenal v Chelsea', ['Arsenal', 'Chelsea']);
    fixture('Bills at Chiefs', ['Bills', 'Chiefs']);
    fixture('Man Utd v Man City', ['Man Utd', 'Man City']);
    fixture('San Francisco 49ers at Los Angeles Rams', ['San Francisco 49ers', 'Los Angeles Rams']);
    fixture('Yankees at Red Sox', ['Yankees', 'Red Sox']);
    fixture('Saint-Étienne v Lyon', ['Saint-Étienne', 'Lyon']);
  });

  test('a league or sport label in front is the league, and comes off the name', () => {
    fixture('NFL: Chiefs vs Bills', ['Chiefs', 'Bills'], 'NFL');
    fixture('NBA | Lakers @ Celtics', ['Lakers', 'Celtics'], 'NBA');
    fixture('EPL - Arsenal v Chelsea', ['Arsenal', 'Chelsea'], 'EPL');
    fixture('NFL Chiefs vs Bills', ['Chiefs', 'Bills'], 'NFL');
    fixture('Premier League: Arsenal v Chelsea', ['Arsenal', 'Chelsea'], 'Premier League');
    // A country code is the playlist's, not a league; the label after it is.
    fixture('US: NFL: Chiefs vs Bills', ['Chiefs', 'Bills'], 'NFL');
    fixture('UK: Rangers at Celtic', ['Rangers', 'Celtic']);
    fixture('[Live] Chiefs vs Bills', ['Chiefs', 'Bills']);
  });

  test('a time, a day or a date behind comes off, and so do the feed decorations', () => {
    fixture('Rangers at Celtic 19:45', ['Rangers', 'Celtic']);
    fixture('Chiefs vs Bills 7:30 PM', ['Chiefs', 'Bills']);
    fixture('Chiefs vs Bills 7:30 PM ET', ['Chiefs', 'Bills']);
    fixture('Lakers @ Celtics Sat', ['Lakers', 'Celtics']);
    fixture('Arsenal v Chelsea 12/09', ['Arsenal', 'Chelsea']);
    fixture('Bills @ Chiefs Dec 25', ['Bills', 'Chiefs']);
    fixture('Yankees at Red Sox Sep 10th', ['Yankees', 'Red Sox']);
    fixture('Arsenal v Chelsea (Sat 19:45) HD', ['Arsenal', 'Chelsea']);
    fixture('Boca Juniors v River Plate 21:00 HD', ['Boca Juniors', 'River Plate']);
    fixture('Tonight: Chiefs vs Bills', ['Chiefs', 'Bills']);
    fixture('Lakers vs Celtics 1080p', ['Lakers', 'Celtics']);
  });

  test('a dash is a separator only when both sides look like teams', () => {
    fixture('Arsenal - Chelsea', ['Arsenal', 'Chelsea']);
    fixture('EPL - Arsenal - Chelsea', ['Arsenal', 'Chelsea'], 'EPL');
    expect(parseName('Sky Sports - Football')).toMatchObject({ kind: 'channel', teams: null });
    expect(parseName('Fox Sports - West')).toMatchObject({ kind: 'channel', teams: null });
  });

  test('what is not a matchup still parses as it did', () => {
    expect(parseName('Dune Part Two')).toMatchObject({
      name: 'Dune Part Two',
      kind: 'channel',
      teams: null,
      league: null,
    });
    // A concert, not a fixture.
    expect(parseName('Live at Wembley')).toMatchObject({
      name: 'Live at Wembley',
      kind: 'channel',
    });
    expect(parseName('Salomon vs Mon')).toMatchObject({ kind: 'channel' });
    // A release with a year is a film, whatever the title says.
    expect(parseName('Godzilla vs Kong 2021 1080p')).toMatchObject({
      name: 'Godzilla vs Kong',
      year: 2021,
      kind: 'movie',
      teams: null,
    });
    expect(parseName('US: ESPN2 HD')).toMatchObject({ name: 'ESPN2', kind: 'channel' });
    expect(parseName('UK | Sky Sports Main Event HD')).toMatchObject({ kind: 'channel' });
  });
});
