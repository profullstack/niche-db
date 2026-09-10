import { config } from '@nichedb/config';
import { FeedCard, ItemList, Notice, Num, Relative, Status } from './components.jsx';
import { Layout } from './Layout.jsx';
import { describeQuery } from './pages.jsx';

/**
 * Managing sources and feeds. Plain forms, one screen each, no wizard. The
 * rule for these pages: everything a person needs to decide is on the row --
 * status, last run, next run, how many items -- and every action is a button.
 */

export const SourcesPage = ({ user, sources, adapters, canAdd, notice, error }) => (
  <Layout user={user} title="Sources" wide>
    <div class="page-head">
      <div>
        <h1>Sources</h1>
        <p class="lede">
          Each source is one adapter pointed at one upstream, fetched on its own schedule. This
          deployment knows {adapters.length} adapters.
        </p>
      </div>
      <div class="actions">
        {canAdd ? (
          <a class="cta button" href="/sources/new">
            Add a source
          </a>
        ) : user ? (
          <a class="ghost button" href="/pro">
            Pro adds sources
          </a>
        ) : (
          <a class="ghost button" href="/login?next=/sources/new">
            Sign in to add
          </a>
        )}
      </div>
    </div>
    <Notice notice={notice} error={error} />
    <table class="table sources">
      <thead>
        <tr>
          <th>Status</th>
          <th>Source</th>
          <th>Adapter</th>
          <th>Items</th>
          <th>Every</th>
          <th>Last ok</th>
          <th>Next</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {sources.map((s) => (
          <tr key={s.slug} class={s.enabled ? '' : 'dim'}>
            <td>
              <Status source={s} />
            </td>
            <td>
              <a href={`/s/${s.slug}`}>{s.name}</a>
              <br />
              <span class="muted small">{s.collection_name}</span>
              {s.last_error ? <div class="small err-text">{s.last_error.slice(0, 120)}</div> : null}
            </td>
            <td class="mono small">{s.adapter}</td>
            <td>
              <Num n={s.item_count} />
            </td>
            <td class="small">{s.cadence_minutes}m</td>
            <td class="small">
              <Relative at={s.last_ok_at} />
            </td>
            <td class="small">
              {s.enabled ? <Relative at={s.next_run_at} /> : <span class="muted">paused</span>}
            </td>
            <td class="row-actions">
              {user && (user.role === 'admin' || s.owner_id === user.id) ? (
                <>
                  <form method="post" action={`/s/${s.slug}/run`} class="inline">
                    <button type="submit" class="ghost small" title="Fetch now">
                      Run
                    </button>
                  </form>
                  <form method="post" action={`/s/${s.slug}/toggle`} class="inline">
                    <button type="submit" class="ghost small">
                      {s.enabled ? 'Pause' : 'Resume'}
                    </button>
                  </form>
                </>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <h2>Adapters</h2>
    <ul class="cards">
      {adapters.map((a) => (
        <li class="card" key={a.name}>
          <span class="card-title">{a.title}</span>
          <p class="card-desc muted small">{a.description}</p>
          <p class="small">
            <span class="mono">{a.name}</span> · {a.collection} · every {a.cadenceMinutes}m
            {a.needsEnv.length ? <span class="muted"> · needs {a.needsEnv.join(', ')}</span> : null}
            {canAdd ? (
              <>
                {' · '}
                <a href={`/sources/new?adapter=${a.name}`}>add</a>
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  </Layout>
);

export const SourceForm = ({ user, adapters, adapter, collections, values = {}, error }) => (
  <Layout user={user} title="Add a source">
    <h1>Add a source</h1>
    {error ? <p class="feedback error">{error}</p> : null}
    {!adapter ? (
      <>
        <p class="lede">Pick what to watch.</p>
        <ul class="cards">
          {adapters.map((a) => (
            <li class="card" key={a.name}>
              <a class="card-title" href={`/sources/new?adapter=${a.name}`}>
                {a.title}
              </a>
              <p class="card-desc muted small">{a.description}</p>
            </li>
          ))}
        </ul>
      </>
    ) : (
      <form method="post" action="/sources/new" class="stack form">
        <input type="hidden" name="adapter" value={adapter.name} />
        <p class="muted">
          <b>{adapter.title}</b> — {adapter.description}{' '}
          {adapter.docs ? (
            <a href={adapter.docs} rel="noopener">
              docs ↗
            </a>
          ) : null}
        </p>
        <label>
          Name
          <input
            type="text"
            name="name"
            value={values.name ?? ''}
            placeholder={`My ${adapter.title}`}
            maxlength="120"
          />
        </label>
        <label>
          Collection
          <select name="collection">
            {collections.map((c) => (
              <option
                key={c.slug}
                value={c.slug}
                selected={(values.collection ?? adapter.collection) === c.slug}
              >
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {adapter.configFields.map((f) => (
          <label key={f.key} for={`cfg-${f.key}`}>
            {f.label}
            {f.required ? ' *' : ''}
            {f.type === 'select' ? (
              <select id={`cfg-${f.key}`} name={`config.${f.key}`}>
                {f.options.map((o) => (
                  <option key={o} value={o} selected={(values.config?.[f.key] ?? '') === o}>
                    {o || '(any)'}
                  </option>
                ))}
              </select>
            ) : f.type === 'list' ? (
              <textarea
                id={`cfg-${f.key}`}
                name={`config.${f.key}`}
                rows="3"
                placeholder={f.placeholder}
              >
                {Array.isArray(values.config?.[f.key])
                  ? values.config[f.key].join(', ')
                  : (values.config?.[f.key] ?? '')}
              </textarea>
            ) : (
              <input
                id={`cfg-${f.key}`}
                type={f.type === 'number' ? 'number' : 'text'}
                name={`config.${f.key}`}
                value={values.config?.[f.key] ?? ''}
                placeholder={f.placeholder}
              />
            )}
            {f.help ? <span class="help">{f.help}</span> : null}
          </label>
        ))}
        <label>
          Fetch every (minutes)
          <input
            type="number"
            name="cadence_minutes"
            min="5"
            max="1440"
            value={values.cadence_minutes ?? adapter.cadenceMinutes}
          />
        </label>
        <button type="submit" class="cta">
          Add source
        </button>
      </form>
    )}
  </Layout>
);

export const SourcePage = ({ user, source, adapter, runs, items, canEdit, notice, error }) => (
  <Layout user={user} title={source.name} canonical={`/s/${source.slug}`}>
    <p class="crumb">
      <a href={`/c/${source.collection_slug}`}>{source.collection_name}</a> ›{' '}
      <a href="/sources">sources</a>
    </p>
    <div class="page-head">
      <div>
        <h1>{source.name}</h1>
        <p class="small muted">
          <Status source={source} /> · <span class="mono">{source.adapter}</span> · every{' '}
          {source.cadence_minutes}m · <Num n={source.item_count} /> items · {source.run_count} runs
          · next <Relative at={source.next_run_at} />
        </p>
        {source.description ? <p class="muted">{source.description}</p> : null}
        {source.last_error ? <p class="feedback error">{source.last_error}</p> : null}
      </div>
      {canEdit ? (
        <div class="actions">
          <form method="post" action={`/s/${source.slug}/run`} class="inline">
            <button type="submit" class="cta">
              Run now
            </button>
          </form>
          <form method="post" action={`/s/${source.slug}/toggle`} class="inline">
            <button type="submit" class="ghost">
              {source.enabled ? 'Pause' : 'Resume'}
            </button>
          </form>
        </div>
      ) : null}
    </div>
    <Notice notice={notice} error={error} />

    {canEdit && adapter ? (
      <details class="panel">
        <summary>Edit</summary>
        <form method="post" action={`/s/${source.slug}/edit`} class="stack form">
          <label>
            Name
            <input type="text" name="name" value={source.name} maxlength="120" />
          </label>
          {adapter.configFields.map((f) => (
            <label key={f.key} for={`edit-${f.key}`}>
              {f.label}
              {f.type === 'select' ? (
                <select id={`edit-${f.key}`} name={`config.${f.key}`}>
                  {f.options.map((o) => (
                    <option key={o} value={o} selected={String(source.config?.[f.key] ?? '') === o}>
                      {o || '(any)'}
                    </option>
                  ))}
                </select>
              ) : f.type === 'list' ? (
                <textarea id={`edit-${f.key}`} name={`config.${f.key}`} rows="3">
                  {Array.isArray(source.config?.[f.key])
                    ? source.config[f.key].join(', ')
                    : (source.config?.[f.key] ?? '')}
                </textarea>
              ) : (
                <input
                  id={`edit-${f.key}`}
                  type={f.type === 'number' ? 'number' : 'text'}
                  name={`config.${f.key}`}
                  value={source.config?.[f.key] ?? ''}
                />
              )}
              {f.help ? <span class="help">{f.help}</span> : null}
            </label>
          ))}
          <label>
            Fetch every (minutes)
            <input
              type="number"
              name="cadence_minutes"
              min="5"
              max="1440"
              value={source.cadence_minutes}
            />
          </label>
          <button type="submit" class="cta">
            Save
          </button>
        </form>
        <form
          method="post"
          action={`/s/${source.slug}/delete`}
          data-confirm="Delete this source and every item it produced?"
        >
          <button type="submit" class="ghost danger">
            Delete source
          </button>
        </form>
      </details>
    ) : null}

    <div class="cols">
      <section>
        <h2>Recent runs</h2>
        {runs.length === 0 ? (
          <p class="muted small">Not run yet.</p>
        ) : (
          <table class="table small">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Seen</th>
                <th>New</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Relative at={r.started_at} />
                  </td>
                  <td class={r.status === 'error' ? 'err-text' : ''}>{r.status}</td>
                  <td>{r.seen}</td>
                  <td>{r.added}</td>
                  <td class="muted">{r.error ? r.error.slice(0, 100) : r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="small">
          Config: <code class="mono">{JSON.stringify(source.config)}</code>
        </p>
      </section>
      <section>
        <h2>Latest items</h2>
        <ItemList items={items} showSource={false} />
        <p class="small muted">
          <a href={`/feeds/new?collection=${source.collection_slug}&sources=${source.slug}`}>
            Make a feed of just this source
          </a>{' '}
          · <a href={`/api/v1/items?source=${source.slug}`}>JSON</a>
        </p>
      </section>
    </div>
  </Layout>
);

export const FeedsPage = ({ user, feeds, mine, notice, error }) => (
  <Layout user={user} title="Feeds">
    <div class="page-head">
      <div>
        <h1>Feeds</h1>
        <p class="lede">
          A feed is a saved query: a collection, narrowed however you like. Follow one, subscribe to
          its RSS, or read it over the API.
        </p>
      </div>
      <div class="actions">
        <a class="cta button" href="/feeds/new">
          Make a feed
        </a>
      </div>
    </div>
    <Notice notice={notice} error={error} />
    {mine?.length ? (
      <>
        <h2>Yours</h2>
        <ul class="cards">
          {mine.map((f) => (
            <FeedCard key={f.slug} feed={f} />
          ))}
        </ul>
      </>
    ) : null}
    <h2>Public feeds</h2>
    <ul class="cards">
      {feeds.map((f) => (
        <FeedCard key={f.slug} feed={f} />
      ))}
    </ul>
  </Layout>
);

export const FeedForm = ({
  user,
  collections,
  collection,
  sources,
  kinds,
  values = {},
  error,
  editing = null,
  preview = [],
}) => (
  <Layout user={user} title={editing ? `Edit ${editing.name}` : 'Make a feed'} wide>
    <h1>{editing ? `Edit ${editing.name}` : 'Make a feed'}</h1>
    {error ? <p class="feedback error">{error}</p> : null}
    <div class="cols">
      <form
        method={editing ? 'post' : 'get'}
        action={editing ? `/f/${editing.slug}/edit` : '/feeds/new'}
        class="stack form"
        id="feed-form"
      >
        {!editing ? (
          <label>
            Collection
            <select name="collection" onchange="this.form.submit()">
              {collections.map((c) => (
                <option key={c.slug} value={c.slug} selected={collection?.slug === c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Name
          <input
            type="text"
            name="name"
            value={values.name ?? ''}
            placeholder="e.g. Indie games under $10"
            maxlength="120"
            required={Boolean(editing)}
          />
        </label>
        <label>
          Description
          <input type="text" name="description" value={values.description ?? ''} maxlength="200" />
        </label>
        <fieldset>
          <legend>Sources (none = all)</legend>
          {sources.map((s) => (
            <label class="check" key={s.slug}>
              <input
                type="checkbox"
                name="sources"
                value={s.slug}
                checked={values.sources?.includes(s.slug)}
              />{' '}
              {s.name}
            </label>
          ))}
        </fieldset>
        {kinds.length > 1 ? (
          <fieldset>
            <legend>Kinds (none = all)</legend>
            {kinds.map((k) => (
              <label class="check" key={k.kind}>
                <input
                  type="checkbox"
                  name="kinds"
                  value={k.kind}
                  checked={values.kinds?.includes(k.kind)}
                />{' '}
                {k.kind}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label>
          Tags (comma separated; any match)
          <input
            type="text"
            name="tags"
            value={Array.isArray(values.tags) ? values.tags.join(', ') : (values.tags ?? '')}
            placeholder="free, indie, rpg"
          />
        </label>
        <label>
          Text match
          <input
            type="text"
            name="q"
            value={values.q ?? ''}
            placeholder="words in the title or summary"
          />
        </label>
        <label class="check">
          <input type="checkbox" name="upcoming" value="1" checked={Boolean(values.upcoming)} />{' '}
          Only items dated in the future (a calendar)
        </label>
        <label class="check">
          <input
            type="checkbox"
            name="public"
            value="1"
            checked={values.public !== false && values.public !== '0'}
          />{' '}
          Public (listed on the feeds page)
        </label>
        {editing ? (
          <button type="submit" class="cta">
            Save
          </button>
        ) : (
          <div class="row">
            <button type="submit" class="ghost" name="preview" value="1">
              Preview
            </button>
            <button type="submit" class="cta" formmethod="post" formaction="/feeds/new">
              Create feed
            </button>
          </div>
        )}
      </form>
      <section>
        <h2>Preview</h2>
        <p class="small muted">{describeQuery(values)}</p>
        <ItemList
          items={preview}
          empty="Nothing matches yet. Widen the query, or wait for the sources to fill."
        />
      </section>
    </div>
    {editing ? (
      <form
        method="post"
        action={`/f/${editing.slug}/delete`}
        data-confirm="Delete this feed? Followers lose it."
      >
        <button type="submit" class="ghost danger">
          Delete feed
        </button>
      </form>
    ) : null}
  </Layout>
);

/* ------------------------------------------------------------------ docs -- */

export const ApiDocs = ({ user, stats }) => (
  <Layout user={user} title="API">
    <h1>API</h1>
    <p class="lede">
      Everything on the site is JSON under <code>/api/v1</code>. Reads need no key. Writes and
      higher limits take a key from <a href="/settings">settings</a> as{' '}
      <code>Authorization: Bearer ndb_…</code>.
    </p>
    <p class="stats">
      <Num n={stats.items} /> items · <Num n={stats.sources} /> sources · <Num n={stats.feeds} />{' '}
      feeds
    </p>
    <h2>Read</h2>
    <table class="table small">
      <tbody>
        {[
          ['GET /api/v1', 'This description, live counts and your rate-limit tier.'],
          ['GET /api/v1/collections', 'Every collection with counts.'],
          ['GET /api/v1/adapters', 'Every adapter and the config fields it takes.'],
          [
            'GET /api/v1/enrichers',
            'Every enricher: what it adds and which collections turn it on by default.',
          ],
          ['GET /api/v1/sources?collection=games', 'Sources, with status and last run.'],
          ['GET /api/v1/sources/:slug', 'One source and its recent runs.'],
          ['GET /api/v1/feeds?collection=packages', 'Public feeds.'],
          [
            'GET /api/v1/feeds/:slug/items?limit=50&before=<id>',
            'What a feed selects, newest first.',
          ],
          [
            'GET /api/v1/items?collection=&source=&kind=&tags=&from=&to=&since=&sort=&order=&limit=&before=&after=',
            'Newest items, keyset paged. tags= is every tag the item must carry (state:in,league:nba); from=/to= bound published_at; since= is what changed on updated_at, for a site keeping its own copy; sort=id|published|updated.',
          ],
          [
            'GET /api/v1/match?q=&collection=&kind=&year=&tags=',
            'Which title, channel or fixture is this name? q is cleaned like a release name (year, S02E03, quality tags, playlist decorations stripped) and matched by trigram similarity; each item carries score.',
          ],
          [
            'GET /api/v1/items/upcoming?collection=games&days=30',
            'Items dated in the future, soonest first.',
          ],
          ['GET /api/v1/items/:id', 'One item with its full data payload.'],
          ['GET /api/v1/search?q=mcp&collection=packages', 'Full-text search.'],
          ['GET /f/:slug.rss · GET /f/:slug.json', 'A feed as RSS 2.0 or JSON Feed.'],
        ].map(([p, d]) => (
          <tr key={p}>
            <td class="mono">{p}</td>
            <td>{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <h2>Write (key required)</h2>
    <table class="table small">
      <tbody>
        {[
          ['GET /api/v1/me', 'Who the key belongs to, tier, limits.'],
          [
            'POST /api/v1/feeds',
            '{ collection, name, description?, sources?, kinds?, tags?, q?, upcoming?, public? }',
          ],
          ['PATCH /api/v1/feeds/:slug · DELETE /api/v1/feeds/:slug', 'Edit or remove your feed.'],
          [
            'POST /api/v1/feeds/:slug/follow · DELETE …/follow',
            '{ channels?: ["webpush","email","webhook"], webhook_url?, webhook_secret? }',
          ],
          [
            'POST /api/v1/sources',
            '{ adapter, collection?, name?, config: {…}, cadence_minutes? } — admins and Pro.',
          ],
          [
            'PATCH /api/v1/sources/:slug · DELETE …',
            '{ name?, config?, cadence_minutes?, enabled? }',
          ],
          ['POST /api/v1/sources/:slug/run', 'Fetch now.'],
        ].map(([p, d]) => (
          <tr key={p}>
            <td class="mono">{p}</td>
            <td>{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <h2>Limits</h2>
    <p class="small">
      Anonymous: {config.api.anonPerHour.toLocaleString('en-US')}/hour per address. Key:{' '}
      {config.api.freePerHour.toLocaleString('en-US')}/hour. Pro key:{' '}
      {config.api.proPerHour.toLocaleString('en-US')}/hour. Every response carries{' '}
      <code>x-ratelimit-remaining</code>.
    </p>
    <h2>Items</h2>
    <p class="small">
      Every item has <code>published_at</code>, <code>time_known</code> and <code>precision</code>.
      When time_known is false the date is real and the clock is not; do not render it as a time.{' '}
      <code>data</code> is the adapter's own payload and differs per kind.
    </p>
  </Layout>
);

export const CliDocs = ({ user, commands }) => (
  <Layout user={user} title="CLI">
    <h1>CLI</h1>
    <p class="lede">
      <code>nichedb</code> is a zero-dependency Node script that talks to this API. It is also an
      MCP server: <code>nichedb mcp</code> speaks stdio for Claude Code, Cursor and friends.
    </p>
    <pre class="data">{`npm install -g @profullstack/nichedb
nichedb login --api ${config.siteUrl}      # paste a key from /settings
nichedb collections
nichedb feeds --collection packages
nichedb items form-d-raises --limit 20
nichedb search "mcp server" --collection packages --json
nichedb source add npm --name "npm: mcp only" --config match=mcp
nichedb feed create --collection games --name "Free this week" --tags free --upcoming`}</pre>
    <table class="table small">
      <tbody>
        {commands.map((c) => (
          <tr key={c.name}>
            <td class="mono">{c.usage}</td>
            <td>{c.summary}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <h2>As an MCP server</h2>
    <pre class="data">{`claude mcp add nichedb -- nichedb mcp --api ${config.siteUrl}`}</pre>
    <p class="small muted">
      Or point a Streamable HTTP client straight at <code>{config.siteUrl}/mcp</code>. See{' '}
      <a href="/docs/mcp">MCP</a>.
    </p>
  </Layout>
);

export const McpDocs = ({ user, tools }) => (
  <Layout user={user} title="MCP">
    <h1>MCP</h1>
    <p class="lede">
      A stateless Model Context Protocol server at <code>{config.siteUrl}/mcp</code> (Streamable
      HTTP, POST). Reads need no key. Send <code>Authorization: Bearer ndb_…</code> for the tools
      that write.
    </p>
    <pre class="data">{`claude mcp add --transport http nichedb ${config.siteUrl}/mcp
# or, through the CLI over stdio:
claude mcp add nichedb -- nichedb mcp --api ${config.siteUrl}`}</pre>
    <table class="table small">
      <tbody>
        {tools.map((t) => (
          <tr key={t.name}>
            <td class="mono">{t.name}</td>
            <td>{t.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p class="small muted">
      Also: <a href="/llms.txt">/llms.txt</a> describes the whole deployment in one document, and it
      is the server's one resource.
    </p>
  </Layout>
);
