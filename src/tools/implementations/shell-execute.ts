import { execSync } from 'child_process';
import type { Tool, ToolResult } from '../../types/tools.js';

export interface ShellConfirmFn {
  (command: string): Promise<boolean>;
}

/**
 * Default confirmation function - auto-confirms (for non-interactive use).
 * In CLI mode, this should be replaced with a real user prompt.
 */
const autoConfirm: ShellConfirmFn = async () => true;

export function createShellExecuteTool(
  workDir: string,
  confirm: ShellConfirmFn = autoConfirm
): Tool {
  return {
    definition: {
      name: 'shell_execute',
      description: 'Execute a shell command and return stdout and stderr. Requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          timeout_ms: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 30000)',
          },
        },
        required: ['command'],
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const command = args['command'] as string;
      const timeoutMs = (args['timeout_ms'] as number | undefined) ?? 30000;

      const confirmed = await confirm(command);
      if (!confirmed) {
        return {
          toolCallId: '',
          content: `Command execution cancelled by user: ${command}`,
          isError: false,
        };
      }

      try {
        const output = execSync(command, {
          cwd: workDir,
          timeout: timeoutMs,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return {
          toolCallId: '',
          content: output || '(no output)',
          isError: false,
        };
      } catch (err) {
        if (err && typeof err === 'object' && 'stdout' in err && 'stderr' in err) {
          const execErr = err as { stdout: string; stderr: string; message: string };
          const output = [
            execErr.stdout ? `stdout:\n${execErr.stdout}` : '',
            execErr.stderr ? `stderr:\n${execErr.stderr}` : '',
            `error: ${execErr.message}`,
          ]
            .filter(Boolean)
            .join('\n');
          return {
            toolCallId: '',
            content: output,
            isError: true,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolCallId: '',
          content: `Command failed: ${message}`,
          isError: true,
        };
      }
    },
  };
}
