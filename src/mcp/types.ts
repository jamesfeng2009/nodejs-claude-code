// MCP 配置类型（扩展 AppConfig）
export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'streamable-http';
  enabled?: boolean;           // 默认 true
  // stdio 专属
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // streamable-http 专属
  url?: string;
  headers?: Record<string, string>;
  // 命名空间控制
  toolNamespace?: boolean;     // 默认 true
}

export interface MCPConfig {
  servers: MCPServerConfig[];
  toolCallTimeoutMs?: number;  // 默认 30000
  connectTimeoutMs?: number;   // 默认 10000
}

// MCP 协议原始类型
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface MCPToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';
