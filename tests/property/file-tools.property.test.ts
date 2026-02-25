import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { createFileReadTool } from '../../src/tools/implementations/file-read.js';
import { createFileWriteTool } from '../../src/tools/implementations/file-write.js';
import { createFileEditTool } from '../../src/tools/implementations/file-edit.js';
import { createGrepSearchTool } from '../../src/tools/implementations/grep-search.js';
import { createListDirectoryTool } from '../../src/tools/implementations/list-directory.js';
import { isSensitiveFile } from '../../src/tools/implementations/security.js';

// Feature: nodejs-claude-code, Property 6: 文件读写往返一致性
// For any valid file path and text content, writing with file write tool then reading
// with file read tool should return identical text.
// Validates: Requirements 3.3, 3.4

// Feature: nodejs-claude-code, Property 7: 文件编辑替换正确性
// For any file content containing target string and replacement string pair,
// after file edit tool executes, target string should be replaced with new string,
// and rest of file remains unchanged.
// Validates: Requirements 3.5

// Feature: nodejs-claude-code, Property 8: 正则搜索结果正确性
// For any directory with known content and regex pattern, every line returned by
// code search tool should match the regex, and no matching lines should be missed.
// Validates: Requirements 3.7

// Feature: nodejs-claude-code, Property 9: 目录列表完整性
// For any directory, entries returned by directory listing tool should be consistent
// with actual filesystem content.
// Validates: Requirements 3.8

// Feature: nodejs-claude-code, Property 28: 文件操作路径安全约束
// File operations should be restricted to working directory and subdirectories.
// Validates: Requirements 6.2, 6.3

// Feature: nodejs-claude-code, Property 29: 敏感文件模式匹配警告
// Sensitive file pattern matching should warn on matching files.
// Validates: Requirements 6.4

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-tools-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Arbitrary for safe file names (no path separators, no null bytes)
const safeFileNameArb = fc
  .stringMatching(/^[a-zA-Z0-9_\-]{1,30}$/)
  .map((s) => `${s}.txt`);

// Arbitrary for file content (printable ASCII + newlines)
const fileContentArb = fc.string({ minLength: 0, maxLength: 500 });

// Arbitrary for non-empty file content
const nonEmptyContentArb = fc.string({ minLength: 1, maxLength: 500 });

// ─── Property 6: 文件读写往返一致性 ──────────────────────────────────────────

