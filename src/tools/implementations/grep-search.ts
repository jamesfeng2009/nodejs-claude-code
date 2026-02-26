import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join, relative } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isWithinWorkDir } from './security.js';

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

/** Directories that are always skipped during traversal (P1-7 fix). */
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

function searchDirectory(
  dir: string,
  pattern: RegExp,
  workDir: string,
  maxResults: number
): SearchMatch[] {
  const matches: SearchMatch[] = [];

  function walk(currentDir: string): void {
    if (matches.length >= maxResults) return;

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.startsWith('.')) continue; // skip hidden files/dirs
      if (ALWAYS_SKIP_DIRS.has(entry)) continue; // hard-deny noisy dirs

      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            const line = lines[i]!;
            if (pattern.test(line)) {
              matches.push({
                file: relative(workDir, fullPath),
                line: i + 1,
                content: line,
              });
            }
          }
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }

  walk(dir);
  return matches;
}

export function createGrepSearchTool(workDir: string): Tool {
  return {
    definition: {
      name: 'grep_search',
      description: 'Search for a regex pattern in files within a directory',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The regex pattern to search for',
          },
          directory: {
            type: 'string',
            description: 'The directory to search in (relative to working directory, defaults to ".")',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results to return (default: 100)',
          },
        },
        required: ['pattern'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const pattern = args['pattern'] as string;
      const directory = (args['directory'] as string | undefined) ?? '.';
      const maxResults = (args['max_results'] as number | undefined) ?? 100;

      const absDir = resolve(workDir, directory);

      if (!isWithinWorkDir(absDir, workDir)) {
        return {
          toolCallId: '',
          content: `Permission denied: directory '${directory}' is outside the working directory`,
          isError: true,
        };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Invalid regex pattern '${pattern}': ${message}`,
          isError: true,
        };
      }

      try {
        const matches = searchDirectory(absDir, regex, workDir, maxResults);

        if (matches.length === 0) {
          return {
            toolCallId: '',
            content: `No matches found for pattern '${pattern}' in '${directory}'`,
            isError: false,
          };
        }

        const output = matches
          .map((m) => `${m.file}:${m.line}: ${m.content}`)
          .join('\n');

        const truncated = matches.length >= maxResults ? `\n(results truncated at ${maxResults})` : '';

        return {
          toolCallId: '',
          content: output + truncated,
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Search failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}
