import { defineAdapter, slugify } from '@nichedb/core/adapter';
import { csvRecords, dumpDir } from '@nichedb/core/dump';

/**
 * Every healthcare provider in the United States.
 *
 * An NPI — National Provider Identifier — is the number on every insurance
 * claim filed in the US. Everyone who bills insurance has one, and NPPES is the
 * register: about eight million records covering individual clinicians
 * (physicians, dentists, nurse practitioners, therapists) and organizations
 * (hospitals, pharmacies, laboratories, medical transport). CMS publishes it in
 * full, monthly, as a public-domain file. No key, no licence, no terms.
 *
 * That last part is why this is here rather than a scrape. A directory of
 * providers is the sort of thing usually assembled from somebody's licensed
 * database; this one is given away by the agency that maintains it.
 *
 * ## What the download actually is
 *
 * A 1.16 GB zip holding a 4.29 GB CSV of 330 columns, plus smaller files for
 * practice locations, endpoints and other names. Measured 2026-09-25 against
 * the September 2026 V2 file. Version 1 was retired on 2026-03-03; V2 widened
 * the name fields and is the only one published now.
 *
 * The walk is the CourtListener shape because the problem is the same: one
 * enormous file, more than a single run can read. Download with Range resume,
 * unzip once, then walk the CSV a batch at a time, saving the line offset after
 * every batch so the next run carries on rather than starting again.
 *
 * ## The privacy decision, made deliberately
 *
 * Most of these records are organizations, but a large minority are sole
 * practitioners who registered a **home address** as their practice location.
 * The data is public by law and CMS publishes it for reuse, so there is no
 * legal question — but republishing several million people's home addresses in
 * a searchable index is a different act from republishing a hospital's address,
 * and it should be a decision rather than a side effect.
 *
 * So individuals (entity type 1) keep city, state and the five-digit ZIP, and
 * their street lines are dropped before the item is built. Organisations
 * (entity type 2) keep the full address. `includeIndividualStreet` turns that
 * off for a deployment that wants the raw file, and it defaults to off.
 */

const BASE = 'https://download.cms.gov/nppes';

/** NUCC publishes the code set the taxonomy columns are written in. */
const NUCC_TAXONOMY = 'https://www.nucc.org/images/stories/CSV/nucc_taxonomy_251.csv';

/** A bulk walk is measured in hours, not the deployment's usual few minutes. */
const BUDGET_MS = 6 * 60 * 60 * 1000;

/** Rows per batch. The cursor is saved after each one. */
const BATCH = 500;

/**
 * Column positions in the main file, zero-based.
 *
 * By index rather than by header name, because the header is 330 columns of
 * prose ("Provider Business Practice Location Address City Name") and matching
 * on it is both slow and fragile. The positions were read off the September
 * 2026 V2 file; `assertLayout` checks them against the header on every run, so
 * a reshuffle fails loudly instead of silently writing the wrong field.
 */
export const COL = {
  npi: 0,
  entityType: 1,
  orgName: 4,
  lastName: 5,
  firstName: 6,
  middleName: 7,
  namePrefix: 8,
  nameSuffix: 9,
  credential: 10,
  practiceStreet1: 28,
  practiceStreet2: 29,
  practiceCity: 30,
  practiceState: 31,
  practicePostal: 32,
  practiceCountry: 33,
  practicePhone: 34,
  enumerationDate: 36,
  lastUpdate: 37,
  deactivationReason: 38,
  deactivationDate: 39,
  reactivationDate: 40,
  sex: 41,
  isSoleProprietor: 307,
  certificationDate: 329,
};

/** Taxonomy blocks: code, licence, licence state, primary switch, fifteen times. */
export const TAXONOMY_FIRST = 47;
export const TAXONOMY_STRIDE = 4;
export const TAXONOMY_SLOTS = 15;

/**
 * The header this adapter was written against, at the positions it relies on.
 *
 * Checked on every run. A 330-column government file is exactly the kind of
 * thing that gains a column one month, and reading `Provider First Name` out of
 * the position that now holds a middle name would be invisible in the output.
 */
const EXPECTED = {
  0: 'NPI',
  1: 'Entity Type Code',
  4: 'Provider Organization Name (Legal Business Name)',
  5: 'Provider Last Name (Legal Name)',
  6: 'Provider First Name',
  30: 'Provider Business Practice Location Address City Name',
  31: 'Provider Business Practice Location Address State Name',
  47: 'Healthcare Provider Taxonomy Code_1',
};