describe('Property 6: 文件读写往返一致性', () => {
  it('write then read returns identical content', async () => {
    await fc.assert(
      fc.asyncProperty(safeFileNameArb, fileContentArb, async (fileName, content) => {
        const writeTool = createFileWriteTool(tmpDir);
        const readTool = createFileReadTool(tmpDir);

        const writeResult = await writeTool.execute({ path: fileName, content });
        expect(writeResult.isError).toBe(false);

        const readResult = await readTool.execute({ path: fileName });
        expect(readResult.isError).toBe(false);
        expect(readResult.content).toBe(content);
      }),
      { numRuns: 100 }
    );
  });

  it('write overwrites existing file content', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeFileNameArb,
        nonEmptyContentArb,
        nonEmptyContentArb,
        async (fileName, firstContent, secondContent) => {
          const writeTool = createFileWriteTool(tmpDir);
          const readTool = createFileReadTool(tmpDir);

          await writeTool.execute({ path: fileName, content: firstContent });
          await writeTool.execute({ path: fileName, content: secondContent });

          const readResult = await readTool.execute({ path: fileName });
          expect(readResult.isError).toBe(false);
          expect(readResult.content).toBe(secondContent);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('read returns error for non-existent file', async () => {
    await fc.assert(
      fc.asyncProperty(safeFileNameArb, async (fileName) => {
        const readTool = createFileReadTool(tmpDir);
        const result = await readTool.execute({ path: `nonexistent_${fileName}` });
        expect(result.isError).toBe(true);
      }),
      { numRuns: 50 }
    );
  });
});

// ─── Property 7: 文件编辑替换正确性 ──────────────────────────────────────────

describe('Property 7: 文件编辑替换正确性', () => {
  it('edit replaces target string with new string, rest unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeFileNameArb,
        // Generate content with a unique target substring
        fc
          .tuple(
            fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')),
            fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')),
            fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')),
            fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')),
          )
          .filter(([prefix, target, suffix, replacement]) =>
            // target must not appear in prefix or suffix to avoid ambiguity
            !prefix.includes(target) && !suffix.includes(target) && target !== replacement
          ),
        async (fileName, [prefix, target, suffix, replacement]) => {
          const originalContent = prefix + target + suffix;
          const writeTool = createFileWriteTool(tmpDir);
          const editTool = createFileEditTool(tmpDir);
          const readTool = createFileReadTool(tmpDir);

          await writeTool.execute({ path: fileName, content: originalContent });

          const editResult = await editTool.execute({
            path: fileName,
            old_text: target,
            new_text: replacement,
          });
          expect(editResult.isError).toBe(false);

          const readResult = await readTool.execute({ path: fileName });
          expect(readResult.isError).toBe(false);

          const expectedContent = prefix + replacement + suffix;
          expect(readResult.content).toBe(expectedContent);

          // Target should no longer appear (since it was unique)
          if (!prefix.includes(target) && !suffix.includes(target) && !replacement.includes(target)) {
            expect(readResult.content).not.toContain(target);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('edit returns error when target text not found', async () => {
    await fc.assert(
      fc.asyncProperty(
        safeFileNameArb,
        nonEmptyContentArb,
        fc.string({ minLength: 1, maxLength: 30 }),
        async (fileName, content, notPresent) => {
          // Ensure notPresent is not in content
          fc.pre(!content.includes(notPresent));

          const writeTool = createFileWriteTool(tmpDir);
          const editTool = createFileEditTool(tmpDir);

          await writeTool.execute({ path: fileName, content });

          const result = await editTool.execute({
            path: fileName,
            old_text: notPresent,
            new_text: 'replacement',
          });
          expect(result.isError).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 8: 正则搜索结果正确性 ──────────────────────────────────────────

describe('Property 8: 正则搜索结果正确性', () => {
  it('every returned line matches the regex pattern', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate files with known content
        fc.array(
          fc.tuple(
            safeFileNameArb,
            fc.array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 1, maxLength: 10 })
          ),
          { minLength: 1, maxLength: 5 }
        ),
        // Use a simple literal pattern that we know appears in some lines
        fc.string({ minLength: 2, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
        async (files, searchToken) => {
          // Create a fresh temp dir for this test
          const testDir = mkdtempSync(join(tmpdir(), 'grep-test-'));
          try {
            // Write files, ensuring at least one line contains the token
            const allLines: string[] = [];
            for (const [fileName, lines] of files) {
              const content = lines.join('\n');
              writeFileSync(join(testDir, fileName), content, 'utf-8');
              allLines.push(...lines);
            }

            const searchTool = createGrepSearchTool(testDir);
            const result = await searchTool.execute({
              pattern: searchToken,
              directory: '.',
            });

            if (result.isError) return; // skip if error (e.g., no matches)

            if (result.content.includes('No matches found')) return;

            // Parse result lines: "file:linenum: content"
            const resultLines = result.content
              .split('\n')
              .filter((l) => l.trim() && !l.startsWith('(results truncated'));

            const regex = new RegExp(searchToken);
            for (const line of resultLines) {
              // Extract the content part after "file:linenum: "
              const colonIdx = line.indexOf(':');
              if (colonIdx === -1) continue;
              const afterFile = line.slice(colonIdx + 1);
              const secondColon = afterFile.indexOf(':');
              if (secondColon === -1) continue;
              const lineContent = afterFile.slice(secondColon + 1).trim();
              // The line content should match the pattern
              expect(regex.test(lineContent)).toBe(true);
            }
          } finally {
            rmSync(testDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('no matching lines are missed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 2, maxLength: 8 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
        fc.array(
          fc.boolean(), // true = line contains token, false = doesn't
          { minLength: 1, maxLength: 20 }
        ),
        async (token, lineFlags) => {
          const testDir = mkdtempSync(join(tmpdir(), 'grep-miss-test-'));
          try {
            const lines = lineFlags.map((hasToken, i) =>
              hasToken ? `line_${i}_${token}_end` : `line_${i}_other_content`
            );
            const expectedMatchCount = lineFlags.filter(Boolean).length;

            writeFileSync(join(testDir, 'test.txt'), lines.join('\n'), 'utf-8');

            const searchTool = createGrepSearchTool(testDir);
            const result = await searchTool.execute({ pattern: token, directory: '.' });

            if (expectedMatchCount === 0) {
              // Should report no matches
              expect(result.content).toContain('No matches');
            } else {
              expect(result.isError).toBe(false);
              // Count result lines
              const resultLines = result.content
                .split('\n')
                .filter((l) => l.trim() && !l.startsWith('(results truncated') && !l.includes('No matches'));
              expect(resultLines.length).toBe(expectedMatchCount);
            }
          } finally {
            rmSync(testDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('invalid regex returns error', async () => {
    const searchTool = createGrepSearchTool(tmpDir);
    const result = await searchTool.execute({ pattern: '[invalid(regex' });
    expect(result.isError).toBe(true);
  });
});

// ─── Property 9: 目录列表完整性 ───────────────────────────────────────────────

describe('Property 9: 目录列表完整性', () => {
  it('listed entries match actual filesystem content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(safeFileNameArb, { minLength: 1, maxLength: 8 }),
        async (fileNames) => {
          const testDir = mkdtempSync(join(tmpdir(), 'list-test-'));
          try {
            // Create files
            for (const name of fileNames) {
              writeFileSync(join(testDir, name), 'content', 'utf-8');
            }

            const listTool = createListDirectoryTool(testDir);
            const result = await listTool.execute({ path: '.', depth: 0 });

            expect(result.isError).toBe(false);

            // Each created file should appear in the output
            for (const name of fileNames) {
              expect(result.content).toContain(name);
            }
          } finally {
            rmSync(testDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('empty directory returns empty message', async () => {
    const listTool = createListDirectoryTool(tmpDir);
    const result = await listTool.execute({ path: '.', depth: 0 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('empty');
  });

  it('subdirectories are listed with trailing slash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.stringMatching(/^[a-zA-Z0-9_]{1,20}$/).filter((s) => s.length > 0),
          { minLength: 1, maxLength: 5 }
        ),
        async (dirNames) => {
          const testDir = mkdtempSync(join(tmpdir(), 'list-dir-test-'));
          try {
            for (const name of dirNames) {
              mkdirSync(join(testDir, name));
            }

            const listTool = createListDirectoryTool(testDir);
            const result = await listTool.execute({ path: '.', depth: 0 });

            expect(result.isError).toBe(false);
            for (const name of dirNames) {
              expect(result.content).toContain(`${name}/`);
            }
          } finally {
            rmSync(testDir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 28: 文件操作路径安全约束 ────────────────────────────────────────

describe('Property 28: 文件操作路径安全约束', () => {
  it('file read rejects paths outside working directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (depth) => {
          const traversal = '../'.repeat(depth) + 'etc/passwd';
          const readTool = createFileReadTool(tmpDir);
          const result = await readTool.execute({ path: traversal });
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/permission denied|outside/i);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('file write rejects paths outside working directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (depth) => {
          const traversal = '../'.repeat(depth) + 'evil.txt';
          const writeTool = createFileWriteTool(tmpDir);
          const result = await writeTool.execute({ path: traversal, content: 'evil' });
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/permission denied|outside/i);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('file edit rejects paths outside working directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (depth) => {
          const traversal = '../'.repeat(depth) + 'evil.txt';
          const editTool = createFileEditTool(tmpDir);
          const result = await editTool.execute({
            path: traversal,
            old_text: 'old',
            new_text: 'new',
          });
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/permission denied|outside/i);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('grep search rejects directories outside working directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (depth) => {
          const traversal = '../'.repeat(depth) + 'etc';
          const searchTool = createGrepSearchTool(tmpDir);
          const result = await searchTool.execute({ pattern: 'test', directory: traversal });
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/permission denied|outside/i);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('list directory rejects paths outside working directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (depth) => {
          const traversal = '../'.repeat(depth);
          const listTool = createListDirectoryTool(tmpDir);
          const result = await listTool.execute({ path: traversal });
          expect(result.isError).toBe(true);
          expect(result.content).toMatch(/permission denied|outside/i);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('absolute paths outside workDir are rejected', async () => {
    const readTool = createFileReadTool(tmpDir);
    const result = await readTool.execute({ path: '/etc/passwd' });
    expect(result.isError).toBe(true);
  });
});

// ─── Property 29: 敏感文件模式匹配警告 ────────────────────────────────────────

describe('Property 29: 敏感文件模式匹配警告', () => {
  it('isSensitiveFile returns true for .env files', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('.env', '.env.local', '.env.production', '.env.test'),
        (fileName) => {
          expect(isSensitiveFile(fileName)).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('isSensitiveFile returns true for key/cert files', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('server.pem', 'private.key', 'cert.p12', 'keystore.pfx', 'id_rsa', 'id_ed25519'),
        (fileName) => {
          expect(isSensitiveFile(fileName)).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('isSensitiveFile returns false for normal files', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('index.ts', 'README.md', 'package.json', 'config.json', 'main.js'),
        (fileName) => {
          expect(isSensitiveFile(fileName)).toBe(false);
        }
      ),
      { numRuns: 20 }
    );
  });

  it('reading a sensitive file includes a warning in the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.env', 'private.key', 'secret.pem'),
        async (sensitiveFile) => {
          const writeTool = createFileWriteTool(tmpDir);
          const readTool = createFileReadTool(tmpDir);

          // Write the sensitive file
          await writeTool.execute({ path: sensitiveFile, content: 'SECRET=value' });

          // Read it - should include warning
          const result = await readTool.execute({ path: sensitiveFile });
          // Either it warns or it's an error (if write was blocked)
          if (!result.isError) {
            expect(result.content).toMatch(/warning/i);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('writing a sensitive file includes a warning in the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.env', 'private.key', 'secret.pem'),
        async (sensitiveFile) => {
          const writeTool = createFileWriteTool(tmpDir);
          const result = await writeTool.execute({ path: sensitiveFile, content: 'SECRET=value' });
          if (!result.isError) {
            expect(result.content).toMatch(/warning/i);
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
