/**
 * Where a fetch goes when the direct road is closed.
 *
 * Every adapter fetches from the deployment's own address first. Some
 * publishers refuse that address outright: an edge answers 403 to every path
 * (www.ftc.gov from dev2), a challenge page stands in front of the data
 * (www.ofcom.org.uk), or a rate limit has already been spent (Wikidata's 429).
 * For those answers, and only those, the same request is asked again by
 * another machine, in this order:
 *
 *   c0mpute  A `container.run` job on one of our own c0mpute nodes runs curl
 *            in a small image and hands back the body and status as two
 *            outputs. The request leaves from that node's address. Reached
 *            through the jobs bridge (`c0mpute jobs serve`):
 *              FETCH_ROUTE_C0MPUTE_URL    http://127.0.0.1:8788
 *              FETCH_ROUTE_C0MPUTE_TOKEN  the bridge's bearer token
 *              FETCH_ROUTE_C0MPUTE_PEERS  comma-separated builder peer ids;
 *                                         never any worker, since the builder
 *                                         controls the bytes it returns
 *
 *   desktop  A person's own desktop, enrolled on w3bs.org, answering
 *            `POST /v1/fetch` over a tunnel to the deployment. It is a
 *            residential address and a real browser profile, which is what a
 *            challenge page wants. See docs/fetch-routes.md for the tunnel.
 *              FETCH_ROUTE_DESKTOP_URL    where the tunnel lands on this box
 *              FETCH_ROUTE_DESKTOP_TOKEN  the desktop's bearer token
 *
 * A route that is not configured is skipped. A route that fails is logged and
 * the next is tried; when every route fails, the direct answer is returned as
 * it was, so an adapter sees the same 403 it always did.
 */

/** Answers that mean "not from your address", not "no such thing". */
export const REROUTE_STATUSES = new Set([403, 429, 451]);

/** A 503 is a refusal only when it is an edge's challenge page, not an outage. */
const CHALLENGE = /cf-mitigated|__cf_chl|challenge-platform|captcha|akamai.*reference/i;

export const CURL_IMAGE = 'curlimages/curl:8.11.1';

const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** The routes this deployment has, from its environment, in the order they are tried. */
export function fetchRoutesFromEnv(env = process.env) {
  const routes = [];
  const peers = list(env.FETCH_ROUTE_C0MPUTE_PEERS);
  if (env.FETCH_ROUTE_C0MPUTE_URL && env.FETCH_ROUTE_C0MPUTE_TOKEN && peers.length) {
    routes.push({
      name: 'c0mpute',
      url: env.FETCH_ROUTE_C0MPUTE_URL.replace(/\/$/, ''),
      token: env.FETCH_ROUTE_C0MPUTE_TOKEN,
      peers,
    });
  }
  if (env.FETCH_ROUTE_DESKTOP_URL && env.FETCH_ROUTE_DESKTOP_TOKEN) {
    routes.push({
      name: 'desktop',
      url: env.FETCH_ROUTE_DESKTOP_URL.replace(/\/$/, ''),
      token: env.FETCH_ROUTE_DESKTOP_TOKEN,
    });
  }
  return routes;
}

/** Whether a direct answer is worth asking another machine about. */
export async function shouldReroute(res, { method = 'GET' } = {}) {
  if (method !== 'GET' || !res) return false;
  if (REROUTE_STATUSES.has(res.status)) return true;
  if (res.status !== 503) return false;
  if (res.headers.get('cf-mitigated')) return true;
  const peek = await res
    .clone()
    .text()
    .catch(() => '');
  return CHALLENGE.test(peek.slice(0, 4096));
}

/**
 * The curl job a c0mpute node runs. The URL and user agent travel as
 * environment variables, never spliced into the shell line, so a URL cannot
 * become a command.
 */