export function assertLayout(header) {
  for (const [index, name] of Object.entries(EXPECTED)) {
    const got = String(header[Number(index)] ?? '').trim();
    if (got !== name) {
      throw new Error(
        `NPPES column ${index} is '${got}', expected '${name}'. The file layout has changed; the column map in nppes.js needs rechecking before this can run.`,
      );
    }
  }
}

/** `YYYYMMDD` or `MM/DD/YYYY` as the file writes them, to an ISO day. */
export function npiDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const slash = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (slash) return `${slash[3]}-${slash[1]}-${slash[2]}`;
  const plain = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}

/**
 * The NUCC code set, as a code → display name map.
 *
 * The file stores `207Q00000X`; a person wants "Family Medicine". Fetched once
 * per run rather than vendored, because the code set gains entries and a stale
 * copy silently degrades every row to a bare code.
 */
export async function taxonomyNames(http, url = NUCC_TAXONOMY) {
  const text = await http.text(url, { timeoutMs: 60_000 });
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const code = (cells[0] ?? '').trim();
    // Display Name is the last useful column; fall back to Classification.
    const display = (cells[6] ?? '').trim() || (cells[2] ?? '').trim();
    if (code && display) map.set(code, display);
  }
  return map;
}

/** One CSV line into cells. Quoted fields may contain commas and doubled quotes. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Every taxonomy on a row, primary first. */
export function taxonomiesOf(cells, names) {
  const out = [];
  for (let slot = 0; slot < TAXONOMY_SLOTS; slot += 1) {
    const base = TAXONOMY_FIRST + slot * TAXONOMY_STRIDE;
    const code = String(cells[base] ?? '').trim();
    if (!code) continue;
    out.push({
      code,
      name: names.get(code) ?? null,
      licenseState: String(cells[base + 2] ?? '').trim() || null,
      primary:
        String(cells[base + 3] ?? '')
          .trim()
          .toUpperCase() === 'Y',
    });
  }
  out.sort((a, b) => Number(b.primary) - Number(a.primary));
  return out;
}

/** A person's name as it should read, or the organisation's. */
export function displayName(cells) {
  const individual = String(cells[COL.entityType] ?? '').trim() === '1';
  if (!individual) return String(cells[COL.orgName] ?? '').trim();
  const parts = [
    String(cells[COL.namePrefix] ?? '').trim(),
    String(cells[COL.firstName] ?? '').trim(),
    String(cells[COL.middleName] ?? '').trim(),
    String(cells[COL.lastName] ?? '').trim(),
    String(cells[COL.nameSuffix] ?? '').trim(),
  ].filter(Boolean);
  const name = parts.join(' ');
  const credential = String(cells[COL.credential] ?? '').trim();
  return credential ? `${name}, ${credential}` : name;
}

/**
 * The address, with a sole practitioner's street withheld.
 *
 * See the note at the top of the file: this is the deliberate part.
 */
export function addressOf(cells, { includeIndividualStreet = false } = {}) {
  const individual = String(cells[COL.entityType] ?? '').trim() === '1';
  const postal = String(cells[COL.practicePostal] ?? '').trim();
  const address = {
    city: String(cells[COL.practiceCity] ?? '').trim() || null,
    state: String(cells[COL.practiceState] ?? '').trim() || null,
    // Five digits: the NPPES file carries ZIP+4, which narrows a home address
    // to roughly a building.
    postalCode: postal ? postal.slice(0, 5) : null,
    country: String(cells[COL.practiceCountry] ?? '').trim() || null,
  };

  if (!individual || includeIndividualStreet) {
    const street = [
      String(cells[COL.practiceStreet1] ?? '').trim(),
      String(cells[COL.practiceStreet2] ?? '').trim(),
    ].filter(Boolean);
    if (street.length) address.street = street;
    const phone = String(cells[COL.practicePhone] ?? '').trim();
    if (phone) address.phone = phone;
  } else {
    address.streetWithheld = true;
  }

  return address;
}

/** True when the NPI has been deactivated and not reactivated since. */
export function isActive(cells) {
  const deactivated = npiDate(cells[COL.deactivationDate]);
  if (!deactivated) return true;
  const reactivated = npiDate(cells[COL.reactivationDate]);
  return Boolean(reactivated && reactivated >= deactivated);
}

