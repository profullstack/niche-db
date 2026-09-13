import { POLICE_CITIES, POLICE_SCOPE } from '@nichedb/adapters';
import { Layout } from './Layout.jsx';

export const PoliceCoveragePage = ({ user, search = '', minimum = 50000, pending = false }) => {
  const eligible = POLICE_CITIES.filter((city) => city.population > minimum);
  const cities = eligible.filter(
    (city) =>
      (!pending || !city.ingestion) &&
      `${city.name} ${city.references.map((r) => r.url).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Layout user={user} title="California police sources" canonical="/c/crime/coverage">
      <p class="crumb">
        <a href="/c/crime">Crime</a> › California sources
      </p>
      <h1>California police sources</h1>
      <p class="lede">
        {eligible.length} cities over {minimum.toLocaleString()} residents.{' '}
        {eligible.filter((city) => city.ingestion).length} have reviewed public feeds configured for
        hourly checks. Other cities have source leads to follow while feed coverage is expanded.
      </p>
      <p>
        <a href="/f/police-updates-ca">Read California police updates</a>. Announcements can include
        traffic advisories, crime releases and community notices. Geographic filters locate the
        publishing city, and dates show when the announcement was published.
      </p>
      <form method="get" action="/c/crime/coverage">
        <label>
          City or account <input name="q" value={search} placeholder="San Jose, Fremont…" />
        </label>{' '}
        <label>
          Population{' '}
          <select name="min">
            <option value="50000" selected={minimum === 50000}>
              Over 50,000
            </option>
            <option value="100000" selected={minimum === 100000}>
              Over 100,000
            </option>
          </select>
        </label>{' '}
        <label>
          <input type="checkbox" name="pending" value="1" checked={pending} /> Needs a feed
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      <p class="muted">
        {cities.length} cities shown. Population: Census {POLICE_SCOPE.populationYear} estimates.
      </p>
      <table>
        <thead>
          <tr>
            <th>City</th>
            <th>Feed coverage</th>
            <th>Source links</th>
          </tr>
        </thead>
        <tbody>
          {cities.map((city) => (
            <tr key={city.geoid}>
              <td>
                <strong>{city.name}</strong>
                <br />
                <span class="muted small">{city.population.toLocaleString()} residents</span>
              </td>
              <td>
                {city.ingestion ? (
                  <>
                    <a href={`/s/police-ca-${city.slug}`}>
                      Reviewed {city.ingestion.format === 'nixle' ? 'Nixle' : 'RSS'} feed
                    </a>
                    <br />
                    <span class="muted small">
                      Hourly when enabled · checked {city.ingestion.checkedAt.slice(0, 10)}
                    </span>
                  </>
                ) : (
                  <span class="muted">Source leads only</span>
                )}
              </td>
              <td>
                <ul class="plain">
                  {city.references.map((reference) => (
                    <li key={reference.url}>
                      <a href={reference.url} rel="noopener nofollow">
                        {reference.kind} ↗
                      </a>{' '}
                      <span class="muted small">
                        {reference.reviewed ? 'reviewed' : 'candidate'}
                      </span>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="small muted">
        Source leads may need jurisdiction and freshness checks. County sheriff pages may cover
        multiple cities. Social account links are available to visit; automated social ingestion is
        not included. Public feeds can change or become unavailable.
      </p>
      <p class="small">
        <a href={POLICE_SCOPE.populationSource}>Census population source</a>
      </p>
    </Layout>
  );
};
