import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPBridgeTool } from '../../../src/mcp/bridge-tool.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import type { MCPClient } from '../../../src/mcp/transport.js';
import type { ToolDefinition } from '../../../src/types/tools.js';

// Validates: Requirements 6.2, 6.3

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockClient(
  serverName = 'test-server',
  status: 'connected' | 'disconnected' | 'reconnecting' = 'connected',
): MCPClient {
  return {
    serverName,
    status,
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  };
}

const testDefinition: ToolDefinition = {
  name: 'test-server__echo',
  description: 'Echo tool',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
    },
    required: ['message'],
  },
};

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('Integration: MCPBridgeTool via ToolRegistry', () => {
  let client: MCPClient;
  let bridgeTool: MCPBridgeTool;
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    client = makeMockClient();
    bridgeTool = new MCPBridgeTool(client, 'echo', testDefinition, 5_000);
    registry = new ToolRegistry();
    registry.register(bridgeTool);
  });

  // ── Requirement 6.3: ToolRegistry executes MCPBridgeTool identically ──────

  describe('ToolRegistry.execute() matches direct MCPBridgeTool.execute()', () => {
    it('successful call: registry result matches direct call result', async () => {
      const mcpResponse = {
        content: [{ type: 'text', text: 'hello from MCP' }],
        isError: false,
      };
      (client.callTool as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mcpResponse)
        .mockResolvedValueOnce(mcpResponse);

      const args = { message: 'hello' };

      const directResult = await bridgeTool.execute(args);
      const registryResult = await registry.execute({
        id: 'call-1',
        name: testDefinition.name,
        arguments: args,
      });

      expect(registryResult.content).toBe(directResult.content);
      expect(registryResult.isError).toBe(directResult.isError);
    });

    it('error response: registry result matches direct call result', async () => {
      const mcpResponse = {
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      };
      (client.callTool as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mcpResponse)
        .mockResolvedValueOnce(mcpResponse);

      const args = { message: 'trigger error' };

      const directResult = await bridgeTool.execute(args);
      const registryResult = await registry.execute({
        id: 'call-2',
        name: testDefinition.name,
        arguments: args,
      });

      expect(registryResult.content).toBe(directResult.content);
      expect(registryResult.isError).toBe(directResult.isError);
      expect(registryResult.isError).toBe(true);
    });

    it('registry result carries the toolCallId from the ToolCall', async () => {
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      });

      const result = await registry.execute({
        id: 'my-call-id',
        name: testDefinition.name,
        arguments: { message: 'test' },
      });

      expect(result.toolCallId).toBe('my-call-id');
    });

    it('disconnected client: registry and direct call both return isError=true', async () => {
      const disconnectedClient = makeMockClient('test-server', 'disconnected');
      const disconnectedTool = new MCPBridgeTool(
        disconnectedClient,
        'echo',
        testDefinition,
        5_000,
      );
      const reg = new ToolRegistry();
      reg.register(disconnectedTool);

      const directResult = await disconnectedTool.execute({ message: 'hi' });
      const registryResult = await reg.execute({
        id: 'call-3',
        name: testDefinition.name,
        arguments: { message: 'hi' },
      });

      expect(directResult.isError).toBe(true);
      expect(registryResult.isError).toBe(true);
      expect(registryResult.content).toBe(directResult.content);
    });
  });

  // ── Requirement 6.2: MCP tool is discoverable and compatible ─────────────

  describe('OrchestratorAgent transparent MCP tool access', () => {
    it('MCP tool is discoverable via ToolRegistry.getAll()', () => {
      const tools = registry.getAll();
      const mcpTool = tools.find((t) => t.definition.name === testDefinition.name);
      expect(mcpTool).toBeDefined();
    });

    it('MCP tool definition is LLM-compatible (has name, description, parameters)', () => {
      const tools = registry.getAll();
      const mcpTool = tools.find((t) => t.definition.name === testDefinition.name);

      expect(mcpTool).toBeDefined();
      expect(typeof mcpTool!.definition.name).toBe('string');
      expect(typeof mcpTool!.definition.description).toBe('string');
      expect(mcpTool!.definition.parameters.type).toBe('object');
      expect(typeof mcpTool!.definition.parameters.properties).toBe('object');
    });

    it('ToolRegistry.execute() calls the MCP tool when given a matching ToolCall', async () => {
      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'mcp result' }],
        isError: false,
      });

      const result = await registry.execute({
        id: 'agent-call-1',
        name: testDefinition.name,
        arguments: { message: 'from orchestrator' },
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBe('mcp result');
      expect(client.callTool).toHaveBeenCalledWith('echo', { message: 'from orchestrator' });
    });

    it('ToolRegistry returns tool-not-found error for unknown tool names', async () => {
      const result = await registry.execute({
        id: 'call-x',
        name: 'nonexistent__tool',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('nonexistent__tool');
    });

    it('multiple MCP tools from different servers coexist in registry', () => {
      const client2 = makeMockClient('other-server');
      const def2: ToolDefinition = {
        name: 'other-server__search',
        description: 'Search tool',
        parameters: { type: 'object', properties: {} },
      };
      const tool2 = new MCPBridgeTool(client2, 'search', def2, 5_000);
      registry.register(tool2);

      const names = registry.getAll().map((t) => t.definition.name);
      expect(names).toContain('test-server__echo');
      expect(names).toContain('other-server__search');
    });

    it('OrchestratorAgent agentic loop can call MCP tool via ToolRegistry', async () => {
      // Simulate what OrchestratorAgent.runAgenticLoop does:
      // 1. Get tool definitions from registry
      // 2. LLM returns a tool call
      // 3. Execute via registry.execute()
      // 4. Result is processed

      (client.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: 'text', text: 'agent got this' }],
        isError: false,
      });

      // Step 1: registry exposes tool definitions to LLM
      const toolDefs = registry.getAll().map((t) => t.definition);
      expect(toolDefs.some((d) => d.name === testDefinition.name)).toBe(true);

      // Step 2: LLM returns a tool call (simulated)
      const toolCall = {
        id: 'tc-001',
        name: testDefinition.name,
        arguments: { message: 'agent query' },
      };

      // Step 3: orchestrator executes via registry (no special handling needed)
      const toolResult = await registry.execute(toolCall);

      // Step 4: result is a standard ToolResult
      expect(toolResult.toolCallId).toBe('tc-001');
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content).toBe('agent got this');
    });
  });
});
