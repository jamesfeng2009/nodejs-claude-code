import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../../../src/mcp/manager.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { MCPConfig } from '../../../src/mcp/types.js';

// Validates: Requirements 1.6, 2.6, 5.3, 5.4, 5.5

// ── Mock transports ───────────────────────────────────────────────────────────

// We mock the transport modules so we can control connect() / listTools() behaviour
// without spawning real processes or making real HTTP requests.

const mockStdioConnect = vi.fn();
const mockStdioDisconnect = vi.fn();
const mockStdioListTools = vi.fn();
const mockStdioCallTool = vi.fn();

const mockHttpConnect = vi.fn();
const mockHttpDisconnect = vi.fn();
const mockHttpListTools = vi.fn();
const mockHttpCallTool = vi.fn();

// Each factory call returns a fresh object that shares the same spy functions so
// tests can inspect calls without caring about which instance was created.
vi.mock('../../../src/mcp/stdio-transport.js', () => ({
  StdioTransport: vi.fn().mockImplementation((serverConfig: { name: string }, _timeout: number, onDisconnect: (name: string) => void) => ({
    serverName: serverConfig.name,
    get status() { return 'connected'; },
    connect: mockStdioConnect,
    disconnect: mockStdioDisconnect,
    listTools: mockStdioListTools,
    callTool: mockStdioCallTool,
    _onDisconnect: onDisconnect,
  })),
}));

