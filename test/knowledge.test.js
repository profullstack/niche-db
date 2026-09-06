import { describe, expect, test } from 'bun:test';
import {
  allocate,
  asJson,
  asJsonArray,
  attributableNetMinor,
  CONTRIBUTION_TIERS,
  dedupeKeyFor,
  diminishFactor,
  domainEvent,
  formatBps,
  formatMinor,
  isReservedNicheSlug,
  MAX_SHARE_BPS,
  machineRevenueEvent,
  nextTierFor,
  scoreContribution,
  shareBpsFor,
  splitShareBps,
  tierFor,
} from '../packages/knowledge/src/index.js';

describe('tiers', () => {
  test('the ladder starts at 20% and ends at 80%', () => {
    expect(CONTRIBUTION_TIERS[0].shareBps).toBe(2000);
    expect(CONTRIBUTION_TIERS.at(-1).shareBps).toBe(MAX_SHARE_BPS);
    expect(MAX_SHARE_BPS).toBe(8000);
  });

  test('every threshold in the PRD maps to its share', () => {
    for (const [score, bps] of [
      [0, 2000],
      [99, 2000],
      [100, 3000],
      [249, 3000],
      [250, 4000],
      [499, 4000],
      [500, 5000],
      [899, 5000],
      [900, 6000],
      [1499, 6000],
      [1500, 7000],
      [2499, 7000],
      [2500, 8000],
      [999_999, 8000],
    ]) {
      expect(tierFor(score).shareBps).toBe(bps);
    }
  });

  test('a score below the first threshold still has a tier, and rubbish scores as zero', () => {
    expect(tierFor(-50).slug).toBe('contributor');
    expect(tierFor(null).slug).toBe('contributor');
    expect(tierFor('nonsense').slug).toBe('contributor');
  });

  test('an unsorted tier table gives the same answer', () => {
    const shuffled = [...CONTRIBUTION_TIERS].reverse();
    expect(tierFor(600, shuffled).slug).toBe('lead-expert');
  });

  test('the next tier says how far away it is, and there is none at the top', () => {
    expect(nextTierFor(90)).toMatchObject({ slug: 'specialist', remaining: 10 });
    expect(nextTierFor(2500)).toBeNull();
  });

  test('a member cap holds a share below what the tier would give', () => {
    expect(shareBpsFor(2500)).toBe(8000);
    expect(shareBpsFor(2500, { capBps: 5000 })).toBe(5000);
    // Nothing may ask for more than the program maximum, cap or no cap.
    expect(shareBpsFor(2500, { capBps: 9999 })).toBe(8000);
  });

  test('formatBps reads as a percentage', () => {
    expect(formatBps(2000)).toBe('20%');
    expect(formatBps(8000)).toBe('80%');
    expect(formatBps(2550)).toBe('25.5%');
  });
});

describe('splitting a niche between several influencers', () => {
  test('under the ceiling everyone gets their own tier', () => {
    const split = splitShareBps([{ score: 0 }, { score: 250 }]);
    expect(split.map((m) => m.shareBps)).toEqual([2000, 4000]);
  });

  test('over the ceiling the shares scale and still sum to exactly 80%', () => {
    const split = splitShareBps([{ score: 2500 }, { score: 2500 }, { score: 900 }]);
    expect(split.reduce((n, m) => n + m.shareBps, 0)).toBe(MAX_SHARE_BPS);
    // The two at the top hold more than the one below them.
    expect(split[0].shareBps).toBeGreaterThan(split[2].shareBps);
  });

  test('three equal claimants divide 8000 with no basis point lost', () => {
    const split = splitShareBps([{ score: 2500 }, { score: 2500 }, { score: 2500 }]);
    expect(split.reduce((n, m) => n + m.shareBps, 0)).toBe(8000);
    expect(split.map((m) => m.shareBps).sort()).toEqual([2666, 2667, 2667]);
  });

  test('a niche with nobody in it allocates nothing', () => {
    expect(splitShareBps([])).toEqual([]);
  });
});

