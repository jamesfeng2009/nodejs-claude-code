import type { ToolCall } from './tools.js';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentRequest {
  message: string;
  idempotencyKey: string;
}

export interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface Run {
  runId: string;
  sessionId: string;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  request: AgentRequest;
  result?: AgentResponse;
  error?: string;
}

export interface RunStateSummary {
  runId: string;
  sessionId: string;
  status: RunStatus;
  progress?: string;
  lastEventSeq: number;
}
