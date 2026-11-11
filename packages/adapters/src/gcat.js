import { defineAdapter, slugify } from '@nichedb/core/adapter';

/**
 * Every object ever catalogued in Earth orbit: Jonathan McDowell's GCAT.
 *
 * GCAT (planet4589.org/space/gcat) is the General Catalog of Artificial Space
 * Objects, about 70,000 rows: every payload, rocket stage, component and piece
 * of debris with a US satellite catalogue (NORAD) number, with owner, maker,
 * launch and decay dates, mass, orbit and status. It is CC-BY, keyless, and
 * updated every few days, and it is the catalogue the space-history community
 * cites. The rows are kept as GCAT writes them and credited on every one.
 *
 * WHY NOT CELESTRAK
 *
 * CelesTrak's SATCAT is the obvious source and it does not answer from our
 * server: the connection times out (an address block, not a slow server).
 * GCAT carries the same objects with more fields. Live orbital elements for a
 * satellite's current position come from SatNOGS DB at page time instead.
 *
 * THE FILE
 *
 * satcat.tsv: a header line starting `#`, a `# Updated` line, then
 * tab-separated rows whose fields are space-padded. `-` is GCAT's empty.
 * Dates are written "1957 Oct  4", optionally followed by a time and a `?`
 * for uncertainty.
 */

const URL_TSV = 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv';
const BATCH = 1000;

export const OBJECT_TYPE = {
  P: 'payload',
  R: 'rocket stage',
  C: 'component',
  D: 'debris',
};

export const STATUS = {
  O: 'in orbit',
  OX: 'in orbit, no longer tracked',
  R: 'reentered',
  D: 'deorbited',
  L: 'landed',
  AO: 'attached to another object, in orbit',
  AR: 'attached to another object, reentered',
  AL: 'attached to another object, landed',
  DK: 'docked',
  DSO: 'deep space',
  E: 'exploded',
  N: 'no orbit reached',
  TFR: 'transferred to another catalogue',
  GRP: 'part of a combined spacecraft (a station module)',
  ATT: 'attached to another object',
  'R?': 'probably reentered',
  'L?': 'probably landed',
};

/**
 * Statuses for an object that is still up there, and for one that is not.
 * GCAT has more codes than these (ATT, DSA, ERR, REL...); for those `inOrbit`
 * is null, unknown, rather than a guess either way. The ISS modules are GRP:
 * an early version counted every code not listed as up as down, and the ISS
 * page lost its position.
 */
const UP = new Set(['O', 'OX', 'AO', 'DK', 'DSO', 'GRP']);
const DOWN = new Set(['R', 'D', 'L', 'AR', 'AL', 'E', 'N', 'R?', 'L?']);

export const ORBIT = {
  LLEO: 'very low Earth orbit',
  LEO: 'low Earth orbit',
  MEO: 'medium Earth orbit',
  GTO: 'geostationary transfer orbit',
  GEO: 'geosynchronous orbit',
  HEO: 'highly elliptical orbit',
  EEO: 'extremely eccentric orbit',
  CLO: 'cislunar orbit',
  DSO: 'deep space',
};

const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && s !== '-' ? s : null;
};

