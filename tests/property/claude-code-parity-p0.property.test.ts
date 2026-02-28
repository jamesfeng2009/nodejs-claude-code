// @vitest-environment node
import { describe, it, afterEach } from 'vitest';
import { expect } from 'vitest';
import * as fc from 'fast-check';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { minimatch } from 'minimatch';
import { createFileReadTool } from '../../src/tools/implementations/file-read.js';
import { createGlobSearchTool } from '../../src/tools/implementations/glob-search.js';
import { ShellSessionManager } from '../../src/tools/implementations/shell-session.js';
import { createShellExecuteTool } from '../../src/tools/implementations/shell-execute.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `pbt-p0-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/**
 * Generate a valid [s, e] range where 1 <= s <= e <= n.
 */
function validRangeArb(n: number): fc.Arbitrary<[number, number]> {
  return fc
    .tuple(fc.integer({ min: 1, max: n }), fc.integer({ min: 1, max: n }))
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]);
}

/** Arbitrary that generates lines + a valid [s, e] range together */
const linesWithRangeArb = fc
  .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
  .chain((lines) =>
    validRangeArb(lines.length).map((range) => ({ lines, range })),
  );

/** Arbitrary that generates lines + a valid start_line */
const linesWithStartArb = fc
  .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
  .chain((lines) =>
    fc.integer({ min: 1, max: lines.length }).map((s) => ({ lines, s })),
  );

/** Arbitrary that generates lines + a valid end_line */
const linesWithEndArb = fc
  .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
  .chain((lines) =>
    fc.integer({ min: 1, max: lines.length }).map((e) => ({ lines, e })),
  );

/** Arbitrary that generates lines + a valid start_line + an end_line that exceeds N */
const linesWithClampArb = fc
  .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
  .chain((lines) =>
    fc
      .tuple(
        fc.integer({ min: 1, max: lines.length }),
        fc.integer({ min: 1, max: 100 }),
      )
      .map(([s, extra]) => ({ lines, s, e: lines.length + extra })),
  );

// ─── Feature: claude-code-parity-p0 ──────────────────────────────────────────

