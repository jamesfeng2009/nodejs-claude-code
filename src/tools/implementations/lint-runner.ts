import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export interface LintDiagnostic {
  filePath: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule?: string;
}

export interface LintResult {
  tool: 'eslint' | 'tsc';
  diagnostics: LintDiagnostic[];
  /** lint command execution error message */
  executionError?: string;
  /** whether the command timed out */
  timedOut?: boolean;
}

const ESLINT_CONFIG_FILES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
];

const TIMEOUT_MS = 30_000;

export class LintRunner {
  private cachedTools: Array<'eslint' | 'tsc'> | null = null;

  constructor(private readonly projectRoot: string) {}

  async detectTools(): Promise<Array<'eslint' | 'tsc'>> {
    if (this.cachedTools !== null) {
      return this.cachedTools;
    }

    const tools: Array<'eslint' | 'tsc'> = [];

    // Check for ESLint config files
    for (const configFile of ESLINT_CONFIG_FILES) {
      try {
        await fs.access(path.join(this.projectRoot, configFile));
        tools.push('eslint');
        break;
      } catch {
        // file doesn't exist, continue
      }
    }

    // Check for tsconfig.json
    try {
      await fs.access(path.join(this.projectRoot, 'tsconfig.json'));
      tools.push('tsc');
    } catch {
      // tsconfig.json doesn't exist
    }

    this.cachedTools = tools;
    return tools;
  }

  async runOnFile(absoluteFilePath: string): Promise<LintResult[]> {
    const tools = await this.detectTools();
    const results: LintResult[] = [];

    for (const tool of tools) {
      if (tool === 'eslint') {
        results.push(await this._runEslint(absoluteFilePath));
      } else if (tool === 'tsc') {
        results.push(await this._runTsc());
      }
    }

    return results;
  }

  formatResults(results: LintResult[]): string {
    const header = '\n\n--- Lint Results ---\n';

    if (results.length === 0) {
      return header + 'No lint issues found.';
    }

    const lines: string[] = [];
    let hasAnyDiagnostics = false;

    for (const result of results) {
      if (result.timedOut) {
        lines.push('Lint timed out after 30s');
        continue;
      }

      if (result.executionError) {
        lines.push(`Lint command could not be run: ${result.executionError}`);
        continue;
      }

      for (const diag of result.diagnostics) {
        hasAnyDiagnostics = true;
        const rule = diag.rule ? ` (${diag.rule})` : '';
        lines.push(`[${diag.severity}] ${diag.filePath}:${diag.line} — ${diag.message}${rule}`);
      }
    }

    if (!hasAnyDiagnostics && lines.length === 0) {
      return header + 'No lint issues found.';
    }

    if (!hasAnyDiagnostics && lines.every(l => l.startsWith('Lint'))) {
      // Only notices, no actual diagnostics
      return header + lines.join('\n');
    }

    return header + (lines.length > 0 ? lines.join('\n') : 'No lint issues found.');
  }

  private _runEslint(filePath: string): Promise<LintResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('npx', ['eslint', '--format', 'json', filePath], {
          cwd: this.projectRoot,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({ tool: 'eslint', diagnostics: [], executionError: message });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, TIMEOUT_MS);

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({
          tool: 'eslint',
          diagnostics: [],
          executionError: isEnoent ? err.message : err.message,
        });
      });

      proc.on('close', () => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({ tool: 'eslint', diagnostics: [], timedOut: true });
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          resolve({ tool: 'eslint', diagnostics: [] });
          return;
        }

        try {
          const parsed = JSON.parse(raw) as Array<{
            filePath: string;
            messages: Array<{
              line: number;
              severity: number;
              message: string;
              ruleId?: string | null;
            }>;
          }>;

          const diagnostics: LintDiagnostic[] = [];
          for (const fileResult of parsed) {
            for (const msg of fileResult.messages) {
              diagnostics.push({
                filePath: fileResult.filePath,
                line: msg.line ?? 0,
                severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
                message: msg.message,
                rule: msg.ruleId ?? undefined,
              });
            }
          }

          resolve({ tool: 'eslint', diagnostics });
        } catch {
          resolve({
            tool: 'eslint',
            diagnostics: [],
            executionError: `JSON parse failed. Raw output:\n${raw}${stderr ? '\nstderr:\n' + stderr : ''}`,
          });
        }
      });
    });
  }

  private _runTsc(): Promise<LintResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
          cwd: this.projectRoot,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({ tool: 'tsc', diagnostics: [], executionError: message });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, TIMEOUT_MS);

      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          tool: 'tsc',
          diagnostics: [],
          executionError: err.message,
        });
      });

      proc.on('close', () => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({ tool: 'tsc', diagnostics: [], timedOut: true });
          return;
        }

        const output = (stdout + stderr).trim();
        if (!output) {
          resolve({ tool: 'tsc', diagnostics: [] });
          return;
        }

        const diagnostics = this._parseTscOutput(output);
        resolve({ tool: 'tsc', diagnostics });
      });
    });
  }

  /**
   * Parse tsc --noEmit --pretty false output.
   * Format: `<file>(<line>,<col>): error|warning TS<code>: <message>`
   */
  private _parseTscOutput(output: string): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    // e.g. src/foo.ts(10,5): error TS2345: Argument of type ...
    const lineRegex = /^(.+)\((\d+),\d+\):\s+(error|warning|info)\s+TS\d+:\s+(.+)$/;

    for (const line of output.split('\n')) {
      const match = lineRegex.exec(line.trim());
      if (match && match[1] && match[2] && match[3] && match[4]) {
        diagnostics.push({
          filePath: match[1].trim(),
          line: parseInt(match[2], 10),
          severity: match[3] as 'error' | 'warning' | 'info',
          message: match[4].trim(),
        });
      }
    }

    return diagnostics;
  }
}
