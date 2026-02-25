import type { Message } from './messages.js';
import type { ToolResult } from './tools.js';

export interface EntityReference {
  type: 'file_path' | 'function_name' | 'variable_name' | 'error_code' | 'class_name';
  value: string;
  lastMentionedTurn: number;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  timestamp: number;
}

export interface Session {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  conversationHistory: Message[];
  keyEntityCache: EntityReference[];
  toolCallRecords: ToolCallRecord[];
  metadata: Record<string, unknown>;
}

export interface SessionData extends Session {}

export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
}