describe('Feature: claude-code-parity-p0', () => {
  // Feature: claude-code-parity-p0, Property 1: 行范围行数正确性
  // Validates: Requirements 8.1, 1.2, 1.3, 1.4, 1.10
  describe('Property 1: 行范围行数正确性', () => {
    it('returns exactly min(e, N) - s + 1 lines for any valid range [s, e]', async () => {
      await fc.assert(
        fc.asyncProperty(linesWithRangeArb, async ({ lines, range: [s, e] }) => {
          const N = lines.length;
          const workDir = makeTempDir();
          writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

          const tool = createFileReadTool(workDir);
          const result = await tool.execute({
            path: 'test.txt',
            start_line: s,
            end_line: e,
          });

          expect(result.isError).toBe(false);

          const expectedCount = Math.min(e, N) - s + 1;
          const returnedLines = result.content.split('\n');
          expect(returnedLines).toHaveLength(expectedCount);
        }),
        { numRuns: 100 },
      );
    });

    it('returns correct line count when only start_line is provided', async () => {
      await fc.assert(
        fc.asyncProperty(linesWithStartArb, async ({ lines, s }) => {
          const N = lines.length;
          const workDir = makeTempDir();
          writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

          const tool = createFileReadTool(workDir);
          const result = await tool.execute({
            path: 'test.txt',
            start_line: s,
          });

          expect(result.isError).toBe(false);

          // end_line defaults to N: count = min(N, N) - s + 1 = N - s + 1
          const expectedCount = N - s + 1;
          const returnedLines = result.content.split('\n');
          expect(returnedLines).toHaveLength(expectedCount);
        }),
        { numRuns: 100 },
      );
    });

    it('returns correct line count when only end_line is provided', async () => {
      await fc.assert(
        fc.asyncProperty(linesWithEndArb, async ({ lines, e }) => {
          const N = lines.length;
          const workDir = makeTempDir();
          writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

          const tool = createFileReadTool(workDir);
          const result = await tool.execute({
            path: 'test.txt',
            end_line: e,
          });

          expect(result.isError).toBe(false);

          // start_line defaults to 1: count = min(e, N) - 1 + 1 = min(e, N)
          const expectedCount = Math.min(e, N);
          const returnedLines = result.content.split('\n');
          expect(returnedLines).toHaveLength(expectedCount);
        }),
        { numRuns: 100 },
      );
    });

    it('clamps end_line to N when end_line exceeds total lines', async () => {
      await fc.assert(
        fc.asyncProperty(linesWithClampArb, async ({ lines, s, e }) => {
          const N = lines.length;
          const workDir = makeTempDir();
          writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

          const tool = createFileReadTool(workDir);
          const result = await tool.execute({
            path: 'test.txt',
            start_line: s,
            end_line: e,
          });

          expect(result.isError).toBe(false);

          // end_line is clamped to N: count = min(e, N) - s + 1 = N - s + 1
          const expectedCount = Math.min(e, N) - s + 1;
          const returnedLines = result.content.split('\n');
          expect(returnedLines).toHaveLength(expectedCount);
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 2: 行号前缀格式
  // Validates: Requirements 8.2, 1.6
  describe('Property 2: 行号前缀格式', () => {
    it('every returned line matches ^\\s*\\d+ \\| for any valid range', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
            .chain((lines) =>
              validRangeArb(lines.length).map((range) => ({ lines, range })),
            ),
          async ({ lines, range: [s, e] }) => {
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({
              path: 'test.txt',
              start_line: s,
              end_line: e,
            });

            expect(result.isError).toBe(false);

            const returnedLines = result.content.split('\n');
            for (const line of returnedLines) {
              expect(line).toMatch(/^\s*\d+ \| /);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 3: 超大文件提示存在性
  // Validates: Requirements 2.1
  describe('Property 3: 超大文件提示存在性', () => {
    it('output contains a notice with total line count when file has > 500 lines and no range is given', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ maxLength: 80 }), { minLength: 501, maxLength: 600 }),
          async (lines) => {
            const N = lines.length;
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({ path: 'test.txt' });

            expect(result.isError).toBe(false);

            const expectedNotice = `Notice: This file has ${N} lines. Consider using start_line/end_line parameters to read specific sections.`;
            expect(result.content).toContain(expectedNotice);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 4: 有范围时不出现超大文件提示
  // Validates: Requirements 2.2
  describe('Property 4: 有范围时不出现超大文件提示', () => {
    it('output does NOT contain the large-file notice when a valid line range is provided', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 600 })
            .chain((lines) =>
              validRangeArb(lines.length).map((range) => ({ lines, range })),
            ),
          async ({ lines, range: [s, e] }) => {
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({
              path: 'test.txt',
              start_line: s,
              end_line: e,
            });

            expect(result.isError).toBe(false);
            expect(result.content).not.toMatch(/Notice:/);
            expect(result.content).not.toMatch(/lines\. Consider/);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 5: Glob 匹配正确性
  // Validates: Requirements 8.3, 3.2
  describe('Property 5: Glob 匹配正确性', () => {
    // Generate safe file names (no path separators, no noise dir names)
    const safeNameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
    // Generate safe directory names (exclude noise dirs)
    const safeDirArb = safeNameArb.filter(
      (n) => !['node_modules', '.git', 'dist', 'build'].includes(n),
    );

    it('every path returned by glob_search matches the glob pattern used', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(safeNameArb, { minLength: 1, maxLength: 10 }),
          async (fileNames) => {
            const workDir = makeTempDir();

            // Create .ts files in the temp dir
            const uniqueNames = [...new Set(fileNames)];
            for (const name of uniqueNames) {
              writeFileSync(join(workDir, `${name}.ts`), `// ${name}\n`, 'utf-8');
            }

            const pattern = '**/*.ts';
            const tool = createGlobSearchTool(workDir);
            const result = await tool.execute({ pattern });

            expect(result.isError).toBe(false);

            if (result.content.startsWith("No files found")) {
              return;
            }

            // Strip truncation notice if present
            const lines = result.content
              .split('\n')
              .filter((l) => !l.startsWith('Results truncated'));

            for (const filePath of lines) {
              if (filePath.trim() === '') continue;
              expect(minimatch(filePath, pattern, { dot: true })).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('every path returned by glob_search ends with .ts when pattern is **/*.ts (with subdirs)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(safeDirArb, safeNameArb),
            { minLength: 1, maxLength: 8 },
          ),
          async (entries) => {
            const workDir = makeTempDir();

            // Create files in subdirectories
            const seen = new Set<string>();
            for (const [dir, name] of entries) {
              const subDir = join(workDir, dir);
              mkdirSync(subDir, { recursive: true });
              const filePath = join(subDir, `${name}.ts`);
              const key = `${dir}/${name}`;
              if (!seen.has(key)) {
                seen.add(key);
                writeFileSync(filePath, `// ${name}\n`, 'utf-8');
              }
            }

            const pattern = '**/*.ts';
            const tool = createGlobSearchTool(workDir);
            const result = await tool.execute({ pattern });

            expect(result.isError).toBe(false);

            if (result.content.startsWith("No files found")) {
              return;
            }

            const lines = result.content
              .split('\n')
              .filter((l) => l.trim() !== '' && !l.startsWith('Results truncated'));

            for (const filePath of lines) {
              expect(filePath.endsWith('.ts')).toBe(true);
              expect(minimatch(filePath, pattern, { dot: true })).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 6: Glob 结果有序性
  // Validates: Requirements 3.3
  describe('Property 6: Glob 结果有序性', () => {
    const safeNameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
    const safeDirArb = safeNameArb.filter(
      (n) => !['node_modules', '.git', 'dist', 'build'].includes(n),
    );

    it('returned paths are in ascending lexicographic order for any file structure', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              // flat files
              safeNameArb.map((name) => ({ dir: null as string | null, name })),
              // files in subdirs
              fc.tuple(safeDirArb, safeNameArb).map(([dir, name]) => ({ dir, name })),
            ),
            { minLength: 1, maxLength: 15 },
          ),
          async (entries) => {
            const workDir = makeTempDir();

            // Create files, deduplicating paths
            const seen = new Set<string>();
            for (const { dir, name } of entries) {
              const fileName = `${name}.txt`;
              const key = dir ? `${dir}/${fileName}` : fileName;
              if (seen.has(key)) continue;
              seen.add(key);

              if (dir) {
                mkdirSync(join(workDir, dir), { recursive: true });
                writeFileSync(join(workDir, dir, fileName), '', 'utf-8');
              } else {
                writeFileSync(join(workDir, fileName), '', 'utf-8');
              }
            }

            const tool = createGlobSearchTool(workDir);
            const result = await tool.execute({ pattern: '**/*' });

            expect(result.isError).toBe(false);

            if (result.content.startsWith('No files found')) {
              return;
            }

            // Parse result lines, filtering out truncation notice
            const lines = result.content
              .split('\n')
              .filter((l) => l.trim() !== '' && !l.startsWith('Results truncated'));

            // Verify the list equals its sorted version
            expect(lines).toEqual([...lines].sort());
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 7: 噪声目录自动排除
  // Validates: Requirements 3.4
  describe('Property 7: 噪声目录自动排除', () => {
    const NOISE_DIRS = ['node_modules', '.git', 'dist', 'build'];
    const safeNameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);
    const safeDirArb = safeNameArb.filter((n) => !NOISE_DIRS.includes(n));

    it('no returned path has a component equal to a noise dir name', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate safe file names and noise dir names to create files in
          fc.tuple(
            fc.array(safeNameArb, { minLength: 1, maxLength: 5 }),
            fc.array(
              fc.tuple(
                fc.constantFrom(...NOISE_DIRS),
                safeNameArb,
              ),
              { minLength: 1, maxLength: 5 },
            ),
            fc.array(
              fc.tuple(safeDirArb, safeNameArb),
              { minLength: 1, maxLength: 5 },
            ),
          ),
          async ([flatNames, noiseDirFiles, safeDirFiles]) => {
            const workDir = makeTempDir();

            // Create flat files in workDir
            const seenFlat = new Set<string>();
            for (const name of flatNames) {
              if (seenFlat.has(name)) continue;
              seenFlat.add(name);
              writeFileSync(join(workDir, `${name}.txt`), '', 'utf-8');
            }

            // Create files inside noise dirs (should be excluded)
            for (const [noiseDir, name] of noiseDirFiles) {
              const dir = join(workDir, noiseDir);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, `${name}.txt`), '', 'utf-8');
            }

            // Create files inside safe dirs (should be included)
            const seenSafe = new Set<string>();
            for (const [safeDir, name] of safeDirFiles) {
              const key = `${safeDir}/${name}`;
              if (seenSafe.has(key)) continue;
              seenSafe.add(key);
              const dir = join(workDir, safeDir);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, `${name}.txt`), '', 'utf-8');
            }

            const tool = createGlobSearchTool(workDir);
            const result = await tool.execute({ pattern: '**/*' });

            expect(result.isError).toBe(false);

            if (result.content.startsWith('No files found')) {
              return;
            }

            const lines = result.content
              .split('\n')
              .filter((l) => l.trim() !== '' && !l.startsWith('Results truncated'));

            for (const filePath of lines) {
              const parts = filePath.split('/');
              expect(
                parts.every((part) => !NOISE_DIRS.includes(part)),
                `Path "${filePath}" contains a noise dir component`,
              ).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 8: 排除模式正确性
  // Validates: Requirements 8.4, 4.2
  describe('Property 8: 排除模式正确性', () => {
    const safeNameArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/);

    it('no returned path matches the exclude pattern when exclude is **/*.spec.ts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(safeNameArb, { minLength: 1, maxLength: 10 }),
          async (fileNames) => {
            const workDir = makeTempDir();

            // Create both .ts and .spec.ts files
            const uniqueNames = [...new Set(fileNames)];
            for (const name of uniqueNames) {
              writeFileSync(join(workDir, `${name}.ts`), `// ${name}\n`, 'utf-8');
              writeFileSync(join(workDir, `${name}.spec.ts`), `// spec ${name}\n`, 'utf-8');
            }

            const pattern = '**/*.ts';
            const exclude = '**/*.spec.ts';
            const tool = createGlobSearchTool(workDir);
            const result = await tool.execute({ pattern, exclude });

            expect(result.isError).toBe(false);

            if (result.content.startsWith('No files found')) {
              return;
            }

            // Strip truncation notice if present
            const lines = result.content
              .split('\n')
              .filter((l) => l.trim() !== '' && !l.startsWith('Results truncated'));

            for (const filePath of lines) {
              expect(
                minimatch(filePath, exclude, { dot: true }),
                `Path "${filePath}" matches the exclude pattern "${exclude}"`,
              ).toBe(false);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 9: cd 命令工作目录持久化
  // Validates: Requirements 8.5, 5.2
  describe('Property 9: cd 命令工作目录持久化', () => {
    let manager: ShellSessionManager;

    afterEach(() => {
      manager?.destroyAll();
    });

    it('executing cd /tmp && pwd produces output containing /tmp for any session ID', async () => {
      manager = new ShellSessionManager();
      await fc.assert(
        fc.asyncProperty(fc.uuid(), async (sessionId) => {
          const output = await manager.execute(sessionId, 'cd /tmp && pwd', 10000);
          expect(output).toContain('/tmp');
        }),
        { numRuns: 10 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 10: export 环境变量持久化
  // Validates: Requirements 8.6, 6.1
  describe('Property 10: export 环境变量持久化', () => {
    let manager: ShellSessionManager;

    afterEach(() => {
      manager?.destroyAll();
    });

    it('export NAME=value followed by echo $NAME produces output containing value for any session', async () => {
      manager = new ShellSessionManager();

      const envVarNameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/);
      const envVarValueArb = fc
        .string({ minLength: 1, maxLength: 20 })
        .filter((v) => /^[a-zA-Z0-9_-]+$/.test(v));

      await fc.assert(
        fc.asyncProperty(
          fc.uuid(),
          envVarNameArb,
          envVarValueArb,
          async (sessionId, name, value) => {
            await manager.execute(sessionId, `export ${name}=${value}`, 10000);
            const output = await manager.execute(sessionId, `echo $${name}`, 10000);
            expect(output).toContain(value);
          },
        ),
        { numRuns: 10 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 11: 确认函数始终被调用
  // Validates: Requirements 7.3
  describe('Property 11: 确认函数始终被调用', () => {
    let manager: ShellSessionManager;

    afterEach(() => {
      manager?.destroyAll();
    });

    it('confirm function is called before every command in persistent shell mode', async () => {
      manager = new ShellSessionManager();
      const workDir = makeTempDir();

      const safeCommandArb = fc
        .string({ minLength: 1, maxLength: 50 })
        .filter((s) => /^[a-zA-Z0-9 _-]+$/.test(s));

      await fc.assert(
        fc.asyncProperty(fc.uuid(), safeCommandArb, async (sessionId, _cmd) => {
          let callCount = 0;
          const mockConfirm = async (_command: string) => {
            callCount++;
            return true;
          };

          const tool = createShellExecuteTool(workDir, mockConfirm, manager, sessionId);
          await tool.execute({ command: 'echo test' });

          expect(callCount).toBe(1);
        }),
        { numRuns: 10 },
      );
    });

    it('confirm function is called before every command in execSync fallback mode', async () => {
      const workDir = makeTempDir();

      const safeCommandArb = fc
        .string({ minLength: 1, maxLength: 50 })
        .filter((s) => /^[a-zA-Z0-9 _-]+$/.test(s));

      await fc.assert(
        fc.asyncProperty(safeCommandArb, async (_cmd) => {
          let callCount = 0;
          const mockConfirm = async (_command: string) => {
            callCount++;
            return true;
          };

          // No shellSessionManager or sessionId — uses execSync fallback
          const tool = createShellExecuteTool(workDir, mockConfirm);
          await tool.execute({ command: 'echo test' });

          expect(callCount).toBe(1);
        }),
        { numRuns: 10 },
      );
    });
  });

  // Feature: claude-code-parity-p0, Property 12: 无效行范围参数返回错误
  // Validates: Requirements 1.7, 1.8, 1.9
  describe('Property 12: 无效行范围参数返回错误', () => {
    it('returns isError: true when start_line < 1', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 100 }),
          fc.integer({ max: 0 }),
          async (lines, invalidStart) => {
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({
              path: 'test.txt',
              start_line: invalidStart,
            });

            expect(result.isError).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns isError: true when end_line < start_line', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.string({ maxLength: 80 }), { minLength: 2, maxLength: 100 })
            .chain((lines) => {
              const N = lines.length;
              return fc
                .tuple(fc.integer({ min: 1, max: N }), fc.integer({ min: 1, max: N }))
                .filter(([a, b]) => a !== b)
                .map(([a, b]) => ({ lines, start: Math.max(a, b), end: Math.min(a, b) }));
            }),
          async ({ lines, start, end }) => {
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({
              path: 'test.txt',
              start_line: start,
              end_line: end,
            });

            expect(result.isError).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('returns isError: true when start_line exceeds total lines', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.string({ maxLength: 80 }), { minLength: 1, maxLength: 100 })
            .chain((lines) => {
              const N = lines.length;
              return fc
                .integer({ min: N + 1, max: N + 100 })
                .map((invalidStart) => ({ lines, invalidStart }));
            }),
          async ({ lines, invalidStart }) => {
            const workDir = makeTempDir();
            writeFileSync(join(workDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const tool = createFileReadTool(workDir);
            const result = await tool.execute({
              path: 'test.txt',
              start_line: invalidStart,
            });

            expect(result.isError).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
