import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import type { LintDiagnostic, LintResult } from '../../src/tools/implementations/lint-runner.js';

// ── Spawn mock setup ──────────────────────────────────────────────────────────
// We hoist a controllable spawn factory so individual tests can configure it.

type FakeProcOptions = {
  stdoutData?: string;
  stderrData?: string;
  closeCode?: number;
  errorCode?: string;
  errorMessage?: string;
  neverClose?: boolean;
};

// Shared state for the mock — tests set this before calling runOnFile
let spawnCallCount = 0;
let spawnConfigs: FakeProcOptions[] = [];

function makeFakeProc(opts: FakeProcOptions) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => {
    setImmediate(() => proc.emit('close', null));
  });

  setImmediate(() => {
    if (opts.errorCode) {
      const err = Object.assign(new Error(opts.errorMessage ?? 'spawn error'), { code: opts.errorCode });
      proc.emit('error', err);
      return;
    }
    if (opts.stdoutData) proc.stdout.emit('data', Buffer.from(opts.stdoutData));
    if (opts.stderrData) proc.stderr.emit('data', Buffer.from(opts.stderrData));
    if (!opts.neverClose) proc.emit('close', opts.closeCode ?? 0);
  });

  return proc;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((..._args: unknown[]) => {
    const config = spawnConfigs[spawnCallCount] ?? spawnConfigs[spawnConfigs.length - 1] ?? {};
    spawnCallCount++;
    return makeFakeProc(config);
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-runner-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function touch(dir: string, filename: string): void {
  writeFileSync(join(dir, filename), '', 'utf-8');
}

// Import after mock is set up
import { LintRunner } from '../../src/tools/implementations/lint-runner.js';

// ── detectTools ───────────────────────────────────────────────────────────────

describe('LintRunner.detectTools', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  it('returns [] when no config files exist', async () => {
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toEqual([]);
  });

  it('returns ["eslint"] when .eslintrc exists', async () => {
    touch(dir, '.eslintrc');
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toContain('eslint');
    expect(tools).not.toContain('tsc');
  });

  it('returns ["eslint"] when eslint.config.js exists', async () => {
    touch(dir, 'eslint.config.js');
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toContain('eslint');
  });

  it('returns ["eslint"] when .eslintrc.json exists', async () => {
    touch(dir, '.eslintrc.json');
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toContain('eslint');
  });

  it('returns ["tsc"] when tsconfig.json exists', async () => {
    touch(dir, 'tsconfig.json');
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toContain('tsc');
    expect(tools).not.toContain('eslint');
  });

  it('returns ["eslint", "tsc"] when both .eslintrc and tsconfig.json exist', async () => {
    touch(dir, '.eslintrc');
    touch(dir, 'tsconfig.json');
    const runner = new LintRunner(dir);
    const tools = await runner.detectTools();
    expect(tools).toContain('eslint');
    expect(tools).toContain('tsc');
    expect(tools).toHaveLength(2);
  });

  it('caches the result on subsequent calls', async () => {
    touch(dir, '.eslintrc');
    const runner = new LintRunner(dir);
    const first = await runner.detectTools();
    // Remove the file after first detection
    rmSync(join(dir, '.eslintrc'));
    const second = await runner.detectTools();
    // Should still return cached result
    expect(second).toEqual(first);
  });
});

// ── formatResults ─────────────────────────────────────────────────────────────

describe('LintRunner.formatResults', () => {
  it('contains "No lint issues found" when results array is empty', () => {
    const runner = new LintRunner('/fake/root');
    const output = runner.formatResults([]);
    expect(output).toContain('No lint issues found');
  });

  it('contains "No lint issues found" when all results have empty diagnostics', () => {
    const runner = new LintRunner('/fake/root');
    const results: LintResult[] = [
      { tool: 'eslint', diagnostics: [] },
      { tool: 'tsc', diagnostics: [] },
    ];
    const output = runner.formatResults(results);
    expect(output).toContain('No lint issues found');
  });

  it('contains diagnostic filePath and message for eslint result', () => {
    const runner = new LintRunner('/fake/root');
    const diag: LintDiagnostic = {
      filePath: '/project/src/foo.ts',
      line: 10,
      severity: 'error',
      message: 'Unexpected token',
      rule: 'no-unexpected-token',
    };
    const results: LintResult[] = [{ tool: 'eslint', diagnostics: [diag] }];
    const output = runner.formatResults(results);
    expect(output).toContain('/project/src/foo.ts');
    expect(output).toContain('Unexpected token');
    expect(output).toContain('10');
  });

  it('contains diagnostic filePath and message for tsc result', () => {
    const runner = new LintRunner('/fake/root');
    const diag: LintDiagnostic = {
      filePath: 'src/bar.ts',
      line: 42,
      severity: 'error',
      message: "Type 'string' is not assignable to type 'number'",
    };
    const results: LintResult[] = [{ tool: 'tsc', diagnostics: [diag] }];
    const output = runner.formatResults(results);
    expect(output).toContain('src/bar.ts');
    expect(output).toContain("Type 'string' is not assignable to type 'number'");
    expect(output).toContain('42');
  });

  it('contains "Lint command could not be run" when executionError is set', () => {
    const runner = new LintRunner('/fake/root');
    const results: LintResult[] = [
      { tool: 'eslint', diagnostics: [], executionError: 'spawn npx ENOENT' },
    ];
    const output = runner.formatResults(results);
    expect(output).toContain('Lint command could not be run');
  });

  it('contains "Lint timed out after 30s" when timedOut is true', () => {
    const runner = new LintRunner('/fake/root');
    const results: LintResult[] = [
      { tool: 'tsc', diagnostics: [], timedOut: true },
    ];
    const output = runner.formatResults(results);
    expect(output).toContain('Lint timed out after 30s');
  });

  it('aggregates diagnostics from multiple tools', () => {
    const runner = new LintRunner('/fake/root');
    const eslintDiag: LintDiagnostic = {
      filePath: '/project/src/a.ts',
      line: 5,
      severity: 'warning',
      message: 'no-console violation',
      rule: 'no-console',
    };
    const tscDiag: LintDiagnostic = {
      filePath: '/project/src/b.ts',
      line: 20,
      severity: 'error',
      message: 'Cannot find name foo',
    };
    const results: LintResult[] = [
      { tool: 'eslint', diagnostics: [eslintDiag] },
      { tool: 'tsc', diagnostics: [tscDiag] },
    ];
    const output = runner.formatResults(results);
    expect(output).toContain('no-console violation');
    expect(output).toContain('Cannot find name foo');
    expect(output).toContain('/project/src/a.ts');
    expect(output).toContain('/project/src/b.ts');
  });

  it('includes severity in the output', () => {
    const runner = new LintRunner('/fake/root');
    const diag: LintDiagnostic = {
      filePath: '/project/src/c.ts',
      line: 1,
      severity: 'warning',
      message: 'some warning',
    };
    const results: LintResult[] = [{ tool: 'eslint', diagnostics: [diag] }];
    const output = runner.formatResults(results);
    expect(output).toContain('warning');
  });

  it('includes rule name when present', () => {
    const runner = new LintRunner('/fake/root');
    const diag: LintDiagnostic = {
      filePath: '/project/src/d.ts',
      line: 3,
      severity: 'error',
      message: 'Unexpected var',
      rule: 'no-var',
    };
    const results: LintResult[] = [{ tool: 'eslint', diagnostics: [diag] }];
    const output = runner.formatResults(results);
    expect(output).toContain('no-var');
  });
});

// ── runOnFile — spawn mocking ─────────────────────────────────────────────────

describe('LintRunner.runOnFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    spawnCallCount = 0;
    spawnConfigs = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('returns [] when no lint tools are detected (no config files)', async () => {
    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/some/file.ts');
    expect(results).toEqual([]);
  });

  it('returns executionError (not a tool failure) when eslint binary not found', async () => {
    touch(dir, '.eslintrc');
    spawnConfigs = [{ errorCode: 'ENOENT', errorMessage: 'spawn npx ENOENT' }];

    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/some/file.ts');

    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('eslint');
    expect(results[0].executionError).toBeDefined();
    expect(results[0].diagnostics).toEqual([]);
  });

  it('returns executionError (not a tool failure) when tsc binary not found', async () => {
    touch(dir, 'tsconfig.json');
    spawnConfigs = [{ errorCode: 'ENOENT', errorMessage: 'spawn npx ENOENT' }];

    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/some/file.ts');

    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('tsc');
    expect(results[0].executionError).toBeDefined();
    expect(results[0].diagnostics).toEqual([]);
  });

  it('parses eslint JSON output into diagnostics', async () => {
    touch(dir, '.eslintrc');

    const eslintOutput = JSON.stringify([
      {
        filePath: '/project/src/foo.ts',
        messages: [
          { line: 5, severity: 2, message: 'Unexpected console statement', ruleId: 'no-console' },
          { line: 10, severity: 1, message: 'Prefer const', ruleId: 'prefer-const' },
        ],
      },
    ]);
    spawnConfigs = [{ stdoutData: eslintOutput, closeCode: 0 }];

    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/project/src/foo.ts');

    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('eslint');
    expect(results[0].diagnostics).toHaveLength(2);
    expect(results[0].diagnostics[0].severity).toBe('error');
    expect(results[0].diagnostics[0].message).toBe('Unexpected console statement');
    expect(results[0].diagnostics[0].rule).toBe('no-console');
    expect(results[0].diagnostics[1].severity).toBe('warning');
    expect(results[0].diagnostics[1].message).toBe('Prefer const');
  });

  it('parses tsc text output into diagnostics', async () => {
    touch(dir, 'tsconfig.json');

    const tscOutput = [
      `src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable to type 'number'.`,
      `src/bar.ts(20,1): error TS2304: Cannot find name 'foo'.`,
    ].join('\n');
    spawnConfigs = [{ stdoutData: tscOutput, closeCode: 1 }];

    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/project/src/foo.ts');

    expect(results).toHaveLength(1);
    expect(results[0].tool).toBe('tsc');
    expect(results[0].diagnostics).toHaveLength(2);
    expect(results[0].diagnostics[0].line).toBe(10);
    expect(results[0].diagnostics[0].severity).toBe('error');
    expect(results[0].diagnostics[1].filePath).toContain('bar.ts');
  });

  it('aggregates results from both eslint and tsc when both are detected', async () => {
    touch(dir, '.eslintrc');
    touch(dir, 'tsconfig.json');

    const eslintOutput = JSON.stringify([
      {
        filePath: '/project/src/foo.ts',
        messages: [{ line: 1, severity: 2, message: 'ESLint error', ruleId: 'some-rule' }],
      },
    ]);
    const tscOutput = `src/foo.ts(5,3): error TS2345: Type error.`;

    // First spawn call = eslint, second = tsc
    spawnConfigs = [
      { stdoutData: eslintOutput, closeCode: 0 },
      { stdoutData: tscOutput, closeCode: 1 },
    ];

    const runner = new LintRunner(dir);
    const results = await runner.runOnFile('/project/src/foo.ts');

    expect(results).toHaveLength(2);
    const eslintResult = results.find(r => r.tool === 'eslint');
    const tscResult = results.find(r => r.tool === 'tsc');
    expect(eslintResult).toBeDefined();
    expect(tscResult).toBeDefined();
    expect(eslintResult!.diagnostics).toHaveLength(1);
    expect(tscResult!.diagnostics).toHaveLength(1);
  });

  it('sets timedOut: true when process exceeds 30s timeout', async () => {
    touch(dir, '.eslintrc');

    // Pre-warm the cache so detectTools doesn't need async I/O during fake timers
    const runner = new LintRunner(dir);
    await runner.detectTools();

    // Build a proc that never closes on its own; kill() emits close synchronously
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    let killed = false;
    proc.kill = vi.fn(() => {
      killed = true;
      proc.emit('close', null);
    });

    const { spawn } = await import('child_process');
    (spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(proc);

    // Use fake timers BEFORE starting runOnFile so setTimeout is intercepted
    vi.useFakeTimers();

    const promise = runner.runOnFile('/some/file.ts');

    // runAllTimersAsync: flushes microtasks (so the async function resumes and
    // registers the setTimeout), then advances all timers (fires the 30s timeout),
    // then flushes microtasks again (so the close handler resolves the promise)
    await vi.runAllTimersAsync();

    vi.useRealTimers();

    expect(killed).toBe(true);

    const results = await promise;

    expect(results).toHaveLength(1);
    expect(results[0].timedOut).toBe(true);
    expect(results[0].diagnostics).toEqual([]);
  }, 15_000);
});
