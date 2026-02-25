import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SSEStreamManager } from '../../src/api/sse/sse-stream.js';
import { BearerTokenAuth } from '../../src/api/middleware/auth.js';
import { CORSMiddleware } from '../../src/api/middleware/cors.js';
import type { RunStateSummary } from '../../src/types/run.js';
import type { SSEEventType } from '../../src/types/sse.js';

// ─── Arbitraries ────────────────────────────────────────────────────────────

const sseEventTypeArb: fc.Arbitrary<SSEEventType> = fc.constantFrom(
  'text_delta',
  'tool_call_start',
  'tool_call_result',
  'run_status',
  'run_complete',
  'run_failed',
  'state_summary',
);

const runStatusArb = fc.constantFrom('pending', 'running', 'completed', 'failed') as fc.Arbitrary<
  'pending' | 'running' | 'completed' | 'failed'
>;

const runStateSummaryArb: fc.Arbitrary<RunStateSummary> = fc.record({
  runId: fc.uuid(),
  sessionId: fc.uuid(),
  status: runStatusArb,
  progress: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  lastEventSeq: fc.integer({ min: 0, max: 1000 }),
});

const tokenArb = fc.string({ minLength: 8, maxLength: 64 }).filter((s) => s.trim().length > 0);

const originArb = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.string({ minLength: 3, maxLength: 20 }).filter((s) => /^[a-z0-9-]+$/.test(s)),
    fc.integer({ min: 1024, max: 65535 }),
  )
  .map(([scheme, host, port]) => `${scheme}://${host}.example.com:${port}`);

// ─── Property 45: SSE 事件流类型完整性 ──────────────────────────────────────
// **Validates: Requirements 10.2**

