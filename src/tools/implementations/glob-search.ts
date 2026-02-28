import { readdirSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import { minimatch } from 'minimatch';
import type { Tool, ToolResult } from '../../types/tools.js';

const NOISE_DIRS = ['node_modules', '.git', 'dist', 'build'];
const MAX_RESULTS = 200;

function collectFiles(dir: string, workDir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (!NOISE_DIRS.includes(entry)) {
          walk(fullPath);
        }
      } else if (stat.isFile()) {
        results.push(relative(workDir, fullPath));
      }
    }
  }

  walk(dir);
  return results;
}

export function createGlobSearchTool(workDir: string): Tool {
  return {
    definition: {
      name: 'glob_search',
      description: 'Search for files matching a glob pattern within the working directory',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match files against (e.g. "**/*.ts")',
          },
          exclude: {
            type: 'string',
            description: 'Optional glob pattern to exclude from results',
          },
        },
        required: ['pattern'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const pattern = args['pattern'] as string;
      const exclude = args['exclude'] as string | undefined;

      if (!pattern || pattern.trim() === '') {
        return {
          toolCallId: '',
          content: 'pattern must not be empty',
          isError: true,
        };
      }

      const absWorkDir = resolve(workDir);
      const allFiles = collectFiles(absWorkDir, absWorkDir);

      const matched = allFiles.filter((filePath) => {
        if (!minimatch(filePath, pattern, { dot: true })) return false;
        if (exclude && minimatch(filePath, exclude, { dot: true })) return false;
        return true;
      });

      matched.sort();

      if (matched.length === 0) {
        return {
          toolCallId: '',
          content: `No files found matching pattern '${pattern}'`,
          isError: false,
        };
      }

      const total = matched.length;
      const truncated = matched.length > MAX_RESULTS;
      const results = truncated ? matched.slice(0, MAX_RESULTS) : matched;

      let content = results.join('\n');
      if (truncated) {
        content += `\nResults truncated. Found ${total} total matches, showing first ${MAX_RESULTS}.`;
      }

      return {
        toolCallId: '',
        content,
        isError: false,
      };
    },
  };
}
