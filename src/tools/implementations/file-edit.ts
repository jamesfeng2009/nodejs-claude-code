import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';
import type { LintRunner } from './lint-runner.js';
import type { ContextManager } from '../../context/context-manager.js';
import type { TransactionManager } from './transaction-manager.js';

export function createFileEditTool(workDir: string, lintRunner?: LintRunner, contextManager?: ContextManager, transactionManager?: TransactionManager): Tool {
  return {
    definition: {
      name: 'file_edit',
      description: 'Find and replace text in a file, or insert lines at a specific position',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file path to edit (relative to working directory)',
          },
          old_text: {
            type: 'string',
            description: 'The text to find and replace (required for replace operation)',
          },
          new_text: {
            type: 'string',
            description: 'The replacement text (required for replace operation)',
          },
          replace_all: {
            type: 'boolean',
            description: 'Replace all occurrences (default: false, replaces only the first)',
          },
          operation: {
            type: 'string',
            enum: ['replace', 'insert'],
            description: 'Operation type: replace (default) or insert',
          },
          line: {
            type: 'integer',
            description: 'Target line number (1-based), required for insert operation',
          },
          insert_position: {
            type: 'string',
            enum: ['before', 'after'],
            description: 'Insert position: before or after the target line',
          },
          content: {
            type: 'string',
            description: 'Content to insert, required for insert operation',
          },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const filePath = args['path'] as string;
      const operation = (args['operation'] as string | undefined) ?? 'replace';
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

      // Handle insert operation
      if (operation === 'insert') {
        const lineParam = args['line'];
        const insertPosition = args['insert_position'] as string | undefined;
        const content = args['content'] as string | undefined;

        if (lineParam === undefined || lineParam === null) {
          return { toolCallId: '', content: 'line parameter is required for insert operation', isError: true };
        }

        const K = Number(lineParam);

        if (!Number.isInteger(K) || K < 1) {
          return { toolCallId: '', content: 'line must be a positive integer', isError: true };
        }

        if (!insertPosition || (insertPosition !== 'before' && insertPosition !== 'after')) {
          return { toolCallId: '', content: `insert_position must be 'before' or 'after'`, isError: true };
        }

        if (content === undefined || content === '') {
          return { toolCallId: '', content: 'insert content must not be empty', isError: true };
        }

        try {
          const original = readFileSync(absPath, 'utf-8');
          const lines = original.split('\n');
          const N = lines.length;

          if (K > N) {
            return { toolCallId: '', content: `line ${K} exceeds file length ${N}`, isError: true };
          }

          const insertedLines = content.split('\n');
          const M = insertedLines.length;

          let result: string[];
          let startLine: number; // 1-based position of first inserted line in result

          if (insertPosition === 'after') {
            result = [...lines.slice(0, K), ...insertedLines, ...lines.slice(K)];
            startLine = K + 1;
          } else {
            result = [...lines.slice(0, K - 1), ...insertedLines, ...lines.slice(K - 1)];
            startLine = K;
          }

          const newContent = result.join('\n');
          if (transactionManager) {
            const txId = transactionManager.getActiveTransactionId();
            if (txId) {
              await transactionManager.writeFile(txId, absPath, newContent);
            } else {
              writeFileSync(absPath, newContent, 'utf-8');
            }
          } else {
            writeFileSync(absPath, newContent, 'utf-8');
          }

          let lintOutput = '';
          if (lintRunner) {
            const lintResults = await lintRunner.runOnFile(absPath);
            lintOutput = lintRunner.formatResults(lintResults);
          }

          if (contextManager) {
            await contextManager.invalidateAndReindex(absPath);
          }

          const endLine = startLine + M - 1;
          const lineRange = M === 1 ? `${startLine}` : `${startLine}..${endLine}`;
          return {
            toolCallId: '',
            content: `${warning}Successfully inserted ${M} line(s) at line ${lineRange} in '${filePath}'${lintOutput}`,
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { toolCallId: '', content: `Failed to edit file '${filePath}': ${message}`, isError: true };
        }
      }

      // Handle replace operation (default)
      const oldText = args['old_text'] as string;
      const newText = args['new_text'] as string;
      const replaceAll = (args['replace_all'] as boolean | undefined) ?? false;

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

        if (transactionManager) {
          const txId = transactionManager.getActiveTransactionId();
          if (txId) {
            await transactionManager.writeFile(txId, absPath, updated);
          } else {
            writeFileSync(absPath, updated, 'utf-8');
          }
        } else {
          writeFileSync(absPath, updated, 'utf-8');
        }

        let lintOutput = '';
        if (lintRunner) {
          const lintResults = await lintRunner.runOnFile(absPath);
          lintOutput = lintRunner.formatResults(lintResults);
        }

        if (contextManager) {
          await contextManager.invalidateAndReindex(absPath);
        }

        return {
          toolCallId: '',
          content: `${warning}Successfully edited '${filePath}' (${count} replacement${count !== 1 ? 's' : ''})${lintOutput}`,
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
