import { rm, stat } from 'node:fs/promises';
import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { dumpDir, zipMemberLines } from '@nichedb/core/dump';

/**
 * Every aircraft on the US civil register, one row per N-number.
 *
 * The FAA publishes the whole register as one zip every night
 * (ReleasableAircraft.zip, ~73 MB, 319k aircraft in MASTER.txt), public
 * domain. MASTER.txt names a model by a seven-digit code; ACFTREF.txt says
 * what that code is (maker, model, seats, engines, weight class), and both are
 * joined here so the row reads "N172SP: 1998 Cessna 172S".
 *
 * THE USER AGENT
 *
 * registry.faa.gov sits behind a bot wall that answers 403 to any user agent
 * carrying a URL -- `niche-db/0.1 (+https://nichedb.dev)` is refused,
 * `niche-db/0.1` is served. So this adapter sends the bare name.
 *
 * PEOPLE
 *
 * About half the register is owned by individuals, and the FAA prints their
 * home addresses. The FAA's own lookup is linked from every row for anyone who
 * needs that; this collection keeps the city, state and country and drops the
 * name and street for registrant types that are people (individual, co-owned,
 * non-citizen co-owned). Companies, partnerships, LLCs and governments keep
 * their names: who operates an aircraft is the point of a register.
 *
 * THE ICAO ADDRESS
 *
 * MODE S CODE HEX is the 24-bit address the transponder broadcasts, the `hex`
 * every ADS-B feed keys on, so /airplanes can answer "what is A004B3" and join
 * a live position from adsb.lol to the registration.
 */

const ZIP_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';
const UA = 'niche-db/0.1';
const BATCH = 1000;

export const REGISTRANT = {
  1: 'individual',
  2: 'partnership',
  3: 'corporation',
  4: 'co-owned',
  5: 'government',
  7: 'llc',
  8: 'non-citizen corporation',
  9: 'non-citizen co-owned',
};

/** Registrant types that are people, whose name and street are not kept. */
export const PERSONAL = new Set(['1', '4', '9']);

export const AIRCRAFT_TYPE = {
  1: 'glider',
  2: 'balloon',
  3: 'blimp',
  4: 'fixed wing single engine',
  5: 'fixed wing multi engine',
  6: 'rotorcraft',
  7: 'weight-shift control',
  8: 'powered parachute',
  9: 'gyroplane',
  H: 'hybrid lift',
  O: 'other',
};

export const ENGINE_TYPE = {
  0: 'none',
  1: 'reciprocating',
  2: 'turboprop',
  3: 'turboshaft',
  4: 'turbojet',
  5: 'turbofan',
  6: 'ramjet',
  7: '2 cycle',
  8: '4 cycle',
  9: 'unknown',
  10: 'electric',
  11: 'rotary',
};

export const CERTIFICATION = {
  1: 'standard',
  2: 'limited',
  3: 'restricted',
  4: 'experimental',
  5: 'provisional',
  6: 'multiple',
  7: 'primary',
  8: 'special flight permit',
  9: 'light sport',
};

export const STATUS = {
  V: 'valid',
  T: 'valid (trainee)',
  M: 'valid (manufacturer dealer certificate)',
  R: 'registration pending',
  A: 'triennial form returned undelivered',
  S: 'second triennial form not returned',
  D: 'expired dealer',
  E: 'revoked by enforcement action',
  N: 'non-citizen flight hour report missing',
  W: 'ineffective or invalid',
  X: 'enforcement letter',
  Z: 'permanently reserved',
};

