import { describe, expect, test } from 'bun:test';
import { slugify } from '../packages/core/src/adapter.js';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';
const { DEFAULT_FEEDS } = await import('../packages/core/src/seed.js');

const partFeeds = DEFAULT_FEEDS.filter(
  (f) => f.collection === 'automotive' && f.slug.startsWith('parts-'),
);

describe('the automotive collection, indexed by the part that failed', () => {
  test('there is a feed per major component group', () => {
    expect(partFeeds.length).toBeGreaterThanOrEqual(10);
    const slugs = partFeeds.map((f) => f.slug);
    for (const expected of [
      'parts-brakes',
      'parts-airbags',
      'parts-tires-and-wheels',
      'parts-electrical',
      'parts-fuel-system',
      'parts-engine-and-powertrain',
      'parts-steering-and-suspension',
    ]) {
      expect(slugs).toContain(expected);
    }
  });

  test('every part feed carries both recalls and complaints', () => {
    // A recall is the manufacturer admitting it; a complaint is an owner
    // noticing first. A feed with only one of them is half the story.
    for (const feed of partFeeds) {
      expect(feed.query.kinds).toEqual(['recall', 'complaint']);
    }
  });

  test('every part feed filters on at least one component tag', () => {
    for (const feed of partFeeds) {
      expect(Array.isArray(feed.query.tags)).toBe(true);
      expect(feed.query.tags.length).toBeGreaterThan(0);
    }
  });

  test('slugs and names are unique', () => {
    const slugs = partFeeds.map((f) => f.slug);
    const names = partFeeds.map((f) => f.name);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every part feed explains itself', () => {
    for (const feed of partFeeds) {
      expect(typeof feed.description).toBe('string');
      expect(feed.description.length).toBeGreaterThan(20);
    }
  });
});

describe('the tags that look misspelt and are not', () => {
  /*
   * `slugify` drops "/" rather than turning it into a hyphen, so an NHTSA
   * component containing one collapses into a single run-on word. Both of
   * these were checked against the live API: the run-on form returns items and
   * the hyphenated form returns nothing. These tests exist so nobody
   * "corrects" the spelling and silently empties two feeds.
   */
  test('slugify drops a slash instead of hyphenating it', () => {
    expect(slugify('LATCHES/LOCKS/LINKAGES')).toBe('latcheslockslinkages');
    expect(slugify('VISIBILITY/WIPER')).toBe('visibilitywiper');
  });

  test('it does hyphenate spaces and commas, which is why most tags look normal', () => {
    expect(slugify('SERVICE BRAKES, AIR')).toBe('service-brakes-air');
    expect(slugify('FUEL SYSTEM, GASOLINE')).toBe('fuel-system-gasoline');
    expect(slugify('BACK OVER PREVENTION')).toBe('back-over-prevention');
  });

  test('the feeds use the run-on spellings that are actually in the data', () => {
    const tags = partFeeds.flatMap((f) => f.query.tags);
    expect(tags).toContain('latcheslockslinkages');
    expect(tags).toContain('visibilitywiper');
    expect(tags).not.toContain('latches-locks-linkages');
    expect(tags).not.toContain('visibility-wiper');
  });

  test('every tag is what slugify would produce for some component', () => {
    // Guards against a hand-written tag that no adapter could ever emit.
    for (const tag of partFeeds.flatMap((f) => f.query.tags)) {
      expect(slugify(tag)).toBe(tag);
    }
  });
});
