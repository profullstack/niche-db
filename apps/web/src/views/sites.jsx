import { Notice, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * /c/sites: a record, the tags it was read from, and the card as each
 * consumer would draw it; the paste page; a host's list. Every word on a
 * card was written by a stranger's page, so it is text, never markup, and
 * every picture is the page's own address.
 */

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

const trim = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * What each consumer would draw, from the record alone. The shapes follow
 * the consumer table in the spec: X and LinkedIn pick wide or square by
 * the twitter:card and the picture's size, Slack and Discord stack the
 * words over the picture, iMessage and WhatsApp put a square beside them.
 */
export function previewsOf(record) {
  const card = record.cards?.twitter?.card ?? '';
  const wide =
    card === 'summary_large_image' ||
    (card === '' &&
      record.image?.width &&
      record.image?.height &&
      record.image.width / record.image.height > 1.3);
  const image = record.image?.url ?? null;
  const site = host(record.canonical);
  const title = record.title || site;
  const description = record.description ?? '';
  return [
    {
      name: 'X',
      layout: wide ? 'wide' : 'square',
      title: trim(title, 70),
      description: trim(description, 125),
      footer: site,
      image,
    },
    {
      name: 'Slack',
      layout: 'stack',
      title: trim(title, 100),
      description: trim(description, 300),
      footer: record.site?.name ?? site,
      image,
    },
    {
      name: 'iMessage',
      layout: 'square',
      title: trim(title, 60),
      description: '',
      footer: site,
      image,
    },
    {
      name: 'Discord',
      layout: 'stack',
      title: trim(title, 256),
      description: trim(description, 350),
      footer: record.site?.name ?? site,
      image,
    },
    {
      name: 'LinkedIn',
      layout: 'wide',
      title: trim(title, 120),
      description: '',
      footer: site,
      image,
    },
    {
      name: 'WhatsApp',
      layout: 'square',
      title: trim(title, 65),
      description: trim(description, 80),
      footer: site,
      image,
    },
  ];
}

const Card = ({ p }) => (
  <figure class={`cardprev ${p.layout}`}>
    <figcaption>{p.name}</figcaption>
    <div class="cardprev-body">
      {p.image ? (
        <img src={p.image} alt="" loading="lazy" />
      ) : (
        <div class="cardprev-noimg">no picture</div>
      )}
      <div class="cardprev-text">
        <b>{p.title}</b>
        {p.description ? <span>{p.description}</span> : null}
        <small>{p.footer}</small>
      </div>
    </div>
  </figure>
);

const TagTable = ({ cards }) => {
  const rows = Object.entries(cards ?? {}).flatMap(([prefix, kv]) =>
    Object.entries(kv).map(([k, v]) => [`${prefix}:${k}`, v]),
  );
  if (rows.length === 0)
    return <p class="muted">The page carries no og: or twitter: tags at all.</p>;
  return (
    <table class="kv">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>
              {/^https?:\/\//.test(v) ? (
                <a href={v} rel="noopener nofollow">
                  {v}
                </a>
              ) : (
                v
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const AddForm = ({ url = '' }) => (
  <form method="post" action="/c/sites/add" class="stack form">
    <label>
      Address
      <input
        type="url"
        name="url"
        value={url}
        placeholder="https://example.com/some/page"
        required
        inputmode="url"
        autocomplete="off"
        maxlength="2048"
      />
    </label>
    <input
      type="text"
      name="website"
      tabindex="-1"
      autocomplete="off"
      style="position:absolute;left:-9999px"
    />
    <button type="submit">Read it</button>
  </form>
);

export const SiteAddPage = ({ user, url = '', notice, error, missing = false }) => (
  <Layout
    user={user}
    title={missing ? 'Not indexed yet' : 'Read a page'}
    description="Paste any address and see every tag its page carries, the card each chat app and social network would draw from it, and its OpenSite record. Read now, kept in the index."
    canonical="/c/sites/add"
  >
    <p class="crumb">
      <a href="/c/sites">Sites</a> › add
    </p>
    <h1>{missing ? 'Not indexed yet' : 'Read a page'}</h1>
    <p class="lede">
      {missing
        ? 'Nothing is kept for that address. Read it now and it will be.'
        : 'Paste an address. The page is read the way a chat app reads it, and you see every tag it carries, the card each consumer would draw, and the OpenSite record that is kept.'}
    </p>
    <Notice notice={notice} error={error} />
    <AddForm url={url} />
    <p class="small muted">
      Reads honour robots.txt and a site’s own <code>/.well-known/opensite.json</code>. The same
      read is{' '}
      <code>
        POST /api/v1/sites {'{'} "url" {'}'}
      </code>
      . Spec: <a href="https://logicsrc.com/opensite">logicsrc.com/opensite</a>.
    </p>
  </Layout>
);

export const SitePage = ({ user, record, item, path, justRead = false }) => {
  const previews = previewsOf(record);
  const image = record.image?.url && !record.image.icon ? record.image.url : null;
  const status = record.status;
  return (
    <Layout
      user={user}
      title={record.title || host(record.canonical)}
      description={
        record.description ?? `${record.title || host(record.canonical)} as an OpenSite record.`
      }
      canonical={path}
      image={image}
      imageWide={previews[0].layout === 'wide'}
    >
      <p class="crumb">
        <a href="/c/sites">Sites</a> ›{' '}
        <a href={`/c/sites/${host(record.canonical)}`}>{host(record.canonical)}</a>
      </p>
      <article class="detail">
        <h1>{record.title || host(record.canonical)}</h1>
        <p class="item-meta">
          <span class={`kind`}>{record.kind}</span> ·{' '}
          <span class={`tag ${status === 'live' ? 'ok' : 'danger'}`}>{status}</span> ·{' '}
          <a href={record.canonical} rel="noopener nofollow">
            {host(record.canonical)} ↗
          </a>{' '}
          · read <Relative at={record.fetched_at} />
          {justRead ? ' (just now)' : null}
        </p>
        {record.description ? <p class="lede">{record.description}</p> : null}
        {record.about ? <p>{record.about}</p> : null}

        <h2>What each consumer would draw</h2>
        {status !== 'live' ? (
          <p class="muted">
            {status === 'blocked'
              ? 'The site asked not to be read, so nothing is drawn.'
              : status === 'gone'
                ? 'The page answers gone; a consumer would show nothing, or its last cached card.'
                : 'The page names another origin as its canonical address; consumers follow it there.'}
          </p>
        ) : null}
        {!image && status === 'live' ? (
          <p class="muted">
            No picture: the page has no og:image or twitter:image, so every card below is words
            only.
          </p>
        ) : null}
        <div class="cardprevs">
          {previews.map((p) => (
            <Card key={p.name} p={p} />
          ))}
        </div>
        <p class="small muted">
          A consumer caches its first reading per exact URL, for hours to days. When one shows an
          old card, the only certain fix is an address it has not seen: add a query parameter it
          ignores.
        </p>

        <h2>The tags the page carries</h2>
        <TagTable cards={record.cards} />
        {record.feeds?.length ? (
          <p class="small">
            Feeds:{' '}
            {record.feeds.map((f, i) => (
              <span key={f}>
                {i ? ', ' : ''}
                <a href={f}>{f}</a>
              </span>
            ))}
          </p>
        ) : null}
        {record.author?.name || record.author?.profile ? (
          <p class="small">
            Author: {record.author.name ?? ''}{' '}
            {record.author.profile ? <a href={record.author.profile}>OpenProfile.md</a> : null}
          </p>
        ) : null}

        <h2>The OpenSite record</h2>
        <pre class="data">{JSON.stringify(record, null, 2)}</pre>
        <p class="small muted">
          <a href={`/api/v1/sites${path.slice('/c/sites'.length)}`}>JSON</a> ·{' '}
          <a href={`/c/sites/add?url=${encodeURIComponent(record.url)}`}>read again</a>
          {item?.id ? (
            <>
              {' '}
              · item <a href={`/i/${item.id}`}>{item.id}</a>
            </>
          ) : null}{' '}
          · spec <a href="https://logicsrc.com/opensite">OpenSite 0.1</a>
        </p>
      </article>
    </Layout>
  );
};

export const SiteHostPage = ({ user, host: h, items }) => (
  <Layout
    user={user}
    title={h}
    description={`Every page of ${h} kept as an OpenSite record.`}
    canonical={`/c/sites/${h}`}
  >
    <p class="crumb">
      <a href="/c/sites">Sites</a> › {h}
    </p>
    <h1>{h}</h1>
    <p class="lede">{items.length} pages kept, newest first.</p>
    <ul class="items">
      {items.map((it) => (
        <li class="item" key={it.id}>
          {it.image_url ? <img class="thumb" src={it.image_url} alt="" loading="lazy" /> : null}
          <div class="item-body">
            <a class="item-title" href={`/c/sites/${it.data?.path ?? ''}`}>
              {it.title}
            </a>
            {it.summary ? <p class="item-summary">{it.summary}</p> : null}
            <p class="item-meta">
              <span class="kind">{it.kind}</span> · read <Relative at={it.updated_at} />
            </p>
          </div>
        </li>
      ))}
    </ul>
    <p>
      <a href="/c/sites/add">Read another page</a>
    </p>
  </Layout>
);
