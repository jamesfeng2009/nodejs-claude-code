import { readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isWithinWorkDir } from './security.js';

interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

/** Directories that are always skipped during traversal (P1-7 fix). */
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function listDir(absDir: string, workDir: string, depth: number, maxDepth: number): string[] {
  const lines: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(absDir).sort();
  } catch {
    return lines;
  }

  for (const entry of entries) {
    if (ALWAYS_SKIP_DIRS.has(entry)) continue; // hard-deny noisy dirs (P1-7 fix)
    const fullPath = join(absDir, entry);
    const relPath = relative(workDir, fullPath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    const indent = '  '.repeat(depth);
    if (stat.isDirectory()) {
      lines.push(`${indent}${entry}/`);
      if (depth < maxDepth) {
        lines.push(...listDir(fullPath, workDir, depth + 1, maxDepth));
      }
    } else {
      lines.push(`${indent}${entry} (${stat.size} bytes)`);
    }
  }

  return lines;
}

export function createListDirectoryTool(workDir: string): Tool {
  return {
    definition: {
      name: 'list_directory',
      description: 'List files and subdirectories in a directory',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory path to list (relative to working directory, defaults to ".")',
          },
          depth: {
            type: 'number',
            description: 'Maximum depth to recurse (default: 1, 0 = flat list)',
          },
        },
        required: [],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const dirPath = (args['path'] as string | undefined) ?? '.';
      const maxDepth = (args['depth'] as number | undefined) ?? 1;
      const absDir = resolve(workDir, dirPath);

      if (!isWithinWorkDir(absDir, workDir)) {
        return {
          toolCallId: '',
          content: `Permission denied: path '${dirPath}' is outside the working directory`,
          isError: true,
        };
      }

      try {
        const stat = statSync(absDir);
        if (!stat.isDirectory()) {
          return {
            toolCallId: '',
            content: `'${dirPath}' is not a directory`,
            isError: true,
          };
        }

        const lines = listDir(absDir, workDir, 0, maxDepth);

        if (lines.length === 0) {
          return {
            toolCallId: '',
            content: `Directory '${dirPath}' is empty`,
            isError: false,
          };
        }

        return {
          toolCallId: '',
          content: lines.join('\n'),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Failed to list directory '${dirPath}': ${message}`,
          isError: true,
        };
      }
    },
  };
}