describe('scoring', () => {
  const base = { nicheId: 1, influencerId: 'u1' };

  test('an unknown event type is refused rather than scored', () => {
    const out = scoreContribution({ ...base, type: 'free_points' });
    expect(out).toMatchObject({ points: 0, status: 'rejected' });
  });

  test('an event with no evidence is held, not scored', () => {
    expect(scoreContribution({ ...base, type: 'knowledge_created', evidence: {} })).toMatchObject({
      points: 0,
      status: 'pending',
    });
    // Present but empty is not evidence either.
    expect(
      scoreContribution({ ...base, type: 'knowledge_created', evidence: { text: '   ' } }),
    ).toMatchObject({ points: 0, status: 'pending' });
  });

  test('a claim on money needs an outside reference, however trusted the claimant', () => {
    const noRef = scoreContribution(
      { ...base, type: 'customer_converted', evidence: { text: 'trust me' } },
      { verifiedCount: 10_000 },
    );
    expect(noRef).toMatchObject({ points: 0, status: 'pending' });

    const withRef = scoreContribution(
      { ...base, type: 'customer_converted', evidence: { paymentRef: 'cp_123' } },
      { verifiedCount: 10_000 },
    );
    expect(withRef.points).toBe(20);
    // Still a human's decision: money never self-verifies.
    expect(withRef.status).toBe('pending');
  });

  test('trust escalation: a new account waits, an established one does not', () => {
    const event = { ...base, type: 'agent_answer', evidence: { questionId: 'q1' } };
    expect(scoreContribution(event, { verifiedCount: 0 }).status).toBe('pending');
    expect(scoreContribution(event, { verifiedCount: 30 }).status).toBe('verified');
  });

  test('text the submitter generated is held even when they are trusted', () => {
    const out = scoreContribution(
      { ...base, type: 'agent_answer', evidence: { questionId: 'q', provenance: 'generated' } },
      { verifiedCount: 500 },
    );
    expect(out.status).toBe('pending');
    expect(out.reason).toMatch(/generated/);
  });

  test('a ranged type is clamped to its ceiling, not to what the caller asked for', () => {
    const out = scoreContribution({
      ...base,
      type: 'revenue_influenced',
      points: 100_000,
      evidence: { paymentRef: 'r1' },
    });
    expect(out.points).toBe(100);
  });

  test('repeating the same kind of thing pays less, then nothing', () => {
    const event = { ...base, type: 'knowledge_created', evidence: { text: 'a real note' } };
    expect(scoreContribution(event, { recentOfType: 0 }).points).toBe(2);
    expect(scoreContribution(event, { recentOfType: 20 }).points).toBe(1);
    expect(scoreContribution(event, { recentOfType: 45 }).points).toBe(1);
    const spammed = scoreContribution(event, { recentOfType: 400 });
    expect(spammed.points).toBe(0);
    expect(spammed.reason).toMatch(/too many/);
  });

  test('a high-value type does not diminish: it is checked by a human every time', () => {
    expect(diminishFactor('customer_converted', 10_000)).toBe(1);
  });

  test('volume cannot buy the top tier', () => {
    // Ten thousand submissions of the cheapest verified thing there is.
    const event = { ...base, type: 'knowledge_created', evidence: { text: 'x' } };
    let score = 0;
    for (let i = 0; i < 10_000; i++) score += scoreContribution(event, { recentOfType: i }).points;
    // The diminishing return stops it long before 2500, which is the point.
    expect(score).toBeLessThan(200);
    expect(tierFor(score).slug).toBe('specialist');
  });
});

