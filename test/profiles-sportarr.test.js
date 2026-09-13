import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import {
  LOOKUPS,
  labelIds,
  parsePersons,
  personItem,
  pickCandidate,
  profileDoc,
  readEntity,
  readLabels,
  resumeAt,
  sportarrPersons,
  wikidataDate,
} from '../packages/adapters/src/sportarr-persons.js';
import { normaliseItem } from '../packages/core/src/adapter.js';
import { assemble, keysOf } from '../packages/core/src/profiles.js';

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`../packages/adapters/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const page = await fixture('sportarr-persons-page.json');
const searchMcGregor = await fixture('wikidata-search-mcgregor.json');
const searchLundberg = await fixture('wikidata-search-lundberg.json');
const entityMcGregor = await fixture('wikidata-entity-mcgregor.json');
const labelsMcGregor = await fixture('wikidata-labels-mcgregor.json');

const mcgregor = { name: 'Conor McGregor', slug: 'conor-mcgregor', shortId: 'pn-001571', id: 'x' };

describe('reading Sportarr', () => {
  test('a page is names with slugs, deduped, with the paging', () => {
    const out = parsePersons(page);
    expect(out.page).toBe(1);
    expect(out.totalPages).toBe(2235);
    expect(out.total).toBe(111733);
    expect(out.persons.length).toBeGreaterThan(25);
    expect(out.persons[0]).toMatchObject({ name: '2Die4', slug: '2die4', shortId: 'pn-150320' });
    expect(new Set(out.persons.map((p) => p.slug)).size).toBe(out.persons.length);
  });
});

describe('reading Wikidata', () => {
  test('the first hit whose label is the name and whose description is a sportsperson', () => {
    expect(pickCandidate(searchMcGregor, 'Conor McGregor')).toEqual({
      qid: 'Q5162259',
      description: 'Irish boxer and mixed martial arts fighter',
    });
    // Three humans named Arvid Lundberg: a footballer, a hockey player, a political prisoner.
    expect(pickCandidate(searchLundberg, 'Arvid Lundberg')?.qid).toBe('Q125258059');
    expect(pickCandidate(searchLundberg, 'Arvid Lundberg')?.description).toContain('footballer');
    expect(
      pickCandidate(
        { search: [{ id: 'Q1', label: 'Someone', description: 'Norwegian political prisoner' }] },
        'Someone',
      ),
    ).toBeNull();
    expect(pickCandidate(searchMcGregor, 'Conor McGregor: The Irishman')).toBeNull();
    expect(pickCandidate({}, 'x')).toBeNull();
  });

  test('an entity is a human with socials, sport, team, country and a birth date', () => {
    const ent = readEntity(entityMcGregor, 'Q5162259');
    expect(ent).toMatchObject({
      label: 'Conor McGregor',
      twitter: 'TheNotoriousMMA',
      instagram: 'thenotoriousmma',
      facebook: 'thenotoriousmma',
      youtube: 'UCAddYoRhmxqsRSt4zV4E2_g',
      website: 'https://shop.conormcgregor.com/',
      born: '1988-07-14',
      wikipedia: 'Conor McGregor',
      countries: ['Q27'],
    });
    expect(ent.sports).toEqual(['Q114466', 'Q2631720']);
    expect(ent.image).toMatch(/\.jpg$/);
    expect(labelIds(ent)).toEqual(['Q114466', 'Q2631720', 'Q22032159', 'Q27']);
    expect(
      readEntity(
        {
          entities: {
            Q1: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q11424' } } } }] } },
          },
        },
        'Q1',
      ),
    ).toBeNull();
    expect(readEntity({}, 'Q9')).toBeNull();
  });

  test('dates by precision', () => {
    expect(wikidataDate({ time: '+1988-07-14T00:00:00Z', precision: 11 })).toBe('1988-07-14');
    expect(wikidataDate({ time: '+1988-07-00T00:00:00Z', precision: 10 })).toBe('1988-07');
    expect(wikidataDate({ time: '+1988-00-00T00:00:00Z', precision: 9 })).toBe('1988');
    expect(wikidataDate(null)).toBeNull();
  });
});

describe('the document', () => {
  const ent = readEntity(entityMcGregor, 'Q5162259');
  const labels = readLabels(labelsMcGregor);

  test('is a valid OpenProfile.md whose accounts are the identity keys', () => {
    const doc = profileDoc(mcgregor, ent, labels);
    expect(doc).not.toContain('—');
    const parsed = assemble([doc], null);
    expect(parsed.name).toBe('Conor McGregor');
    expect(parsed.headline).toBe('Irish boxer and mixed martial arts fighter.');
    expect(parsed.identity.find((e) => e.key === 'Kind')?.value).toBe('person');
    expect(parsed.identity.find((e) => e.key === 'Handle')?.value).toBe('conor-mcgregor');
    expect(parsed.identity.find((e) => e.key === 'Avatar')?.value).toMatch(
      /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//,
    );
    const keys = keysOf(doc);
    expect(keys.some((k) => k.includes('x.com/thenotoriousmma'))).toBe(true);
    expect(keys.some((k) => k.includes('instagram.com/thenotoriousmma'))).toBe(true);
    expect(keys.some((k) => k.includes('sportarr.net/browse/persons/pn-001571'))).toBe(true);
    expect(keys.some((k) => k.includes('wikidata.org/wiki/q5162259'))).toBe(true);
    expect(doc).toContain('## Topics');
    expect(doc).toContain('- Mixed martial arts');
    expect(doc).toContain('Born 1988-07-14, from Ireland');
    expect(doc).toContain('Compiled by NicheDB from Sportarr (pn-001571) and Wikidata (Q5162259)');
  });

  test('the item is what the core absorbs', () => {
    const item = normaliseItem(personItem(mcgregor, ent, labels, '2026-09-13T05:00:00.000Z'));
    expect(item.kind).toBe('openprofile');
    expect(item.externalId).toBe('https://sportarr.net/api/public/v1/persons/conor-mcgregor');
    expect(item.url).toBe('https://sportarr.net/browse/persons/pn-001571');
    expect(item.data.app).toBe('sportarr');
    expect(item.data.source_url).toBe(item.externalId);
    expect(typeof item.data.doc).toBe('string');
    expect(item.tags).toContain('from:sportarr');
    expect(item.tags).toContain('sport:mixed-martial-arts');
  });
});

describe('the walk', () => {
  /** Two Sportarr pages; only McGregor resolves on Wikidata. */
  function provider() {
    const urls = [];
    const persons = [
      mcgregor,
      { name: 'Arvid Nobody', slug: 'arvid-nobody', shortId: 'pn-2' },
      { name: 'Zed', slug: 'zed', shortId: 'pn-3' },
    ];
    const listing = (p) => ({
      items: p === 1 ? persons.slice(0, 2) : persons.slice(2),
      page: p,
      pageSize: 50,
      totalPages: 2,
      total: 3,
    });
    const http = {
      async request(url) {
        urls.push(url);
        const u = new URL(url);
        const body = (() => {
          if (u.hostname === 'sportarr.net')
            return listing(Number(u.searchParams.get('page')) || 1);
          if (u.searchParams.get('action') === 'wbsearchentities') {
            return u.searchParams.get('search') === 'Conor McGregor'
              ? searchMcGregor
              : { search: [] };
          }
          if (u.searchParams.get('action') === 'wbgetentities') return labelsMcGregor;
          if (u.pathname.includes('Q5162259')) return entityMcGregor;
          return {};
        })();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      async json(url) {
        throw new Error(`500 from ${url}`);
      },
    };
    return { http, urls };
  }
  const run = (config, cursor, p) =>
    sportarrPersons.pull({
      config: { lookups: LOOKUPS, pauseMs: 0, ...config },
      cursor,
      env: {},
      http: p.http,
      log: () => {},
      deadline: Number.POSITIVE_INFINITY,
    });

  test('walks both pages, keeps only the person Wikidata knows, and starts over when done', async () => {
    const p = provider();
    const out = await run({}, {}, p);
    expect(out.items.map((i) => i.title)).toEqual(['Conor McGregor']);
    expect(out.cursor).toMatchObject({ page: 1, index: 0, totalPages: 2 });
    expect(out.cursor.walkedAt).toMatch(/^\d{4}-/);
    expect(out.nextInMinutes).toBeUndefined();
    expect(out.note).toContain('1 people from 3 names');
    // page1, search McGregor, entity, labels, search Nobody, page2, search Zed
    expect(p.urls).toHaveLength(7);
  });

  test('stops at the cap mid-page and resumes at the same index', async () => {
    const p = provider();
    const first = await run({ lookups: 4 }, {}, p);
    expect(first.items).toHaveLength(1);
    expect(first.cursor).toMatchObject({ page: 1, index: 1 });
    expect(first.nextInMinutes).toBe(10);
    // page 1 again, search Nobody (no match), page 2: the cap lands before Zed is searched
    const second = await run({ lookups: 3 }, first.cursor, p);
    expect(second.items).toHaveLength(0);
    expect(second.cursor).toMatchObject({ page: 2, index: 0 });
  });

  test('resume defaults', () => {
    expect(resumeAt({})).toEqual({ page: 1, index: 0 });
    expect(resumeAt({ page: 7, index: 12 })).toEqual({ page: 7, index: 12 });
    expect(resumeAt({ page: 0, index: -1 })).toEqual({ page: 1, index: 0 });
  });
});