export function c0mputeFetchJob(url, { userAgent, timeoutMs = 60_000, headers = {} } = {}) {
  const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
  const env = { FETCH_URL: String(url), FETCH_UA: String(userAgent ?? 'niche-db/0.1') };
  const accept = headers.accept ?? headers.Accept;
  if (accept) env.FETCH_ACCEPT = String(accept);
  return {
    workload: 'container.run',
    spec: {
      image: CURL_IMAGE,
      cmd: [
        'sh',
        '-c',
        // The body file exists even when curl cannot connect, so the job's
        // declared outputs are always there to collect.
        'mkdir -p /tmp/out && : > /tmp/out/body && curl -sS -L --max-time "$FETCH_T" -A "$FETCH_UA" ' +
          '${FETCH_ACCEPT:+-H "accept: $FETCH_ACCEPT"} ' +
          '-o /tmp/out/body -w "%{http_code} %{content_type}" "$FETCH_URL" > /tmp/out/status',
      ],
      env: { ...env, FETCH_T: String(seconds) },
      outputs: ['/tmp/out/body', '/tmp/out/status'],
      network: true,
      timeout_secs: seconds + 60,
    },
  };
}

/** Ask a c0mpute node to fetch `url`; a Response, or a thrown error. */
export async function c0mputeFetch(route, url, opts = {}, { fetchImpl = fetch } = {}) {
  const auth = { authorization: `Bearer ${route.token}` };
  const job = c0mputeFetchJob(url, opts);
  const res = await fetchImpl(`${route.url}/v1/jobs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...job, allow_peers: route.peers }),
    signal: AbortSignal.timeout((job.spec.timeout_secs + 120) * 1000),
  });
  if (!res.ok) throw new Error(`c0mpute bridge answered ${res.status}`);
  const out = await res.json();
  const urlOf = (p) => out.outputs?.find((o) => o.path === p)?.url;
  const bodyUrl = urlOf('/tmp/out/body');
  const statusUrl = urlOf('/tmp/out/status');
  if (!statusUrl) throw new Error(`c0mpute job ${out.job_id ?? '?'} returned no status`);
  const get = async (path) => {
    const r = await fetchImpl(`${route.url}${path}`, { headers: auth });
    if (!r.ok) throw new Error(`c0mpute blob ${path} answered ${r.status}`);
    return r;
  };
  const [code, ...type] = (await (await get(statusUrl)).text()).trim().split(' ');
  const status = Number(code);
  if (!Number.isInteger(status) || status < 100) {
    throw new Error(`c0mpute node could not reach ${new URL(url).host}`);
  }
  const body = bodyUrl ? await (await get(bodyUrl)).arrayBuffer() : new ArrayBuffer(0);
  const headers = { 'x-fetch-route': 'c0mpute' };
  if (type.join(' ')) headers['content-type'] = type.join(' ');
  if (out.worker) headers['x-fetch-worker'] = String(out.worker);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/**
 * Ask a person's desktop to fetch `url`. The desktop answers with the
 * upstream body and puts the upstream status in `x-upstream-status`.
 */
export async function desktopFetch(route, url, opts = {}, { fetchImpl = fetch } = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const res = await fetchImpl(`${route.url}/v1/fetch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${route.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: String(url), headers: opts.headers ?? {}, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs + 15_000),
  });
  const status = Number(res.headers.get('x-upstream-status'));
  if (!res.ok || !Number.isInteger(status)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`desktop route answered ${res.status}`);
  }
  const headers = { 'x-fetch-route': 'desktop' };
  const type = res.headers.get('content-type');
  if (type) headers['content-type'] = type;
  return new Response(status === 204 || status === 304 ? null : res.body, { status, headers });
}

const ROUTE_FETCH = { c0mpute: c0mputeFetch, desktop: desktopFetch };

/**
 * Try each route for a request the direct road refused. The first answer
 * that is not itself a refusal wins; otherwise `direct` comes back unchanged.
 */
export async function reroute(direct, url, opts, { routes, log = () => {}, fetchImpl } = {}) {
  for (const route of routes ?? []) {
    try {
      const res = await ROUTE_FETCH[route.name](route, url, opts, fetchImpl ? { fetchImpl } : {});
      if (!(await shouldReroute(res))) {
        log(`${new URL(url).host} refused us (${direct.status}); fetched via ${route.name}`);
        await direct.body?.cancel().catch(() => {});
        return res;
      }
      log(`${route.name} was refused too (${res.status}) by ${new URL(url).host}`);
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      log(`${route.name} route failed for ${new URL(url).host}: ${err?.message ?? err}`);
    }
  }
  return direct;
}
