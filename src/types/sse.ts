import type { ToolResult } from './tools.js';
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
  data: unknown;
  timestamp: number;
}

export interface TextDeltaPayload {
  content: string;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: ToolResult;
}

export interface RunStatusPayload {
  runId: string;
  status: RunStatus;
  error?: string;
}

export interface StateSummaryPayload {
  run: RunStateSummary;
  sessionMessageCount: number;
}
