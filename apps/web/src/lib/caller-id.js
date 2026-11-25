import * as store from '@nichedb/db/caller-id';

/**
 * Caller ID for /phone: the name a phone shows when the number calls (CNAM),
 * plus the line type and carrier as the network has them today, ports
 * included. Asked of Telnyx Number Lookup ($0.003 a caller-name query, Nov
 * 2026) on the account smshub.dev already runs on, and cached 30 days so a
 * number is paid for at most once a month.
 *
 * Paid, so never asked by a crawler: a page shows the cached answer, and a
 * fresh lookup needs a person to press the button (a POST) or an API call.
 * Every fresh lookup passes a per-caller limit and a daily cap first.
 *
 *   TELNYX_API_KEY           the key (unset: caller ID is off, the page says so)
 *   CALLER_ID_DAILY_CAP      paid lookups a day across everyone (default 1000)
 *   CALLER_ID_PER_CALLER     paid lookups a day per address (default 20)
 */

export const CACHE_DAYS = 30;
const TELNYX = 'https://api.telnyx.com/v2/number_lookup';

const env = (k, d) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const perCaller = new Map();

/** Count one lookup for a caller; false when they are over today's allowance. */
export function allowCaller(identity, now = Date.now()) {
  if (!identity) return true;
  const day = Math.floor(now / 86_400_000);
  const seen = perCaller.get(identity);
  const n = seen?.day === day ? seen.n : 0;
  if (n >= env('CALLER_ID_PER_CALLER', 20)) return false;
  if (perCaller.size > 50_000) perCaller.clear();
  perCaller.set(identity, { day, n: n + 1 });
  return true;
}

export const resetCallerLimits = () => perCaller.clear();

/** Telnyx's answer as the row we keep. */
export function fromTelnyx(e164, data) {
  const name = String(data?.caller_name?.caller_name ?? '').trim();
  const port = data?.portability ?? {};
  const lineType = String(port.line_type || data?.carrier?.type || '').trim() || null;
  const carrier = String(port.spid_carrier_name || data?.carrier?.name || '').trim() || null;
  return {
    e164,
    callerName: name && !/^(unavailable|unknown)$/i.test(name) ? name : null,
    lineType,
    carrier,
    ocn: String(port.ocn ?? '').trim() || null,
    ported: port.ported_status ? port.ported_status === 'Y' : null,
    raw: { caller_name: data?.caller_name ?? null, carrier: data?.carrier ?? null },
  };
}

/** The cached answer shaped for a page, or null. */
export function callerIdOut(row) {
  if (!row) return null;
  return {
    name: row.caller_name ?? null,
    lineType: row.line_type ?? null,
    carrier: row.carrier ?? null,
    ocn: row.ocn ?? null,
    ported: row.ported ?? null,
    lookedUpAt: row.looked_up_at ? new Date(row.looked_up_at).toISOString() : null,
    source: 'CNAM via Telnyx Number Lookup',
  };
}

const fresh = (row) =>
  row?.looked_up_at && Date.now() - new Date(row.looked_up_at).getTime() < CACHE_DAYS * 86_400_000;

/** The cached caller ID only: never a paid call. For page renders. */
export async function cachedCallerId(e164) {
  return callerIdOut(await store.cachedCallerId(e164).catch(() => null));
}

/**
 * Caller ID for a number, asking Telnyx when the cache has none or it is
 * stale. Answers { callerId } or { error, status }. North American numbers
 * only: CNAM is a NANP service.
 */
export async function lookupCallerId(e164, { identity = null, fetchImpl = fetch } = {}) {
  if (!/^\+1\d{10}$/.test(e164)) {
    return { error: 'Caller ID names exist for US and Canadian numbers only.', status: 400 };
  }
  const cached = await store.cachedCallerId(e164).catch(() => null);
  if (fresh(cached)) return { callerId: callerIdOut(cached), cached: true };

  const key = process.env.TELNYX_API_KEY;
  if (!key) return { error: 'Caller ID lookups are not configured here.', status: 503 };
  if (!allowCaller(identity)) {
    return { error: 'You have used today’s caller ID lookups. Try again tomorrow.', status: 429 };
  }
  if ((await store.callerIdLookupsToday().catch(() => 0)) >= env('CALLER_ID_DAILY_CAP', 1000)) {
    return { error: 'Today’s caller ID lookups are used up. Try again tomorrow.', status: 429 };
  }

  const res = await fetchImpl(
    `${TELNYX}/${encodeURIComponent(e164)}?type=caller-name&type=carrier`,
    {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);
  if (!res?.ok) {
    return { error: 'The caller ID service did not answer. Try again shortly.', status: 502 };
  }
  const body = await res.json().catch(() => null);
  const row = fromTelnyx(e164, body?.data);
  await store.saveCallerId(row).catch(() => {});
  return {
    callerId: callerIdOut({
      caller_name: row.callerName,
      line_type: row.lineType,
      carrier: row.carrier,
      ocn: row.ocn,
      ported: row.ported,
      looked_up_at: new Date(),
    }),
    cached: false,
  };
}
