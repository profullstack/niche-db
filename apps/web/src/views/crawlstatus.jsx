import { config } from '@nichedb/config';
import { crawlHealth, fillHours, STALL_MINUTES } from '../lib/crawlstatus.js';
import { Num, Relative } from './components.jsx';
import { Layout } from './Layout.jsx';

/**
 * /crawlstatus: what the crawler behind the database is doing.
 *
 * The site can render perfectly while the worker that feeds it has been dead
 * for a week; every page still lists its items, they just stop being new. This
 * page is where that shows. Not the same thing as /crawl, which sells AI
 * crawlers a pass to read us.
 */

const HEALTH_CLASS = { ok: 'ok', degraded: 'idle', stalled: 'err', idle: 'off' };
const RUN_CLASS = { ok: 'ok', error: 'err', running: 'idle' };

const Tile = ({ label, n, cls }) => (
  <li class={`crawl-tile ${cls ?? ''}`}>
    <span class="crawl-n">
      <Num n={n} />
    </span>
    <span class="muted small">{label}</span>
  </li>
);

const SourceCell = ({ s }) => (
  <td>
    <a href={`/s/${s.slug}`}>{s.name}</a>
    <br />
    <span class="muted small">
      {s.collection_name ?? s.adapter}
      {s.collection_name ? <span class="mono"> · {s.adapter}</span> : null}
    </span>
  </td>
);

/** Twenty-four bars, one an hour, scaled to the busiest. */
const Hourly = ({ hourly }) => {
  const max = Math.max(1, ...hourly.map((h) => h.ok + h.errors + h.running));
  const pct = (n) => `${((n / max) * 100).toFixed(1)}%`;
  return (
    <div class="crawl-bars" role="img" aria-label="Runs started per hour, last 24 hours">
      {hourly.map((h) => (
        <span
          key={String(h.hour)}
          class="crawl-bar"
          title={`${new Date(h.hour).toISOString().slice(11, 16)} UTC: ${h.ok} ok, ${h.errors} failed`}
        >
          <i class="err" style={`height:${pct(h.errors)}`} />
          <i class="ok" style={`height:${pct(h.ok + h.running)}`} />
        </span>
      ))}
    </div>
  );
};

export const CrawlStatusPage = ({ user, status, now = Date.now() }) => {
  const { sources, day, hourly, failing, overdue, recent } = status;
  const health = crawlHealth(status, now);
  return (
    <Layout
      user={user}
      title="Crawl status"
      description={`Live status of the ${config.siteName} crawler: which sources are fetching, failing or behind, and what the last day of runs added.`}
      wide
    >
      <div class="page-head">
        <div>
          <h1>Crawl status</h1>
          <p class="lede">
            Every source is one upstream fetched on its own schedule by the worker. This is what
            that worker has been doing, live. The same numbers are{' '}
            <a href="/api/v1/crawlstatus">JSON</a>; every source is listed on{' '}
            <a href="/sources">/sources</a>.
          </p>
        </div>
        <p class="crawl-health">
          <span class={`status ${HEALTH_CLASS[health.state]}`}>
            <i /> {health.label}
          </span>
          <br />
          <span class="muted small">
            last run started <Relative at={recent[0]?.started_at} />
          </span>
        </p>
      </div>

      <h2>Sources</h2>
      <ul class="crawl-tiles">
        <Tile label="enabled" n={sources.enabled} />
        <Tile label="healthy" n={sources.ok} cls="ok" />
        <Tile label="failing" n={sources.failing} cls={sources.failing ? 'err' : ''} />
        <Tile label="waiting for a first run" n={sources.waiting} />
        <Tile label="overdue" n={sources.overdue} cls={sources.overdue ? 'warn' : ''} />
        <Tile label="paused" n={sources.paused} />
        <Tile label="items held" n={sources.items} />
      </ul>

      <h2>Last 24 hours</h2>
      <ul class="crawl-tiles">
        <Tile label="runs" n={day.runs} />
        <Tile label="succeeded" n={day.ok} cls="ok" />
        <Tile label="failed" n={day.errors} cls={day.errors ? 'err' : ''} />
        <Tile label="running now" n={day.running} />
        <Tile label="sources run" n={day.sources} />
        <Tile label="items added" n={day.added} />
        <Tile label="items updated" n={day.updated} />
      </ul>
      <Hourly hourly={fillHours(hourly, now)} />
      <p class="muted small">
        Runs started per hour, UTC, green for success and red for failure. No run started in{' '}
        {STALL_MINUTES / 60} hours reads as stalled.
      </p>

      <h2>Failing</h2>
      {failing.length ? (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Last ok</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {failing.map((s) => (
                <tr key={s.slug}>
                  <SourceCell s={s} />
                  <td class="small">
                    <Relative at={s.last_ok_at} />
                  </td>
                  <td class="small err-text">{String(s.last_error).slice(0, 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No enabled source is failing.</p>
      )}
      {sources.failing > failing.length ? (
        <p class="muted small">
          The {failing.length} longest without a success, of {sources.failing}.
        </p>
      ) : null}

      <h2>Overdue</h2>
      {overdue.length ? (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Due</th>
                <th>Every</th>
                <th>Last ok</th>
              </tr>
            </thead>
            <tbody>
              {overdue.map((s) => (
                <tr key={s.slug}>
                  <SourceCell s={s} />
                  <td class="small">
                    <Relative at={s.next_run_at} />
                  </td>
                  <td class="small">{s.cadence_minutes}m</td>
                  <td class="small">
                    <Relative at={s.last_ok_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">The queue is keeping up: nothing is waiting past its turn.</p>
      )}

      <h2>Recent runs</h2>
      {recent.length ? (
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Source</th>
                <th>Started</th>
                <th>Seen</th>
                <th>Added</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.slug}-${i}`}>
                  <td>
                    <span
                      class={`status ${RUN_CLASS[r.status] ?? 'off'}`}
                      title={r.error ?? r.status}
                    >
                      <i /> {r.status}
                    </span>
                  </td>
                  <td>
                    <a href={`/s/${r.slug}`}>{r.name}</a>
                    <br />
                    <span class="muted small mono">{r.adapter}</span>
                  </td>
                  <td class="small">
                    <Relative at={r.started_at} />
                  </td>
                  <td>
                    <Num n={r.seen} />
                  </td>
                  <td>
                    <Num n={r.added} />
                  </td>
                  <td>
                    <Num n={r.updated} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No run has been recorded yet.</p>
      )}
    </Layout>
  );
};
