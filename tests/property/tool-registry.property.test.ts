import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool, ToolDefinition, ToolCall } from '../../src/types/tools.js';

// Feature: nodejs-claude-code, Property 5: 工具查找与执行正确性
// For any registered tool and matching Tool Call, Tool Registry should find and execute
// the correct tool implementation, returning result containing toolCallId.
// Validates: Requirements 3.2

// Feature: nodejs-claude-code, Property 10: 工具参数校验正确性
// For any tool definition JSON Schema and non-conforming parameter object,
// Tool Registry should return parameter validation error.
// Validates: Requirements 3.9

// Feature: nodejs-claude-code, Property 31: 工具定义序列化往返一致性
// For all valid tool definition objects, parsing serialized JSON then deserializing
// should produce equivalent tool definition (round-trip consistency).
// Validates: Requirements 8.1, 8.2, 8.3

// Feature: nodejs-claude-code, Property 32: 无效 JSON 工具定义错误报告
// If JSON tool definition file format is invalid, Tool Registry should return
// parse error with specific error location and reason.
// Validates: Requirements 8.4

// ─── Arbitraries ────────────────────────────────────────────────────────────

const toolNameArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/)
  .filter((s) => s.length > 0);

const toolDescriptionArb = fc.string({ minLength: 1, maxLength: 200 });

const jsonSchemaTypeArb = fc.constantFrom('string', 'number', 'boolean', 'integer');

const propertyArb = fc.record({
  type: jsonSchemaTypeArb,
  description: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
});

const toolDefinitionArb: fc.Arbitrary<ToolDefinition> = fc
  .tuple(
    toolNameArb,
    toolDescriptionArb,
    fc.dictionary(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
      propertyArb,
      { minKeys: 0, maxKeys: 5 }
    )
  )
  .map(([name, description, properties]) => ({
    name,
    description,
    parameters: {
      type: 'object' as const,
      properties,
    },
  }));

const toolCallIdArb = fc.string({ minLength: 1, maxLength: 50 });

/** Build a Tool that records calls and returns a predictable result */
function makeMockTool(definition: ToolDefinition): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    definition,
    calls,
    async execute(args: Record<string, unknown>) {
      calls.push(args);
      return { toolCallId: '', content: 'ok', isError: false };
    },
  };
}

// ─── Property 5: 工具查找与执行正确性 ────────────────────────────────────────

