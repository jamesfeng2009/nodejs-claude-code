import type { MCPServerConfig, MCPToolCallResult, MCPToolDefinition, ConnectionStatus } from './types.js';
import type { MCPClient } from './transport.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2024-11-05';

export class StreamableHttpTransport implements MCPClient {
  readonly serverName: string;
  private _status: ConnectionStatus = 'disconnected';
  private nextId = 1;
  private abortController: AbortController | null = null;

  constructor(
    private readonly config: MCPServerConfig,
    private readonly connectTimeoutMs: number,
  ) {
    this.serverName = config.name;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    this._status = 'disconnected';
    const abortController = new AbortController();
    this.abortController = abortController;

    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, this.connectTimeoutMs);

    try {
      const response = await this.sendRequest(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ai-assistant', version: '1.0.0' },
        },
        abortController.signal,
      ) as { protocolVersion?: string };

      // Check protocol version compatibility
      if (response.protocolVersion && response.protocolVersion !== PROTOCOL_VERSION) {
        console.warn(
          `[MCP][${this.serverName}] 协议版本不匹配：期望 ${PROTOCOL_VERSION}，实际 ${response.protocolVersion}，继续连接`,
        );
      }

      this._status = 'connected';
    } catch (err) {
      this._status = 'disconnected';
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MCP][${this.serverName}] 连接失败：${message}`);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async disconnect(): Promise<void> {
    this._status = 'disconnected';
    this.abortController?.abort();
    this.abortController = null;
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {}) as { tools: MCPToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as MCPToolCallResult;
  }

  private async sendRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };

    const requestSignal = signal ?? this.abortController?.signal;

    let response: Response;
    try {
      response = await fetch(this.config.url!, {
        method: 'POST',
        headers,
        body,
        signal: requestSignal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Distinguish timeout (abort) from other network errors
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[MCP][${this.serverName}] 连接超时（${this.connectTimeoutMs}ms）`);
      }
      throw new Error(`[MCP][${this.serverName}] 请求失败：${message}`);
    }

    if (!response.ok) {
      throw new Error(`[MCP][${this.serverName}] HTTP 错误：${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      return this.parseSSEResponse(response);
    }

    // application/json or other: parse directly
    const json = await response.json() as JsonRpcResponse;
    if (json.error) {
      throw new Error(`[MCP][${this.serverName}] JSON-RPC 错误 ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }

  private async parseSSEResponse(response: Response): Promise<MCPToolCallResult> {
    const contentParts: Array<{ type: string; text?: string }> = [];
    let isError = false;

    const body = response.body;
    if (!body) {
      return { content: contentParts, isError };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice('data: '.length).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as JsonRpcResponse;
            if (event.result) {
              const result = event.result as MCPToolCallResult;
              if (Array.isArray(result.content)) {
                contentParts.push(...result.content);
              }
              if (result.isError) {
                isError = true;
              }
            }
          } catch {
            console.warn(`[MCP][${this.serverName}] 无法解析 SSE 数据：${data}`);
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice('data: '.length).trim();
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data) as JsonRpcResponse;
            if (event.result) {
              const result = event.result as MCPToolCallResult;
              if (Array.isArray(result.content)) {
                contentParts.push(...result.content);
              }
              if (result.isError) {
                isError = true;
              }
            }
          } catch {
            console.warn(`[MCP][${this.serverName}] 无法解析 SSE 数据：${data}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content: contentParts, isError };
  }
}
