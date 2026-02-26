import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SchemaConverter } from '../../../src/mcp/schema-converter.js';
import type { MCPToolDefinition } from '../../../src/mcp/types.js';

// Validates: Requirements 3.2, 3.3, 3.6

describe('SchemaConverter.toToolDefinition', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Namespace ────────────────────────────────────────────────────────────

  it('prefixes name with serverName when useNamespace=true', () => {
    const tool: MCPToolDefinition = { name: 'read_file', description: 'Reads a file' };
    const def = SchemaConverter.toToolDefinition('filesystem', tool, true);
    expect(def.name).toBe('filesystem__read_file');
  });

  it('uses bare toolName when useNamespace=false', () => {
    const tool: MCPToolDefinition = { name: 'read_file', description: 'Reads a file' };
    const def = SchemaConverter.toToolDefinition('filesystem', tool, false);
    expect(def.name).toBe('read_file');
  });

  it('namespace separator is double underscore', () => {
    const tool: MCPToolDefinition = { name: 'search', description: 'Search' };
    const def = SchemaConverter.toToolDefinition('search-api', tool, true);
    expect(def.name).toBe('search-api__search');
  });

  // ── Missing type field auto-completion ───────────────────────────────────

  it('auto-completes type to "object" when inputSchema has no type field', () => {
    const tool: MCPToolDefinition = {
      name: 'my_tool',
      inputSchema: { properties: { foo: { type: 'string' } } },
    };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.parameters.type).toBe('object');
  });

  it('logs a warning when inputSchema is missing type field', () => {
    const tool: MCPToolDefinition = {
      name: 'my_tool',
      inputSchema: { properties: {} },
    };
    SchemaConverter.toToolDefinition('srv', tool, false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('my_tool'));
  });

  it('does not log a warning when inputSchema already has type:"object"', () => {
    const tool: MCPToolDefinition = {
      name: 'my_tool',
      inputSchema: { type: 'object', properties: {} },
    };
    SchemaConverter.toToolDefinition('srv', tool, false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('auto-completes type when inputSchema is an empty object (no type key)', () => {
    const tool: MCPToolDefinition = { name: 'empty_schema', inputSchema: {} };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.parameters.type).toBe('object');
    expect(console.warn).toHaveBeenCalled();
  });

  // ── Full inputSchema conversion ──────────────────────────────────────────

  it('preserves properties from inputSchema', () => {
    const tool: MCPToolDefinition = {
      name: 'create_file',
      description: 'Creates a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path'],
      },
    };
    const def = SchemaConverter.toToolDefinition('fs', tool, true);

    expect(def.parameters.properties).toEqual({
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' },
    });
  });

  it('preserves required array from inputSchema', () => {
    const tool: MCPToolDefinition = {
      name: 'create_file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    };
    const def = SchemaConverter.toToolDefinition('fs', tool, true);
    expect(def.parameters.required).toEqual(['path']);
  });

  it('sets description from mcpTool.description', () => {
    const tool: MCPToolDefinition = {
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: { type: 'object', properties: {} },
    };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.description).toBe('Does something useful');
  });

  it('defaults description to empty string when not provided', () => {
    const tool: MCPToolDefinition = { name: 'no_desc' };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.description).toBe('');
  });

  // ── No inputSchema (undefined) ───────────────────────────────────────────

  it('returns empty properties when inputSchema is undefined', () => {
    const tool: MCPToolDefinition = { name: 'no_schema' };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.parameters.properties).toEqual({});
  });

  it('sets parameters.type to "object" when inputSchema is undefined', () => {
    const tool: MCPToolDefinition = { name: 'no_schema' };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.parameters.type).toBe('object');
  });

  it('required is undefined when inputSchema has no required field', () => {
    const tool: MCPToolDefinition = {
      name: 'no_required',
      inputSchema: { type: 'object', properties: {} },
    };
    const def = SchemaConverter.toToolDefinition('srv', tool, false);
    expect(def.parameters.required).toBeUndefined();
  });
});
