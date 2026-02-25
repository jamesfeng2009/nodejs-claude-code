import { randomUUID } from 'crypto';
import type { Run, RunStatus, AgentRequest } from '../types/run.js';

export class RunManager {
  /** runId → Run */
  private readonly runs = new Map<string, Run>();

  /**
   * Submit a new Run for the given session.
   * Returns a Run with status='pending' and a freshly generated UUID runId.
   * Requirement 12.1, 12.3
   */
  submit(sessionId: string, request: AgentRequest): Run {
    const run: Run = {
      runId: randomUUID(),
      sessionId,
      status: 'pending',
      createdAt: Date.now(),
      request,
    };
    this.runs.set(run.runId, run);
    return run;
  }

  /**
   * Return the Run for the given runId, or undefined if not found.
   * Requirement 12.4
   */
  getStatus(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /**
   * Return all Runs belonging to the given session, in insertion order.
   * Requirement 12.3
   */
  getRunsBySession(sessionId: string): Run[] {
    const result: Run[] = [];
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) {
        result.push(run);
      }
    }
    return result;
  }

  /**
   * Advance a Run through the state machine.
   *
   * Valid transitions:
   *   pending  → running   (sets startedAt)
   *   running  → completed (sets completedAt)
   *   running  → failed    (sets completedAt)
   *
   * All other transitions throw an Error.
   * Requirement 12.6
   */
  transitionState(runId: string, newStatus: RunStatus): void {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const { status: current } = run;

    if (current === 'pending' && newStatus === 'running') {
      run.status = 'running';
      run.startedAt = Date.now();
      return;
    }

    if (current === 'running' && (newStatus === 'completed' || newStatus === 'failed')) {
      run.status = newStatus;
      run.completedAt = Date.now();
      return;
    }

    throw new Error(
      `Invalid state transition: ${current} → ${newStatus} for run ${runId}`,
    );
  }

  /**
   * Process all pending Runs for a session serially (one at a time).
   * Each Run is transitioned: pending → running → completed.
   * Requirement 12.5
   */
  async processQueue(sessionId: string): Promise<void> {
    const pending = this.getRunsBySession(sessionId).filter(
      (r) => r.status === 'pending',
    );

    for (const run of pending) {
      this.transitionState(run.runId, 'running');
      try {
        // Placeholder: real work would be injected via a handler callback.
        // For now, immediately mark as completed.
        await Promise.resolve();
        this.transitionState(run.runId, 'completed');
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
        this.transitionState(run.runId, 'failed');
      }
    }
  }
}
