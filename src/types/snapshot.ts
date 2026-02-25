import type { SessionSummary } from './session.js';
import type { RunStateSummary } from './run.js';

export interface StateSnapshot {
  timestamp: number;
  activeSessions: SessionSummary[];
  activeRuns: RunStateSummary[];
}
