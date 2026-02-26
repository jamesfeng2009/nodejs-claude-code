import type { ToolCall } from './tools.js';
import type { ContentBlock } from './messages.js';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentRequest {
  /** Plain text message (one of message/content) */
  message?: string;
  /** Multimodal content block array (one of message/content) */
  content?: ContentBlock[];
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
