import type { MCPConfig, MCPServerConfig, ConnectionStatus } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MCPClient } from './transport.js';
import { StdioTransport } from './stdio-transport.js';
import { StreamableHttpTransport } from './streamable-http-transport.js';
import { SchemaConverter } from './schema-converter.js';
import { MCPBridgeTool } from './bridge-tool.js';
import { ConfigValidator } from './config-validator.js';

/**
 * 计算第 n 次重连的指数退避延迟（毫秒）
 * 公式：min(1000 * 2^(n-1), 30000)
 * n=1: 1000ms, n=2: 2000ms, ..., n>=6: 30000ms
 */
export function calcBackoffDelay(n: number): number {
  return Math.min(1000 * Math.pow(2, n - 1), 30000);
}

export class MCPManager {
  private readonly clients = new Map<string, MCPClient>();
  private readonly registeredTools: string[] = [];

  // Separate connection state tracking (req 5.1 — state machine)
  private readonly connectionStates = new Map<string, ConnectionStatus>();

  // Reconnect timers per server name (req 5.5 — stop on shutdown)
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Server configs kept for reconnect (need toolNamespace setting)
  private readonly serverConfigs = new Map<string, MCPServerConfig>();

  private toolCallTimeoutMs = 30000;
  private isShuttingDown = false;

  constructor(
    private readonly mcpConfig: MCPConfig | undefined,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async initialize(): Promise<void> {
    if (this.mcpConfig === undefined) {
      return;
    }

    ConfigValidator.validate(this.mcpConfig);

    this.toolCallTimeoutMs = this.mcpConfig.toolCallTimeoutMs ?? 30000;
    const connectTimeoutMs = this.mcpConfig.connectTimeoutMs ?? 10000;

    for (const server of this.mcpConfig.servers) {
      if (server.enabled === false) {
        continue;
      }

      this.serverConfigs.set(server.name, server);

      const client = this.createClient(server, connectTimeoutMs);
      this.clients.set(server.name, client);
      this.connectionStates.set(server.name, 'disconnected');

      try {
        await client.connect();
        this.connectionStates.set(server.name, 'connected');

        await this.discoverAndRegisterTools(server.name, client);

        console.info(`[MCP] ${server.name}: registered tools`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] ${server.name}: connection failed - ${message}`);
        this.connectionStates.set(server.name, 'disconnected');
        // Schedule reconnect — single failure must not interrupt startup (req 2.6)
        this.scheduleReconnect(server.name, 1);
      }
    }
  }

  async shutdown(): Promise<void> {
    // Mark as shutting down first so reconnect callbacks are ignored (req 5.5)
    this.isShuttingDown = true;

    // Stop all pending reconnect timers (req 5.5)
    for (const [, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    // Disconnect all clients (req 5.4)
    // StdioTransport.disconnect() handles SIGTERM + 5s SIGKILL (req 5.6)
    const disconnectPromises: Promise<void>[] = [];
    for (const [name, client] of this.clients) {
      this.connectionStates.set(name, 'disconnected');
      disconnectPromises.push(client.disconnect());
    }
    await Promise.all(disconnectPromises);
  }

  getConnectionStatus(): Map<string, ConnectionStatus> {
    // Return a snapshot of the tracked connection states (req 2.7)
    return new Map(this.connectionStates);
  }

  getRegisteredMcpTools(): string[] {
    return [...this.registeredTools];
  }

  // ── Reconnect state machine ──────────────────────────────────────────────

  /**
   * Schedule a reconnect attempt after the appropriate backoff delay.
   * disconnected → (timer fires) → attemptReconnect
   */
  scheduleReconnect(serverName: string, attempt: number): void {
    if (this.isShuttingDown) {
      return;
    }

    const delay = calcBackoffDelay(attempt);
    console.info(`[MCP] ${serverName}: scheduling reconnect attempt ${attempt} in ${delay}ms`);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverName);
      void this.attemptReconnect(serverName, attempt);
    }, delay);

    this.reconnectTimers.set(serverName, timer);
  }

  /**
   * Attempt to reconnect a server.
   * reconnecting → connected (on success) | disconnected → scheduleReconnect (on failure)
   */
  async attemptReconnect(serverName: string, attempt: number): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    const client = this.clients.get(serverName);
    if (!client) {
      return;
    }

    // Transition to reconnecting state (req 5.1)
    this.connectionStates.set(serverName, 'reconnecting');
    console.info(`[MCP] ${serverName}: reconnecting (attempt ${attempt})…`);

    try {
      await client.connect();

      // Reconnect succeeded (req 5.3)
      this.connectionStates.set(serverName, 'connected');
      console.info(`[MCP] ${serverName}: reconnected successfully`);

      // Re-discover tools and update ToolRegistry (req 5.3)
      await this.discoverAndRegisterTools(serverName, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] ${serverName}: reconnect attempt ${attempt} failed - ${message}`);
      this.connectionStates.set(serverName, 'disconnected');

      // Schedule next attempt with incremented counter (req 5.1, 5.2)
      this.scheduleReconnect(serverName, attempt + 1);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Discover tools from a connected client and register/overwrite them in ToolRegistry.
   * Re-registration overwrites existing entries (ToolRegistry.register uses Map.set).
   */
  private async discoverAndRegisterTools(serverName: string, client: MCPClient): Promise<void> {
    const server = this.serverConfigs.get(serverName);
    const useNamespace = server ? server.toolNamespace !== false : true;

    const tools = await client.listTools();

    for (const tool of tools) {
      const definition = SchemaConverter.toToolDefinition(serverName, tool, useNamespace);
      const bridgeTool = new MCPBridgeTool(client, tool.name, definition, this.toolCallTimeoutMs);
      this.toolRegistry.register(bridgeTool);

      // Track registered tool names (avoid duplicates on re-registration)
      if (!this.registeredTools.includes(definition.name)) {
        this.registeredTools.push(definition.name);
      }
    }
  }

  private createClient(server: MCPServerConfig, connectTimeoutMs: number): MCPClient {
    if (server.transport === 'stdio') {
      return new StdioTransport(server, connectTimeoutMs, (serverName) => {
        this.scheduleReconnect(serverName, 1);
      });
    }
    // streamable-http
    return new StreamableHttpTransport(server, connectTimeoutMs);
  }
}
