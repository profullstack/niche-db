import { config } from '@nichedb/config';
import { areaPath, LEVEL_LABELS } from '@nichedb/core/population';

/**
 * How a population row is shown and served: the measures in the order worth
 * reading, each with a label and a formatter, and the JSON shape the API and
 * MCP tool return.
 */

const int = (v) => Math.round(v).toLocaleString('en-US');
const dollars = (v) => `$${int(v)}`;
const percent = (v) => `${Number(v).toFixed(1)}%`;
const oneDp = (v) => Number(v).toFixed(1);
const twoDp = (v) => Number(v).toFixed(2);

/** [field, label, format, unit hint]. Countries and US areas carry different subsets. */
export const MEASURES = [
  ['density', 'People per km²', oneDp],
  ['medianAge', 'Median age', oneDp],
  ['households', 'Households', int],
  ['medianHouseholdIncome', 'Median household income', dollars],
  ['perCapitaIncome', 'Income per person', dollars],
  ['medianHomeValue', 'Median home value', dollars],
  ['medianGrossRent', 'Median rent', dollars],
  ['ownerOccupiedRate', 'Homes owner-occupied', percent],
  ['povertyRate', 'Below the poverty line', percent],
  ['bachelorsOrHigherRate', "Bachelor's degree or higher (25+)", percent],
  ['unemploymentRate', 'Unemployment', percent],
  ['hispanicShare', 'Hispanic or Latino', percent],
  ['growthRate', 'Population growth a year', (v) => `${twoDp(v)}%`],
  ['urbanShare', 'Living in cities', percent],
  ['under15Share', 'Under 15', percent],
  ['workingAgeShare', 'Aged 15 to 64', percent],
  ['over65Share', '65 and over', percent],
  ['dependencyRatio', 'Dependants per 100 of working age', oneDp],
  ['birthRate', 'Births per 1,000', oneDp],
  ['deathRate', 'Deaths per 1,000', oneDp],
  ['fertilityRate', 'Children per woman', twoDp],
  ['lifeExpectancy', 'Life expectancy', (v) => `${oneDp(v)} years`],
  ['netMigration', 'Net migration', (v) => `${v > 0 ? '+' : ''}${int(v)}`],
  ['gdpPerCapita', 'GDP per person (US$)', dollars],
  ['gini', 'Gini index', oneDp],
];

export const RACE_LABELS = {
  white: 'White',
  black: 'Black',
  asian: 'Asian',
  nativeAmerican: 'American Indian or Alaska Native',
  pacificIslander: 'Native Hawaiian or Pacific Islander',
  otherRace: 'Another race',
  multiracial: 'Two or more races',
};

/** The measures an area actually has, formatted, top codes marked with "+". */
export function measureRows(data) {
  const m = data?.measures ?? {};
  const top = new Set(m.topCoded ?? []);
  const years = data?.measureYears ?? {};
  return MEASURES.filter(([k]) => m[k] !== null && m[k] !== undefined).map(([k, label, fmt]) => ({
    key: k,
    label,
    value: `${fmt(m[k])}${top.has(k) ? '+' : ''}`,
    year: years[k] && years[k] !== data?.year ? years[k] : null,
  }));
}

export const fmtPeople = (n) => (n === null || n === undefined ? '—' : int(n));

export const levelLabel = (level, plural = false) => LEVEL_LABELS[level]?.[plural ? 1 : 0] ?? level;

/** A row as the API and MCP tool return it. */
export function areaOut(row) {
  if (!row) return null;
  const d = row.data ?? {};
  const path = areaPath(d);
  return {
    key: d.key,
    level: d.level,
    name: d.name,
    title: row.title,
    summary: row.summary,
    population: d.population ?? null,
    year: d.year ?? null,
    parentKey: d.parentKey ?? null,
    country: d.country ?? null,
    countryName: d.countryName ?? null,
    state: d.state ?? null,
    stateName: d.stateName ?? null,
    stateKey: d.stateKey ?? null,
    cityKey: d.cityKey ?? null,
    cityName: d.cityName ?? null,
    zip: d.zip ?? null,
    landAreaKm2: d.landAreaKm2 ?? null,
    measures: d.measures ?? {},
    measureYears: d.measureYears ?? undefined,
    series: d.series ?? undefined,
    listedCities: d.listedCities ?? undefined,
    listedCityPopulation: d.listedCityPopulation ?? undefined,
    location: d.location ?? null,
    survey: d.survey ?? undefined,
    source: d.source ?? row.source_name,
    licence: d.licence ?? null,
    upstream: row.url,
    page: `${config.siteUrl}${path}`,
    api: `${config.siteUrl}/api/v1/population/${d.key}`,
    updatedAt: row.updated_at,
  };
}

/** The trail from the world down to an area, from what the row already says. */
export function crumbsOf(d) {
  if (!d) return [];
  const out = [{ name: 'World', path: '/population' }];
  if (d.level === 'country') return out;
  if (d.country)
    out.push({
      name: d.countryName ?? d.country,
      path: `/population/${String(d.country).toLowerCase()}`,
    });
  if ((d.level === 'city' || d.level === 'zip') && d.stateKey)
    out.push({
      name: d.stateName ?? d.state ?? d.stateKey,
      path: areaPath({ level: 'state', key: d.stateKey }),
    });
  if (d.level === 'zip' && d.cityKey)
    out.push({
      name: d.cityName ?? d.cityKey,
      path: areaPath({ level: 'city', key: d.cityKey, stateKey: d.stateKey }),
    });
  return out;
}
