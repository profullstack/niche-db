import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  signPayload,
  verifySignature,
} from '../packages/knowledge/src/signing.js';

/**
 * The internal routes create scored work and move somebody's revenue share, so
 * what this file is really testing is that nobody without the secret can.
 */
const secret = 'a-test-signing-secret';
const body = JSON.stringify({ type: 'agent.question_created', payload: { title: 'TPO waste' } });

describe('signing', () => {
  test('a body signed with the secret verifies', () => {
    const header = signPayload({ rawBody: body, secret });
    expect(verifySignature({ rawBody: body, header, secret })).toMatchObject({ ok: true });
  });

  test('the header is the house shape: t=<unix>,v1=<hex>', () => {
    const header = signPayload({ rawBody: body, secret, timestamp: 1_700_000_000 });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(SIGNATURE_HEADER).toBe('x-chovy-signature');
  });

  test('a changed body does not verify against the old signature', () => {
    const header = signPayload({ rawBody: body, secret });
    const tampered = body.replace('TPO waste', 'TPO waste (edited)');
    expect(verifySignature({ rawBody: tampered, header, secret })).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
  });

  test('the wrong secret does not verify', () => {
    const header = signPayload({ rawBody: body, secret: 'someone elses secret' });
    expect(verifySignature({ rawBody: body, header, secret }).ok).toBe(false);
  });

  test('a captured request cannot be replayed once the window has passed', () => {
    const t = 1_700_000_000;
    const header = signPayload({ rawBody: body, secret, timestamp: t });
    // Inside the window it is still good.
    expect(verifySignature({ rawBody: body, header, secret, now: t + 60 }).ok).toBe(true);
    // Outside it, the same bytes are refused.
    expect(
      verifySignature({ rawBody: body, header, secret, now: t + DEFAULT_TOLERANCE_SECONDS + 1 }),
    ).toMatchObject({ ok: false, reason: 'signature expired' });
  });

  test('a timestamp in the future is refused on the same window', () => {
    const t = 1_700_000_000;
    const header = signPayload({ rawBody: body, secret, timestamp: t });
    expect(
      verifySignature({ rawBody: body, header, secret, now: t - DEFAULT_TOLERANCE_SECONDS - 1 }).ok,
    ).toBe(false);
  });

  test('moving the timestamp invalidates the signature, so the window cannot be re-dated', () => {
    const t = 1_700_000_000;
    const header = signPayload({ rawBody: body, secret, timestamp: t });
    const mac = header.split('v1=')[1];
    const restamped = `t=${t + 10_000},v1=${mac}`;
    expect(
      verifySignature({ rawBody: body, header: restamped, secret, now: t + 10_000 }),
    ).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  test('nonsense headers are refused rather than throwing', () => {
    for (const header of ['', 'garbage', 't=abc,v1=x', 'v1=onlythis', 't=1700000000']) {
      expect(verifySignature({ rawBody: body, header, secret }).ok).toBe(false);
    }
  });

  test('a signature of a different length is refused without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so this path must not reach it.
    const header = 't=1700000000,v1=abc';
    expect(verifySignature({ rawBody: body, header, secret, now: 1_700_000_000 })).toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
  });

  test('with no secret configured nothing verifies, and signing refuses', () => {
    const header = signPayload({ rawBody: body, secret });
    expect(verifySignature({ rawBody: body, header, secret: '' }).ok).toBe(false);
    expect(() => signPayload({ rawBody: body, secret: '' })).toThrow();
  });

  test('an empty body still signs and verifies', () => {
    const header = signPayload({ rawBody: '', secret });
    expect(verifySignature({ rawBody: '', header, secret }).ok).toBe(true);
    // And an empty body is not interchangeable with a full one.
    expect(verifySignature({ rawBody: body, header, secret }).ok).toBe(false);
  });
});