/** "1957 Oct  4 1933?" to "1957-10-04", or null. Month-only dates keep the 1st. */
export function gcatDate(v) {
  const s = clean(v);
  if (!s) return null;
  const m = /^(\d{4})(?:\s+([A-Z][a-z]{2}))?(?:\s+(\d{1,2}))?/.exec(s);
  if (!m) return null;
  const mo = m[2] ? MONTHS[m[2]] : 1;
  if (!mo) return null;
  const d = Number(m[3] ?? 1);
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const numOrNull = (v) => {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** The family a name belongs to: "Starlink 38086" is starlink, "Cosmos 2553" is cosmos. */
export function family(name) {
  const m = /^([A-Za-z][A-Za-z.-]*(?: [A-Za-z][A-Za-z.-]*)?)[ -]\d+[A-Z]?$/.exec(
    String(name ?? ''),
  );
  return m ? slugify(m[1]) : null;
}

/** One satcat.tsv row as an item. */
export function toItem(line) {
  if (!line || line.startsWith('#')) return null;
  const f = line.split('\t');
  const jcat = clean(f[0]);
  const name = clean(f[5]);
  if (!jcat || !name) return null;
  const typeCode = String(f[4] ?? '').trim()[0];
  if (typeCode === 'Z') return null; // spurious entries, kept by GCAT for the record
  const objectType = OBJECT_TYPE[typeCode] ?? 'object';
  const norad = numOrNull(f[1]);
  const designator = clean(f[3]);
  const launched = gcatDate(f[7]);
  const decayed = gcatDate(f[11]);
  const statusCode = clean(f[12]);
  const status = STATUS[statusCode] ?? statusCode;
  const up = UP.has(statusCode) ? true : DOWN.has(statusCode) ? false : null;
  const owner = clean(f[14]);
  const state = clean(f[15]);
  const opOrbit = clean(f[39]);
  const orbitKey = opOrbit?.split('/')[0] ?? null;
  const orbit = orbitKey ? (ORBIT[orbitKey] ?? opOrbit) : null;
  const perigee = numOrNull(f[33]);
  const apogee = numOrNull(f[35]);
  const inc = numOrNull(f[37]);
  const fam = objectType === 'payload' ? family(name) : null;

  return {
    externalId: jcat,
    kind: objectType === 'payload' ? 'satellite' : 'space-object',
    title: `${name}${designator ? ` (${designator})` : ''}`,
    summary: [
      `${name}`,
      norad ? `, NORAD ${norad}` : '',
      `, is a ${objectType}`,
      clean(f[6]) && clean(f[6]) !== name ? ` (${clean(f[6])})` : '',
      launched ? ` launched ${launched}` : '',
      state ? ` by ${state}` : '',
      owner ? `, owner ${owner}` : '',
      clean(f[16]) ? `, built by ${clean(f[16])}` : '',
      `. ${status ? status[0].toUpperCase() + status.slice(1) : 'Status unknown'}`,
      decayed ? ` ${decayed}` : '',
      up && orbit
        ? `, ${orbit}${perigee !== null && apogee !== null ? ` ${perigee} x ${apogee} km` : ''}${inc !== null ? ` at ${inc}°` : ''}`
        : '',
      '.',
    ].join(''),
    url: norad
      ? `https://celestrak.org/satcat/table-satcat.php?CATNR=${norad}`
      : 'https://planet4589.org/space/gcat/',
    publishedAt: launched,
    timeKnown: false,
    precision: 'day',
    tags: [
      'space',
      slugify(objectType),
      up === true ? 'in-orbit' : up === false ? 'down' : null,
      statusCode ? `status-${slugify(statusCode)}` : null,
      state ? `state-${slugify(state)}` : null,
      owner ? `owner-${slugify(owner)}` : null,
      orbitKey ? `orbit-${slugify(orbitKey)}` : null,
      launched ? `launched-${launched.slice(0, 4)}` : null,
      decayed ? `decayed-${decayed.slice(0, 4)}` : null,
      fam ? `family-${fam}` : null,
      norad ? `norad-${norad}` : null,
    ].filter(Boolean),
    data: {
      jcat,
      norad,
      designator,
      launchTag: clean(f[2]),
      name,
      payloadName: clean(f[6]),
      objectType,
      family: fam,
      launchedAt: launched,
      separatedAt: gcatDate(f[9]),
      parent: clean(f[8]),
      primary: clean(f[10]),
      decayedAt: decayed,
      status,
      statusCode,
      inOrbit: up,
      destination: clean(f[13]),
      owner,
      state,
      manufacturer: clean(f[16]),
      bus: clean(f[17]),
      motor: clean(f[18]),
      massKg: numOrNull(f[19]),
      dryMassKg: numOrNull(f[21]),
      totalMassKg: numOrNull(f[23]),
      lengthM: numOrNull(f[25]),
      diameterM: numOrNull(f[27]),
      spanM: numOrNull(f[29]),
      shape: clean(f[31]),
      orbitEpoch: gcatDate(f[32]),
      perigeeKm: perigee,
      apogeeKm: apogee,
      inclinationDeg: inc,
      orbitClass: opOrbit,
      orbit,
      altNames: clean(f[41]),
      source: 'GCAT, Jonathan C. McDowell, planet4589.org (CC-BY)',
      credit:
        'McDowell, Jonathan C., 2020. General Catalog of Artificial Space Objects, Release 1.x, https://planet4589.org/space/gcat',
      dataset: URL_TSV,
    },
  };
}

export const gcatSatcat = defineAdapter({
  name: 'gcat-satcat',
  title: 'GCAT space object catalogue',
  collection: 'satellites',
  description:
    'Every catalogued object in Earth orbit since Sputnik, about 70,000: satellites, rocket stages and debris, with owner, country, maker, launch and reentry dates, mass and orbit, from Jonathan McDowell’s General Catalog of Artificial Space Objects (CC-BY).',
  docs: 'https://planet4589.org/space/gcat/web/intro/index.html',
  kinds: ['satellite', 'space-object'],
  cadenceMinutes: 24 * 60,
  budgetMs: 30 * 60_000,
  defaultSources: [{ slug: 'gcat-satcat', name: 'GCAT: every catalogued space object' }],

  async *pull({ http, log }) {
    const text = await http.text(URL_TSV, { timeoutMs: 5 * 60_000 });
    const updated = /^# Updated (.+)$/m.exec(text)?.[1]?.trim() ?? null;
    let batch = [];
    let wrote = 0;
    for (const line of text.split('\n')) {
      const item = toItem(line.replace(/\r$/, ''));
      if (!item) continue;
      batch.push(item);
      if (batch.length >= BATCH) {
        wrote += batch.length;
        yield { items: batch };
        batch = [];
      }
    }
    if (batch.length) {
      wrote += batch.length;
      yield { items: batch };
    }
    log(`${wrote} objects, GCAT updated ${updated}`);
    return { cursor: { updated }, note: `${wrote} objects (GCAT ${updated ?? 'date unknown'})` };
  },
});