vi.mock('../../../src/mcp/streamable-http-transport.js', () => ({
  StreamableHttpTransport: vi.fn().mockImplementation((serverConfig: { name: string }) => ({
    serverName: serverConfig.name,
    get status() { return 'connected'; },
    connect: mockHttpConnect,
    disconnect: mockHttpDisconnect,
    listTools: mockHttpListTools,
    callTool: mockHttpCallTool,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

const sampleTools = [
  {
    name: 'tool_a',
    description: 'Tool A',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const sampleTools2 = [
  {
    name: 'tool_b',
    description: 'Tool B',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCPManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStdioDisconnect.mockResolvedValue(undefined);
    mockHttpDisconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Requirement 1.6: No mcp config ───────────────────────────────────────

  describe('no mcp config (undefined)', () => {
    it('initialize() resolves without error', async () => {
      const manager = new MCPManager(undefined, makeToolRegistry());
      await expect(manager.initialize()).resolves.toBeUndefined();
    });

    it('getRegisteredMcpTools() returns empty array', async () => {
      const manager = new MCPManager(undefined, makeToolRegistry());
      await manager.initialize();
      expect(manager.getRegisteredMcpTools()).toEqual([]);
    });

    it('getConnectionStatus() returns empty Map', async () => {
      const manager = new MCPManager(undefined, makeToolRegistry());
      await manager.initialize();
      expect(manager.getConnectionStatus().size).toBe(0);
    });
  });

  // ── Requirement 2.6: Single server failure doesn't affect others ──────────

  describe('single server failure does not affect others', () => {
    it('second server tools are registered when first server fails', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [
          { name: 'server-fail', transport: 'stdio', command: 'fail-cmd' },
          { name: 'server-ok', transport: 'streamable-http', url: 'http://ok' },
        ],
      };

      // First server (stdio) fails to connect; second (http) succeeds
      mockStdioConnect.mockRejectedValueOnce(new Error('connection refused'));
      mockHttpConnect.mockResolvedValueOnce(undefined);
      mockHttpListTools.mockResolvedValueOnce(sampleTools);

      const registry = makeToolRegistry();
      const manager = new MCPManager(config, registry);
      await manager.initialize();

      // Second server's tool should be registered
      const tools = manager.getRegisteredMcpTools();
      expect(tools).toContain('server-ok__tool_a');
    });

    it('first server is disconnected, second server is connected', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [
          { name: 'server-fail', transport: 'stdio', command: 'fail-cmd' },
          { name: 'server-ok', transport: 'streamable-http', url: 'http://ok' },
        ],
      };

      mockStdioConnect.mockRejectedValueOnce(new Error('connection refused'));
      mockHttpConnect.mockResolvedValueOnce(undefined);
      mockHttpListTools.mockResolvedValueOnce(sampleTools);

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();

      const status = manager.getConnectionStatus();
      expect(status.get('server-fail')).toBe('disconnected');
      expect(status.get('server-ok')).toBe('connected');
    });

    it('getRegisteredMcpTools() does not include tools from failed server', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [
          { name: 'server-fail', transport: 'stdio', command: 'fail-cmd' },
          { name: 'server-ok', transport: 'streamable-http', url: 'http://ok' },
        ],
      };

      mockStdioConnect.mockRejectedValueOnce(new Error('connection refused'));
      mockHttpConnect.mockResolvedValueOnce(undefined);
      mockHttpListTools.mockResolvedValueOnce(sampleTools);

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();

      const tools = manager.getRegisteredMcpTools();
      // No tools from the failed server
      expect(tools.every((t) => !t.startsWith('server-fail__'))).toBe(true);
    });
  });

  // ── Requirement 5.5: shutdown() clears reconnect timers ──────────────────

  describe('shutdown() clears reconnect timers', () => {
    it('no reconnect attempt fires after shutdown()', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [{ name: 'server-a', transport: 'stdio', command: 'cmd' }],
      };

      // Connection fails → scheduleReconnect is called
      mockStdioConnect.mockRejectedValueOnce(new Error('fail'));

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();

      // Shut down before the reconnect timer fires
      await manager.shutdown();

      // Spy on attemptReconnect to ensure it is never called
      const attemptSpy = vi.spyOn(manager, 'attemptReconnect');

      // Advance time well past the first backoff delay (1000ms)
      await vi.advanceTimersByTimeAsync(60_000);

      expect(attemptSpy).not.toHaveBeenCalled();
    });

    it('shutdown() resolves even when no servers are configured', async () => {
      const manager = new MCPManager(undefined, makeToolRegistry());
      await manager.initialize();
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    it('shutdown() calls disconnect on all connected clients', async () => {
      const config: MCPConfig = {
        servers: [
          { name: 'server-a', transport: 'stdio', command: 'cmd' },
          { name: 'server-b', transport: 'streamable-http', url: 'http://b' },
        ],
      };

      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce([]);
      mockHttpConnect.mockResolvedValueOnce(undefined);
      mockHttpListTools.mockResolvedValueOnce([]);

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();
      await manager.shutdown();

      expect(mockStdioDisconnect).toHaveBeenCalledTimes(1);
      expect(mockHttpDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  // ── Requirement 5.3: Reconnect success updates tools ─────────────────────

  describe('reconnect success updates tools in ToolRegistry', () => {
    it('new tools are registered after successful reconnect', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [{ name: 'server-a', transport: 'stdio', command: 'cmd' }],
        connectTimeoutMs: 10000,
      };

      // First connect succeeds, registers sampleTools
      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce(sampleTools);

      const registry = makeToolRegistry();
      const manager = new MCPManager(config, registry);
      await manager.initialize();

      expect(manager.getRegisteredMcpTools()).toContain('server-a__tool_a');

      // Simulate disconnect: second connect (reconnect) succeeds with different tools
      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce(sampleTools2);

      // Trigger reconnect directly (simulates onDisconnect callback firing)
      await manager.attemptReconnect('server-a', 1);

      // New tool should now be registered
      expect(manager.getRegisteredMcpTools()).toContain('server-a__tool_b');
    });

    it('connection status is connected after successful reconnect', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [{ name: 'server-a', transport: 'stdio', command: 'cmd' }],
      };

      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce(sampleTools);

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();

      // Simulate a disconnect then reconnect
      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce(sampleTools2);

      await manager.attemptReconnect('server-a', 1);

      expect(manager.getConnectionStatus().get('server-a')).toBe('connected');
    });

    it('failed reconnect schedules another attempt', async () => {
      vi.useFakeTimers();

      const config: MCPConfig = {
        servers: [{ name: 'server-a', transport: 'stdio', command: 'cmd' }],
      };

      // Initial connect succeeds
      mockStdioConnect.mockResolvedValueOnce(undefined);
      mockStdioListTools.mockResolvedValueOnce(sampleTools);

      const manager = new MCPManager(config, makeToolRegistry());
      await manager.initialize();

      // Reconnect attempt fails
      mockStdioConnect.mockRejectedValueOnce(new Error('still down'));

      const scheduleSpy = vi.spyOn(manager, 'scheduleReconnect');
      await manager.attemptReconnect('server-a', 2);

      // Should schedule attempt 3
      expect(scheduleSpy).toHaveBeenCalledWith('server-a', 3);
    });
  });
});
