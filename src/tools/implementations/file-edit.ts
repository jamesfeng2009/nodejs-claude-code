import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';

export function createFileEditTool(workDir: string): Tool {
  return {
    definition: {
      name: 'file_edit',
      description: 'Find and replace text in a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to edit (relative to working directory)',
          },
          old_text: {
            type: 'string',
            description: 'The text to find and replace',
          },
          new_text: {
            type: 'string',
            description: 'The replacement text',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false, replaces only the first)',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const filePath = args['path'] as string;
      const oldText = args['old_text'] as string;
      const newText = args['new_text'] as string;
      const replaceAll = (args['replace_all'] as boolean | undefined) ?? false;
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
        const original = readFileSync(absPath, 'utf-8');

        if (!original.includes(oldText)) {
          return {
            toolCallId: '',
            content: `Text not found in '${filePath}': the specified old_text does not exist in the file`,
            isError: true,
          };
        }

        // Count occurrences so we can report how many were replaced
        let count = 0;
        let updated: string;
        if (replaceAll) {
          // Replace all occurrences using a global split/join (avoids regex escaping issues)
          const parts = original.split(oldText);
          count = parts.length - 1;
          updated = parts.join(newText);
        } else {
          updated = original.replace(oldText, () => { count = 1; return newText; });
        }

        writeFileSync(absPath, updated, 'utf-8');

        return {
          toolCallId: '',
          content: `${warning}Successfully edited '${filePath}' (${count} replacement${count !== 1 ? 's' : ''})`,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Failed to edit file '${filePath}': ${message}`,
          isError: true,
        };
      }
    },
  };
}
