import type { Tool, ToolDefinition, ToolResult } from '../types/tools.js';
import type { MCPClient } from './transport.js';

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

function sleep(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new TimeoutError()), ms),
  );
}

export class MCPBridgeTool implements Tool {
  constructor(
    private readonly client: MCPClient,
    private readonly mcpToolName: string,
    public readonly definition: ToolDefinition,
    private readonly timeoutMs: number,
  ) {}

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.client.status === 'disconnected') {
      return {
        toolCallId: '',
        content: `MCP server '${this.client.serverName}' 当前不可用`,
        isError: true,
      };
    }

    const startTime = Date.now();
    try {
      const result = await Promise.race([
        this.client.callTool(this.mcpToolName, args),
        sleep(this.timeoutMs),
      ]);

      const elapsed = Date.now() - startTime;
      console.debug(`[MCP] ${this.mcpToolName} 完成，耗时 ${elapsed}ms`);

      const content = result.content.map((c) => c.text ?? '').join('\n');
      return {
        toolCallId: '',
        content,
        isError: result.isError ?? false,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (err instanceof TimeoutError) {
        console.warn(`[MCP] ${this.mcpToolName} 超时（${elapsed}ms）`);
        return {
          toolCallId: '',
          content: `工具 '${this.mcpToolName}' 调用超时（${this.timeoutMs}ms）`,
          isError: true,
        };
      }
      throw err;
    }
  }
}
