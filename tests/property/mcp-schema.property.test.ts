import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SchemaConverter } from '../../src/mcp/schema-converter.js';
import type { MCPToolDefinition } from '../../src/mcp/types.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Safe identifier: letters, digits, hyphens, underscores; non-empty */
const identArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
  .filter((s) => s.length > 0);

/** Arbitrary inputSchema variant: with type, without type, with properties, without properties, undefined */
const inputSchemaArb: fc.Arbitrary<MCPToolDefinition['inputSchema']> = fc.oneof(
  // undefined (no inputSchema)
  fc.constant(undefined),
  // empty object (no type, no properties)
  fc.constant({}),
  // has type: 'object' but no properties
  fc.constant({ type: 'object' }),
  // has type: 'object' with properties
  fc.record({
    type: fc.constant('object' as const),
    properties: fc.dictionary(
      identArb,
      fc.record({ type: fc.constantFrom('string', 'number', 'boolean') })
    ),
  }),
  // missing type field, has properties
  fc.record({
    properties: fc.dictionary(
      identArb,
      fc.record({ type: fc.constantFrom('string', 'number', 'boolean') })
    ),
  }),
  // has a non-object type (should be auto-corrected)
  fc.record({
    type: fc.constantFrom('string', 'number', 'array', 'null'),
  }),
  // has type: 'object' with required array
  fc.record({
    type: fc.constant('object' as const),
    properties: fc.dictionary(
      identArb,
      fc.record({ type: fc.constantFrom('string', 'number', 'boolean') })
    ),
    required: fc.array(identArb, { minLength: 0, maxLength: 3 }),
  }),
);

/** Arbitrary MCPToolDefinition */
const mcpToolArb: fc.Arbitrary<MCPToolDefinition> = fc.record({
  name: identArb,
  description: fc.option(fc.string({ minLength: 0, maxLength: 100 }), { nil: undefined }),
  inputSchema: inputSchemaArb,
});

// ─── Property 4: 命名空间前缀格式 ─────────────────────────────────────────────
// Feature: mcp-integration, Property 4: 命名空间前缀格式
// For any valid serverName and toolName, when useNamespace=true,
// SchemaConverter.toToolDefinition() returns a definition.name equal to
// `${serverName}__${toolName}`.
// Validates: Requirements 3.3

describe('Property 4: 命名空间前缀格式', () => {
  it('useNamespace=true produces name in format serverName__toolName', () => {
    fc.assert(
      fc.property(identArb, identArb, (serverName, toolName) => {
        const mcpTool: MCPToolDefinition = { name: toolName };
        const definition = SchemaConverter.toToolDefinition(serverName, mcpTool, true);

        expect(definition.name).toBe(`${serverName}__${toolName}`);
      }),
      { numRuns: 100 }
    );
  });

  it('useNamespace=false uses toolName directly without prefix', () => {
    fc.assert(
      fc.property(identArb, identArb, (serverName, toolName) => {
        const mcpTool: MCPToolDefinition = { name: toolName };
        const definition = SchemaConverter.toToolDefinition(serverName, mcpTool, false);

        expect(definition.name).toBe(toolName);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 5: inputSchema 转换后符合 ToolDefinition 格式 ───────────────────
// Feature: mcp-integration, Property 5: inputSchema 转换格式
// For any MCP tool's inputSchema (including cases missing type:'object'),
// SchemaConverter.toToolDefinition() returns parameters.type always equal to
// 'object', and parameters.properties is always an object type.
// Validates: Requirements 3.2, 3.6

describe('Property 5: inputSchema 转换后符合 ToolDefinition 格式', () => {
  it('parameters.type is always "object" regardless of inputSchema', () => {
    fc.assert(
      fc.property(identArb, mcpToolArb, (serverName, mcpTool) => {
        const definition = SchemaConverter.toToolDefinition(serverName, mcpTool, true);

        expect(definition.parameters.type).toBe('object');
      }),
      { numRuns: 100 }
    );
  });

  it('parameters.properties is always an object type', () => {
    fc.assert(
      fc.property(identArb, mcpToolArb, (serverName, mcpTool) => {
        const definition = SchemaConverter.toToolDefinition(serverName, mcpTool, true);

        expect(typeof definition.parameters.properties).toBe('object');
        expect(definition.parameters.properties).not.toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it('properties from inputSchema are preserved when present', () => {
    fc.assert(
      fc.property(
        identArb,
        identArb,
        fc.dictionary(
          identArb,
          fc.record({ type: fc.constantFrom('string', 'number', 'boolean') })
        ),
        (serverName, toolName, properties) => {
          const mcpTool: MCPToolDefinition = {
            name: toolName,
            inputSchema: { type: 'object', properties },
          };
          const definition = SchemaConverter.toToolDefinition(serverName, mcpTool, true);

          expect(definition.parameters.properties).toEqual(properties);
        }
      ),
      { numRuns: 100 }
    );
  });
});