describe('deduplication', () => {
  const base = { nicheId: 1, influencerId: 'u1', type: 'source_added' };

  test('the same submission twice has the same key', () => {
    const a = dedupeKeyFor({ ...base, evidence: { url: 'https://example.com/a' } });
    const b = dedupeKeyFor({ ...base, evidence: { url: 'https://example.com/a' } });
    expect(a).toBe(b);
    expect(a).toBeTruthy();
  });

  test('whitespace and case do not make a resubmission new', () => {
    const a = dedupeKeyFor({ ...base, evidence: { text: 'Waste factor is 10%' } });
    const b = dedupeKeyFor({ ...base, evidence: { text: '  waste   factor is 10%  ' } });
    expect(a).toBe(b);
  });

  test('a different person, niche or type is a different key', () => {
    const e = { evidence: { url: 'https://example.com/a' } };
    const mine = dedupeKeyFor({ ...base, ...e });
    expect(dedupeKeyFor({ ...base, ...e, influencerId: 'u2' })).not.toBe(mine);
    expect(dedupeKeyFor({ ...base, ...e, nicheId: 2 })).not.toBe(mine);
    expect(dedupeKeyFor({ ...base, ...e, type: 'knowledge_created' })).not.toBe(mine);
  });

  test('an event with no substance has no key, so it cannot collide with another', () => {
    expect(dedupeKeyFor({ ...base, evidence: {} })).toBeNull();
    expect(dedupeKeyFor({ ...base, evidence: { text: '   ' } })).toBeNull();
  });
});

