import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';
process.env.SITE_URL ??= 'https://nichedb.test';

// The cache table, in memory. The real module is spread in so other test
// files that import it keep working (bun's mock.module leaks across files).
const realStore = await import('../packages/db/src/caller-id.js');
const rows = new Map();
let todayCount = 0;
mock.module('../packages/db/src/caller-id.js', () => ({
  ...realStore,
  cachedCallerId: async (e164) => rows.get(e164) ?? null,
  saveCallerId: async (row) => {
    todayCount++;
    rows.set(row.e164, {
      e164: row.e164,
      caller_name: row.callerName,
      line_type: row.lineType,
      carrier: row.carrier,
      ocn: row.ocn,
      ported: row.ported,
      looked_up_at: new Date(),
    });
  },
  callerIdLookupsToday: async () => todayCount,
}));

const { allowCaller, fromTelnyx, lookupCallerId, resetCallerLimits } = await import(
  '../apps/web/src/lib/caller-id.js'
);

/** Telnyx's answer for the White House switchboard, as it came on 2026-11-25. */
const WHITE_HOUSE = {
  data: {
    caller_name: { caller_name: 'THE WHITE HOUSE', error_code: null },
    carrier: { name: 'VERIZON WASHINGTON DC, INC.', type: 'fixed line' },
    portability: {
      ocn: '9211',
      line_type: 'fixed line',
      ported_status: '',
      spid_carrier_name: 'VERIZON WASHINGTON DC, INC.',
    },
  },
};

describe('caller ID', () => {
  let calls;
  const telnyx = async (url, init) => {
    calls.push({ url, init });
    return Response.json(WHITE_HOUSE);
  };

  beforeEach(() => {
    rows.clear();
    todayCount = 0;
    calls = [];
    resetCallerLimits();
    process.env.TELNYX_API_KEY = 'test-key';
    delete process.env.CALLER_ID_DAILY_CAP;
    delete process.env.CALLER_ID_PER_CALLER;
  });
  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  test('a Telnyx answer becomes the name, line type and current carrier', () => {
    const row = fromTelnyx('+12024561111', WHITE_HOUSE.data);
    expect(row).toMatchObject({
      callerName: 'THE WHITE HOUSE',
      lineType: 'fixed line',
      carrier: 'VERIZON WASHINGTON DC, INC.',
      ocn: '9211',
      ported: null,
    });
    expect(fromTelnyx('+1', { caller_name: { caller_name: 'UNAVAILABLE' } }).callerName).toBeNull();
  });

  test('the first lookup pays once; the second comes from the cache', async () => {
    const a = await lookupCallerId('+12024561111', { identity: '1.2.3.4', fetchImpl: telnyx });
    expect(a.cached).toBe(false);
    expect(a.callerId.name).toBe('THE WHITE HOUSE');
    expect(calls[0].url).toContain(
      '/v2/number_lookup/%2B12024561111?type=caller-name&type=carrier',
    );
    expect(calls[0].init.headers.authorization).toBe('Bearer test-key');
    const b = await lookupCallerId('+12024561111', { identity: '1.2.3.4', fetchImpl: telnyx });
    expect(b.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('only North American numbers, and only with a key', async () => {
    expect((await lookupCallerId('+442079460000', { fetchImpl: telnyx })).status).toBe(400);
    delete process.env.TELNYX_API_KEY;
    expect((await lookupCallerId('+12024561111', { fetchImpl: telnyx })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  test('each caller has a daily allowance', async () => {
    process.env.CALLER_ID_PER_CALLER = '2';
    expect(allowCaller('9.9.9.9')).toBe(true);
    expect(allowCaller('9.9.9.9')).toBe(true);
    expect(allowCaller('9.9.9.9')).toBe(false);
    expect(allowCaller('8.8.8.8')).toBe(true);
    const r = await lookupCallerId('+12025550143', { identity: '9.9.9.9', fetchImpl: telnyx });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  test('the daily cap stops paid lookups for everyone', async () => {
    process.env.CALLER_ID_DAILY_CAP = '1';
    await lookupCallerId('+12024561111', { identity: 'a', fetchImpl: telnyx });
    const r = await lookupCallerId('+12025550143', { identity: 'b', fetchImpl: telnyx });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test('a Telnyx failure is a 502 and caches nothing', async () => {
    const r = await lookupCallerId('+12024561111', {
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    expect(r.status).toBe(502);
    expect(rows.size).toBe(0);
  });
});
