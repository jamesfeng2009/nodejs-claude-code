import { spawn, type ChildProcess } from 'child_process';
import type { MCPServerConfig, MCPToolCallResult, MCPToolDefinition, ConnectionStatus } from './types.js';
import type { MCPClient, ReconnectCallback } from './transport.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const PROTOCOL_VERSION = '2024-11-05';

export class StdioTransport implements MCPClient {
  readonly serverName: string;
  private _status: ConnectionStatus = 'disconnected';
  private process: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private intentionalDisconnect = false;

  constructor(
    private readonly config: MCPServerConfig,
    private readonly connectTimeoutMs: number,
    private readonly onReconnect?: ReconnectCallback,
  ) {
    this.serverName = config.name;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this._status = 'disconnected';

    const child = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = child;

    // Pipe stderr to console for debugging
    child.stderr?.on('data', (data: Buffer) => {
      console.warn(`[MCP][${this.serverName}] stderr: ${data.toString().trim()}`);
    });

    // Buffer stdout and parse newline-delimited JSON-RPC responses
    child.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.flushBuffer();
    });

    // Handle unexpected exit
    child.on('exit', (code, signal) => {
      if (!this.intentionalDisconnect) {
        console.warn(`[MCP][${this.serverName}] 子进程意外退出 (code=${code}, signal=${signal})`);
        this._status = 'disconnected';
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`[MCP][${this.serverName}] 子进程意外退出`));
        }
        this.pendingRequests.clear();
        this.onReconnect?.(this.serverName);
      }
    });

    // Perform MCP handshake with timeout
    await this.performHandshake();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this._status = 'disconnected';

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(`[MCP][${this.serverName}] 连接已断开`));
    }
    this.pendingRequests.clear();

    if (this.process) {
      const child = this.process;
      this.process = null;

      // Force SIGKILL if process hasn't exited within 5 seconds (req 5.6)
      // Attach the exit listener BEFORE sending SIGTERM to avoid a race where
      // the process exits synchronously before the listener is registered.
      await new Promise<void>((resolve) => {
        let resolved = false;

        const forceKillTimer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // Process may have already exited
            }
            resolve();
          }
        }, 5000);

        child.once('exit', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(forceKillTimer);
            resolve();
          }
        });

        child.kill('SIGTERM');
      });
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {}) as { tools: MCPToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as MCPToolCallResult;
  }

  private async performHandshake(): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`[MCP][${this.serverName}] 连接超时（${this.connectTimeoutMs}ms）`));
      }, this.connectTimeoutMs);
    });

    try {
      const response = await Promise.race([
        this.sendRequest('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ai-assistant', version: '1.0.0' },
        }),
        timeoutPromise,
      ]) as { protocolVersion?: string };

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
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

      this.pendingRequests.set(id, { resolve, reject });

      const line = JSON.stringify(request) + '\n';
      this.process?.stdin?.write(line, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(new Error(`[MCP][${this.serverName}] 写入 stdin 失败：${err.message}`));
        }
      });
    });
  }

  private flushBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) chunk in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);
        if (!pending) continue;

        this.pendingRequests.delete(response.id);

        if (response.error) {
          pending.reject(
            new Error(`[MCP][${this.serverName}] JSON-RPC 错误 ${response.error.code}: ${response.error.message}`),
          );
        } else {
          pending.resolve(response.result);
        }
      } catch {
        console.warn(`[MCP][${this.serverName}] 无法解析响应行：${trimmed}`);
      }
    }
  }
}
