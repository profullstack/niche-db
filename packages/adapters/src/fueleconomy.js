import { defineAdapter, looseDate, slugify } from '@nichedb/core/adapter';

/**
 * The catalogue: every make, model and year sold in the US since 1984.
 *
 * NHTSA's vPIC knows makes and models too, but it lists twelve thousand
 * "makes" because every trailer welder and hearse converter is one. The EPA's
 * fuel-economy database is the catalogue people mean: the cars, trucks and
 * vans actually sold, year by year, with the trims under each one and what
 * each trim is — engine, drive, transmission, fuel, and what it gets to the
 * gallon. US public domain.
 *
 * The menu is a tree (year → make → model → trim), so this walks it the same
 * way the NHTSA adapters do: newest year first, resuming from the cursor,
 * spending a budget per run. One item per model year, because that is the row
 * a person asks for: "2019 Subaru Outback".
 */

const BASE = 'https://www.fueleconomy.gov/ws/rest';
const JSON_HEADERS = { accept: 'application/json' };

/** The menu endpoints answer with one object when there is one result. */
export function menuList(res) {
  const raw = res?.menuItem ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((m) => m && m.value !== undefined && m.value !== null);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== -1 ? n : null;
};

/** The parts of an EPA spec row worth keeping on a model. */
export function specOf(v) {
  if (!v) return null;
  return {
    id: v.id ? String(v.id) : null,
    trim: v.trany ? `${v.trany}` : null,
    engineCylinders: num(v.cylinders),
    engineLitres: num(v.displ),
    drive: v.drive || null,
    transmission: v.trany || null,
    fuel: v.fuelType || null,
    fuelPrimary: v.fuelType1 || null,
    fuelSecondary: v.fuelType2 || null,
    vehicleClass: v.VClass || null,
    mpgCity: num(v.city08),
    mpgHighway: num(v.highway08),
    mpgCombined: num(v.comb08),
    kwhPer100Miles: num(v.combE),
    electricRange: num(v.range),
    co2GramsPerMile: num(v.co2TailpipeGpm),
    annualFuelCost: num(v.fuelCost08),
    startStop: v.startStop || null,
    turbo: v.tCharger ? true : null,
    supercharged: v.sCharger ? true : null,
  };
}

