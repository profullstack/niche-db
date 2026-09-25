import { describe, expect, test } from 'bun:test';
import { ENRICHERS, enricherByName } from '../packages/enrichers/src/index.js';
import {
  appliesTo,
  bboxAround,
  distanceM,
  isAuthError,
  mapillary,
  pointOf,
  rank,
  toImage,
} from '../packages/enrichers/src/mapillary.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const at = (block) => ({ title: 'somewhere', data: block });

describe('pointOf follows the database’s own geo convention', () => {
  test('reads data.location', () => {
    expect(pointOf(at({ location: { lat: 37.3, lon: -121.9 } }))).toEqual({
      lat: 37.3,
      lon: -121.9,
    });
  });

  test('reads data.place, data.position and data.geometry too', () => {
    expect(pointOf(at({ place: { latitude: 1, longitude: 2 } }))).toEqual({ lat: 1, lon: 2 });
    expect(pointOf(at({ position: { lat: 3, lng: 4 } }))).toEqual({ lat: 3, lon: 4 });
    expect(pointOf(at({ geometry: { lat: 5, long: 6 } }))).toEqual({ lat: 5, lon: 6 });
  });

  test('reads a bare point on data itself', () => {
    expect(pointOf(at({ lat: 51.5, lon: -0.1 }))).toEqual({ lat: 51.5, lon: -0.1 });
  });

  test('reads GeoJSON, which is [lon, lat] and is the order people get wrong', () => {
    const p = pointOf(at({ location: { type: 'Point', coordinates: [-121.9, 37.3] } }));
    expect(p).toEqual({ lat: 37.3, lon: -121.9 });
  });

  test('refuses (0, 0), which is the Atlantic and means a missing coordinate', () => {
    expect(pointOf(at({ location: { lat: 0, lon: 0 } }))).toBeNull();
  });

  test('refuses an out-of-range coordinate', () => {
    expect(pointOf(at({ location: { lat: 91, lon: 0 } }))).toBeNull();
    expect(pointOf(at({ location: { lat: 0, lon: 181 } }))).toBeNull();
  });

  test('is null for an item with no location at all', () => {
    expect(pointOf(at({}))).toBeNull();
    expect(pointOf({ data: null })).toBeNull();
  });

  test('appliesTo is exactly “can this be placed”', () => {
    expect(appliesTo(at({ location: { lat: 1, lon: 2 } }))).toBe(true);
    expect(appliesTo(at({}))).toBe(false);
  });
});

describe('bboxAround', () => {
  test('is minLon,minLat,maxLon,maxLat, as Mapillary wants', () => {
    const [minLon, minLat, maxLon, maxLat] = bboxAround({ lat: 37.3, lon: -121.9 })
      .split(',')
      .map(Number);
    expect(minLon).toBeLessThan(maxLon);
    expect(minLat).toBeLessThan(maxLat);
    expect(maxLat).toBeCloseTo(37.3012, 4);
  });

  test('stays well inside Mapillary’s 0.01° ceiling, formalised January 2026', () => {
    const [minLon, minLat, maxLon, maxLat] = bboxAround({ lat: 0, lon: 0 }).split(',').map(Number);
    expect(maxLon - minLon).toBeLessThan(0.01);
    expect(maxLat - minLat).toBeLessThan(0.01);
  });
});

describe('distanceM', () => {
  test('is zero for the same point', () => {
    expect(distanceM({ lat: 37.3, lon: -121.9 }, { lat: 37.3, lon: -121.9 })).toBe(0);
  });

  test('is about 111 m for a thousandth of a degree of latitude', () => {
    expect(distanceM({ lat: 37.3, lon: -121.9 }, { lat: 37.301, lon: -121.9 })).toBeGreaterThan(
      100,
    );
    expect(distanceM({ lat: 37.3, lon: -121.9 }, { lat: 37.301, lon: -121.9 })).toBeLessThan(125);
  });
});

describe('toImage', () => {
  /* The shape graph.mapillary.com returns for the requested fields. */
  const raw = {
    id: '1234567890',
    thumb_1024_url: 'https://scontent.mapillary.com/x.jpg',
    captured_at: 1700000000000,
    compass_angle: 271.5,
    geometry: { type: 'Point', coordinates: [-121.9, 37.3] },
    creator: { username: 'somebody' },
  };

  test('keeps the credit, because CC BY-SA requires it', () => {
    const img = toImage(raw, { lat: 37.3, lon: -121.9 });
    expect(img.by).toBe('somebody');
    expect(img.license).toBe('CC-BY-SA-4.0');
    expect(img.licenseUrl).toContain('creativecommons.org');
  });

  test('turns the epoch millis into a readable time', () => {
    expect(toImage(raw, null).capturedAt).toBe('2023-11-14T22:13:20.000Z');
  });

  test('works out how far away the photo was taken', () => {
    expect(toImage(raw, { lat: 37.3, lon: -121.9 }).metresAway).toBe(0);
  });

  test('links back to the image on Mapillary', () => {
    expect(toImage(raw, null).page).toContain('pKey=1234567890');
  });

  test('is null without an id or a usable thumbnail', () => {
    expect(toImage({ id: '1' }, null)).toBeNull();
    expect(toImage({ thumb_1024_url: 'x' }, null)).toBeNull();
  });
});

