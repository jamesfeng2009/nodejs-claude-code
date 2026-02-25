import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';

export function createFileWriteTool(workDir: string): Tool {
  return {
    definition: {
      name: 'file_write',
      description: 'Write content to a file, creating it or overwriting if it exists',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to write (relative to working directory)',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const filePath = args['path'] as string;
      const content = args['content'] as string;
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
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content, 'utf-8');
        return {
          toolCallId: '',
          content: `${warning}Successfully wrote ${content.length} bytes to '${filePath}'`,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Failed to write file '${filePath}': ${message}`,
          isError: true,
        };
      }
    },
  };
}
