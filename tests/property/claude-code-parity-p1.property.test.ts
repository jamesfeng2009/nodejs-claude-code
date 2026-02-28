// @vitest-environment node
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { expect } from 'vitest';
import { formatMemorySection } from '../../src/context/memory-loader.js';
import type { MemoryFile } from '../../src/context/memory-loader.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const memoryFileArb = fc.record({
  absolutePath: fc
    .string({ minLength: 1, maxLength: 30 })
    .map((s) => `/some/path/${s.replace(/\//g, '_')}/CLAUDE.md`),
  content: fc.string({ minLength: 1, maxLength: 200 }),
});

const memoryFilesArb = fc.array(memoryFileArb, { minLength: 1, maxLength: 5 });

/** Generate an array of MemoryFiles with unique absolutePaths */
const uniqueMemoryFilesArb = (minLength: number, maxLength: number) =>
  fc
    .array(
      fc.tuple(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .map((s) => s.replace(/\//g, '_')),
        fc.string({ minLength: 1, maxLength: 200 })
      ),
      { minLength, maxLength }
    )
    .chain((pairs) => {
      // Deduplicate by segment to ensure unique paths
      const seen = new Set<string>();
      const unique = pairs.filter(([seg]) => {
        if (seen.has(seg)) return false;
        seen.add(seg);
        return true;
      });
      if (unique.length < minLength) return fc.constant([] as MemoryFile[]);
      return fc.constant(
        unique.map(([seg, content], i) => ({
          absolutePath: `/root/depth${i}/${seg}/CLAUDE.md`,
          content,
        }))
      );
    })
    .filter((files) => files.length >= minLength);

// ─── Property 1: CLAUDE.md 内容注入 ──────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 1: CLAUDE.md 内容注入
// For any non-empty array of MemoryFile, formatMemorySection output contains each file's content.
// Validates: Requirements 1.1, 2.1, 2.3, 10.1

describe('Property 1: CLAUDE.md 内容注入', () => {
  it('formatMemorySection output contains every file content', () => {
    fc.assert(
      fc.property(uniqueMemoryFilesArb(1, 5), (files: MemoryFile[]) => {
        const output = formatMemorySection(files);
        for (const file of files) {
          expect(output).toContain(file.content);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('formatMemorySection output is non-empty for non-empty input', () => {
    fc.assert(
      fc.property(uniqueMemoryFilesArb(1, 5), (files: MemoryFile[]) => {
        const output = formatMemorySection(files);
        expect(output.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 2: CLAUDE.md 多文件排序 ────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 2: CLAUDE.md 多文件排序
// For any array of MemoryFile with at least 2 entries, the output has each file's
// absolutePath as a header, and the order of headers matches the input order (root-first = index 0 first).
// Validates: Requirements 1.2, 2.2

describe('Property 2: CLAUDE.md 多文件排序', () => {
  it('each file absolutePath appears as a header in the output', () => {
    fc.assert(
      fc.property(uniqueMemoryFilesArb(2, 5), (files: MemoryFile[]) => {
        const output = formatMemorySection(files);
        for (const file of files) {
          expect(output).toContain(file.absolutePath);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('headers appear in input order (index 0 first, i.e. root-first)', () => {
    fc.assert(
      fc.property(uniqueMemoryFilesArb(2, 5), (files: MemoryFile[]) => {
        const output = formatMemorySection(files);
        // Find the position of each file's path header in the output
        const positions = files.map((f) => output.indexOf(f.absolutePath));
        // Every path must be present
        for (const pos of positions) {
          expect(pos).toBeGreaterThanOrEqual(0);
        }
        // Positions must be strictly increasing (preserving input order)
        for (let i = 0; i < positions.length - 1; i++) {
          expect(positions[i]).toBeLessThan(positions[i + 1]!);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('outermost content (index 0) precedes innermost content (last index)', () => {
    fc.assert(
      fc.property(uniqueMemoryFilesArb(2, 5), (files: MemoryFile[]) => {
        const output = formatMemorySection(files);
        const firstPos = output.indexOf(files[0]!.absolutePath);
        const lastPos = output.indexOf(files[files.length - 1]!.absolutePath);
        expect(firstPos).toBeLessThan(lastPos);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: Token 累计求和 ───────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 3: Token 累计求和
// Validates: Requirements 3.1, 3.2, 10.2, 10.3

import { TokenTracker } from '../../src/session/token-tracker.js';

const tokenRecordArb = fc.record({
  model: fc.constantFrom('claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'),
  inputTokens: fc.integer({ min: 0, max: 1_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 500_000 }),
});
const tokenSequenceArb = fc.array(tokenRecordArb, { minLength: 1, maxLength: 20 });

describe('Property 3: Token 累计求和', () => {
  it('totalInputTokens equals sum of all recorded inputTokens', () => {
    fc.assert(
      fc.property(tokenSequenceArb, (records) => {
        const tracker = new TokenTracker();
        for (const r of records) {
          tracker.record(r.model, r.inputTokens, r.outputTokens);
        }
        const summary = tracker.getSummary();
        const expectedInput = records.reduce((sum, r) => sum + r.inputTokens, 0);
        expect(summary.totalInputTokens).toBe(expectedInput);
      }),
      { numRuns: 200 }
    );
  });

  it('totalOutputTokens equals sum of all recorded outputTokens', () => {
    fc.assert(
      fc.property(tokenSequenceArb, (records) => {
        const tracker = new TokenTracker();
        for (const r of records) {
          tracker.record(r.model, r.inputTokens, r.outputTokens);
        }
        const summary = tracker.getSummary();
        const expectedOutput = records.reduce((sum, r) => sum + r.outputTokens, 0);
        expect(summary.totalOutputTokens).toBe(expectedOutput);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 4: 成本估算公式 ─────────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 4: 成本估算公式
// Validates: Requirements 4.2, 10.4

import { MODEL_PRICING } from '../../src/session/token-tracker.js';

const knownModelArb = fc.constantFrom(...(Object.keys(MODEL_PRICING) as [string, ...string[]]));

const nonNegativeTokenArb = fc.integer({ min: 0, max: 1_000_000 });

describe('Property 4: 成本估算公式', () => {
  it('computed cost matches formula for all known models and non-negative token counts', () => {
    fc.assert(
      fc.property(knownModelArb, nonNegativeTokenArb, nonNegativeTokenArb, (model, inputTokens, outputTokens) => {
        const tracker = new TokenTracker();
        tracker.record(model, inputTokens, outputTokens);
        const summary = tracker.getSummary();

        const pricing = MODEL_PRICING[model]!;
        const expectedCost =
          (inputTokens / 1_000_000) * pricing.inputPricePerMillion +
          (outputTokens / 1_000_000) * pricing.outputPricePerMillion;

        const modelEntry = summary.perModelCost.find((e) => e.model === model);
        expect(modelEntry).toBeDefined();
        expect(modelEntry!.estimatedCostUsd).toBeCloseTo(expectedCost, 10);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 5: 成本格式化 ───────────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 5: 成本格式化
// Validates: Requirements 4.5

const tokenRecordForFormatArb = fc.record({
  model: fc.constantFrom(...(Object.keys(MODEL_PRICING) as [string, ...string[]])),
  inputTokens: fc.integer({ min: 0, max: 1_000_000 }),
  outputTokens: fc.integer({ min: 0, max: 500_000 }),
});
const tokenSequenceForFormatArb = fc.array(tokenRecordForFormatArb, { minLength: 0, maxLength: 20 });

describe('Property 5: 成本格式化', () => {
  it('formattedCost matches /^\\$\\d+\\.\\d{4}$/ for any sequence of token records', () => {
    fc.assert(
      fc.property(tokenSequenceForFormatArb, (records) => {
        const tracker = new TokenTracker();
        for (const r of records) {
          tracker.record(r.model, r.inputTokens, r.outputTokens);
        }
        const summary = tracker.getSummary();
        expect(summary.formattedCost).toMatch(/^\$\d+\.\d{4}$/);
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 6: Lint 工具检测 ────────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 6: Lint 工具检测
// Validates: Requirements 6.2, 6.3

import os from 'os';
import * as fsSync from 'fs';
import { LintRunner } from '../../src/tools/implementations/lint-runner.js';

const lintConfigArb = fc.record({
  hasEslint: fc.boolean(),
  eslintConfigFile: fc.constantFrom(
    '.eslintrc',
    '.eslintrc.json',
    'eslint.config.js',
    'eslint.config.mjs'
  ),
  hasTsc: fc.boolean(),
});

describe('Property 6: Lint 工具检测', () => {
  it('detectTools returns eslint iff ESLint config exists; tsc iff tsconfig.json exists', async () => {
    await fc.assert(
      fc.asyncProperty(lintConfigArb, async ({ hasEslint, eslintConfigFile, hasTsc }) => {
        // Create a temp directory
        const tmpDir = await fsSync.promises.mkdtemp(os.tmpdir() + '/lint-detect-');
        try {
          if (hasEslint) {
            await fsSync.promises.writeFile(
              `${tmpDir}/${eslintConfigFile}`,
              '{}',
              'utf-8'
            );
          }
          if (hasTsc) {
            await fsSync.promises.writeFile(
              `${tmpDir}/tsconfig.json`,
              '{}',
              'utf-8'
            );
          }

          const runner = new LintRunner(tmpDir);
          const tools = await runner.detectTools();

          expect(tools.includes('eslint')).toBe(hasEslint);
          expect(tools.includes('tsc')).toBe(hasTsc);
        } finally {
          await fsSync.promises.rm(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 7: Lint 诊断附加 ────────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 7: Lint 诊断附加
// Validates: Requirements 7.1, 7.2, 7.6

const lintDiagnosticArb = fc.record({
  filePath: fc
    .string({ minLength: 1, maxLength: 50 })
    .map((s) => `/project/${s.replace(/\//g, '_')}.ts`),
  line: fc.integer({ min: 1, max: 1000 }),
  severity: fc.constantFrom('error', 'warning', 'info') as fc.Arbitrary<'error' | 'warning' | 'info'>,
  message: fc.string({ minLength: 1, maxLength: 100 }),
});

const lintResultArb = fc.record({
  tool: fc.constantFrom('eslint', 'tsc') as fc.Arbitrary<'eslint' | 'tsc'>,
  diagnostics: fc.array(lintDiagnosticArb, { minLength: 1, maxLength: 5 }),
});

const lintResultsArb = fc.array(lintResultArb, { minLength: 1, maxLength: 3 });

describe('Property 7: Lint 诊断附加', () => {
  it('formatResults output contains --- Lint Results --- header', () => {
    fc.assert(
      fc.property(lintResultsArb, (results) => {
        const runner = new LintRunner('/project');
        const output = runner.formatResults(results);
        expect(output).toContain('--- Lint Results ---');
      }),
      { numRuns: 200 }
    );
  });

  it('formatResults output contains each diagnostic message', () => {
    fc.assert(
      fc.property(lintResultsArb, (results) => {
        const runner = new LintRunner('/project');
        const output = runner.formatResults(results);
        for (const result of results) {
          for (const diag of result.diagnostics) {
            expect(output).toContain(diag.message);
          }
        }
      }),
      { numRuns: 200 }
    );
  });

  it('formatResults output contains each diagnostic filePath', () => {
    fc.assert(
      fc.property(lintResultsArb, (results) => {
        const runner = new LintRunner('/project');
        const output = runner.formatResults(results);
        for (const result of results) {
          for (const diag of result.diagnostics) {
            expect(output).toContain(diag.filePath);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Property 8: insert 结构不变量 ────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 8: insert 结构不变量
// Validates: Requirements 8.4, 8.5, 10.5, 10.6

import * as path from 'path';
import * as fsp from 'fs/promises';
import { createFileEditTool } from '../../src/tools/implementations/file-edit.js';

const linesArb = fc.array(
  fc.string({ maxLength: 80 }).filter((s) => !s.includes('\n')),
  { minLength: 1, maxLength: 200 }
);

const validLineArb = (n: number) => fc.integer({ min: 1, max: n });

const insertContentArb = fc
  .array(
    fc.string({ minLength: 1, maxLength: 80 }).filter((s) => !s.includes('\n')),
    { minLength: 1, maxLength: 5 }
  )
  .map((lines) => lines.join('\n'));

describe('Property 8: insert 结构不变量', () => {
  it('8a: insert after K — result has N+M lines; prefix and suffix unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        linesArb.chain((lines) =>
          fc.tuple(
            fc.constant(lines),
            validLineArb(lines.length),
            insertContentArb
          )
        ),
        async ([originalLines, K, insertedContent]) => {
          const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'insert-after-'));
          const filePath = path.join(tmpDir, 'test.txt');
          try {
            await fsp.writeFile(filePath, originalLines.join('\n'), 'utf-8');

            const tool = createFileEditTool(tmpDir);
            const result = await tool.execute({
              path: 'test.txt',
              operation: 'insert',
              insert_position: 'after',
              line: K,
              content: insertedContent,
            });

            expect(result.isError).toBe(false);

            const resultContent = await fsp.readFile(filePath, 'utf-8');
            const resultLines = resultContent.split('\n');
            const insertedLines = insertedContent.split('\n');
            const N = originalLines.length;
            const M = insertedLines.length;

            // Assert: result has N+M lines
            expect(resultLines.length).toBe(N + M);

            // Assert: prefix lines 0..K-1 (0-indexed) unchanged
            for (let i = 0; i < K; i++) {
              expect(resultLines[i]).toBe(originalLines[i]);
            }

            // Assert: suffix lines K+M..N+M-1 equal original lines K..N-1
            for (let i = K; i < N; i++) {
              expect(resultLines[i + M]).toBe(originalLines[i]);
            }
          } finally {
            await fsp.rm(tmpDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('8b: insert before K — result has N+M lines; prefix and suffix unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        linesArb.chain((lines) =>
          fc.tuple(
            fc.constant(lines),
            validLineArb(lines.length),
            insertContentArb
          )
        ),
        async ([originalLines, K, insertedContent]) => {
          const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'insert-before-'));
          const filePath = path.join(tmpDir, 'test.txt');
          try {
            await fsp.writeFile(filePath, originalLines.join('\n'), 'utf-8');

            const tool = createFileEditTool(tmpDir);
            const result = await tool.execute({
              path: 'test.txt',
              operation: 'insert',
              insert_position: 'before',
              line: K,
              content: insertedContent,
            });

            expect(result.isError).toBe(false);

            const resultContent = await fsp.readFile(filePath, 'utf-8');
            const resultLines = resultContent.split('\n');
            const insertedLines = insertedContent.split('\n');
            const N = originalLines.length;
            const M = insertedLines.length;

            // Assert: result has N+M lines
            expect(resultLines.length).toBe(N + M);

            // Assert: prefix lines 0..K-2 (0-indexed) unchanged
            for (let i = 0; i < K - 1; i++) {
              expect(resultLines[i]).toBe(originalLines[i]);
            }

            // Assert: suffix lines K+M-1..N+M-1 equal original lines K-1..N-1
            for (let i = K - 1; i < N; i++) {
              expect(resultLines[i + M]).toBe(originalLines[i]);
            }
          } finally {
            await fsp.rm(tmpDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 9: insert 汇合性 ────────────────────────────────────────────────
// Feature: claude-code-parity-p1, Property 9: insert 汇合性
// Validates: Requirements 10.7

/**
 * Pure helper: insert `insertedLines` after position K (1-based).
 * K=0 means prepend; K=N means append.
 */
function insertAfter(lines: string[], K: number, insertedLines: string[]): string[] {
  return [...lines.slice(0, K), ...insertedLines, ...lines.slice(K)];
}

const confluenceArb = linesArb
  .filter((lines) => lines.length >= 2)
  .chain((lines) => {
    const N = lines.length;
    return fc.tuple(
      // K1: 1-based, in [1, N-1] so K2 can be strictly greater
      fc.integer({ min: 1, max: N - 1 }),
      // ins1: 1–5 non-newline strings
      fc.integer({ min: 1, max: 5 }).chain((m1) =>
        fc.array(
          fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes('\n')),
          { minLength: m1, maxLength: m1 }
        )
      ),
      // ins2: 1–5 non-newline strings
      fc.integer({ min: 1, max: 5 }).chain((m2) =>
        fc.array(
          fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes('\n')),
          { minLength: m2, maxLength: m2 }
        )
      ),
    ).chain(([k1, ins1, ins2]) => {
      // K2 must be in [K1+1, N] (strictly after K1, within original file)
      return fc.integer({ min: k1 + 1, max: N }).map((k2) => ({
        lines,
        K1: k1,
        K2: k2,
        ins1,
        ins2,
      }));
    });
  });

describe('Property 9: insert 汇合性', () => {
  it('two non-overlapping inserts produce identical result regardless of order', () => {
    fc.assert(
      fc.property(confluenceArb, ({ lines, K1, K2, ins1, ins2 }) => {
        // Path A: apply op1 (insert ins1 after K1) then op2 (insert ins2 after K2+ins1.length)
        const afterOp1 = insertAfter(lines, K1, ins1);
        const resultA = insertAfter(afterOp1, K2 + ins1.length, ins2);

        // Path B: apply op2 (insert ins2 after K2) then op1 (insert ins1 after K1, unchanged since K1 < K2)
        const afterOp2 = insertAfter(lines, K2, ins2);
        const resultB = insertAfter(afterOp2, K1, ins1);

        expect(resultA).toEqual(resultB);
      }),
      { numRuns: 200 }
    );
  });
});