describe('rank', () => {
  const near = { id: '1', thumb_1024_url: 'a', geometry: { coordinates: [-121.9, 37.3] } };
  const far = { id: '2', thumb_1024_url: 'b', geometry: { coordinates: [-121.905, 37.305] } };

  test('nearest first, because a photo 400 m away is not this address', () => {
    const out = rank([far, near], { lat: 37.3, lon: -121.9 });
    expect(out[0].id).toBe('1');
  });

  test('drops anything unusable rather than returning a hole', () => {
    expect(rank([{ id: 'x' }, near], { lat: 37.3, lon: -121.9 })).toHaveLength(1);
  });
});

describe('isAuthError', () => {
  test('recognises code 190, which arrives with a 500', () => {
    expect(isAuthError({ error: { code: 190, message: 'Invalid OAuth 2.0 Access Token' } })).toBe(
      true,
    );
  });

  test('recognises the message even without the code', () => {
    expect(isAuthError({ error: { message: 'Invalid OAuth 2.0 Access Token' } })).toBe(true);
  });

  test('does not mistake an unrelated error for an auth failure', () => {
    expect(isAuthError({ error: { message: 'upstream unavailable', code: 2 } })).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError({})).toBe(false);
  });
});

describe('registration', () => {
  test('it is registered', () => {
    expect(enricherByName('mapillary')).toBeTruthy();
    expect(ENRICHERS).toContain(mapillary);
  });

  test('it declares the token it needs, so it is simply off without one', () => {
    expect(mapillary.needsEnv).toEqual(['mapillaryToken']);
  });

  test('it is default-on for the collections that have places in them', () => {
    expect(mapillary.collections).toContain('listings');
    expect(mapillary.collections).toContain('housing');
  });

  test('it refuses to run without a token rather than failing quietly', async () => {
    await expect(
      mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), { env: {}, http: {} }),
    ).rejects.toThrow(/MAPILLARY_TOKEN/);
  });

  test('an item with no coordinates yields nothing, without a request', async () => {
    let called = false;
    const http = {
      request: async () => {
        called = true;
        return { ok: true, json: async () => ({ data: [] }) };
      },
    };
    const out = await mapillary.enrich(at({}), { env: { mapillaryToken: 't' }, http });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  test('nothing nearby is stored as an answer, so the item is not re-asked forever', async () => {
    const http = {
      request: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }),
    };
    const out = await mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), {
      env: { mapillaryToken: 't' },
      http,
    });
    expect(out.images).toEqual([]);
    expect(out.searchedAt).toBeTruthy();
  });

  test('a rejected token says so rather than looking like “no imagery here”', async () => {
    const http = { request: async () => ({ ok: false, status: 401, json: async () => null }) };
    await expect(
      mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), {
        env: { mapillaryToken: 'bad' },
        http,
      }),
    ).rejects.toThrow(/rejected the token/);
  });

  test('a bad token arriving as HTTP 500 is still named as a bad token', async () => {
    /*
     * Measured against the live endpoint on 2026-09-25: Mapillary answers an
     * invalid token with 500, not 401. Reporting the status alone would send
     * somebody to Mapillary's status page instead of to their token.
     */
    const http = {
      request: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: { message: 'Invalid OAuth 2.0 Access Token', type: 'MLYApiException', code: 190 },
        }),
      }),
    };
    await expect(
      mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), {
        env: { mapillaryToken: 'bad' },
        http,
      }),
    ).rejects.toThrow(/rejected the token: Invalid OAuth/);
  });

  test('a genuine outage is reported as an outage, not as a bad token', async () => {
    const http = {
      request: async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: 'upstream' } }),
      }),
    };
    await expect(
      mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), {
        env: { mapillaryToken: 't' },
        http,
      }),
    ).rejects.toThrow(/answered 503/);
  });

  test('a result carries the licence and says what it is not', async () => {
    const http = {
      request: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: '9',
              thumb_1024_url: 'https://x/y.jpg',
              geometry: { coordinates: [2, 1] },
              creator: { username: 'who' },
            },
          ],
        }),
      }),
    };
    const out = await mapillary.enrich(at({ location: { lat: 1, lon: 2 } }), {
      env: { mapillaryToken: 't' },
      http,
    });
    expect(out.license).toBe('CC-BY-SA-4.0');
    expect(out.images[0].by).toBe('who');
    expect(out.note).toMatch(/not the property/i);
  });
});
