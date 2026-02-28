import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';

const LARGE_FILE_THRESHOLD = 500;

/**
 * Apply line range slicing and add line-number prefixes.
 * Returns the sliced lines with prefixes, or an error string.
 */
function applyLineRange(
  lines: string[],
  startLine?: number,
  endLine?: number,
): { sliced: string[]; effectiveStart: number } | { error: string } {
  const N = lines.length;
  const s = startLine ?? 1;
  const e = endLine ?? N;

  if (startLine !== undefined && startLine < 1) {
    return { error: 'start_line must be a positive integer' };
  }
  if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
    return { error: 'end_line must be >= start_line' };
  }
  if (endLine !== undefined && startLine === undefined && endLine < 1) {
    return { error: 'end_line must be >= start_line' };
  }
  if (startLine !== undefined && startLine > N) {
    return { error: `start_line ${startLine} exceeds file length ${N}` };
  }

  const effectiveEnd = Math.min(e, N);
  const sliced = lines.slice(s - 1, effectiveEnd);
  return { sliced, effectiveStart: s };
}

function addLinePrefix(lines: string[], startLine: number, totalLines: number): string[] {
  const width = String(totalLines).length;
  return lines.map((line, i) => {
    const lineNum = String(startLine + i).padStart(width, ' ');
    return `${lineNum} | ${line}`;
  });
}

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
          start_line: {
            type: 'integer',
            description: 'The 1-based line number to start reading from (inclusive)',
          },
          end_line: {
            type: 'integer',
            description: 'The 1-based line number to stop reading at (inclusive)',
          },
        },
        required: ['path'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const filePath = args['path'] as string;
      const startLine = args['start_line'] !== undefined ? (args['start_line'] as number) : undefined;
      const endLine = args['end_line'] !== undefined ? (args['end_line'] as number) : undefined;
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
        const raw = readFileSync(absPath, 'utf-8');
        const hasRange = startLine !== undefined || endLine !== undefined;

        if (!hasRange) {
          // No range — return full content, with large-file notice if needed
          const lines = raw.split('\n');
          const N = lines.length;
          let prefix = warning;
          if (N > LARGE_FILE_THRESHOLD) {
            prefix += `Notice: This file has ${N} lines. Consider using start_line/end_line parameters to read specific sections.\n`;
          }
          return {
            toolCallId: '',
            content: prefix + raw,
            isError: false,
          };
        }

        // Range mode
        const lines = raw.split('\n');
        const result = applyLineRange(lines, startLine, endLine);

        if ('error' in result) {
          return {
            toolCallId: '',
            content: result.error,
            isError: true,
          };
        }

        const { sliced, effectiveStart } = result;
        const prefixed = addLinePrefix(sliced, effectiveStart, lines.length);
        return {
          toolCallId: '',
          content: warning + prefixed.join('\n'),
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
