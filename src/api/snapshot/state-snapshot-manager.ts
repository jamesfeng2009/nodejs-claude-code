import type { StateSnapshot } from '../../types/snapshot.js';
import type { RunStateSummary } from '../../types/run.js';
import type { SessionStore } from '../../session/session-store.js';
import type { RunManager } from '../../agent/run-manager.js';
import type { SSEStreamManager } from '../sse/sse-stream.js';

export class StateSnapshotManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly runManager: RunManager,
    private readonly sseManager: SSEStreamManager,
  ) {}

  /**
   * Generates a snapshot of current state:
   * - activeSessions: all sessions from sessionStore.list()
   * - activeRuns: all runs with status 'pending' or 'running', mapped to RunStateSummary
   * - timestamp: Date.now()
   * Requirement 14.1
   */
  async generateSnapshot(): Promise<StateSnapshot> {
    const activeSessions = await this.sessionStore.list();

    const activeRuns: RunStateSummary[] = [];
    for (const session of activeSessions) {
      const runs = this.runManager.getRunsBySession(session.sessionId);
      for (const run of runs) {
        if (run.status === 'pending' || run.status === 'running') {
          activeRuns.push(this.toRunSummary(run.runId));
        }
      }
    }

    return {
      timestamp: Date.now(),
      activeSessions,
      activeRuns,
    };
  }

  /**
   * Returns a RunStateSummary for the given runId, or undefined if not found.
   * Requirement 14.4
   */
  getRunSummary(runId: string): RunStateSummary | undefined {
    const run = this.runManager.getStatus(runId);
    if (!run) return undefined;
    return this.toRunSummary(runId);
  }

  private toRunSummary(runId: string): RunStateSummary {
    const run = this.runManager.getStatus(runId)!;
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      lastEventSeq: this.sseManager.getCurrentSeq(runId),
    };
  }
}