const VALID = new Set(['V', 'T', 'M']);

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** YYYYMMDD to YYYY-MM-DD, or null. */
export function ymd(v) {
  const s = clean(v);
  if (!s || !/^\d{8}$/.test(s) || s === '00000000') return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** A title-cased maker name: "CESSNA" reads as "Cessna", "PIPER AIRCRAFT INC" as "Piper Aircraft Inc". */
export function titleCase(s) {
  const v = clean(s);
  if (!v) return null;
  return v.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** The comma-split fields of one line, trimmed. The FAA pads, never quotes. */
const fields = (line) =>
  line
    .replace(/^﻿/, '')
    .split(',')
    .map((f) => f.trim());

/** ACFTREF.txt as a map from model code to what the model is. */
export function parseModels(text) {
  const out = new Map();
  for (const line of String(text).split('\n').slice(1)) {
    const f = fields(line);
    if (!f[0]) continue;
    out.set(f[0], {
      manufacturer: titleCase(f[1]),
      model: clean(f[2]),
      aircraftType: AIRCRAFT_TYPE[f[3]] ?? null,
      engineType: ENGINE_TYPE[Number(f[4])] ?? null,
      engines: Number(f[7]) || null,
      seats: Number(f[8]) || null,
      weightClass: clean(f[9])?.toLowerCase() ?? null,
      cruiseMph: Number(f[10]) || null,
      typeCertificate: clean(f[11]),
      typeCertificateHolder: clean(f[12]),
    });
  }
  return out;
}

/** ENGINE.txt as a map from engine code to maker and model. */
export function parseEngines(text) {
  const out = new Map();
  for (const line of String(text).split('\n').slice(1)) {
    const f = fields(line);
    if (!f[0]) continue;
    out.set(f[0], {
      manufacturer: titleCase(f[1]),
      model: clean(f[2]),
      horsepower: Number(f[4]) || null,
      thrustLb: Number(f[5]) || null,
    });
  }
  return out;
}

/** One MASTER.txt line as an item. */
export function toItem(line, { models = new Map(), engines = new Map() } = {}) {
  const f = fields(line);
  const n = clean(f[0]);
  if (!n || n === 'N-NUMBER') return null;
  const nNumber = `N${n.toUpperCase()}`;
  const model = models.get(f[2]) ?? {};
  const engine = engines.get(f[3]) ?? null;
  const year = Number(f[4]) || null;
  const registrantCode = clean(f[5]);
  const personal = PERSONAL.has(registrantCode);
  const statusCode = clean(f[20]);
  const status = STATUS[statusCode] ?? (statusCode ? `FAA status code ${statusCode}` : null);
  const hex = clean(f[33])?.toLowerCase() ?? null;
  const certCode = clean(f[17])?.[0] ?? null;
  const aircraftType = AIRCRAFT_TYPE[f[18]] ?? model.aircraftType ?? null;
  const engineType = ENGINE_TYPE[Number(f[19])] ?? model.engineType ?? null;
  const kitMaker = titleCase(f[31]);
  const kitModel = clean(f[32]);
  const city = titleCase(f[9]);
  const state = clean(f[10]);
  const country = clean(f[14]);
  const owner = personal ? null : clean(f[6]);
  const what = [year, model.manufacturer ?? kitMaker, model.model ?? kitModel]
    .filter(Boolean)
    .join(' ');

  return {
    externalId: nNumber,
    kind: 'aircraft-registration',
    title: `${nNumber}${what ? `: ${what}` : ''}`,
    summary: [
      `${nNumber}`,
      what ? ` is a ${what}` : ' is registered',
      aircraftType ? ` (${aircraftType}${engineType ? `, ${engineType}` : ''})` : '',
      owner
        ? `, registered to ${owner}`
        : registrantCode
          ? `, registered to an ${REGISTRANT[registrantCode] ?? 'owner'}`
          : '',
      city || state ? ` in ${[city, state].filter(Boolean).join(', ')}` : '',
      status ? `. Registration: ${status}` : '',
      ymd(f[29]) ? `, expires ${ymd(f[29])}` : '',
      hex ? `. Mode S hex ${hex.toUpperCase()}.` : '.',
    ].join(''),
    url: `https://registry.faa.gov/AircraftInquiry/Search/NNumberResult?nNumberTxt=${encodeURIComponent(n)}`,
    publishedAt: ymd(f[16]) ?? ymd(f[15]),
    timeKnown: false,
    precision: 'day',
    tags: [
      'aircraft',
      'faa',
      aircraftType ? slugify(aircraftType) : null,
      engineType ? `engine-${slugify(engineType)}` : null,
      model.manufacturer ? slugify(model.manufacturer) : null,
      model.model ? `model-${slugify(model.model)}` : null,
      state ? `state-${state.toLowerCase()}` : null,
      registrantCode && REGISTRANT[registrantCode]
        ? `owner-${slugify(REGISTRANT[registrantCode])}`
        : null,
      certCode && CERTIFICATION[certCode] ? `cert-${slugify(CERTIFICATION[certCode])}` : null,
      VALID.has(statusCode) ? 'registered' : null,
      statusCode ? `status-${statusCode.toLowerCase()}` : null,
      hex ? `hex-${hex}` : null,
      kitMaker ? 'kit-built' : null,
    ].filter(Boolean),
    data: {
      nNumber,
      icaoHex: hex,
      modeSOctal: clean(f[21]),
      serialNumber: clean(f[1]),
      year,
      manufacturer: model.manufacturer ?? null,
      model: model.model ?? null,
      kitManufacturer: kitMaker,
      kitModel,
      aircraftType,
      engineType,
      engines: model.engines ?? null,
      seats: model.seats ?? null,
      weightClass: model.weightClass ?? null,
      cruiseMph: model.cruiseMph ?? null,
      engine,
      typeCertificate: model.typeCertificate ?? null,
      registrantType: REGISTRANT[registrantCode] ?? null,
      owner,
      ownerWithheld: personal,
      otherOwners: personal ? [] : f.slice(24, 29).map(clean).filter(Boolean),
      street: personal ? null : clean(f[7]),
      city,
      state,
      zip: personal ? null : clean(f[11]),
      country,
      certification: certCode ? (CERTIFICATION[certCode] ?? null) : null,
      certificationDetail: clean(f[17]),
      fractionalOwner: clean(f[22]) === 'Y',
      status,
      statusCode,
      registeredAt: ymd(f[16]),
      lastActionAt: ymd(f[15]),
      airworthinessAt: ymd(f[23]),
      expiresAt: ymd(f[29]),
      faaUniqueId: clean(f[30]),
      source: 'FAA Aircraft Registry, Releasable Aircraft Database (public domain)',
      dataset: ZIP_URL,
      note: personal
        ? 'Owned by a private individual: the name and street address are left out here. The FAA lookup linked from this row has the public record.'
        : null,
    },
  };
}

export const faaRegistry = defineAdapter({
  name: 'faa-registry',
  title: 'FAA aircraft register',
  collection: 'aircraft',
  description:
    'Every aircraft on the US civil register (about 319,000), one row per N-number, from the FAA’s nightly Releasable Aircraft Database: maker, model, year, seats, engines, airworthiness class, registration status and expiry, and the Mode S hex the transponder broadcasts, so a live ADS-B sighting can be named. Private owners’ names and street addresses are left out. Public domain.',
  docs: 'https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download',
  kinds: ['aircraft-registration'],
  cadenceMinutes: 7 * 24 * 60,
  budgetMs: 60 * 60_000,
  defaults: {},
  defaultSources: [{ slug: 'faa-aircraft-registry', name: 'FAA aircraft register (US civil)' }],

  async *pull({ cursor, http, log }) {
    const dir = await dumpDir('faa-registry');
    const path = `${dir}/ReleasableAircraft.zip`;
    let skip = Number(cursor?.line) || 0;
    const have = await stat(path).catch(() => null);

    /* A walk that ran out of time resumes on the file it started; anything
     * else starts from tonight's file, because the FAA rewrites the whole zip
     * and a resumed range onto yesterday's bytes would be a corrupt archive. */
    if (!skip || !have) {
      skip = 0;
      await rm(path, { force: true });
      const got = await http.download(ZIP_URL, path, {
        timeoutMs: 20 * 60_000,
        headers: { 'user-agent': UA },
      });
      if (!got.complete) return { cursor: {}, note: 'download incomplete', nextInMinutes: 30 };
    }

    // The two reference tables are small (15 MB and 0.2 MB) and read whole.
    const models = parseModels(await collect(zipMemberLines(path, 'ACFTREF.txt')));
    const engines = parseEngines(await collect(zipMemberLines(path, 'ENGINE.txt')));
    log(`${models.size} models, ${engines.size} engines; walking MASTER.txt from line ${skip}`);

    let line = skip;
    let batch = [];
    let wrote = 0;
    for await (const text of zipMemberLines(path, 'MASTER.txt', { skip })) {
      line++;
      const item = toItem(text, { models, engines });
      if (item) batch.push(item);
      if (batch.length >= BATCH) {
        wrote += batch.length;
        yield { items: batch, cursor: { line } };
        batch = [];
      }
    }
    if (batch.length) wrote += batch.length;
    if (batch.length) yield { items: batch, cursor: { line: 0 } };
    await rm(path, { force: true });
    return { cursor: { line: 0, finishedAt: new Date().toISOString() }, note: `${wrote} aircraft` };
  },
});

async function collect(lines) {
  const out = [];
  for await (const l of lines) out.push(l);
  return out.join('\n');
}