export function modelToItem({ year, make, model, trims, spec }) {
  const label = `${year} ${make} ${model}`;
  const bits = [
    spec?.engineLitres ? `${spec.engineLitres}L` : null,
    spec?.engineCylinders ? `${spec.engineCylinders}-cyl` : null,
    spec?.drive || null,
    spec?.fuel || null,
    spec?.mpgCombined ? `${spec.mpgCombined} mpg combined` : null,
  ].filter(Boolean);
  return {
    externalId: `${year}|${slugify(make)}|${slugify(model)}`,
    kind: 'model',
    title: label,
    summary:
      `${trims.length} configuration${trims.length === 1 ? '' : 's'}${bits.length ? `. ${bits.join(', ')}` : ''}.`.trim(),
    url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${encodeURIComponent(trims[0]?.value ?? '')}`,
    publishedAt: looseDate(String(year)).publishedAt,
    timeKnown: false,
    precision: 'year',
    tags: [
      'model',
      'vehicle',
      String(year),
      slugify(make),
      slugify(model),
      slugify(`${make}-${model}`),
      spec?.fuel ? slugify(spec.fuel) : null,
      spec?.drive ? slugify(spec.drive) : null,
      spec?.vehicleClass ? slugify(spec.vehicleClass) : null,
    ].filter(Boolean),
    data: {
      year: Number(year),
      make,
      model,
      trims: trims.map((t) => ({ id: String(t.value), name: t.text })),
      spec,
      redistribution: 'public-domain',
      attribution: 'US EPA / DOE fueleconomy.gov, US public domain',
    },
  };
}

export const fueleconomyCatalog = defineAdapter({
  name: 'fueleconomy-catalog',
  title: 'Vehicle catalogue: makes, models, years',
  collection: 'automotive',
  description:
    'Every make, model and year sold in the US since 1984, with the trims under each and what each one is: engine, drive, transmission, fuel and mpg. From the EPA and DOE fuel-economy database. US public domain, keyless.',
  docs: 'https://www.fueleconomy.gov/feg/ws/',
  kinds: ['model'],
  cadenceMinutes: 240,
  redistribution: 'public-domain',
  configFields: [
    {
      key: 'yearsBack',
      label: 'Model years back',
      type: 'number',
      help: 'From next year backwards. The catalogue starts at 1984, so 45 covers all of it.',
    },
    {
      key: 'specs',
      label: 'Fetch specs',
      type: 'select',
      options: ['yes', 'no'],
      help: 'Read one trim per model for engine, drive and mpg. Off is roughly three times faster.',
    },
  ],
  defaults: { yearsBack: 45, specs: 'yes' },
  defaultSources: [
    {
      slug: 'vehicle-catalog',
      name: 'Vehicles: every make, model and year',
      config: { yearsBack: 45, specs: 'yes' },
    },
  ],
  async pull({ config, cursor, http, log, budget, deadline }) {
    const latest = new Date().getUTCFullYear() + 1;
    const back = Math.min(Math.max(Number(config.yearsBack) || 45, 1), 45);
    const wantSpecs = (config.specs ?? 'yes') !== 'no';

    const allYears = menuList(
      await http.json(`${BASE}/vehicle/menu/year`, { headers: JSON_HEADERS }),
    )
      .map((m) => Number(m.value))
      .filter((y) => Number.isInteger(y) && y <= latest)
      .sort((a, b) => b - a)
      .slice(0, back + 1);
    if (!allYears.length) return { items: [], note: 'no model years listed' };

    let yearIdx = Number(cursor.yearIdx) || 0;
    if (yearIdx >= allYears.length) yearIdx = 0;
    const year = allYears[yearIdx];
    let makeIdx = Number(cursor.makeIdx) || 0;
    let makes = Array.isArray(cursor.makes) && cursor.cursorYear === year ? cursor.makes : null;

    if (!makes) {
      makes = menuList(
        await http.json(`${BASE}/vehicle/menu/make?year=${year}`, { headers: JSON_HEADERS }),
      ).map((m) => String(m.value));
      makeIdx = 0;
      log(`${makes.length} makes for ${year}`);
    }

    const items = [];
    let spent = 0;
    while (makeIdx < makes.length && spent < budget && Date.now() < deadline) {
      const make = makes[makeIdx];
      const models = menuList(
        await http
          .json(`${BASE}/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}`, {
            headers: JSON_HEADERS,
          })
          .catch(() => ({})),
      ).map((m) => String(m.value));
      spent++;

      for (const model of models) {
        if (spent >= budget || Date.now() >= deadline) break;
        const trims = menuList(
          await http
            .json(
              `${BASE}/vehicle/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`,
              { headers: JSON_HEADERS },
            )
            .catch(() => ({})),
        );
        spent++;
        if (!trims.length) continue;

        let spec = null;
        if (wantSpecs && spent < budget) {
          const detail = await http
            .json(`${BASE}/vehicle/${encodeURIComponent(trims[0].value)}`, {
              headers: JSON_HEADERS,
            })
            .catch(() => null);
          spent++;
          spec = specOf(detail);
        }
        items.push(modelToItem({ year, make, model, trims, spec }));
      }
      makeIdx++;
    }

    const done = makeIdx >= makes.length;
    return {
      items,
      cursor: done
        ? { yearIdx: (yearIdx + 1) % allYears.length, makeIdx: 0, makes: null, cursorYear: null }
        : { yearIdx, makeIdx, makes, cursorYear: year },
      note: `${year}: ${items.length} models from ${spent} lookups, ${done ? 'year complete' : `at make ${makeIdx}/${makes.length}`}`,
    };
  },
});
