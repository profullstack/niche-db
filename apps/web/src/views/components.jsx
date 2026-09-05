/** Shared bits of markup. Small and dumb on purpose. */

const fmtTimeUtc = (d) =>
  new Date(d).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
export const fmtDayUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const fmtMonthUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const fmtYearUtc = (d) =>
  new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric' });

/**
 * Times are rendered in UTC on the server and localised in the browser. A row
 * whose clock time nobody announced never shows one.
 */
export const When = ({ item }) => {
  const at = item.published_at ?? item.first_seen_at;
  if (!at) return null;
  const iso = new Date(at).toISOString();
  if (item.published_at && !item.time_known) {
    const text =
      item.precision === 'year'
        ? fmtYearUtc(at)
        : item.precision === 'month'
          ? fmtMonthUtc(at)
          : fmtDayUtc(at);
    return (
      <time datetime={iso} class="undated" title="date only">
        {text}
      </time>
    );
  }
  return (
    <time datetime={iso} data-local>
      <span data-local-day>{fmtDayUtc(at)}</span> <span data-local-time>{fmtTimeUtc(at)}</span>
    </time>
  );
};

export const Relative = ({ at }) => {
  if (!at) return <span class="muted">never</span>;
  return (
    <time datetime={new Date(at).toISOString()} data-relative>
      {fmtDayUtc(at)}
    </time>
  );
};

export const Status = ({ source }) => {
  const cls = !source.enabled
    ? 'off'
    : source.last_error
      ? 'err'
      : source.last_ok_at
        ? 'ok'
        : 'idle';
  const label = !source.enabled
    ? 'paused'
    : source.last_error
      ? 'error'
      : source.last_ok_at
        ? 'ok'
        : 'waiting';
  return (
    <span class={`status ${cls}`} title={source.last_error ?? label}>
      <i /> {label}
    </span>
  );
};

export const Tags = ({ tags, collection, limit = 6 }) => {
  if (!tags?.length) return null;
  return (
    <span class="tags">
      {tags.slice(0, limit).map((t) => (
        <a
          key={t}
          class="tag"
          href={
            collection
              ? `/c/${collection}?tag=${encodeURIComponent(t)}`
              : `/search?q=${encodeURIComponent(t)}`
          }
        >
          {t}
        </a>
      ))}
    </span>
  );
};

export const ItemRow = ({ item, showSource = true }) => (
  <li class="item">
    {item.image_url ? (
      <img class="thumb" src={item.image_url} alt="" loading="lazy" />
    ) : (
      <span class="thumb blank" />
    )}
    <div class="item-body">
      <a class="item-title" href={`/i/${item.id}`}>
        {item.title}
      </a>
      {item.summary ? <p class="item-summary">{item.summary.slice(0, 220)}</p> : null}
      <p class="item-meta">
        <When item={item} />
        {showSource ? (
          <>
            {' · '}
            <a href={`/s/${item.source_slug}`}>{item.source_name}</a>
          </>
        ) : null}
        {' · '}
        <span class="kind">{item.kind}</span>
        {item.url ? (
          <>
            {' · '}
            <a href={item.url} rel="noopener nofollow">
              open ↗
            </a>
          </>
        ) : null}
      </p>
      <Tags tags={item.tags} collection={item.collection_slug} />
    </div>
  </li>
);

export const ItemList = ({ items, showSource = true, empty = 'Nothing here yet.' }) =>
  items.length === 0 ? (
    <p class="muted empty">{empty}</p>
  ) : (
    <ul class="items">
      {items.map((i) => (
        <ItemRow key={i.id} item={i} showSource={showSource} />
      ))}
    </ul>
  );

export const Pager = ({ items, base }) => {
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  const sep = base.includes('?') ? '&' : '?';
  return (
    <p class="pager">
      <a class="ghost button" href={`${base}${sep}before=${last.id}`}>
        Older →
      </a>
    </p>
  );
};

export const Notice = ({ notice, error }) => (
  <>
    {error ? (
      <p class="feedback error" role="alert">
        {error}
      </p>
    ) : null}
    {notice ? (
      <p class="feedback ok" role="status">
        {notice}
      </p>
    ) : null}
  </>
);

export const FeedCard = ({ feed }) => (
  <li class="card">
    <a class="card-title" href={`/f/${feed.slug}`}>
      {feed.name}
    </a>
    <p class="card-desc muted">
      {feed.collection_name}
      {feed.follower_count ? ` · ${feed.follower_count} following` : ''}
    </p>
    <p class="card-links small">
      <a href={`/f/${feed.slug}.rss`}>RSS</a> · <a href={`/f/${feed.slug}.json`}>JSON</a>
    </p>
  </li>
);

export const Num = ({ n }) => <span class="num">{Number(n ?? 0).toLocaleString('en-US')}</span>;
