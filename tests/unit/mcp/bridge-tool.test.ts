import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPBridgeTool } from '../../../src/mcp/bridge-tool.js';
import type { MCPClient } from '../../../src/mcp/transport.js';
import type { ToolDefinition } from '../../../src/types/tools.js';

// Validates: Requirements 3.4, 3.5, 4.1, 4.2, 4.3, 4.4

// ── Helpers ───────────────────────────────────────────────────────────────────

const testDefinition: ToolDefinition = {
  name: 'test-server__my_tool',
  description: 'A test tool',
  parameters: {
    type: 'object',
    properties: {},
  },
};

function makeMockClient(status: 'connected' | 'disconnected' | 'reconnecting' = 'connected'): MCPClient {
  return {
    serverName: 'test-server',
    status,
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCPBridgeTool', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Requirement 3.4 / 4.1 / 4.4: Normal call ─────────────────────────────

  describe('normal call (connected)', () => {
    it('returns ToolResult with isError=false and the content text', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hello world' }],
        isError: false,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({ input: 'test' });

      expect(result.isError).toBe(false);
      expect(result.content).toBe('hello world');
      expect(result.toolCallId).toBe('');
    });

    it('joins multiple content parts with newline', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
        isError: false,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      expect(result.content).toBe('line one\nline two');
    });

    it('logs elapsed time via console.debug', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      await tool.execute({});

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('my_tool'));
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('ms'));
      debugSpy.mockRestore();
    });

    it('forwards args to client.callTool', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      await tool.execute({ key: 'value', num: 42 });

      expect(client.callTool).toHaveBeenCalledWith('my_tool', { key: 'value', num: 42 });
    });
  });

  // ── Requirement 4.2: Timeout ──────────────────────────────────────────────

  describe('timeout', () => {
    it('returns isError=true after timeoutMs when callTool never resolves', async () => {
      vi.useFakeTimers();

      const client = makeMockClient('connected');
      // callTool never resolves
      (client.callTool as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise(() => {}),
      );

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 3_000);
      const resultPromise = tool.execute({});

      await vi.advanceTimersByTimeAsync(3_001);
      const result = await resultPromise;

      expect(result.isError).toBe(true);
    });

    it('timeout content mentions the tool name', async () => {
      vi.useFakeTimers();

      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise(() => {}),
      );

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 3_000);
      const resultPromise = tool.execute({});

      await vi.advanceTimersByTimeAsync(3_001);
      const result = await resultPromise;

      expect(result.content).toContain('my_tool');
    });

    it('timeout content mentions the timeout duration', async () => {
      vi.useFakeTimers();

      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise(() => {}),
      );

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 3_000);
      const resultPromise = tool.execute({});

      await vi.advanceTimersByTimeAsync(3_001);
      const result = await resultPromise;

      expect(result.content).toContain('3000');
    });
  });

  // ── Requirement 4.3: Disconnected state ──────────────────────────────────

  describe('disconnected state', () => {
    it('immediately returns isError=true without calling callTool', async () => {
      const client = makeMockClient('disconnected');

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({ input: 'test' });

      expect(result.isError).toBe(true);
      expect(client.callTool).not.toHaveBeenCalled();
    });

    it('content mentions the server is unavailable', async () => {
      const client = makeMockClient('disconnected');

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      // Should mention the server name or unavailability
      expect(result.content).toContain('test-server');
    });

    it('returns immediately (does not wait for timeout)', async () => {
      vi.useFakeTimers();
      const client = makeMockClient('disconnected');

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);

      // Should resolve without advancing timers
      const result = await tool.execute({});

      expect(result.isError).toBe(true);
      // No timer advancement needed — confirms it returned immediately
    });
  });

  // ── Requirement 3.5: isError passthrough ─────────────────────────────────

  describe('isError passthrough', () => {
    it('returns isError=true when MCP response has isError=true', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      expect(result.isError).toBe(true);
    });

    it('content contains the error text from the MCP response', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      expect(result.content).toContain('something went wrong');
    });

    it('returns isError=false when MCP response has isError=false', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'success' }],
        isError: false,
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      expect(result.isError).toBe(false);
    });

    it('defaults isError to false when MCP response omits the field', async () => {
      const client = makeMockClient('connected');
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'no isError field' }],
        // isError omitted
      });

      const tool = new MCPBridgeTool(client, 'my_tool', testDefinition, 5_000);
      const result = await tool.execute({});

      expect(result.isError).toBe(false);
    });
  });
});
