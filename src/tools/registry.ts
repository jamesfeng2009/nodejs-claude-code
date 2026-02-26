import { readFileSync } from 'fs';
import type { Tool, ToolCall, ToolResult, ToolDefinition } from '../types/tools.js';
import { AppError, ErrorCode } from '../types/errors.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        content: `Tool not found: ${toolCall.name}`,
        isError: true,
      };
    }

    const validation = this.validateArgs(toolCall.name, toolCall.arguments);
    if (!validation.valid) {
      return {
        toolCallId: toolCall.id,
        content: `Argument validation failed: ${validation.errors.join('; ')}`,
        isError: true,
      };
    }

    try {
      const result = await tool.execute(toolCall.arguments);
      return { ...result, toolCallId: toolCall.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: toolCall.id,
        content: `Tool execution error: ${message}`,
        isError: true,
      };
    }
  }

  validateArgs(name: string, args: unknown): ValidationResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return { valid: false, errors: [`Tool not found: ${name}`] };
    }

    const schema = tool.definition.parameters;
    const errors: string[] = [];

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { valid: false, errors: ['Arguments must be an object'] };
    }

    const argsObj = args as Record<string, unknown>;

    // Reject unknown top-level keys — the top-level parameters schema should
    // only contain declared properties (P1-6 fix).
    if (schema.properties) {
      for (const key of Object.keys(argsObj)) {
        if (!(key in schema.properties)) {
          errors.push(`Unknown argument: ${key}`);
        }
      }
    }

    validateObject(argsObj, schema.properties, schema.required, '', errors);

    return { valid: errors.length === 0, errors };
  }

  toJSON(): string {
    const definitions: ToolDefinition[] = Array.from(this.tools.values()).map(
      (t) => t.definition
    );
    return JSON.stringify(definitions, null, 2);
  }

  static fromJSON(json: string): ToolDefinition[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `Invalid JSON: ${message}`,
        { json }
      );
    }

    if (!Array.isArray(parsed)) {
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        'Tool definitions JSON must be an array',
        { parsed }
      );
    }

    const definitions: ToolDefinition[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      const def = validateToolDefinition(item, i);
      definitions.push(def);
    }
    return definitions;
  }

  loadFromFile(filePath: string): void {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(
        ErrorCode.TOOL_VALIDATION_ERROR,
        `Failed to read tool definition file: ${message}`,
        { filePath }
      );
    }

    const definitions = ToolRegistry.fromJSON(content);
    for (const def of definitions) {
      // Register as stub tools (definition only, no execute)
      this.tools.set(def.name, {
        definition: def,
        execute: async () => ({
          toolCallId: '',
          content: `Tool ${def.name} loaded from file but has no implementation`,
          isError: true,
        }),
      });
    }
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }
}

function validateObject(
  obj: Record<string, unknown>,
  properties: Record<string, import('../types/tools.js').JSONSchemaProperty>,
  required: string[] | undefined,
  prefix: string,
  errors: string[],
): void {
  const path = (key: string) => (prefix ? `${prefix}.${key}` : key);

  // Check required fields
  if (required) {
    for (const req of required) {
      if (!(req in obj)) {
        errors.push(`Missing required argument: ${path(req)}`);
      }
    }
  }

  // Validate each provided property
  for (const [key, value] of Object.entries(obj)) {
    const propSchema = properties[key];
    if (!propSchema) {
      // additionalProperties is not defined on the top-level parameters schema,
      // but individual nested object schemas may set it to false.
      continue;
    }
    validateValue(value, propSchema, path(key), errors);
  }
}

function validateValue(
  value: unknown,
  schema: import('../types/tools.js').JSONSchemaProperty,
  path: string,
  errors: string[],
): void {
  // Type check
  const typeError = validateType(value, schema.type, path);
  if (typeError) {
    errors.push(typeError);
    return; // No point doing deeper checks if the type is wrong
  }

  // Enum check
  if (schema.enum && schema.enum.length > 0) {
    if (!schema.enum.includes(value as string)) {
      errors.push(`Argument '${path}' must be one of: ${schema.enum.join(', ')}`);
    }
  }

  // Nested object validation
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const nested = value as Record<string, unknown>;

    // additionalProperties: false — reject unknown keys
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(nested)) {
        if (!(key in schema.properties)) {
          errors.push(`Argument '${path}' has unexpected property: ${key}`);
        }
      }
    }

    if (schema.properties) {
      validateObject(nested, schema.properties, schema.required, path, errors);
    }
  }

  // Array item validation
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

function validateType(value: unknown, type: string, key: string): string | null {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') return `Argument '${key}' must be a string`;
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number') return `Argument '${key}' must be a number`;
      if (type === 'integer' && !Number.isInteger(value))
        return `Argument '${key}' must be an integer`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `Argument '${key}' must be a boolean`;
      break;
    case 'array':
      if (!Array.isArray(value)) return `Argument '${key}' must be an array`;
      break;
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return `Argument '${key}' must be an object`;
      break;
  }
  return null;
}

function validateToolDefinition(item: unknown, index: number): ToolDefinition {
  if (typeof item !== 'object' || item === null) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index} must be an object`,
      { index, item }
    );
  }

  const obj = item as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || !obj['name']) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index} missing required field 'name' (must be non-empty string)`,
      { index, field: 'name' }
    );
  }

  if (typeof obj['description'] !== 'string') {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index} missing required field 'description' (must be string)`,
      { index, field: 'description' }
    );
  }

  if (typeof obj['parameters'] !== 'object' || obj['parameters'] === null) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index} missing required field 'parameters' (must be object)`,
      { index, field: 'parameters' }
    );
  }

  const params = obj['parameters'] as Record<string, unknown>;
  if (params['type'] !== 'object') {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index}: parameters.type must be 'object'`,
      { index, field: 'parameters.type' }
    );
  }

  if (typeof params['properties'] !== 'object' || params['properties'] === null) {
    throw new AppError(
      ErrorCode.TOOL_VALIDATION_ERROR,
      `Tool definition at index ${index}: parameters.properties must be an object`,
      { index, field: 'parameters.properties' }
    );
  }

  return {
    name: obj['name'] as string,
    description: obj['description'] as string,
    parameters: {
      type: 'object',
      properties: params['properties'] as Record<string, import('../types/tools.js').JSONSchemaProperty>,
      required: Array.isArray(params['required']) ? (params['required'] as string[]) : undefined,
    },
  };
}
