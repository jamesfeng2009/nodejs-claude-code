import type { ToolCall, ToolResult } from './tools.js';
import type { RunStatus, RunStateSummary } from './run.js';

export type SSEEventType =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'run_status'
  | 'run_complete'
  | 'run_failed'
  | 'state_summary';

export interface SSEEvent {
  id: string;
  seq: number;
  event: SSEEventType;
  data: SSEEventData;
  timestamp: number;
}

// ── Strict per-event payload types ───────────────────────────────────────────

export interface TextDeltaPayload {
  content: string;
}

export interface ToolCallStartPayload {
  toolCall: Pick<ToolCall, 'id' | 'name' | 'arguments'>;
}

export interface ToolCallResultPayload {
  toolCall: Pick<ToolCall, 'id' | 'name'> & { result?: ToolResult };
}

export interface RunStatusPayload {
  runId: string;
  status: RunStatus;
}

export interface RunCompletePayload {
  runId: string;
  status: 'completed';
}

export interface RunFailedPayload {
  runId: string;
  error: string;
}

export interface StateSummaryPayload {
  summary: RunStateSummary;
}

/**
 * Discriminated union of all SSE event data shapes.
 * Clients can switch on the parent SSEEvent.event field to narrow the type.
 */
export type SSEEventData =
  | TextDeltaPayload
  | ToolCallStartPayload
  | ToolCallResultPayload
  | RunStatusPayload
  | RunCompletePayload
  | RunFailedPayload
  | StateSummaryPayload;
