import { Notice, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * Suggesting a feed, and the queue an admin decides it in. Two screens, plain
 * forms. The submitter's screen asks for one thing (the URL) and offers two
 * more (a collection, a note); everything else is the admin's problem.
 */

export const SubmitPage = ({ user, collections, collection, values = {}, notice, error }) => (
  <Layout
    user={user}
    title="Submit a feed"
    description="Suggest an RSS or Atom feed for the index. An admin looks at every suggestion before it is fetched."
    canonical="/submit"
  >
    <h1>Submit a feed</h1>
    <p class="lede">
      Know a feed that belongs here? Paste its address. Every suggestion is read by a person before
      anything is fetched, so it may take a day to appear.
    </p>
    <Notice notice={notice} error={error} />
    <form method="post" action="/submit" class="stack form">
      <label>
        Feed URL *
        <input
          type="url"
          name="url"
          value={values.url ?? ''}
          placeholder="https://example.com/feed.xml"
          required
          inputmode="url"
          autocomplete="off"
          maxlength="2048"
        />
      </label>
      <label>
        Collection
        <select name="collection">
          <option value="" selected={!(values.collection ?? collection)}>
            Let an admin decide
          </option>
          {collections.map((c) => (
            <option
              key={c.slug}
              value={c.slug}
              selected={(values.collection ?? collection) === c.slug}
            >
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Why it belongs here <span class="muted">(optional)</span>
        <textarea
          name="note"
          rows="3"
          maxlength="1000"
          placeholder="Who publishes it, what it covers."
        >
          {values.note ?? ''}
        </textarea>
      </label>
      {user ? null : (
        <label>
          Your email <span class="muted">(optional, to hear back)</span>
          <input
            type="email"
            name="email"
            value={values.email ?? ''}
            placeholder="you@example.com"
            autocomplete="email"
            maxlength="254"
          />
        </label>
      )}
      {/* A field no person sees and no person fills in. A bot does. */}
      <div class="hp" aria-hidden="true" style="position:absolute;left:-9999px;top:auto">
        <label>
          Website
          <input type="text" name="website" tabindex="-1" autocomplete="off" />
        </label>
      </div>
      <p>
        <button type="submit" class="cta">
          Suggest it
        </button>
      </p>
    </form>
    <p class="muted small">
      Podcast feeds are handed to{' '}
      <a href="https://rssamplifier.com" rel="noopener">
        rssamplifier
      </a>
      , the directory this site's podcasts collection reads. Everything else becomes a source here,
      fetched every few minutes, and shows up on its collection page and in the API.
    </p>
  </Layout>
);

const Probe = ({ probe }) => {
  if (!probe || probe.status === null || probe.status === undefined)
    return <span class="muted">not probed</span>;
  if (probe.error)
    return <span class="muted">unreachable: {String(probe.error).slice(0, 80)}</span>;
  return (
    <span>
      HTTP {probe.status}
      {probe.looksLikeFeed ? ' · parses as a feed' : ' · not a feed?'}
      {probe.contentType ? (
        <span class="muted small"> · {String(probe.contentType).split(';')[0]}</span>
      ) : null}
    </span>
  );
};

export const SubmissionsAdmin = ({ user, pending, decided, collections, notice, error }) => (
  <Layout user={user} title="Feed suggestions" wide>
    <div class="page-head">
      <div>
        <h1>Feed suggestions</h1>
        <p class="lede">
          {pending.length === 0
            ? 'Nothing waiting.'
            : `${pending.length} waiting. Approving a podcast feed hands it to rssamplifier; anything else becomes a newsfeed source in the collection you pick and is fetched at once.`}
        </p>
      </div>
      <div class="actions">
        <a class="ghost button" href="/admin/knowledge">
          Knowledge queue
        </a>
      </div>
    </div>
    <Notice notice={notice} error={error} />

    <section>
      <h2>Waiting</h2>
      {pending.length === 0 ? (
        <p class="muted empty">Nothing waiting.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Feed</th>
              <th>Who</th>
              <th>When</th>
              <th>Probe</th>
              <th>Decide</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((s) => (
              <tr key={s.id}>
                <td>
                  <a href={s.feed_url} rel="noopener nofollow ugc">
                    {s.probe?.title ? String(s.probe.title) : s.feed_url}
                  </a>
                  {s.probe?.title ? (
                    <>
                      <br />
                      <span class="muted small">{s.feed_url}</span>
                    </>
                  ) : null}
                  {s.note ? (
                    <>
                      <br />
                      {/* Submitted text, rendered as text. Never as markup. */}
                      <span class="small">{s.note}</span>
                    </>
                  ) : null}
                </td>
                <td>
                  {s.user_handle ?? s.user_email ?? s.email ?? <span class="muted">anonymous</span>}
                </td>
                <td>
                  <Relative at={s.created_at} />
                </td>
                <td>
                  <Probe probe={s.probe} />
                </td>
                <td>
                  <form method="post" action={`/admin/submissions/${s.id}`} class="stack">
                    <input type="hidden" name="decision" value="approve" />
                    <select name="collection" aria-label="Collection">
                      {collections.map((c) => (
                        <option
                          key={c.slug}
                          value={c.slug}
                          selected={(s.collection_slug ?? 'news') === c.slug}
                        >
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      name="section"
                      value="world"
                      aria-label="Section, for newsfeed sources"
                      maxlength="40"
                    />
                    <button type="submit">Approve</button>
                  </form>
                  <form method="post" action={`/admin/submissions/${s.id}`} class="inline">
                    <input type="hidden" name="decision" value="reject" />
                    <button type="submit" class="ghost">
                      Reject
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section>
      <h2>Decided</h2>
      {decided.length === 0 ? (
        <p class="muted empty">Nothing decided yet.</p>
      ) : (
        <table class="table small">
          <thead>
            <tr>
              <th>Feed</th>
              <th>Outcome</th>
              <th>By</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {decided.map((s) => (
              <tr key={s.id} class={s.status === 'rejected' ? 'dim' : ''}>
                <td>
                  <a href={s.feed_url} rel="noopener nofollow ugc">
                    {s.probe?.title ? String(s.probe.title) : s.feed_url}
                  </a>
                </td>
                <td>
                  {s.status}
                  {s.source_slug ? (
                    <>
                      {' → '}
                      <a href={`/s/${s.source_slug}`}>{s.source_slug}</a>
                    </>
                  ) : s.forwarded_to ? (
                    ` → ${s.forwarded_to}`
                  ) : null}
                  {s.decision_note ? <span class="muted small"> · {s.decision_note}</span> : null}
                </td>
                <td>{s.decided_by_email ?? <span class="muted">—</span>}</td>
                <td>
                  <Relative at={s.decided_at ?? s.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </Layout>
);
