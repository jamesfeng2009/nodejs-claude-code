import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calcBackoffDelay } from '../../src/mcp/manager.js';

// ─── Property 8: 退避公式正确性 ───────────────────────────────────────────────
// Feature: mcp-integration, Property 8: 指数退避公式正确性
// For any reconnect attempt n (n >= 1), the calculated backoff delay should equal
// min(1000 * 2^(n-1), 30000) ms, and for all n >= 6, the delay should equal 30000ms.
// Validates: Requirements 5.1, 5.2

describe('Property 8: 退避公式正确性', () => {
  it('calcBackoffDelay(n) equals min(1000 * 2^(n-1), 30000) for any n in 1..100', () => {
    // Feature: mcp-integration, Property 8: 退避公式正确性
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const expected = Math.min(1000 * Math.pow(2, n - 1), 30000);
        expect(calcBackoffDelay(n)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('calcBackoffDelay(n) equals 30000ms for all n >= 6', () => {
    // Feature: mcp-integration, Property 8: 退避公式正确性（上限）
    fc.assert(
      fc.property(fc.integer({ min: 6, max: 100 }), (n) => {
        expect(calcBackoffDelay(n)).toBe(30000);
      }),
      { numRuns: 100 }
    );
  });

  it('specific values: n=1→1000, n=2→2000, n=3→4000, n=4→8000, n=5→16000, n=6→30000', () => {
    expect(calcBackoffDelay(1)).toBe(1000);
    expect(calcBackoffDelay(2)).toBe(2000);
    expect(calcBackoffDelay(3)).toBe(4000);
    expect(calcBackoffDelay(4)).toBe(8000);
    expect(calcBackoffDelay(5)).toBe(16000);
    expect(calcBackoffDelay(6)).toBe(30000);
  });
});
