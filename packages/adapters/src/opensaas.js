import { defineAdapter, looseDate } from '@nichedb/core/adapter';

/**
 * OpenSaaS descriptors: the way in and the way out of a subscription
 * service's plans, served from its own origin at `/.well-known/opensaas.json`
 * (logicsrc.com/opensaas).
 *
 * This is the first reader of the spec. The service is the author: its plans
 * at its prices, and for each action (subscribe, cancel, pause, resume,
 * change_plan, unsubscribe, export, delete) the page a person opens and the
 * endpoint an agent calls, with the service's own count of `steps` and what
 * it demands as `confirm`. The adapter takes the file as written and puts
 * the way out beside the way in on every plan's row, which is the one number
 * a directory owes a reader: cancel.steps against subscribe.steps.
 *
 * ORIGIN IS THE PROOF
 *
 * A descriptor is believed only when it was fetched from the origin it
 * claims: the URL it was read from must share a host with `service.web`. A
 * descriptor that names no `web` is believed only at the well-known path on
 * the origin the source was pointed at. Anywhere else it is a claim about the
 * service by whoever hosts it, and is dropped with a note in the log.
 *
 * ABSENT IS UNSTATED
 *
 * Only `service.name` and one action are required. A plan with no `renews`
 * is unstated, never auto-renew; a service with no `cancel` action has said
 * nothing about cancelling, and the row says exactly that. Nothing is
 * derived: `steps` is the service's number, `confirm` the service's word.
 *
 * IDS
 *
 * A plan is `opensaas:<host>:<plan.id>`; a service with no plans is
 * `opensaas:service:<host>`. A re-read on the day updates in place; a plan
 * that leaves the file is marked gone by the ingest, not deleted.
 */
export const WELL_KNOWN = '/.well-known/opensaas.json';

export const ACTIONS = [
  'subscribe',
  'cancel',
  'pause',
  'resume',
  'change_plan',
  'unsubscribe',
  'export',
  'delete',
];

/** A confirm a person gives up on and an agent cannot give at all. */
export const FLAGGED_CONFIRMS = ['chat', 'call', 'mail'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const str = (v) => (v == null || v === '' ? null : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** A bare origin becomes the well-known path; anything with a path is read as given. */
export function descriptorUrl(entry) {
  const raw = String(entry).trim();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.pathname === '/' || u.pathname === '') return `${u.origin}${WELL_KNOWN}`;
    return u.href;
  } catch {
    return null;
  }
}

/** True when the descriptor was served from the origin it describes. */
export function servedByService(fetchedFrom, descriptor) {
  const a = hostOf(fetchedFrom);
  if (!a) return false;
  const web = descriptor?.service?.web;
  if (!web) {
    try {
      return new URL(fetchedFrom).pathname === WELL_KNOWN;
    } catch {
      return false;
    }
  }
  const b = hostOf(web);
  return Boolean(b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}

/** The actions the service named, each as written; unknown names kept. */
export function actionsOf(descriptor) {
  const raw = descriptor?.actions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [name, act] of Object.entries(raw)) {
    if (!act || typeof act !== 'object') continue;
    if (!str(act.page) && !act.api?.url) continue;
    out[name] = act;
  }
  return out;
}

/**
 * The way out beside the way in, as the service stated it. Every field is
 * null when unstated; `cancelStated` is false when the file has no cancel
 * action at all, which is a fact worth more than any number.
 */
export function exitOf(actions) {
  const s = actions.subscribe ?? null;
  const c = actions.cancel ?? null;
  return {
    subscribeSteps: s ? num(s.steps) : null,
    subscribeApi: Boolean(s?.api?.url),
    cancelStated: Boolean(c),
    cancelSteps: c ? num(c.steps) : null,
    cancelConfirm: c ? str(c.confirm) : null,
    cancelFlagged: Boolean(
      c?.confirm && FLAGGED_CONFIRMS.includes(String(c.confirm).toLowerCase()),
    ),
    cancelApi: Boolean(c?.api?.url),
    cancelPage: Boolean(str(c?.page)),
    cancelEffective: c ? str(c.effective) : null,
    refund: c ? str(c.refund) : null,
    exportApi: Boolean(actions.export?.api?.url),
    deleteApi: Boolean(actions.delete?.api?.url),
  };
}

