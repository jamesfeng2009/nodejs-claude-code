import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/session/session-store.js';
import { RunManager } from '../../src/agent/run-manager.js';
import { StateSnapshotManager } from '../../src/api/snapshot/state-snapshot-manager.js';
import { SSEStreamManager } from '../../src/api/sse/sse-stream.js';
import type { AgentRequest } from '../../src/types/run.js';

// Feature: nodejs-claude-code, Property 58: 状态快照完整性
// generateSnapshot() always returns a StateSnapshot with:
//   - timestamp that is a positive number
//   - activeSessions that is an array (may be empty)
//   - activeRuns that is an array (may be empty)
//   - All active (pending/running) runs appear in activeRuns
//   - Completed/failed runs do NOT appear in activeRuns
// **Validates: Requirements 14.1**

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return join(tmpdir(), `test-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeRequest(key: string): AgentRequest {
  return { message: 'test', idempotencyKey: key };
}

// ─── Property 58: 状态快照完整性 ────────────────────────────────────────────

describe('Property 58: 状态快照完整性', () => {
  it('snapshot has positive timestamp, array activeSessions, array activeRuns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        async (numSessions) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const sessionStore = new SessionStore(workDir);
          const runManager = new RunManager();
          const snapshotManager = new StateSnapshotManager(sessionStore, runManager, new SSEStreamManager());

          // Create and save some sessions
          for (let i = 0; i < numSessions; i++) {
            const session = sessionStore.create();
            await sessionStore.save(session);
          }

          const snapshot = await snapshotManager.generateSnapshot();

          expect(typeof snapshot.timestamp).toBe('number');
          expect(snapshot.timestamp).toBeGreaterThan(0);
          expect(Array.isArray(snapshot.activeSessions)).toBe(true);
          expect(Array.isArray(snapshot.activeRuns)).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('all pending/running runs appear in activeRuns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 3 }),
        async (numPending, numRunning) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const sessionStore = new SessionStore(workDir);
          const runManager = new RunManager();
          const snapshotManager = new StateSnapshotManager(sessionStore, runManager, new SSEStreamManager());

          const session = sessionStore.create();
          await sessionStore.save(session);

          const pendingRunIds: string[] = [];
          const runningRunIds: string[] = [];

          // Submit pending runs
          for (let i = 0; i < numPending; i++) {
            const run = runManager.submit(session.sessionId, makeRequest(`key-pending-${i}`));
            pendingRunIds.push(run.runId);
          }

          // Submit and transition to running
          for (let i = 0; i < numRunning; i++) {
            const run = runManager.submit(session.sessionId, makeRequest(`key-running-${i}`));
            runManager.transitionState(run.runId, 'running');
            runningRunIds.push(run.runId);
          }

          const snapshot = await snapshotManager.generateSnapshot();
          const activeRunIds = new Set(snapshot.activeRuns.map((r) => r.runId));

          // All pending runs must appear
          for (const id of pendingRunIds) {
            expect(activeRunIds.has(id)).toBe(true);
          }

          // All running runs must appear
          for (const id of runningRunIds) {
            expect(activeRunIds.has(id)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('completed and failed runs do NOT appear in activeRuns', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (numCompleted, numFailed) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const sessionStore = new SessionStore(workDir);
          const runManager = new RunManager();
          const snapshotManager = new StateSnapshotManager(sessionStore, runManager, new SSEStreamManager());

          const session = sessionStore.create();
          await sessionStore.save(session);

          const completedRunIds: string[] = [];
          const failedRunIds: string[] = [];

          // Submit and complete runs
          for (let i = 0; i < numCompleted; i++) {
            const run = runManager.submit(session.sessionId, makeRequest(`key-completed-${i}`));
            runManager.transitionState(run.runId, 'running');
            runManager.transitionState(run.runId, 'completed');
            completedRunIds.push(run.runId);
          }

          // Submit and fail runs
          for (let i = 0; i < numFailed; i++) {
            const run = runManager.submit(session.sessionId, makeRequest(`key-failed-${i}`));
            runManager.transitionState(run.runId, 'running');
            runManager.transitionState(run.runId, 'failed');
            failedRunIds.push(run.runId);
          }

          const snapshot = await snapshotManager.generateSnapshot();
          const activeRunIds = new Set(snapshot.activeRuns.map((r) => r.runId));

          // Completed runs must NOT appear
          for (const id of completedRunIds) {
            expect(activeRunIds.has(id)).toBe(false);
          }

          // Failed runs must NOT appear
          for (const id of failedRunIds) {
            expect(activeRunIds.has(id)).toBe(false);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('activeRuns contains only runs from sessions in activeSessions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (numSessions) => {
          const workDir = makeTempDir();
          tempDirs.push(workDir);
          const sessionStore = new SessionStore(workDir);
          const runManager = new RunManager();
          const snapshotManager = new StateSnapshotManager(sessionStore, runManager, new SSEStreamManager());

          const sessionIds: string[] = [];
          for (let i = 0; i < numSessions; i++) {
            const session = sessionStore.create();
            await sessionStore.save(session);
            sessionIds.push(session.sessionId);
            // Submit a pending run for each session
            runManager.submit(session.sessionId, makeRequest(`key-${i}`));
          }

          const snapshot = await snapshotManager.generateSnapshot();
          const activeSessionIds = new Set(snapshot.activeSessions.map((s) => s.sessionId));

          // Every activeRun's sessionId must be in activeSessions
          for (const run of snapshot.activeRuns) {
            expect(activeSessionIds.has(run.sessionId)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