export function toItem(cells, names, opts = {}) {
  const npi = String(cells[COL.npi] ?? '').trim();
  if (!/^\d{10}$/.test(npi)) return null;

  const name = displayName(cells);
  if (!name) return null;

  const individual = String(cells[COL.entityType] ?? '').trim() === '1';
  const taxonomies = taxonomiesOf(cells, names);
  const primary = taxonomies[0] ?? null;
  const address = addressOf(cells, opts);
  const active = isActive(cells);

  const where = [address.city, address.state].filter(Boolean).join(', ');
  const what = primary?.name ?? primary?.code ?? null;

  return {
    externalId: `npi-${npi}`,
    kind: 'provider',
    title: name,
    summary:
      [what, where].filter(Boolean).join(' · ') ||
      `${individual ? 'Individual' : 'Organization'} provider ${npi}`,
    // The NPPES registry's own page for the number.
    url: `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
    publishedAt: npiDate(cells[COL.enumerationDate]),
    timeKnown: false,
    precision: 'day',
    tags: [
      'provider',
      'npi',
      individual ? 'individual' : 'organization',
      ...(active ? [] : ['deactivated']),
      ...(address.state ? [slugify(address.state)] : []),
      ...taxonomies
        .slice(0, 4)
        .map((t) => slugify(t.name ?? t.code))
        .filter(Boolean),
    ],
    data: {
      npi,
      entityType: individual ? 'individual' : 'organization',
      name,
      organizationName: individual ? null : String(cells[COL.orgName] ?? '').trim() || null,
      credential: String(cells[COL.credential] ?? '').trim() || null,
      taxonomies,
      primaryTaxonomy: primary,
      address,
      active,
      soleProprietor:
        String(cells[COL.isSoleProprietor] ?? '')
          .trim()
          .toUpperCase() === 'Y',
      enumerationDate: npiDate(cells[COL.enumerationDate]),
      lastUpdated: npiDate(cells[COL.lastUpdate]),
      deactivationDate: npiDate(cells[COL.deactivationDate]),
      source: 'NPPES, Centers for Medicare & Medicaid Services (US public domain)',
    },
  };
}

/** The monthly file's name for a given month. */
export function monthlyFile(date = new Date()) {
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `NPPES_Data_Dissemination_${month}_${date.getUTCFullYear()}_V2.zip`;
}

/**
 * The months worth trying, newest first.
 *
 * CMS posts the month's file partway through it, so on the 3rd the current
 * month may not exist yet and last month's is the newest there is.
 */
export function candidateFiles(now = new Date(), back = 3) {
  const out = [];
  for (let i = 0; i < back; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(monthlyFile(d));
  }
  return out;
}

export const nppesProviders = defineAdapter({
  name: 'nppes-providers',
  title: 'US healthcare providers (NPPES)',
  collection: 'health',
  description:
    'Every healthcare provider in the United States: the NPI registry CMS publishes in full each month. Around eight million clinicians and organizations with their specialty, licence state and city. Public domain, no key. A 1.16 GB download inflating to 4.29 GB, walked a batch at a time across as many runs as it takes. Sole practitioners often register a home address, so individuals are carried at city and state without the street line unless that is turned on.',
  docs: 'https://download.cms.gov/nppes/NPI_Files.html',
  kinds: ['provider'],
  // The file is monthly; a daily look finds it the day it appears.
  cadenceMinutes: 60 * 24,
  budgetMs: BUDGET_MS,
  configFields: [
    {
      key: 'states',
      label: 'States',
      type: 'list',
      help: 'Two-letter codes. Empty for the whole country.',
    },
    {
      key: 'entityTypes',
      label: 'Entity types',
      type: 'list',
      help: 'individual, organization. Empty for both.',
    },
    {
      key: 'includeIndividualStreet',
      label: 'Include individual street addresses',
      type: 'select',
      options: ['no', 'yes'],
      help: 'Sole practitioners frequently register a home address. Off by default; individuals are carried at city and state only.',
    },
    {
      key: 'skipDeactivated',
      label: 'Skip deactivated NPIs',
      type: 'select',
      options: ['yes', 'no'],
    },
  ],
  defaults: { includeIndividualStreet: 'no', skipDeactivated: 'yes' },
  defaultSources: [{ slug: 'nppes-providers', name: 'US healthcare providers' }],

  async *pull({ config, cursor, http, log, deadline }) {
    const wantStates = new Set(
      (Array.isArray(config.states) ? config.states : []).map((s) =>
        String(s).trim().toUpperCase(),
      ),
    );
    const wantTypes = new Set(
      (Array.isArray(config.entityTypes) ? config.entityTypes : []).map((s) =>
        String(s).trim().toLowerCase(),
      ),
    );
    const includeIndividualStreet = String(config.includeIndividualStreet) === 'yes';
    const skipDeactivated = String(config.skipDeactivated ?? 'yes') !== 'no';

    const dir = await dumpDir('nppes');

    // Which monthly file. A cursor names the one it was walking; a new month
    // starts a fresh walk rather than resuming into a different file.
    let file = cursor?.file ?? null;
    if (!file) {
      for (const candidate of candidateFiles()) {
        const head = await http
          .request(`${BASE}/${candidate}`, { method: 'HEAD', timeoutMs: 60_000 })
          .catch(() => null);
        if (head?.ok) {
          file = candidate;
          break;
        }
      }
      if (!file) throw new Error('no NPPES monthly file found for the last three months');
      log(`monthly file: ${file}`);
    }

    const zipPath = `${dir}/${file}`;
    const got = await http.download(`${BASE}/${file}`, zipPath, {
      timeoutMs: Math.max(60_000, deadline - Date.now()),
      onProgress: ({ bytes, total }) => {
        if (total && bytes % (200 * 1024 * 1024) < 1024 * 1024) {
          log(`downloaded ${(bytes / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB`);
        }
      },
    });

    if (!got.complete) {
      log(`download incomplete at ${(got.bytes / 1e9).toFixed(2)} GB; resuming next run`);
      return { cursor: { file }, note: 'downloading', nextInMinutes: 10 };
    }

    // Extract once. The member name carries the file's date range, so it is
    // read from the archive rather than guessed.
    const member = cursor?.member ?? (await mainMember(zipPath));
    const csvPath = `${dir}/${member}`;
    if (!(await exists(csvPath))) {
      log(`extracting ${member}`);
      await unzipMember(zipPath, member, dir);
    }

    const names = await taxonomyNames(http);
    log(`${names.size} taxonomy codes`);

    let offset = cursor?.offset ?? 0;
    let wrote = 0;
    let batch = [];
    let lineNo = 0;
    let checked = false;

    for await (const cells of csvRecords(fileChunks(csvPath), { keepHeader: true })) {
      if (!checked) {
        assertLayout(cells);
        checked = true;
        lineNo += 1;
        continue;
      }
      lineNo += 1;
      if (lineNo <= offset) continue;

      const item = toItem(cells, names, { includeIndividualStreet });
      if (!item) continue;

      if (skipDeactivated && item.data.active === false) continue;
      if (wantStates.size && !wantStates.has(String(item.data.address.state ?? '').toUpperCase())) {
        continue;
      }
      if (wantTypes.size && !wantTypes.has(item.data.entityType)) continue;

      batch.push(item);
      if (batch.length >= BATCH) {
        wrote += batch.length;
        offset = lineNo;
        yield { items: batch, cursor: { file, member, offset } };
        batch = [];
        if (Date.now() > deadline) {
          log(`deadline at line ${lineNo}; ${wrote} provider(s) this run`);
          return { cursor: { file, member, offset }, note: `${wrote} provider(s), resuming` };
        }
      }
    }

    if (batch.length) {
      wrote += batch.length;
      yield { items: batch, cursor: { file, member, offset: lineNo } };
    }

    log(`walk complete: ${lineNo} rows read`);
    // A finished pass waits for next month's file.
    return { cursor: { done: true, file }, note: `${wrote} provider(s), file complete` };
  },
});

/* ---- file helpers, kept at the bottom because they are plumbing ---- */

async function exists(path) {
  return await Bun.file(path)
    .exists()
    .catch(() => false);
}

function fileChunks(path) {
  return Bun.file(path).stream();
}

/**
 * The main data member's name, read from the archive.
 *
 * It carries the file's date range (`npidata_pfile_20050523-20260913.csv`), and
 * the archive also holds a same-named `_fileheader.csv` holding only the header
 * row, which must not be mistaken for the data.
 */
export function pickMainMember(names) {
  return names.find((n) => /^npidata_pfile_.*\.csv$/i.test(n) && !/fileheader/i.test(n)) ?? null;
}

async function mainMember(zipPath) {
  const proc = Bun.spawn(['unzip', '-Z1', zipPath], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unzip -Z1 exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}`);
  }
  const member = pickMainMember(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  if (!member) throw new Error('no npidata_pfile CSV in the NPPES archive');
  return member;
}

async function unzipMember(zipPath, member, dir) {
  const proc = Bun.spawn(['unzip', '-o', '-q', zipPath, member, '-d', dir], {
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`unzip exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}`);
  }
}