describe('revenue arithmetic', () => {
  test('net takes off what it cost to take the money, and nothing else', () => {
    expect(attributableNetMinor({ grossMinor: 1000, processingMinor: 30, infraMinor: 20 })).toBe(
      950,
    );
    // Costs exceeding gross floor at zero rather than going negative.
    expect(attributableNetMinor({ grossMinor: 100, refundMinor: 500 })).toBe(0);
  });

  test('an allocation is whole cents and adds up to the net exactly', () => {
    const out = allocate({ netMinor: 1001, members: [{ influencerId: 'u1', score: 250 }] });
    const influencer = out.find((a) => a.allocationType === 'knowledge_influencer');
    const platform = out.find((a) => a.allocationType === 'platform');
    expect(influencer.shareBps).toBe(4000);
    expect(influencer.amountMinor).toBe(400);
    expect(platform.amountMinor).toBe(601);
    expect(out.reduce((n, a) => n + a.amountMinor, 0)).toBe(1001);
    for (const a of out) expect(Number.isInteger(a.amountMinor)).toBe(true);
  });

  test('a niche at the top of the ladder still leaves the platform 20%', () => {
    const out = allocate({ netMinor: 10_000, members: [{ influencerId: 'u1', score: 5000 }] });
    expect(out[0].amountMinor).toBe(8000);
    expect(out.at(-1).amountMinor).toBe(2000);
  });

  test('a sale nobody operates goes entirely to the platform', () => {
    const out = allocate({ netMinor: 500, members: [] });
    expect(out).toHaveLength(1);
    expect(out[0].allocationType).toBe('platform');
    expect(out[0].amountMinor).toBe(500);
  });

  test('rounding never over-pays: the parts never exceed the whole', () => {
    for (const net of [1, 3, 7, 99, 101, 333, 9999]) {
      const out = allocate({
        netMinor: net,
        members: [
          { influencerId: 'a', score: 2500 },
          { influencerId: 'b', score: 2500 },
          { influencerId: 'c', score: 900 },
        ],
      });
      expect(out.reduce((n, a) => n + a.amountMinor, 0)).toBe(net);
      for (const a of out) expect(a.amountMinor).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the x402 contract', () => {
  // The shape this deployment's gateway already hands onSale.
  const sale = {
    payer: '0xabc',
    ref: 'pay_123',
    days: 1,
    priceCents: 100,
    totalCents: 100,
    currency: 'USD',
    userAgent: 'ClaudeBot',
  };

  test('a sale normalises into a ledger event keyed by its payment reference', () => {
    const event = machineRevenueEvent(sale, { property: 'nichedb', nicheId: 7 });
    expect(event.eventId).toBe('x402:pay_123');
    expect(event.amountMinor).toBe(100);
    expect(event.sourceType).toBe('x402');
    expect(event.nicheId).toBe(7);
    expect(Number.isInteger(event.amountMinor)).toBe(true);
  });

  test('the same sale delivered twice is the same event id, so it books once', () => {
    expect(machineRevenueEvent(sale).eventId).toBe(machineRevenueEvent({ ...sale }).eventId);
  });

  test('a sale with no reference is not a ledger event', () => {
    expect(machineRevenueEvent({ ...sale, ref: null })).toBeNull();
  });
});

describe('domain events', () => {
  test('every event carries an id, so a redelivery can be recognised', () => {
    const a = domainEvent({ type: 'agent.question_created', producer: 'chovy' });
    const b = domainEvent({ type: 'agent.question_created', producer: 'chovy' });
    expect(a.id).not.toBe(b.id);
    expect(a.version).toBe(1);
  });

  test('an event with no type or producer is refused', () => {
    expect(() => domainEvent({ producer: 'chovy' })).toThrow();
    expect(() => domainEvent({ type: 'x' })).toThrow();
  });
});

describe('reserved slugs', () => {
  test('a niche may not take a route the site already serves', () => {
    for (const slug of ['settings', 'login', 'api', 'opportunities', 'sell', 'llms.txt'])
      expect(isReservedNicheSlug(slug)).toBe(true);
    expect(isReservedNicheSlug('SETTINGS')).toBe(true);
    expect(isReservedNicheSlug('commercial-roofing')).toBe(false);
  });
});

describe('reading a jsonb column', () => {
  test('an object comes back as itself', () => {
    expect(asJson({ software_gap: 80 })).toEqual({ software_gap: 80 });
    expect(asJsonArray([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });

  test('a column that stored a string is parsed rather than iterated', () => {
    // This is the shape that shipped: Object.keys('{}') is ['0','1'], which is
    // how two dimensions called 0 and 1 appeared on every opportunity page.
    expect(Object.keys('{}')).toEqual(['0', '1']);
    expect(asJson('{}')).toEqual({});
    expect(Object.keys(asJson('{}'))).toEqual([]);
    expect(asJson('{"software_gap":80}')).toEqual({ software_gap: 80 });
    expect(asJsonArray('[{"id":"ea"}]')).toEqual([{ id: 'ea' }]);
  });

  test('null, nonsense and scalars fall back rather than throwing', () => {
    expect(asJson(null)).toEqual({});
    expect(asJson(undefined)).toEqual({});
    expect(asJson('not json at all')).toEqual({});
    expect(asJson('"just a string"')).toEqual({});
    expect(asJson('42')).toEqual({});
    expect(asJson(42)).toEqual({});
    expect(asJson(null, { a: 1 })).toEqual({ a: 1 });
  });

  test('asJsonArray refuses an object, so a map() cannot be reached with one', () => {
    expect(asJsonArray('{"a":1}')).toEqual([]);
    expect(asJsonArray({ a: 1 })).toEqual([]);
    expect(asJsonArray(null)).toEqual([]);
  });
});

describe('rendering money', () => {
  test('minor units become a currency string only at the last moment', () => {
    expect(formatMinor(0)).toBe('$0.00');
    expect(formatMinor(1)).toBe('$0.01');
    expect(formatMinor(100)).toBe('$1.00');
    expect(formatMinor(123_456)).toBe('$1,234.56');
  });

  test('an odd cent is not lost to rounding on the way to the page', () => {
    expect(formatMinor(999)).toBe('$9.99');
    expect(formatMinor(1001)).toBe('$10.01');
  });

  test('rubbish renders as zero rather than NaN', () => {
    expect(formatMinor(null)).toBe('$0.00');
    expect(formatMinor(undefined)).toBe('$0.00');
    expect(formatMinor('nonsense')).toBe('$0.00');
  });

  test('an unknown currency code does not take the page down', () => {
    expect(formatMinor(500, 'NOTACURRENCY')).toContain('5.00');
  });
});
