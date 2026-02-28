import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { Tool, ToolResult } from '../../types/tools.js';
import { isSensitiveFile, isWithinWorkDir } from './security.js';
import type { LintRunner } from './lint-runner.js';
import type { ContextManager } from '../../context/context-manager.js';
import type { TransactionManager } from './transaction-manager.js';

export function createFileWriteTool(workDir: string, lintRunner?: LintRunner, contextManager?: ContextManager, transactionManager?: TransactionManager): Tool {
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
        if (transactionManager) {
          const txId = transactionManager.getActiveTransactionId();
          if (txId) {
            await transactionManager.writeFile(txId, absPath, content);
          } else {
            mkdirSync(dirname(absPath), { recursive: true });
            writeFileSync(absPath, content, 'utf-8');
          }
        } else {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content, 'utf-8');
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
          content: `${warning}Successfully wrote ${content.length} bytes to '${filePath}'${lintOutput}`,
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
