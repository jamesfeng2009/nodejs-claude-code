import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { MCPBridgeTool } from '../../src/mcp/bridge-tool.js';
import type { MCPClient } from '../../src/mcp/transport.js';
import type { MCPToolCallResult } from '../../src/mcp/types.js';
import type { ToolDefinition } from '../../src/types/tools.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal ToolDefinition for constructing MCPBridgeTool */
const stubDefinition: ToolDefinition = {
  name: 'test__tool',
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
};

/** Build a mock MCPClient in 'connected' state whose callTool returns the given result */
function makeConnectedClient(result: MCPToolCallResult): MCPClient {
  return {
    serverName: 'test-server',
    status: 'connected',
    connect: async () => {},
    disconnect: async () => {},
    listTools: async () => [],
    callTool: async (_name, _args) => result,
  };
}

/** Build a mock MCPClient in 'disconnected' state; callTool should never be called */
function makeDisconnectedClient(): MCPClient & { callCount: number } {
  let callCount = 0;
  return {
    serverName: 'test-server',
    status: 'disconnected',
    connect: async () => {},
    disconnect: async () => {},
    listTools: async () => [],
    callTool: async (_name, _args) => {
      callCount++;
      return { content: [] };
    },
    get callCount() {
      return callCount;
    },
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary content item with type and optional text */
const contentItemArb = fc.record({
  type: fc.constantFrom('text', 'error', 'resource'),
  text: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
});

/** Arbitrary MCPToolCallResult with isError=true and at least one content item */
const errorResultArb: fc.Arbitrary<MCPToolCallResult> = fc.record({
  content: fc.array(contentItemArb, { minLength: 1, maxLength: 5 }),
  isError: fc.constant(true as const),
});

/** Arbitrary args object: string keys, primitive values */
const argsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,10}$/),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
);

// ─── Property 6: MCP 错误响应透传 ─────────────────────────────────────────────
// Feature: mcp-integration, Property 6: MCP 错误响应透传
// For any MCPToolCallResult with isError=true, MCPBridgeTool.execute() returns
// ToolResult.isError=true and content contains the error text from the response.
// Validates: Requirements 3.5

describe('Property 6: MCP 错误响应透传', () => {
  it('isError=true response is propagated to ToolResult.isError=true with error content', async () => {
    await fc.assert(
      fc.asyncProperty(errorResultArb, argsArb, async (mcpResult, args) => {
        const client = makeConnectedClient(mcpResult);
        const tool = new MCPBridgeTool(client, 'tool', stubDefinition, 30000);

        const toolResult = await tool.execute(args);

        // isError must be propagated
        expect(toolResult.isError).toBe(true);

        // content must be a string (joined from content items)
        expect(typeof toolResult.content).toBe('string');

        // content must equal the joined text of all content items
        const expectedContent = mcpResult.content.map((c) => c.text ?? '').join('\n');
        expect(toolResult.content).toBe(expectedContent);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 7: disconnected 状态立即返回错误 ────────────────────────────────
// Feature: mcp-integration, Property 7: disconnected 立即返回错误
// For any MCPClient in 'disconnected' state, MCPBridgeTool.execute() immediately
// returns isError=true without calling callTool.
// Validates: Requirements 4.3

describe('Property 7: disconnected 状态立即返回错误', () => {
  it('disconnected client returns isError=true without calling callTool', async () => {
    await fc.assert(
      fc.asyncProperty(argsArb, async (args) => {
        const client = makeDisconnectedClient();
        const tool = new MCPBridgeTool(client, 'tool', stubDefinition, 30000);

        const toolResult = await tool.execute(args);

        // Must return error immediately
        expect(toolResult.isError).toBe(true);

        // callTool must never be invoked
        expect(client.callCount).toBe(0);

        // content must be a non-empty string describing unavailability
        expect(typeof toolResult.content).toBe('string');
        expect(toolResult.content.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});
