import { describe, expect, test } from 'bun:test';
import { RETRY_MINUTES, retryMinutes } from '../packages/core/src/retry.js';

describe('retryMinutes', () => {
  test('starts at fifteen minutes and doubles per consecutive failure', () => {
    expect(RETRY_MINUTES).toBe(15);
    expect(retryMinutes(0, 1440)).toBe(15);
    expect(retryMinutes(1, 1440)).toBe(30);
    expect(retryMinutes(2, 1440)).toBe(60);
    expect(retryMinutes(6, 1440)).toBe(960);
    expect(retryMinutes(7, 1440)).toBe(1440);
  });

  test('never exceeds the cadence, and a short cadence is its own retry', () => {
    expect(retryMinutes(0, 5)).toBe(5);
    expect(retryMinutes(3, 60)).toBe(60);
    expect(retryMinutes(0, 43_200)).toBe(15);
  });

  test('shrugs off nonsense', () => {
    expect(retryMinutes(-3, 1440)).toBe(15);
    expect(retryMinutes(Number.NaN, 1440)).toBe(15);
    expect(retryMinutes(1e6, 1440)).toBe(1440);
    expect(retryMinutes(0, 0)).toBe(1);
    expect(retryMinutes(0, undefined)).toBe(1);
  });
});
