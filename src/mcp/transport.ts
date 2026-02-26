import type { ConnectionStatus, MCPToolCallResult, MCPToolDefinition } from './types.js';

export interface MCPClient {
  readonly serverName: string;
  readonly status: ConnectionStatus;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult>;
}

export type ReconnectCallback = (serverName: string) => void;
