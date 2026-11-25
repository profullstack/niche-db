import { describe, expect, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

const {
  longestPrefix,
  mapLink,
  ownerQuery,
  ownersFromBindings,
  parsePrefixTable,
  placeOf,
  timeZonesOf,
  wikidataOwners,
  writtenForms,
} = await import('../apps/web/src/lib/phone-place.js');
const { parseNumber } = await import('../apps/web/src/lib/phone.js');

const WH = parseNumber('+1 202-456-1111');

/** Wikidata's answer for the White House switchboard, as it came on 2026-11-25. */
const WIKIDATA_WH = {
  results: {
    bindings: [
      {
        item: { value: 'http://www.wikidata.org/entity/Q35525' },
        itemLabel: { value: 'White House' },
        itemDescription: {
          value: 'official residence and office of the President of the United States',
        },
        addr: { value: '1600 Pennsylvania Avenue NW, Washington, DC 20500' },
        coord: { value: 'Point(-77.036666666 38.897777777)' },
        site: { value: 'https://www.whitehouse.gov' },
        placeLabel: { value: 'Washington, D.C.' },
      },
    ],
  },
};

describe('phone place', () => {
  test('prefix tables: the longest prefix wins', () => {
    const t = parsePrefixTable('# comment\n1202|Washington D.C.\n1|North America\n4420|London\n');
    expect(longestPrefix(t, '12024561111')).toBe('Washington D.C.');
    expect(longestPrefix(t, '13105550100')).toBe('North America');
    expect(longestPrefix(t, '442079460000')).toBe('London');
    expect(longestPrefix(t, '33123456789')).toBeNull();
  });

  test('place and time zone come from the country file for the calling code', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      if (url.endsWith('/geocoding/en/1.txt')) return new Response('1202|Washington D.C.\n');
      if (url.endsWith('/timezones/map_data.txt'))
        return new Response(
          '1|America/Adak&America/Chicago&America/Denver&America/New_York&America/Phoenix\n1202|America/New_York\n',
        );
      return new Response('', { status: 404 });
    };
    expect(await placeOf(WH, { fetchImpl })).toBe('Washington D.C.');
    expect(await timeZonesOf(WH, { fetchImpl })).toEqual(['America/New_York']);
    expect(asked[0]).toContain('/v9.0.44/resources/geocoding/en/1.txt');
  });

  test('Wikidata is asked for every way the number is written, and never for people', () => {
    const forms = writtenForms(WH);
    expect(forms).toEqual(
      expect.arrayContaining([
        '+12024561111',
        '+1 202 456 1111',
        '+1-202-456-1111',
        '+1 202-456-1111',
        '(202) 456-1111',
      ]),
    );
    const q = ownerQuery(WH);
    expect(q).toContain('"+1-202-456-1111"');
    expect(q).toContain('MINUS { ?item wdt:P31 wd:Q5 }');
  });

  test('an owner carries its address, coordinates and website', () => {
    const [o] = ownersFromBindings(WIKIDATA_WH);
    expect(o).toMatchObject({
      wikidata: 'Q35525',
      name: 'White House',
      address: '1600 Pennsylvania Avenue NW, Washington, DC 20500',
      website: 'https://www.whitehouse.gov',
      place: 'Washington, D.C.',
    });
    expect(o.lat).toBeCloseTo(38.8978, 3);
    expect(o.lon).toBeCloseTo(-77.0367, 3);
  });

  test('a slow or failing Wikidata is no owners, not an error', async () => {
    const n = parseNumber('+1 415 555 0100');
    expect(
      await wikidataOwners(n, { fetchImpl: async () => new Response('', { status: 500 }) }),
    ).toEqual([]);
  });

  test('the map pins coordinates, else searches the place', () => {
    expect(mapLink({ lat: 38.9, lon: -77 })).toBe(
      'https://www.openstreetmap.org/?mlat=38.9&mlon=-77#map=17/38.9/-77',
    );
    expect(mapLink({ query: 'Washington D.C.' })).toBe(
      'https://www.openstreetmap.org/search?query=Washington%20D.C.',
    );
    expect(mapLink({})).toBeNull();
  });
});
