import { areaPath } from '@nichedb/core/population';
import { crumbsOf, fmtPeople, levelLabel, measureRows, RACE_LABELS } from '../lib/population.js';
import { Num } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * The population tree, one level at a time.
 *
 * Every page is the same shape whatever the level: where you are (the trail
 * back to the world), what this place is (its headcount and the measures the
 * sources carry for it), and what it is made of (the next level down, largest
 * first, each row a link one level further). The world page is the same page
 * with no area.
 */

const Crumbs = ({ data }) => {
  const trail = crumbsOf(data);
  if (!trail.length) return null;
  return (
    <nav class="small muted" aria-label="Where this is">
      {trail.map((c, i) => (
        <span>
          {i ? ' › ' : ''}
          <a href={c.path}>{c.name}</a>
        </span>
      ))}
    </nav>
  );
};

/** The headcount series as a line, when the row has one (countries do). */
const Sparkline = ({ series }) => {
  if (!Array.isArray(series) || series.length < 3) return null;
  const w = 320;
  const h = 64;
  const ys = series.map(([, v]) => v);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const pts = series
    .map(([, v], i) => {
      const x = (i / (series.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = series[0];
  const last = series[series.length - 1];
  return (
    <figure>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`Population from ${first[0]} (${fmtPeople(first[1])}) to ${last[0]} (${fmtPeople(last[1])})`}
      >
        <polyline points={pts} fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
      <figcaption class="small muted">
        {first[0]}: {fmtPeople(first[1])} → {last[0]}: {fmtPeople(last[1])}
      </figcaption>
    </figure>
  );
};

const Measures = ({ data }) => {
  const rows = measureRows(data);
  const race = data?.measures?.raceShares;
  if (!rows.length && !race) return null;
  return (
    <section class="table-scroll" aria-label="Measures">
      <table class="table small">
        <tbody>
          {rows.map((r) => (
            <tr>
              <th scope="row">{r.label}</th>
              <td class="num">
                {r.value}
                {r.year ? <span class="muted"> ({r.year})</span> : null}
              </td>
            </tr>
          ))}
          {race
            ? Object.entries(RACE_LABELS)
                .filter(([k]) => race[k] !== undefined)
                .map(([k, label]) => (
                  <tr>
                    <th scope="row">Race: {label}</th>
                    <td class="num">{race[k].toFixed(1)}%</td>
                  </tr>
                ))
            : null}
        </tbody>
      </table>
    </section>
  );
};

const AreaHead = ({ row }) => {
  const d = row.data ?? {};
  return (
    <section class="hero">
      <Crumbs data={d} />
      <h1>{row.title}</h1>
      <p class="lede">
        {d.population !== null && d.population !== undefined ? (
          <>
            <strong>{fmtPeople(d.population)}</strong> people
            {d.year ? ` (${d.survey ?? d.year})` : ''}
            {d.populationMoe ? <span class="muted"> ± {fmtPeople(d.populationMoe)}</span> : null}
          </>
        ) : d.listedCities ? (
          <>
            {fmtPeople(d.listedCities)} listed {d.listedCities === 1 ? 'city' : 'cities'} with{' '}
            {fmtPeople(d.listedCityPopulation)} people between them. GeoNames does not publish this
            division's own total, so none is shown.
          </>
        ) : (
          'No population published for this area.'
        )}
      </p>
      {d.level === 'zip' && d.cityName ? (
        <p class="small muted">
          Filed under {d.cityName}, which holds {Math.round((d.cityShare ?? 0) * 100)}% of this
          ZIP's land. A ZIP code here is the Census Bureau's ZCTA, drawn from ZIP delivery areas.
        </p>
      ) : null}
      {d.landAreaKm2 ? (
        <p class="small muted">
          Land area <Num n={Math.round(d.landAreaKm2)} /> km²
        </p>
      ) : null}
    </section>
  );
};

const ChildTable = ({ parent, level, list, offset, limit, base }) => {
  const total = list.total;
  const parentPop = parent?.data?.population ?? null;
  const showIncome = list.areas.some((a) => a.data?.measures?.medianHouseholdIncome);
  const showAge = list.areas.some((a) => a.data?.measures?.medianAge);
  const showLife = list.areas.some((a) => a.data?.measures?.lifeExpectancy);
  return (
    <section>
      <section class="table-scroll" aria-label={levelLabel(level, true)} tabindex="0">
        <table class="table small">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{levelLabel(level)}</th>
              <th scope="col" class="num">
                People
              </th>
              {parentPop ? (
                <th scope="col" class="num">
                  Share
                </th>
              ) : null}
              <th scope="col" class="num">
                Per km²
              </th>
              {showAge ? (
                <th scope="col" class="num">
                  Median age
                </th>
              ) : null}
              {showIncome ? (
                <th scope="col" class="num">
                  Median household income
                </th>
              ) : null}
              {showLife ? (
                <th scope="col" class="num">
                  Life expectancy
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {list.areas.map((a, i) => {
              const d = a.data ?? {};
              const m = d.measures ?? {};
              return (
                <tr>
                  <td class="muted">{offset + i + 1}</td>
                  <td>
                    <a href={areaPath(d)}>{d.level === 'zip' ? a.title : d.name}</a>
                  </td>
                  <td class="num">
                    {d.population !== null && d.population !== undefined
                      ? fmtPeople(d.population)
                      : d.listedCityPopulation
                        ? `≥ ${fmtPeople(d.listedCityPopulation)}`
                        : '—'}
                  </td>
                  {parentPop ? (
                    <td class="num">
                      {d.population ? `${((d.population / parentPop) * 100).toFixed(1)}%` : '—'}
                    </td>
                  ) : null}
                  <td class="num">{m.density ? m.density.toFixed(1) : '—'}</td>
                  {showAge ? (
                    <td class="num">{m.medianAge ? m.medianAge.toFixed(1) : '—'}</td>
                  ) : null}
                  {showIncome ? (
                    <td class="num">
                      {m.medianHouseholdIncome
                        ? `$${Math.round(m.medianHouseholdIncome).toLocaleString('en-US')}${(m.topCoded ?? []).includes('medianHouseholdIncome') ? '+' : ''}`
                        : '—'}
                    </td>
                  ) : null}
                  {showLife ? (
                    <td class="num">{m.lifeExpectancy ? m.lifeExpectancy.toFixed(1) : '—'}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <p class="small muted">
        {total ? (
          <>
            {offset + 1}–{Math.min(offset + limit, total)} of <Num n={total} />
          </>
        ) : (
          'Nothing here yet.'
        )}
        {offset > 0 ? (
          <>
            {' · '}
            <a href={`${base}?level=${level}&offset=${Math.max(0, offset - limit)}`}>previous</a>
          </>
        ) : null}
        {offset + limit < total ? (
          <>
            {' · '}
            <a href={`${base}?level=${level}&offset=${offset + limit}`}>next</a>
          </>
        ) : null}
      </p>
    </section>
  );
};

const Search = ({ q = '' }) => (
  <form class="row" method="get" action="/population">
    <div class="field">
      <label class="label" for="population-q">
        A place or a ZIP code
      </label>
      <input
        id="population-q"
        name="q"
        type="search"
        value={q}
        placeholder="Springfield, Lagos, 90210"
        autocomplete="off"
      />
    </div>
    <button class="cta" type="submit">
      Find
    </button>
  </form>
);

const Sources = () => (
  <p class="small muted">
    Countries: World Bank World Development Indicators (CC BY 4.0). US states, cities and ZIP codes:
    US Census Bureau, American Community Survey 5-year estimates (public domain). Cities elsewhere:
    GeoNames (CC BY 4.0). Everything here is also at{' '}
    <a href="/api/v1/population">/api/v1/population</a>, in the <code>population</code> MCP tool and
    in <code>nichedb population</code>.
  </p>
);

/**
 * @param {{ user, row?, level, levels, counts, list, offset, limit, stats?, q?, results? }} props
 */
export const PopulationPage = ({
  user,
  row = null,
  level,
  levels = [],
  counts = {},
  list,
  offset = 0,
  limit = 50,
  stats = null,
  q = '',
  results = null,
}) => {
  const d = row?.data ?? null;
  const base = d ? areaPath(d) : '/population';
  return (
    <Layout
      user={user}
      canonical={base}
      title={row ? `${row.title}: population` : 'Population'}
      description={
        row?.summary ??
        'Who lives where, from the world to the ZIP code: every country, every US state, city and ZIP code, and the cities of every other country. Free data, drill down by country, state, city and ZIP.'
      }
    >
      {row ? (
        <AreaHead row={row} />
      ) : (
        <section class="hero">
          <h1>Population, from the world to the ZIP code</h1>
          <p class="lede">
            Every country, every US state, city and ZIP code, and the cities of every other country,
            with what the free sources know about who lives there: age, income, housing, poverty,
            education, work, births, deaths and life expectancy. Start anywhere and drill down.
          </p>
          {stats ? (
            <p class="stats">
              <Num n={stats.country ?? 0} /> countries · <Num n={stats.state ?? 0} /> states and
              regions · <Num n={stats.city ?? 0} /> cities · <Num n={stats.zip ?? 0} /> ZIP codes
            </p>
          ) : null}
        </section>
      )}

      <Search q={q} />

      {results ? (
        <section>
          <h2>Places called “{q}”</h2>
          {results.length ? (
            <ul>
              {results.map((r) => (
                <li>
                  <a href={areaPath(r.data)}>{r.title}</a>{' '}
                  <span class="muted small">
                    {levelLabel(r.data?.level)} · {fmtPeople(r.data?.population)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">Nothing by that name. Try the spelling the place uses in English.</p>
          )}
        </section>
      ) : null}

      {d ? (
        <section>
          <Sparkline series={d.series} />
          <Measures data={d} />
        </section>
      ) : null}

      {level && list ? (
        <section>
          <h2>
            {levelLabel(level, true)}
            {row ? ` in ${d.name}` : ''}
          </h2>
          {levels.length > 1 ? (
            <p class="small">
              {levels.map((l, i) => (
                <span>
                  {i ? ' · ' : ''}
                  {l === level ? (
                    <strong>
                      {levelLabel(l, true)} ({(counts[l] ?? 0).toLocaleString('en-US')})
                    </strong>
                  ) : (
                    <a href={`${base}?level=${l}`}>
                      {levelLabel(l, true)} ({(counts[l] ?? 0).toLocaleString('en-US')})
                    </a>
                  )}
                </span>
              ))}
            </p>
          ) : null}
          <ChildTable
            parent={row}
            level={level}
            list={list}
            offset={offset}
            limit={limit}
            base={base}
          />
        </section>
      ) : null}

      <Sources />
    </Layout>
  );
};
