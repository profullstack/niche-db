import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  audioLinks,
  crawlPage,
  DIRECTORY_URL,
  parseDirectory,
  proscanDirectory,
  publicAddress,
  pullDirectory,
  readPublicText,
  scannerUrl,
} from '../packages/adapters/src/proscan.js';

const row = (url = 'http://scanner.example.org:5000/', name = 'Town &amp; County') =>
  `<tr><td>${name}</td><td><a href='${url}'>listen</a></td><td>US, Iowa, Example</td><td>Dispatch &amp; fire</td><td>SDS200</td><td>0</td><td><div class='green'>1</div><div class='red'>2</div></td><td>1788959519</td><td>1789294216</td></tr>`;
const html = `<table><tr><th>Web Page Header</th></tr>${row()}</table>`;
const player = `<a href='Town.m3u'>Listen Live</a><audio id='audio_player' src="HTMLAudioPlayerTown" type='audio/mp3' controls preload='none'>`;
const reader = async (url) =>
  url.endsWith('/robots.txt')
    ? { status: 404, body: '' }
    : { status: 200, body: url === DIRECTORY_URL ? html : player, url };

describe('public ProScan links', () => {
  test('parses location labels and stable URL IDs, deduplicates and skips malformed rows', () => {
    const rows = parseDirectory(
      `${html}${row()}${row('javascript:alert(1)')}<tr><td>bad</td></tr>`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Town & County',
      region: 'Iowa',
      area: 'Example',
      reachable: true,
    });
    expect(parseDirectory(row('http://scanner.example.org:5000/', 'New name'))[0].id).toBe(
      rows[0].id,
    );
  });
  test('extracts actual unclosed ProScan audio markup and playlists, without guessing', () => {
    expect(audioLinks(player, 'http://scanner.example.org:5000/')).toEqual({
      stream_url: 'http://scanner.example.org:5000/HTMLAudioPlayerTown',
      playlist_url: 'http://scanner.example.org:5000/Town.m3u',
    });
    expect(
      audioLinks('<audio><source src="/live.aac"></audio>', 'https://scanner.example.org/')
        .stream_url,
    ).toBe('https://scanner.example.org/live.aac');
    expect(audioLinks('No audio here', 'https://scanner.example.org/').stream_url).toBeNull();
    expect(
      audioLinks('<audio src="http://127.0.0.1/secret">', 'https://scanner.example.org/')
        .stream_url,
    ).toBeNull();
  });
  test('default source is seeded, so an empty configuration is enough to ingest listings', () => {
    expect(proscanDirectory.defaultSources[0].slug).toBe('scanners-proscan');
    expect(proscanDirectory.collection).toBe('crime');
    expect(proscanDirectory.needsEnv).toBeUndefined();
  });
  test('indexes all listings even with zero discovery budget; preserves known audio links', async () => {
    const entry = parseDirectory(html)[0];
    const previous = async () =>
      new Map([
        [
          entry.id,
          { stream_url: 'http://scanner.example.org:5000/live', last_checked: '2026-09-13' },
        ],
      ]);
    const result = await pullDirectory({ read: reader, maxPlayers: 0, previous });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].data.stream_url).toEndWith('/live');
    expect(result.items[0].data.coverage).toBeNull();
    expect(result.items[0].data.state).toBe('Iowa');
  });
  test('discovery records an advertised URL, not permission to rehost audio', async () => {
    const result = await pullDirectory({ read: reader });
    expect(result.items[0].data.stream_url).toEndWith('/HTMLAudioPlayerTown');
    expect(result.items[0].data.stream_reuse_allowed).toBe(false);
    expect(result.items[0].data.discovery_status).toBe('advertised');
  });
  test('robots restrictions and server removal clear stale stream links', async () => {
    const entry = parseDirectory(html)[0];
    const old = {
      player_url: entry.player,
      stream_url: `${entry.player}live`,
      directory_title: 'Town',
    };
    const previous = async () => new Map([[entry.id, old]]);
    const read = async (url) =>
      url === DIRECTORY_URL
        ? { status: 200, body: html }
        : url.includes('proscan.org')
          ? { status: 404, body: '' }
          : { status: 200, body: 'User-agent: *\nDisallow: /' };
    const result = await pullDirectory({ read, previous });
    expect(result.items[0].data.stream_url).toBeNull();
    expect(result.items[0].data.discovery_status).toBe('restricted');
    const removed = await pullDirectory({
      read: async (url) =>
        url === DIRECTORY_URL
          ? { status: 200, body: row('http://other.example.org/') }
          : reader(url),
      previous,
      cursor: { ids: [entry.id] },
      maxPlayers: 0,
    });
    expect(removed.items.find((i) => i.externalId === entry.id).data).toMatchObject({
      directory_present: false,
      stream_url: null,
      playlist_url: null,
    });
  });
  test('failed directory fetch never deletes existing data', async () => {
    await expect(
      pullDirectory({
        read: async (url) => ({ status: 200, body: url === DIRECTORY_URL ? 'changed markup' : '' }),
      }),
    ).rejects.toThrow('no recognized rows');
  });
  test('redirected player paths get their own robots checks', async () => {
    const calls = [];
    const read = async (url) => {
      calls.push(url);
      return url === 'http://scanner.example.org/'
        ? { status: 302, location: 'http://other.example.org/private' }
        : url === 'http://other.example.org/robots.txt'
          ? { status: 200, body: 'User-agent: *\nDisallow: /private' }
          : { status: 404, body: '' };
    };
    await expect(crawlPage('http://scanner.example.org/', { read })).rejects.toThrow(
      'robots disallows',
    );
    expect(calls).not.toContain('http://other.example.org/private');
  });
  test('rejects private addresses including DNS results and credentials', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.64.1.1',
      '::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(scannerUrl('http://user:pass@example.org')).toBeNull();
    await expect(
      readPublicText('http://scanner.example.org/', {
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('non-public scanner address');
  });
  test('pins a public DNS result and reads only bounded text responses', async () => {
    const requestHttp = (url, options, callback) => {
      expect(url.hostname).toBe('scanner.example.org');
      options.lookup(url.hostname, {}, (error, address, family) => {
        expect(error).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);
      });
      const req = new EventEmitter();
      req.end = () =>
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = { 'content-type': 'text/html' };
          res.destroy = () => {};
          callback(res);
          res.emit('data', Buffer.from(player));
          res.emit('end');
        });
      req.destroy = (e) => req.emit('error', e);
      return req;
    };
    const r = await readPublicText('http://scanner.example.org/', {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      requestHttp,
    });
    expect(r.body).toBe(player);
  });
});