function when(s) {
  if (!s) return { publishedAt: null, timeKnown: false, precision: 'day' };
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return { publishedAt: d, timeKnown: true, precision: 'minute' };
  return looseDate(String(s).slice(0, 10));
}

function tagsFor(service, plan, exit, host) {
  return [
    'opensaas',
    `service:${host}`,
    plan?.status ? `status:${String(plan.status).toLowerCase()}` : null,
    plan?.renews === true ? 'renews' : plan?.renews === false ? 'prepaid' : null,
    plan && num(plan.price) === 0 ? 'free' : null,
    exit.cancelStated ? 'cancel:stated' : 'cancel:unstated',
    exit.cancelApi ? 'cancel:agent' : null,
    exit.cancelFlagged ? `confirm:${exit.cancelConfirm}` : null,
    service.currency ? `currency:${String(service.currency).toLowerCase()}` : null,
  ].filter(Boolean);
}

function priceLine(plan, currency) {
  const p = num(plan.price);
  if (p === null) return null;
  const cur = str(plan.currency) ?? str(currency) ?? '';
  return `${p === 0 ? 'free' : `${p} ${cur}`.trim()}${plan.period ? ` per ${plan.period}` : ''}`;
}

export function planItem(descriptor, plan, fetchedFrom, verified) {
  const service = descriptor.service;
  const host = hostOf(fetchedFrom);
  const id = str(plan?.id) ?? str(plan?.name);
  if (!str(service?.name) || !id) return null;
  const actions = actionsOf(descriptor);
  const exit = exitOf(actions);
  const includes = Array.isArray(plan.includes)
    ? plan.includes.filter((x) => typeof x === 'string')
    : [];
  const price = priceLine(plan, service.currency);
  const summaryParts = [price, includes.length ? includes.join(', ') : null].filter(Boolean);
  return {
    externalId: `opensaas:${host}:${id}`,
    kind: 'plan',
    title: `${str(service.name)} ${str(plan.name) ?? id}`.trim(),
    summary: summaryParts.length ? summaryParts.join('. ') : null,
    url: str(plan.url) ?? str(service.web) ?? fetchedFrom,
    ...when(descriptor.updated),
    tags: tagsFor(service, plan, exit, host),
    data: {
      opensaas: descriptor.opensaas ?? null,
      descriptor: fetchedFrom,
      verified,
      service,
      plan,
      actions,
      policies: descriptor.policies ?? null,
      exit,
    },
  };
}

export function serviceItem(descriptor, fetchedFrom, verified) {
  const service = descriptor?.service;
  const host = hostOf(fetchedFrom);
  if (!str(service?.name)) return null;
  const actions = actionsOf(descriptor);
  const exit = exitOf(actions);
  return {
    externalId: `opensaas:service:${host}`,
    kind: 'service',
    title: str(service.name),
    summary: `${str(service.name)}, as it describes itself in its OpenSaaS descriptor: ${Object.keys(actions).length} actions, no plans listed.`,
    url: str(service.web) ?? fetchedFrom,
    ...when(descriptor.updated),
    tags: tagsFor(service, null, exit, host),
    data: {
      opensaas: descriptor.opensaas ?? null,
      descriptor: fetchedFrom,
      verified,
      service,
      actions,
      policies: descriptor.policies ?? null,
      exit,
    },
  };
}

/**
 * A descriptor into items. `verified` is whether it was served from the
 * origin it names; a descriptor from anywhere else is rejected outright,
 * because a cancel endpoint is exactly the thing nobody else may state.
 */
