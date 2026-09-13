import { config } from '@nichedb/config';
import { parseOpenProfile } from '@profullstack/openprofile';
import { mdUrlOf, pathOf } from '../lib/profiles.js';
import { Notice, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * A person, as their OpenProfile.md reads once merged: the identity block,
 * the headline, accounts as links with the network named, topics, the shows
 * (Broadcast) and the appearances offered (Guest), every other section as
 * written, and where each of it came from. The file itself is one link away
 * and is what a reader on another site should take.
 */

const linkish = (v) => /^(https?:\/\/|mailto:)/i.test(String(v));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v));

const Value = ({ v }) => {
  const s = String(v ?? '');
  if (linkish(s))
    return (
      <a href={s} rel="noopener nofollow me">
        {s.replace(/^https?:\/\//, '')}
      </a>
    );
  if (isEmail(s)) return <a href={`mailto:${s}`}>{s}</a>;
  return <span>{s}</span>;
};

/** `- **Key**: value` bullets as a definition list; anything else as lines. */
const SectionBody = ({ body }) => {
  const lines = String(body ?? '').split('\n');
  const kv = [];
  const rest = [];
  for (const line of lines) {
    const m = /^\s*[-*+]\s+\*{0,2}([^*:]{1,40}?)\*{0,2}\s*:\*{0,2}\s*(.*)$/.exec(line);
    if (m) kv.push([m[1].trim(), m[2].trim()]);
    else if (line.trim()) rest.push(line.replace(/^\s*[-*+]\s+/, ''));
  }
  return (
    <>
      {kv.length ? (
        <dl class="kv">
          {kv.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>
                <Value v={v} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {rest.length ? (
        <ul class="plain">
          {rest.map((l, i) => (
            <li key={`${i}-${l.slice(0, 20)}`}>{renderInline(l)}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
};

/** `[label](url)` and bare URLs as links; everything else as text. */
function renderInline(text) {
  const parts = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m = re.exec(text);
  let i = 0;
  while (m) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const href = m[2] ?? m[3];
    parts.push(
      <a key={`l${i++}`} href={href} rel="noopener nofollow">
        {m[1] || href.replace(/^https?:\/\//, '')}
      </a>,
    );
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const HIDDEN = new Set(['accounts', 'topics']);

export const ProfilePage = ({ user, profile, canEdit, notice, error }) => {
  const view = profile.data ?? {};
  const doc = parseOpenProfile(profile.doc);
  const identity = doc.identity.filter((e) => !/^avatar$/i.test(e.key));
  const avatar = view.identity?.avatar ?? null;
  const md = mdUrlOf(profile);
  return (
    <Layout
      user={user}
      title={profile.name}
      description={profile.headline ?? `${profile.name} on ${config.siteName}`}
      canonical={pathOf(profile)}
      openprofile={md}
    >
      <p class="crumb">
        <a href="/c/profiles">People</a> › {profile.name}
      </p>
      <Notice notice={notice} error={error} />
      <article class="detail profile">
        {avatar ? <img class="hero-img avatar" src={avatar} alt="" width="160" /> : null}
        <h1>{profile.name}</h1>
        {profile.headline ? <p class="lede">{profile.headline}</p> : null}
        <p class="item-meta">
          {view.kind ? (
            <span class="kind">{view.kind}</span>
          ) : (
            <span class="kind muted">kind unstated</span>
          )}
          {profile.handle ? <> · @{profile.handle}</> : null}
          {' · '}
          {profile.claimed_at ? (
            <span title={`claimed by ${profile.claim_method}`}>claimed</span>
          ) : (
            <span class="muted">unclaimed</span>
          )}
          {' · '}
          <a href={md} type="text/markdown">
            openprofile.md
          </a>
          {' · '}
          <a href={`/api/v1/profiles/${profile.id}`}>JSON</a>
        </p>

        <p class="actions row">
          {canEdit ? (
            <a class="cta button" href={`${pathOf(profile)}/edit`}>
              Edit profile
            </a>
          ) : profile.claimed_at ? null : (
            <form method="post" action={`${pathOf(profile)}/claim`} class="inline">
              <button type="submit" class="cta">
                {user ? 'This is me' : 'Sign in to claim'}
              </button>
              <span class="small muted">
                {' '}
                Proven by the email the profile lists, or a link back to this page from your site.
              </span>
            </form>
          )}
        </p>

        {identity.length ? (
          <dl class="kv identity">
            {identity.map((e) => (
              <div key={e.key}>
                <dt>{e.key}</dt>
                <dd>
                  <Value v={e.value} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {doc.prose ? <p>{doc.prose}</p> : null}

        {view.accounts?.length ? (
          <section>
            <h2>Accounts</h2>
            <ul class="plain accounts">
              {view.accounts.map((a) => (
                <li key={a.url}>
                  {a.network ? <span class="tag">{a.network}</span> : null}{' '}
                  {/^https?:/.test(a.url) ? (
                    <a href={a.url} rel="noopener nofollow me">
                      {a.label && a.label.toLowerCase() !== a.network
                        ? a.label
                        : a.url.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    <span>{a.url}</span>
                  )}{' '}
                  <span class="small muted">claimed</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {view.topics?.length ? (
          <section>
            <h2>Topics</h2>
            <p class="tags">
              {view.topics.map((t) => (
                <a key={t} class="tag" href={`/c/profiles?tag=${encodeURIComponent(t)}`}>
                  {t}
                </a>
              ))}
            </p>
          </section>
        ) : null}

        {doc.sections
          .filter((s) => !HIDDEN.has(s.name))
          .map((s) => (
            <section key={`${s.name}-${s.title}`} class={`section-${s.name}`}>
              <h2>{s.title}</h2>
              {s.name === 'broadcast' &&
              (s.body.includes('\n### ') || s.body.startsWith('### ')) ? (
                s.body
                  .split(/^###\s+/m)
                  .filter((p) => p.trim())
                  .map((part) => {
                    const [head, ...body] = part.split('\n');
                    return (
                      <div key={head} class="show">
                        <h3>{head.trim()}</h3>
                        <SectionBody body={body.join('\n')} />
                      </div>
                    );
                  })
              ) : (
                <SectionBody body={s.body} />
              )}
            </section>
          ))}

        <section>
          <h2>Where this came from</h2>
          <ul class="plain">
            {(profile.sources ?? []).map((s) => (
              <li key={s.source_url}>
                <a href={s.page_url ?? s.source_url} rel="noopener nofollow">
                  {s.app}
                </a>{' '}
                <span class="small muted">
                  <a href={s.source_url}>openprofile.md</a> · read <Relative at={s.fetched_at} />
                </span>
              </li>
            ))}
            {profile.claimed_at ? (
              <li>
                <span>the owner</span>{' '}
                <span class="small muted">
                  claimed <Relative at={profile.claimed_at} /> by {profile.claim_method}
                </span>
              </li>
            ) : null}
          </ul>
          <p class="small muted">
            Two documents that share an account URL are one person here; two that share only a name
            are two. What the owner writes wins over every source and survives every re-read.{' '}
            <a href="https://logicsrc.com/openprofile">OpenProfile.md</a> ·{' '}
            <a href="https://logicsrc.com/openbroadcast">OpenBroadcast</a> ·{' '}
            <a href="https://logicsrc.com/openguest">OpenGuest</a>
          </p>
        </section>
        <p class="small muted">
          updated <Relative at={profile.updated_at} /> · id {profile.id}
        </p>
      </article>
    </Layout>
  );
};

const KNOWN_KEYS = [
  'Kind',
  'Handle',
  'Web',
  'Email',
  'Location',
  'Pronouns',
  'Timezone',
  'Languages',
  'Avatar',
  'DID',
  'Pay',
  'Resume',
];
const SECTION_HINTS = {
  broadcast:
    'OpenBroadcast keys: Show, Kind, Format, Live, Cadence, Length, Language, Audience, Since, Feed, Listen, Topics, Seeking, Not, Slots, Remote, Book, Pays, Charges. Two shows: two `### Show name` groups.',
  guest:
    'OpenGuest keys: Available, Expertise, Pitch, Credentials, Formats, Live, Languages, Location, Timezone, Availability, Lead time, Remote, Rate, Pays, Appeared on, Press, Book, Not.',
  accounts:
    'One account per line: `- [Bluesky](https://bsky.app/profile/you)` or the bare URL. The URL is your identity here.',
  topics: 'One per line, or comma-separated. The words you would use to find yourself.',
};

export const ProfileEditPage = ({ user, profile, notice, error }) => {
  const doc = parseOpenProfile(profile.doc);
  const identityKeys = [...new Set([...doc.identity.map((e) => e.key), ...KNOWN_KEYS])];
  const sectionNames = ['accounts', 'topics', 'broadcast', 'guest', 'about', 'links'];
  const sections = [...doc.sections];
  for (const n of sectionNames)
    if (!sections.some((s) => s.name === n))
      sections.push({ title: n[0].toUpperCase() + n.slice(1), name: n, body: '' });
  return (
    <Layout user={user} title={`Edit ${profile.name}`} canonical={`${pathOf(profile)}/edit`}>
      <p class="crumb">
        <a href="/c/profiles">People</a> › <a href={pathOf(profile)}>{profile.name}</a> › edit
      </p>
      <h1>Edit your profile</h1>
      <p class="lede">
        What you write here wins over everything the apps said about you, and a re-read never undoes
        it. Leave a field empty to keep what was generated; write <code>none</code> in a section to
        remove it.
      </p>
      <Notice notice={notice} error={error} />
      <form method="post" action={`${pathOf(profile)}/edit`} class="form stack">
        <div class="row">
          <div class="field">
            <label class="label" for="name">
              Name
            </label>
            <input id="name" name="name" value={profile.name} maxlength="200" />
          </div>
          <div class="field">
            <label class="label" for="handle">
              Handle (your URL: /c/profiles/&lt;handle&gt;)
            </label>
            <input
              id="handle"
              name="handle"
              value={profile.handle ?? ''}
              placeholder="ada-lovelace"
              maxlength="40"
            />
          </div>
        </div>
        <div class="field">
          <label class="label" for="headline">
            Headline (one line)
          </label>
          <input id="headline" name="headline" value={profile.headline ?? ''} maxlength="500" />
        </div>
        <fieldset class="stack">
          <legend>Identity</legend>
          {identityKeys.map((k) => {
            const cur = doc.identity.find((e) => e.key.toLowerCase() === k.toLowerCase());
            return (
              <div class="field" key={k}>
                <label class="label" for={`identity.${k}`}>
                  {k}
                </label>
                <input
                  id={`identity.${k}`}
                  name={`identity.${k}`}
                  value={cur?.value ?? ''}
                  maxlength="500"
                />
              </div>
            );
          })}
          <div class="row">
            <div class="field">
              <label class="label" for="identity_new_key">
                Another key
              </label>
              <input
                id="identity_new_key"
                name="identity_new_key"
                placeholder="Discord"
                maxlength="40"
              />
            </div>
            <div class="field">
              <label class="label" for="identity_new_value">
                Its value
              </label>
              <input id="identity_new_value" name="identity_new_value" maxlength="500" />
            </div>
          </div>
        </fieldset>
        <fieldset class="stack">
          <legend>Sections</legend>
          {sections.map((s) => (
            <div class="field" key={s.name}>
              <label class="label" for={`section.${s.name}`}>
                {s.title}
              </label>
              <textarea
                id={`section.${s.name}`}
                name={`section.${s.name}`}
                rows={Math.min(14, Math.max(4, s.body.split('\n').length + 1))}
              >
                {s.body}
              </textarea>
              {SECTION_HINTS[s.name] ? (
                <p class="help small muted">{SECTION_HINTS[s.name]}</p>
              ) : null}
            </div>
          ))}
          <div class="row">
            <div class="field">
              <label class="label" for="section_new_name">
                Another section
              </label>
              <input
                id="section_new_name"
                name="section_new_name"
                placeholder="Projects"
                maxlength="40"
              />
            </div>
            <div class="field">
              <label class="label" for="section_new_body">
                Its body (Markdown)
              </label>
              <textarea id="section_new_body" name="section_new_body" rows="3" />
            </div>
          </div>
        </fieldset>
        <div class="field">
          <label>
            <input type="checkbox" name="public" checked={profile.public} /> Public: listed, served
            at openprofile.md, and pulled by other directories
          </label>
        </div>
        <p class="actions">
          <button type="submit" class="cta">
            Save
          </button>{' '}
          <a class="ghost button" href={pathOf(profile)}>
            Cancel
          </a>
        </p>
      </form>
      <details>
        <summary>Or replace the whole file</summary>
        <form method="post" action={`${pathOf(profile)}/edit`} class="form stack">
          <p class="small muted">
            Paste a complete OpenProfile.md. Every part of it becomes yours; sections you leave out
            are removed. The same file, sent as <code>PUT /api/v1/profiles/{profile.id}</code> with{' '}
            <code>Content-Type: text/markdown</code>, does the same from a script, the CLI or an
            agent.
          </p>
          <div class="field">
            <label class="label" for="markdown">
              openprofile.md
            </label>
            <textarea id="markdown" name="markdown" rows="24" class="mono">
              {profile.doc}
            </textarea>
          </div>
          <p class="actions">
            <button type="submit" class="cta">
              Replace
            </button>
          </p>
        </form>
      </details>
    </Layout>
  );
};
