/**
 * How enrichment is shown. One block per enricher on the item page, one badge
 * per enricher on a row. Only the enrichers the feed (or the collection's
 * defaults) allow reach here; filtering happens in lib/serialize.
 */

export const Badges = ({ enrichment }) => {
  const e = enrichment ?? {};
  const out = [];
  if (e.youtube?.videos?.length)
    out.push(`▶ ${e.youtube.videos.length} video${e.youtube.videos.length === 1 ? '' : 's'}`);
  if (e.wikipedia) out.push('Wikipedia');
  if (e['github-repo']) out.push(`★ ${fmt(e['github-repo'].stars)}`);
  if (e['npm-stats']) out.push(`⇩ ${fmt(e['npm-stats'].weeklyDownloads)}/wk`);
  if (e['semantic-scholar']) out.push(`${fmt(e['semantic-scholar'].citations)} cites`);
  if (e['sec-company']?.tickers?.length) out.push(e['sec-company'].tickers.slice(0, 2).join(' '));
  if (out.length === 0) return null;
  return (
    <span class="badges">
      {out.map((b) => (
        <span class="badge" key={b}>
          {b}
        </span>
      ))}
    </span>
  );
};

const fmt = (n) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n ?? 0);

export const EnrichmentBlocks = ({ enrichment }) => {
  const e = enrichment ?? {};
  const blocks = [];
  if (e.youtube?.videos?.length) {
    const [first, ...rest] = e.youtube.videos;
    blocks.push(
      <section class="enrich" key="youtube">
        <h2>Videos</h2>
        <div class="video">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${first.id}`}
            title={first.title}
            loading="lazy"
            allow="accelerometer; encrypted-media; picture-in-picture"
            allowfullscreen
          />
        </div>
        <ul class="plain small">
          {[first, ...rest].map((v) => (
            <li key={v.id}>
              <a href={v.url} rel="noopener nofollow">
                {v.title}
              </a>
              {v.channel ? <span class="muted"> · {v.channel}</span> : null}
              {v.length ? <span class="muted"> · {v.length}</span> : null}
            </li>
          ))}
        </ul>
      </section>,
    );
  }
  if (e.wikipedia?.extract) {
    blocks.push(
      <section class="enrich" key="wikipedia">
        <h2>From Wikipedia</h2>
        <p>{e.wikipedia.extract}</p>
        <p class="small muted">
          <a href={e.wikipedia.url} rel="noopener">
            {e.wikipedia.title} on Wikipedia ↗
          </a>
        </p>
      </section>,
    );
  }
  if (e['github-repo']) {
    const g = e['github-repo'];
    blocks.push(
      <section class="enrich" key="github">
        <h2>Repository</h2>
        <p>
          <a href={g.url} rel="noopener">
            {g.repo}
          </a>{' '}
          · ★ {fmt(g.stars)} · {fmt(g.forks)} forks · {g.openIssues} open issues
          {g.language ? ` · ${g.language}` : ''}
          {g.license ? ` · ${g.license}` : ''}
          {g.archived ? ' · archived' : ''}
        </p>
        {g.description ? <p class="muted">{g.description}</p> : null}
        {g.topics?.length ? <p class="small muted">{g.topics.join(' · ')}</p> : null}
      </section>,
    );
  }
  if (e['npm-stats']) {
    blocks.push(
      <section class="enrich" key="npm">
        <h2>Downloads</h2>
        <p>
          {Number(e['npm-stats'].weeklyDownloads).toLocaleString('en-US')} downloads in the week to{' '}
          {e['npm-stats'].to}.
        </p>
      </section>,
    );
  }
  if (e['semantic-scholar']) {
    const s = e['semantic-scholar'];
    blocks.push(
      <section class="enrich" key="s2">
        <h2>Semantic Scholar</h2>
        {s.tldr ? <p>TL;DR: {s.tldr}</p> : null}
        <p class="small muted">
          {s.citations} citations ({s.influential} influential)
          {s.pdf ? (
            <>
              {' · '}
              <a href={s.pdf} rel="noopener">
                open-access PDF
              </a>
            </>
          ) : null}
          {' · '}
          <a href={s.url} rel="noopener">
            on Semantic Scholar ↗
          </a>
        </p>
      </section>,
    );
  }
  if (e['sec-company']) {
    const c = e['sec-company'];
    blocks.push(
      <section class="enrich" key="sec">
        <h2>Filer</h2>
        <p>
          {c.name}
          {c.tickers?.length
            ? ` · ${c.tickers.join(', ')}${c.exchanges?.length ? ` (${c.exchanges.join(', ')})` : ''}`
            : ''}
          {c.industry ? ` · ${c.industry}` : ''}
          {c.state ? ` · ${c.state}` : ''}
          {c.entityType ? ` · ${c.entityType}` : ''}
        </p>
        {c.website ? (
          <p class="small muted">
            <a href={c.website} rel="noopener nofollow">
              {c.website}
            </a>
          </p>
        ) : null}
      </section>,
    );
  }
  if (e['openlibrary-work']?.description) {
    blocks.push(
      <section class="enrich" key="ol">
        <h2>Description</h2>
        <p>{e['openlibrary-work'].description}</p>
      </section>,
    );
  }
  if (e.opengraph?.description && !e.wikipedia) {
    blocks.push(
      <section class="enrich" key="og">
        <h2>{e.opengraph.site ? `From ${e.opengraph.site}` : 'Preview'}</h2>
        <p>{e.opengraph.description}</p>
      </section>,
    );
  }
  return blocks.length ? <div class="enrichment">{blocks}</div> : null;
};
