import { MCPToolDefinition } from './types';
import { ToolDefinition } from '../types/tools';

export class SchemaConverter {
  static toToolDefinition(
    serverName: string,
    mcpTool: MCPToolDefinition,
    useNamespace: boolean,
  ): ToolDefinition {
    const toolName = useNamespace ? `${serverName}__${mcpTool.name}` : mcpTool.name;

    let schema = mcpTool.inputSchema ?? {};
    if (schema.type !== 'object') {
      console.warn(`[MCP] ${mcpTool.name}: inputSchema 缺少 type:'object'，自动补全`);
      schema = { ...schema, type: 'object' };
    }

    return {
      name: toolName,
      description: mcpTool.description ?? '',
      parameters: {
        type: 'object',
        properties: (schema.properties ?? {}) as Record<string, never>,
        required: schema.required,
      },
    };
  }
}
