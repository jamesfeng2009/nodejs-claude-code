import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { RunManager } from '../../src/agent/run-manager.js';
import type { AgentRequest } from '../../src/types/run.js';

// Feature: nodejs-claude-code
// Property 50: Agent 请求立即返回 202 与 runId
// Validates: Requirements 12.1
//
// Property 51: Run ID 唯一性与状态查询正确性
// Validates: Requirements 12.3, 12.4
//
// Property 52: 会话内作业串行执行
// Validates: Requirements 12.5
//
// Property 53: Run 异常状态转移
// Validates: Requirements 12.6

// ─── Arbitraries ────────────────────────────────────────────────────────────

const sessionIdArb = fc.uuid();

const agentRequestArb: fc.Arbitrary<AgentRequest> = fc.record({
  message: fc.string({ minLength: 1, maxLength: 200 }),
  idempotencyKey: fc.uuid(),
});

// ─── Property 50: Agent 请求立即返回 202 与 runId ────────────────────────────

describe('Property 50: Agent 请求立即返回 202 与 runId', () => {
  /**
   * **Validates: Requirements 12.1**
   * submit() always returns a Run with a non-empty runId and status='pending'.
   */
  it('submit() returns a Run with non-empty runId and status=pending', () => {
    fc.assert(
      fc.property(sessionIdArb, agentRequestArb, (sessionId, request) => {
        const manager = new RunManager();
        const run = manager.submit(sessionId, request);

        expect(run.runId).toBeTruthy();
        expect(typeof run.runId).toBe('string');
        expect(run.runId.length).toBeGreaterThan(0);
        expect(run.status).toBe('pending');
        expect(run.sessionId).toBe(sessionId);
        expect(run.request).toEqual(request);
        expect(typeof run.createdAt).toBe('number');
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property 51: Run ID 唯一性与状态查询正确性 ──────────────────────────────

describe('Property 51: Run ID 唯一性与状态查询正确性', () => {
  /**
   * **Validates: Requirements 12.3, 12.4**
   * Submitting N runs always produces N distinct runIds.
   * getStatus(runId) returns the correct Run for each runId.
   */
  it('N submissions produce N distinct runIds and getStatus returns correct Run', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        fc.array(agentRequestArb, { minLength: 1, maxLength: 50 }),
        (sessionId, requests) => {
          const manager = new RunManager();
          const runs = requests.map((req) => manager.submit(sessionId, req));

          // All runIds must be distinct
          const ids = runs.map((r) => r.runId);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(runs.length);

          // getStatus must return the correct Run for each runId
          for (const run of runs) {
            const fetched = manager.getStatus(run.runId);
            expect(fetched).toBeDefined();
            expect(fetched?.runId).toBe(run.runId);
            expect(fetched?.sessionId).toBe(sessionId);
            expect(fetched?.status).toBe('pending');
          }

          // getStatus for an unknown runId returns undefined
          expect(manager.getStatus('non-existent-id')).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 52: 会话内作业串行执行 ────────────────────────────────────────

describe('Property 52: 会话内作业串行执行', () => {
  /**
   * **Validates: Requirements 12.5**
   * Within a session, processQueue processes runs one at a time.
   * No two runs are in 'running' state simultaneously for the same session.
   */
  it('processQueue processes runs serially — no two runs running simultaneously', async () => {
    await fc.assert(
      fc.asyncProperty(
        sessionIdArb,
        fc.array(agentRequestArb, { minLength: 1, maxLength: 10 }),
        async (sessionId, requests) => {
          const manager = new RunManager();
          const runs = requests.map((req) => manager.submit(sessionId, req));

          // Track the maximum number of concurrently running runs
          let maxConcurrent = 0;
          let currentRunning = 0;

          // Patch transitionState to observe concurrency
          const original = manager.transitionState.bind(manager);
          manager.transitionState = (runId, newStatus) => {
            original(runId, newStatus);
            if (newStatus === 'running') {
              currentRunning++;
              if (currentRunning > maxConcurrent) {
                maxConcurrent = currentRunning;
              }
            } else if (newStatus === 'completed' || newStatus === 'failed') {
              currentRunning--;
            }
          };

          await manager.processQueue(sessionId);

          // All runs should be completed
          for (const run of runs) {
            const status = manager.getStatus(run.runId)?.status;
            expect(status).toBe('completed');
          }

          // At most 1 run was running at any given time
          expect(maxConcurrent).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 53: Run 异常状态转移 ──────────────────────────────────────────

describe('Property 53: Run 异常状态转移', () => {
  /**
   * **Validates: Requirements 12.6**
   * Invalid state transitions throw errors.
   * Valid transitions succeed.
   */
  it('valid transitions succeed; invalid transitions throw', () => {
    fc.assert(
      fc.property(sessionIdArb, agentRequestArb, (sessionId, request) => {
        const manager = new RunManager();

        // ── Valid: pending → running ──────────────────────────────────────
        const run1 = manager.submit(sessionId, request);
        expect(() => manager.transitionState(run1.runId, 'running')).not.toThrow();
        expect(manager.getStatus(run1.runId)?.status).toBe('running');
        expect(manager.getStatus(run1.runId)?.startedAt).toBeDefined();

        // ── Valid: running → completed ────────────────────────────────────
        const run2 = manager.submit(sessionId, request);
        manager.transitionState(run2.runId, 'running');
        expect(() => manager.transitionState(run2.runId, 'completed')).not.toThrow();
        expect(manager.getStatus(run2.runId)?.status).toBe('completed');
        expect(manager.getStatus(run2.runId)?.completedAt).toBeDefined();

        // ── Valid: running → failed ───────────────────────────────────────
        const run3 = manager.submit(sessionId, request);
        manager.transitionState(run3.runId, 'running');
        expect(() => manager.transitionState(run3.runId, 'failed')).not.toThrow();
        expect(manager.getStatus(run3.runId)?.status).toBe('failed');
        expect(manager.getStatus(run3.runId)?.completedAt).toBeDefined();

        // ── Invalid: pending → completed ──────────────────────────────────
        const run4 = manager.submit(sessionId, request);
        expect(() => manager.transitionState(run4.runId, 'completed')).toThrow();

        // ── Invalid: pending → failed ─────────────────────────────────────
        const run5 = manager.submit(sessionId, request);
        expect(() => manager.transitionState(run5.runId, 'failed')).toThrow();

        // ── Invalid: completed → anything ─────────────────────────────────
        const run6 = manager.submit(sessionId, request);
        manager.transitionState(run6.runId, 'running');
        manager.transitionState(run6.runId, 'completed');
        expect(() => manager.transitionState(run6.runId, 'running')).toThrow();
        expect(() => manager.transitionState(run6.runId, 'pending')).toThrow();
        expect(() => manager.transitionState(run6.runId, 'failed')).toThrow();

        // ── Invalid: failed → anything ────────────────────────────────────
        const run7 = manager.submit(sessionId, request);
        manager.transitionState(run7.runId, 'running');
        manager.transitionState(run7.runId, 'failed');
        expect(() => manager.transitionState(run7.runId, 'running')).toThrow();
        expect(() => manager.transitionState(run7.runId, 'pending')).toThrow();
        expect(() => manager.transitionState(run7.runId, 'completed')).toThrow();

        // ── Invalid: running → pending ────────────────────────────────────
        const run8 = manager.submit(sessionId, request);
        manager.transitionState(run8.runId, 'running');
        expect(() => manager.transitionState(run8.runId, 'pending')).toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
