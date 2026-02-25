import { readFileSync } from 'fs';
import { resolve, relative } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';

export function createFileReadTool(workDir: string): Tool {
  return {
    definition: {
      name: 'file_read',
      description: 'Read the contents of a file at the specified path',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to read (relative to working directory)',
          },
        },
        required: ['path'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const filePath = args['path'] as string;
      const absPath = resolve(workDir, filePath);

      if (!isWithinWorkDir(absPath, workDir)) {
        return {
          toolCallId: '',
          content: `Permission denied: path '${filePath}' is outside the working directory`,
          isError: true,
        };
      }

      const warning = isSensitiveFile(filePath)
        ? `Warning: '${filePath}' matches a sensitive file pattern.\n`
        : '';

      try {
        const content = readFileSync(absPath, 'utf-8');
        return {
          toolCallId: '',
          content: warning + content,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Failed to read file '${filePath}': ${message}`,
          isError: true,
        };
      }
    },
  };
}
