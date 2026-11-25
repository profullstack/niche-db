/**
 * Where a number is and who owns it, for /phone:
 *
 *   place      the city or region a number's prefix belongs to, worldwide,
 *              from Google libphonenumber's geocoding tables (Apache-2.0),
 *              longest prefix wins: +1 202 -> "Washington D.C.", +44 20 ->
 *              "London". One file per country code, fetched once per process
 *              from the pinned release and kept in memory.
 *   timeZones  from the same project's prefix -> time zone table
 *   owners     organisations that publish the number as their own on
 *              Wikidata (CC0): name, description, street address, the
 *              coordinates of the place, website. People are excluded.
 *
 * Every remote read has a short timeout and caches misses too, so a slow
 * upstream costs one page a few seconds at most, once a day.
 */

const LIBPHONE = 'https://raw.githubusercontent.com/google/libphonenumber/v9.0.44/resources';
const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'niche-db/0.1 (+https://nichedb.dev)';
const DAY = 86_400_000;

/** `prefix|value` lines as a Map. */
export function parsePrefixTable(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const bar = line.indexOf('|');
    if (bar > 0) out.set(line.slice(0, bar), line.slice(bar + 1).trim());
  }
  return out;
}

/** The value for the longest prefix of `digits` in `table`, or null. */
export function longestPrefix(table, digits) {
  for (let i = digits.length; i > 0; i--) {
    const v = table.get(digits.slice(0, i));
    if (v) return v;
  }
  return null;
}

const tables = new Map();

/** A libphonenumber table, fetched once (a failure is retried after an hour). */
async function table(path, { fetchImpl = fetch } = {}) {
  const hit = tables.get(path);
  if (hit && (hit.value || Date.now() - hit.at < DAY / 24)) return hit.value;
  let value = null;
  try {
    const res = await fetchImpl(`${LIBPHONE}/${path}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8_000),
    });
    value = res.ok ? parsePrefixTable(await res.text()) : null;
  } catch {
    value = null;
  }
  tables.set(path, { at: Date.now(), value });
  return value;
}

/** The place a number belongs to ("Washington D.C.", "London"), or null. */
export async function placeOf(n, opts) {
  const geo = await table(`geocoding/en/${n.callingCode}.txt`, opts);
  return geo ? longestPrefix(geo, n.digits) : null;
}

/** IANA time zones for a number, or []. A whole-country answer with dozens of zones says nothing, so it is dropped. */
export async function timeZonesOf(n, opts) {
  const tz = await table('timezones/map_data.txt', opts);
  const v = tz ? longestPrefix(tz, n.digits) : null;
  const zones = v ? v.split('&') : [];
  return zones.length <= 4 ? zones : [];
}

/**
 * The ways a number is written on Wikidata, where P1329 is free text:
 * "+1-202-456-1111", "+1 202-456-1111", "+12024561111", ...
 */
export function writtenForms(n) {
  const intl = n.international; // "+1 202 456 1111"
  const forms = new Set([n.e164, intl, intl.replace(/ /g, '-'), intl.replace(/ /g, '')]);
  const [cc, ...rest] = intl.split(' ');
  if (rest.length > 1) {
    forms.add(`${cc} ${rest.join('-')}`);
    forms.add(`${cc}-${rest.join(' ')}`);
  }
  if (n.nanp) {
    const d = n.digits.slice(1);
    forms.add(`+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
    forms.add(`(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
    forms.add(`${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`);
    forms.add(`+1.${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`);
  }
  return [...forms];
}

const sparqlString = (s) => `"${String(s).replace(/["\\]/g, '')}"`;

export function ownerQuery(n) {
  return `SELECT ?item ?itemLabel ?itemDescription ?addr ?coord ?site ?placeLabel WHERE {
  VALUES ?phone { ${writtenForms(n).map(sparqlString).join(' ')} }
  ?item wdt:P1329 ?phone .
  MINUS { ?item wdt:P31 wd:Q5 }
  OPTIONAL { ?item wdt:P6375 ?addr }
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item wdt:P856 ?site }
  OPTIONAL { ?item wdt:P131 ?place }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 20`;
}

/** SPARQL bindings as one owner per item. */
export function ownersFromBindings(body) {
  const byItem = new Map();
  for (const b of body?.results?.bindings ?? []) {
    const id = b.item?.value?.split('/').pop();
    if (!id) continue;
    const o = byItem.get(id) ?? {
      wikidata: id,
      name: b.itemLabel?.value ?? id,
      description: b.itemDescription?.value ?? null,
      address: null,
      place: null,
      lat: null,
      lon: null,
      website: null,
      url: `https://www.wikidata.org/wiki/${id}`,
      source: 'Wikidata (CC0)',
    };
    o.address ??= b.addr?.value ?? null;
    o.place ??= b.placeLabel?.value ?? null;
    o.website ??= b.site?.value ?? null;
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord?.value ?? '');
    if (m && o.lat === null) {
      o.lon = Number(m[1]);
      o.lat = Number(m[2]);
    }
    byItem.set(id, o);
  }
  return [...byItem.values()];
}

const owners = new Map();

/** Organisations that publish this number on Wikidata; [] on a miss or a slow answer. */
export async function wikidataOwners(n, { fetchImpl = fetch } = {}) {
  const hit = owners.get(n.e164);
  if (hit && Date.now() - hit.at < DAY) return hit.value;
  let value = [];
  try {
    const res = await fetchImpl(`${SPARQL}?query=${encodeURIComponent(ownerQuery(n))}`, {
      headers: { 'user-agent': UA, accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(6_000),
    });
    value = res.ok ? ownersFromBindings(await res.json()) : [];
  } catch {
    value = [];
  }
  if (owners.size > 20_000) owners.clear();
  owners.set(n.e164, { at: Date.now(), value });
  return value;
}

/** An OpenStreetMap link: a pin when coordinates are known, else a search for the place. */
export function mapLink({ lat, lon, query }) {
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
  }
  return query ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}` : null;
}
