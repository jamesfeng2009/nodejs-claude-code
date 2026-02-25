import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { IdempotencyStore } from '../../src/api/idempotency/idempotency-store.js';

// Feature: nodejs-claude-code
// Property 54: 幂等键必填校验 — Validates: Requirements 13.1, 13.2
// Property 55: 幂等性缓存命中返回 — Validates: Requirements 13.4
// Property 56: 飞行中请求合并 — Validates: Requirements 13.5
// Property 57: 幂等缓存 TTL 过期 — Validates: Requirements 13.6

// ─── Arbitraries ────────────────────────────────────────────────────────────

/** Non-empty, non-whitespace-only keys */
const validKeyArb = fc.string({ minLength: 1, maxLength: 100 }).filter(
  (s) => s.trim().length > 0
);

/** Empty or whitespace-only keys */
const invalidKeyArb = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 10 })
);

// ─── Property 54: 幂等键必填校验 ────────────────────────────────────────────

/**
 * **Validates: Requirements 13.1, 13.2**
 *
 * check('') or check with empty/whitespace key throws an error.
 * Non-empty keys are accepted without throwing.
 */
describe('Property 54: 幂等键必填校验', () => {
  it('empty or whitespace-only key throws an error', () => {
    fc.assert(
      fc.property(invalidKeyArb, (key) => {
        const store = new IdempotencyStore();
        expect(() => store.check(key)).toThrow('Idempotency key is required');
      }),
      { numRuns: 100 }
    );
  });

  it('non-empty key does not throw', () => {
    fc.assert(
      fc.property(validKeyArb, (key) => {
        const store = new IdempotencyStore();
        expect(() => store.check(key)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 55: 幂等性缓存命中返回 ────────────────────────────────────────

/**
 * **Validates: Requirements 13.4**
 *
 * After complete(key, result), check(key) returns { status: 'completed', result }
 * with the exact same result value.
 */
describe('Property 55: 幂等性缓存命中返回', () => {
  it('after complete(key, result), check returns completed with exact result', () => {
    fc.assert(
      fc.property(
        validKeyArb,
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        (key, result) => {
          const store = new IdempotencyStore();
          store.check(key); // register as in-flight
          store.complete(key, result);
          const checkResult = store.check(key);
          expect(checkResult).toEqual({ status: 'completed', result });
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 56: 飞行中请求合并 ────────────────────────────────────────────

/**
 * **Validates: Requirements 13.5**
 *
 * After the first check(key) returns 'new', subsequent check(key) calls return
 * 'in_flight' until complete() or fail() is called.
 */
describe('Property 56: 飞行中请求合并', () => {
  it('subsequent checks return in_flight after first check returns new', () => {
    fc.assert(
      fc.property(validKeyArb, fc.integer({ min: 1, max: 10 }), (key, extraChecks) => {
        const store = new IdempotencyStore();
        const first = store.check(key);
        expect(first.status).toBe('new');

        for (let i = 0; i < extraChecks; i++) {
          const subsequent = store.check(key);
          expect(subsequent.status).toBe('in_flight');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('after complete(), check returns completed (no longer in_flight)', () => {
    fc.assert(
      fc.property(validKeyArb, fc.string(), (key, result) => {
        const store = new IdempotencyStore();
        store.check(key); // register as in-flight
        store.complete(key, result);
        const afterComplete = store.check(key);
        expect(afterComplete.status).toBe('completed');
      }),
      { numRuns: 100 }
    );
  });

  it('after fail(), check returns new again', () => {
    fc.assert(
      fc.property(validKeyArb, (key) => {
        const store = new IdempotencyStore();
        store.check(key); // register as in-flight
        store.fail(key);
        const afterFail = store.check(key);
        expect(afterFail.status).toBe('new');
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 57: 幂等缓存 TTL 过期 ─────────────────────────────────────────

/**
 * **Validates: Requirements 13.6**
 *
 * After complete(key, result) with a very short TTL (1ms), cleanExpired() removes
 * the record and subsequent check(key) returns 'new'.
 */
describe('Property 57: 幂等缓存 TTL 过期', () => {
  it('cleanExpired removes records past TTL, subsequent check returns new', async () => {
    await fc.assert(
      fc.asyncProperty(validKeyArb, fc.string(), async (key, result) => {
        const store = new IdempotencyStore(1); // 1ms TTL
        store.check(key); // register as in-flight
        store.complete(key, result);

        // Wait for TTL to expire
        await new Promise((resolve) => setTimeout(resolve, 5));

        store.cleanExpired();

        const afterClean = store.check(key);
        expect(afterClean.status).toBe('new');
      }),
      { numRuns: 50 }
    );
  });

  it('records within TTL are preserved after cleanExpired', () => {
    fc.assert(
      fc.property(validKeyArb, fc.string(), (key, result) => {
        const store = new IdempotencyStore(60_000); // 60s TTL — won't expire
        store.check(key);
        store.complete(key, result);
        store.cleanExpired();
        const afterClean = store.check(key);
        expect(afterClean.status).toBe('completed');
      }),
      { numRuns: 100 }
    );
  });
});