export function parseDescriptor(descriptor, fetchedFrom) {
  if (!str(descriptor?.service?.name)) return { items: [], rejected: 'service' };
  const actions = actionsOf(descriptor);
  if (Object.keys(actions).length === 0) return { items: [], rejected: 'actions' };
  const verified = servedByService(fetchedFrom, descriptor);
  if (!verified) return { items: [], rejected: 'origin' };
  const plans = Array.isArray(descriptor.plans) ? descriptor.plans : [];
  const items = plans.map((p) => planItem(descriptor, p, fetchedFrom, verified)).filter(Boolean);
  if (items.length === 0) {
    const s = serviceItem(descriptor, fetchedFrom, verified);
    if (s) items.push(s);
  }
  return { items, rejected: null };
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export const opensaas = defineAdapter({
  name: 'opensaas',
  title: 'OpenSaaS descriptors',
  collection: 'saas',
  description:
    'The way in and the way out of a subscription service, read from the OpenSaaS descriptor it serves at /.well-known/opensaas.json: one row per plan at the service’s own price, with the service’s own count of steps and its confirm for subscribe and cancel shown beside each other, and whether an agent holding an OpenAccess grant can take each door. A descriptor counts only when served from the origin it describes. Keyless.',
  docs: 'https://logicsrc.com/docs/opensaas',
  kinds: ['plan', 'service'],
  cadenceMinutes: 1440,
  configFields: [
    {
      key: 'urls',
      label: 'Descriptors',
      type: 'list',
      help: 'Service origins (read at /.well-known/opensaas.json) or full descriptor URLs.',
      placeholder: 'https://nichedb.dev',
    },
    {
      key: 'probe',
      label: 'Probe',
      type: 'list',
      help: 'Origins to try at the well-known path; a miss is remembered for a week.',
      placeholder: 'https://example.com',
    },
  ],
  defaults: { urls: [], probe: [] },
  defaultSources: [
    {
      slug: 'opensaas',
      name: 'OpenSaaS: what services say about their own way in and way out',
      description:
        'Plans and exit terms read from the OpenSaaS descriptor each service serves at /.well-known/opensaas.json, in the service’s words: the steps to subscribe beside the steps to cancel, what the service demands to confirm, and whether an agent can do either. nichedb.dev serves the first.',
      config: { urls: ['https://nichedb.dev'], probe: [] },
      enabled: true,
    },
  ],
  async pull({ config, cursor, http, log, deadline }) {
    const list = (v) =>
      (Array.isArray(v) ? v : String(v ?? '').split(',')).map(descriptorUrl).filter(Boolean);
    const entries = list(config.urls).slice(0, 500);
    const misses = { ...(cursor?.misses ?? {}) };
    const now = Date.now();
    for (const [u, at] of Object.entries(misses)) if (now - at > WEEK) delete misses[u];
    const probes = list(config.probe)
      .filter((u) => !entries.includes(u) && !misses[u])
      .slice(0, 200);
    if (entries.length === 0 && probes.length === 0) {
      log('no descriptors configured');
      return { items: [], note: 'no descriptors configured', cursor: { misses } };
    }
    const items = [];
    const failed = [];
    let services = 0;
    let probed = 0;
    for (const [url, isProbe] of [
      ...entries.map((u) => [u, false]),
      ...probes.map((u) => [u, true]),
    ]) {
      if (Date.now() > deadline) break;
      try {
        const doc = await http.json(url, { timeoutMs: isProbe ? 5_000 : 20_000 });
        const { items: got, rejected } = parseDescriptor(doc, url);
        if (rejected) {
          if (isProbe) misses[url] = now;
          else
            failed.push(
              `${hostOf(url)} (${rejected === 'origin' ? 'not served by the service it names' : `no ${rejected}`})`,
            );
          continue;
        }
        services += 1;
        if (isProbe) probed += 1;
        items.push(...got);
      } catch (err) {
        if (isProbe) misses[url] = now;
        else failed.push(`${hostOf(url) ?? url} (${err.message.slice(0, 40)})`);
      }
    }
    const note = `${services} services, ${items.length} rows${probed ? `, ${probed} found by probe` : ''}${failed.length ? `; ${failed.length} descriptors rejected` : ''}`;
    log(`${note}${failed.length ? `: ${failed.join(', ')}` : ''}`);
    return { items, note, cursor: { misses } };
  },
});