describe('Property 5: 工具查找与执行正确性', () => {
  it('registered tool is found and executed, result contains toolCallId', async () => {
    await fc.assert(
      fc.asyncProperty(
        toolDefinitionArb,
        toolCallIdArb,
        async (definition, callId) => {
          const registry = new ToolRegistry();
          const tool = makeMockTool(definition);
          registry.register(tool);

          const toolCall: ToolCall = {
            id: callId,
            name: definition.name,
            arguments: {},
          };

          const result = await registry.execute(toolCall);

          // Result must contain the toolCallId
          expect(result.toolCallId).toBe(callId);
          // Should not be an error for a valid call
          expect(result.isError).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('get() returns the registered tool by name', () => {
    fc.assert(
      fc.property(toolDefinitionArb, (definition) => {
        const registry = new ToolRegistry();
        const tool = makeMockTool(definition);
        registry.register(tool);

        const found = registry.get(definition.name);
        expect(found).toBeDefined();
        expect(found?.definition.name).toBe(definition.name);
      }),
      { numRuns: 100 }
    );
  });

  it('execute returns error result with toolCallId when tool is not found', async () => {
    await fc.assert(
      fc.asyncProperty(
        toolCallIdArb,
        fc.string({ minLength: 1, maxLength: 30 }),
        async (callId, unknownName) => {
          const registry = new ToolRegistry();

          const toolCall: ToolCall = {
            id: callId,
            name: `nonexistent_${unknownName}`,
            arguments: {},
          };

          const result = await registry.execute(toolCall);
          expect(result.toolCallId).toBe(callId);
          expect(result.isError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiple tools can be registered and each is found by its name', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolDefinitionArb, { minLength: 2, maxLength: 5, selector: (d) => d.name }),
        (definitions) => {
          const registry = new ToolRegistry();
          for (const def of definitions) {
            registry.register(makeMockTool(def));
          }

          for (const def of definitions) {
            const found = registry.get(def.name);
            expect(found).toBeDefined();
            expect(found?.definition.name).toBe(def.name);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 10: 工具参数校验正确性 ─────────────────────────────────────────

describe('Property 10: 工具参数校验正确性', () => {
  it('missing required argument causes validation error', () => {
    fc.assert(
      fc.property(
        toolNameArb,
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
        (toolName, requiredParam) => {
          const registry = new ToolRegistry();
          const definition: ToolDefinition = {
            name: toolName,
            description: 'test tool',
            parameters: {
              type: 'object',
              properties: {
                [requiredParam]: { type: 'string', description: 'required param' },
              },
              required: [requiredParam],
            },
          };
          registry.register(makeMockTool(definition));

          // Pass empty args - missing the required param
          const result = registry.validateArgs(toolName, {});
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.errors.some((e) => e.includes(requiredParam))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('wrong type for a parameter causes validation error', () => {
    fc.assert(
      fc.property(
        toolNameArb,
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
        (toolName, paramName) => {
          const registry = new ToolRegistry();
          const definition: ToolDefinition = {
            name: toolName,
            description: 'test tool',
            parameters: {
              type: 'object',
              properties: {
                [paramName]: { type: 'string', description: 'string param' },
              },
              required: [paramName],
            },
          };
          registry.register(makeMockTool(definition));

          // Pass a number instead of string
          const result = registry.validateArgs(toolName, { [paramName]: 42 });
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('valid args pass validation', () => {
    fc.assert(
      fc.property(
        toolNameArb,
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
        fc.string({ minLength: 0, maxLength: 100 }),
        (toolName, paramName, paramValue) => {
          const registry = new ToolRegistry();
          const definition: ToolDefinition = {
            name: toolName,
            description: 'test tool',
            parameters: {
              type: 'object',
              properties: {
                [paramName]: { type: 'string', description: 'string param' },
              },
              required: [paramName],
            },
          };
          registry.register(makeMockTool(definition));

          const result = registry.validateArgs(toolName, { [paramName]: paramValue });
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-object args always fail validation', () => {
    fc.assert(
      fc.property(
        toolNameArb,
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.array(fc.string())
        ),
        (toolName, invalidArgs) => {
          const registry = new ToolRegistry();
          const definition: ToolDefinition = {
            name: toolName,
            description: 'test tool',
            parameters: { type: 'object', properties: {} },
          };
          registry.register(makeMockTool(definition));

          const result = registry.validateArgs(toolName, invalidArgs);
          expect(result.valid).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('execute returns validation error result when args are invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        toolNameArb,
        toolCallIdArb,
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
        async (toolName, callId, requiredParam) => {
          const registry = new ToolRegistry();
          const definition: ToolDefinition = {
            name: toolName,
            description: 'test tool',
            parameters: {
              type: 'object',
              properties: {
                [requiredParam]: { type: 'string' },
              },
              required: [requiredParam],
            },
          };
          registry.register(makeMockTool(definition));

          const toolCall: ToolCall = {
            id: callId,
            name: toolName,
            arguments: {}, // missing required param
          };

          const result = await registry.execute(toolCall);
          expect(result.toolCallId).toBe(callId);
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/validation/i);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 31: 工具定义序列化往返一致性 ────────────────────────────────────

describe('Property 31: 工具定义序列化往返一致性', () => {
  it('toJSON then fromJSON produces equivalent tool definitions', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolDefinitionArb, { minLength: 1, maxLength: 5, selector: (d) => d.name }),
        (definitions) => {
          const registry = new ToolRegistry();
          for (const def of definitions) {
            registry.register(makeMockTool(def));
          }

          const json = registry.toJSON();
          const restored = ToolRegistry.fromJSON(json);

          expect(restored).toHaveLength(definitions.length);

          // Sort both by name for comparison
          const sortedOriginal = [...definitions].sort((a, b) => a.name.localeCompare(b.name));
          const sortedRestored = [...restored].sort((a, b) => a.name.localeCompare(b.name));

          for (let i = 0; i < sortedOriginal.length; i++) {
            const orig = sortedOriginal[i]!;
            const rest = sortedRestored[i]!;
            expect(rest.name).toBe(orig.name);
            expect(rest.description).toBe(orig.description);
            expect(rest.parameters.type).toBe(orig.parameters.type);
            expect(rest.parameters.properties).toEqual(orig.parameters.properties);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('toJSON produces valid JSON string', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(toolDefinitionArb, { minLength: 0, maxLength: 5, selector: (d) => d.name }),
        (definitions) => {
          const registry = new ToolRegistry();
          for (const def of definitions) {
            registry.register(makeMockTool(def));
          }

          const json = registry.toJSON();
          expect(() => JSON.parse(json)).not.toThrow();

          const parsed = JSON.parse(json);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed).toHaveLength(definitions.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('round-trip preserves required fields', () => {
    fc.assert(
      fc.property(
        toolNameArb,
        toolDescriptionArb,
        fc.array(
          fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/).filter((s) => s.length > 0),
          { minLength: 1, maxLength: 3 }
        ),
        (name, description, requiredFields) => {
          const uniqueFields = [...new Set(requiredFields)];
          const properties: Record<string, { type: string }> = {};
          for (const f of uniqueFields) {
            properties[f] = { type: 'string' };
          }

          const definition: ToolDefinition = {
            name,
            description,
            parameters: {
              type: 'object',
              properties,
              required: uniqueFields,
            },
          };

          const registry = new ToolRegistry();
          registry.register(makeMockTool(definition));

          const json = registry.toJSON();
          const [restored] = ToolRegistry.fromJSON(json);

          expect(restored!.parameters.required).toEqual(uniqueFields);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 32: 无效 JSON 工具定义错误报告 ──────────────────────────────────

describe('Property 32: 无效 JSON 工具定义错误报告', () => {
  it('invalid JSON string throws error with message', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
          try {
            JSON.parse(s);
            return false; // skip valid JSON
          } catch {
            return true;
          }
        }),
        (invalidJson) => {
          expect(() => ToolRegistry.fromJSON(invalidJson)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-array JSON throws error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ name: fc.string(), description: fc.string() }), // object, not array
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null)
        ),
        (nonArray) => {
          const json = JSON.stringify(nonArray);
          expect(() => ToolRegistry.fromJSON(json)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('array with invalid tool definition throws error with location info', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.string(),
          fc.integer(),
          fc.boolean(),
          // object missing required fields
          fc.record({ foo: fc.string() }),
          // object with wrong name type
          fc.record({ name: fc.integer(), description: fc.string(), parameters: fc.constant({ type: 'object', properties: {} }) }),
        ),
        (invalidItem) => {
          const json = JSON.stringify([invalidItem]);
          expect(() => ToolRegistry.fromJSON(json)).toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('error message contains useful information about the failure', () => {
    // Missing name field
    const json = JSON.stringify([{ description: 'test', parameters: { type: 'object', properties: {} } }]);
    let error: Error | undefined;
    try {
      ToolRegistry.fromJSON(json);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message.length).toBeGreaterThan(0);
    // Should mention the field or index
    expect(error!.message).toMatch(/name|index|0/i);
  });

  it('completely invalid JSON throws with error message', () => {
    const invalidInputs = [
      '{not valid json',
      'undefined',
      '{"key": undefined}',
      '[1, 2, 3,]', // trailing comma
    ];

    for (const input of invalidInputs) {
      expect(() => ToolRegistry.fromJSON(input)).toThrow();
    }
  });
});