describe('Property 45: SSE 事件流类型完整性', () => {
  it('pushEvent always returns an SSEEvent with all required fields', () => {
    fc.assert(
      fc.property(fc.uuid(), sseEventTypeArb, fc.anything(), (runId, eventType, data) => {
        const manager = new SSEStreamManager();
        manager.createStream(runId);

        const event = manager.pushEvent(runId, { event: eventType, data });

        // All required fields must be present
        expect(typeof event.id).toBe('string');
        expect(event.id.length).toBeGreaterThan(0);
        expect(typeof event.seq).toBe('number');
        expect(Number.isInteger(event.seq)).toBe(true);
        expect(event.seq).toBeGreaterThan(0);
        expect(event.event).toBe(eventType);
        expect(event.data).toEqual(data);
        expect(typeof event.timestamp).toBe('number');
        expect(event.timestamp).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property 59: SSE 重新订阅与状态摘要 ────────────────────────────────────
// **Validates: Requirements 14.2, 14.5**

describe('Property 59: SSE 重新订阅与状态摘要', () => {
  it('resubscribe returns a state_summary event with the RunStateSummary as data', () => {
    fc.assert(
      fc.property(fc.uuid(), runStateSummaryArb, (runId, stateSummary) => {
        const manager = new SSEStreamManager();
        manager.createStream(runId);

        const event = manager.resubscribe(runId, stateSummary);

        // Must be a state_summary event
        expect(event.event).toBe('state_summary');
        // Data must contain the RunStateSummary
        expect(event.data).toEqual(stateSummary);
        // Must have all required SSEEvent fields
        expect(typeof event.id).toBe('string');
        expect(typeof event.seq).toBe('number');
        expect(typeof event.timestamp).toBe('number');
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property 60: SSE 事件序号单调递增 ──────────────────────────────────────
// **Validates: Requirements 14.3**

describe('Property 60: SSE 事件序号单调递增', () => {
  it('pushing N events produces strictly increasing seq numbers starting at 1', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.integer({ min: 1, max: 50 }),
        sseEventTypeArb,
        (runId, n, eventType) => {
          const manager = new SSEStreamManager();
          manager.createStream(runId);

          const events = Array.from({ length: n }, () =>
            manager.pushEvent(runId, { event: eventType, data: null }),
          );

          // Seq numbers must be 1, 2, 3, ..., n
          for (let i = 0; i < events.length; i++) {
            expect(events[i].seq).toBe(i + 1);
          }

          // Strictly increasing
          for (let i = 1; i < events.length; i++) {
            expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
          }

          // getCurrentSeq must match the last seq
          expect(manager.getCurrentSeq(runId)).toBe(n);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 43: Bearer Token 认证正确性 ───────────────────────────────────
// **Validates: Requirements 10.4, 10.5**

describe('Property 43: Bearer Token 认证正确性', () => {
  it('valid tokens pass auth; missing/invalid tokens return 401', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
        tokenArb,
        (validTokens, invalidToken) => {
          // Ensure invalidToken is not in validTokens
          fc.pre(!validTokens.includes(invalidToken));

          const auth = new BearerTokenAuth(validTokens);

          // All valid tokens should pass
          for (const token of validTokens) {
            expect(auth.isValidToken(token)).toBe(true);
          }

          // Invalid token should fail
          expect(auth.isValidToken(invalidToken)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preHandler returns 401 for missing Authorization header', () => {
    fc.assert(
      fc.property(fc.array(tokenArb, { minLength: 1, maxLength: 5 }), (validTokens) => {
        const auth = new BearerTokenAuth(validTokens);

        let statusCode = 0;
        let sentBody: unknown = null;
        let doneCalled = false;

        const request = { headers: {} as Record<string, string | undefined> };
        const reply = {
          code: (status: number) => {
            statusCode = status;
            return { send: (body: unknown) => { sentBody = body; } };
          },
        };
        const done = () => { doneCalled = true; };

        auth.preHandler(request, reply, done);

        expect(statusCode).toBe(401);
        expect(doneCalled).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('preHandler returns 401 for invalid Bearer token', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
        tokenArb,
        (validTokens, invalidToken) => {
          fc.pre(!validTokens.includes(invalidToken));

          const auth = new BearerTokenAuth(validTokens);

          let statusCode = 0;
          let doneCalled = false;

          const request = {
            headers: { authorization: `Bearer ${invalidToken}` } as Record<string, string | undefined>,
          };
          const reply = {
            code: (status: number) => {
              statusCode = status;
              return { send: (_body: unknown) => {} };
            },
          };
          const done = () => { doneCalled = true; };

          auth.preHandler(request, reply, done);

          expect(statusCode).toBe(401);
          expect(doneCalled).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preHandler calls done() for valid Bearer token', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0 }),
        (validTokens, idx) => {
          const token = validTokens[idx % validTokens.length];
          const auth = new BearerTokenAuth(validTokens);

          let doneCalled = false;
          let statusCode = 0;

          const request = {
            headers: { authorization: `Bearer ${token}` } as Record<string, string | undefined>,
          };
          const reply = {
            code: (status: number) => {
              statusCode = status;
              return { send: (_body: unknown) => {} };
            },
          };
          const done = () => { doneCalled = true; };

          auth.preHandler(request, reply, done);

          expect(doneCalled).toBe(true);
          expect(statusCode).toBe(0); // reply.code should not have been called
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 44: CORS 源地址验证 ───────────────────────────────────────────
// **Validates: Requirements 10.6, 10.7**

describe('Property 44: CORS 源地址验证', () => {
  it('allowed origins are recognized; disallowed origins are not', () => {
    fc.assert(
      fc.property(
        fc.array(originArb, { minLength: 1, maxLength: 5 }),
        originArb,
        (allowedOrigins, disallowedOrigin) => {
          fc.pre(!allowedOrigins.includes(disallowedOrigin));

          const cors = new CORSMiddleware(allowedOrigins);

          // All allowed origins should pass
          for (const origin of allowedOrigins) {
            expect(cors.isAllowedOrigin(origin)).toBe(true);
          }

          // Disallowed origin should fail
          expect(cors.isAllowedOrigin(disallowedOrigin)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('addHooks sets Access-Control-Allow-Origin for allowed origins', () => {
    fc.assert(
      fc.property(
        fc.array(originArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0 }),
        (allowedOrigins, idx) => {
          const origin = allowedOrigins[idx % allowedOrigins.length];
          const cors = new CORSMiddleware(allowedOrigins);

          const headers: Record<string, string> = {};
          let doneCalled = false;
          let statusCode = 0;

          const mockFastify = {
            addHook: (
              _event: string,
              handler: (
                req: { headers: Record<string, string>; method: string },
                rep: { header: (n: string, v: string) => void; code: (s: number) => { send: () => void } },
                done: () => void,
              ) => void,
            ) => {
              handler(
                { headers: { origin }, method: 'GET' },
                {
                  header: (name: string, value: string) => { headers[name] = value; },
                  code: (s: number) => { statusCode = s; return { send: () => {} }; },
                },
                () => { doneCalled = true; },
              );
            },
          };

          cors.addHooks(mockFastify);

          expect(headers['Access-Control-Allow-Origin']).toBe(origin);
          expect(doneCalled).toBe(true);
          expect(statusCode).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('addHooks returns 403 for disallowed origins', () => {
    fc.assert(
      fc.property(
        fc.array(originArb, { minLength: 1, maxLength: 5 }),
        originArb,
        (allowedOrigins, disallowedOrigin) => {
          fc.pre(!allowedOrigins.includes(disallowedOrigin));

          const cors = new CORSMiddleware(allowedOrigins);

          let statusCode = 0;
          let doneCalled = false;

          const mockFastify = {
            addHook: (
              _event: string,
              handler: (
                req: { headers: Record<string, string>; method: string },
                rep: { header: (n: string, v: string) => void; code: (s: number) => { send: () => void } },
                done: () => void,
              ) => void,
            ) => {
              handler(
                { headers: { origin: disallowedOrigin }, method: 'GET' },
                {
                  header: (_name: string, _value: string) => {},
                  code: (s: number) => { statusCode = s; return { send: () => {} }; },
                },
                () => { doneCalled = true; },
              );
            },
          };

          cors.addHooks(mockFastify);

          expect(statusCode).toBe(403);
          expect(doneCalled).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
