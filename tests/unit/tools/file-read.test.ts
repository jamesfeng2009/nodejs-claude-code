import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileReadTool } from '../../../src/tools/implementations/file-read.js';

// Helper: create a temp dir and return its path + cleanup fn
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `file-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Helper: write lines to a file and return the path
function writeLines(dir: string, name: string, lines: string[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

describe('file_read tool — line range support', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  // ── Regression: no range returns full content without line prefixes ──────────

  describe('neither start_line nor end_line (regression)', () => {
    it('returns full file content without line prefixes', async () => {
      const lines = ['alpha', 'beta', 'gamma'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt' });
      expect(result.isError).toBe(false);
      expect(result.content).toBe(lines.join('\n'));
    });

    it('does not add line prefixes for small files', async () => {
      writeLines(dir, 'test.txt', ['line1', 'line2']);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt' });
      expect(result.content).not.toMatch(/^\s*\d+ \| /m);
    });
  });

  // ── start_line only ──────────────────────────────────────────────────────────

  describe('start_line only', () => {
    it('returns from start_line to end of file', async () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 3 });
      expect(result.isError).toBe(false);
      // Should contain lines 3,4,5 (c,d,e)
      expect(result.content).toContain('c');
      expect(result.content).toContain('d');
      expect(result.content).toContain('e');
      // Should NOT contain lines 1,2
      const outputLines = result.content.split('\n');
      expect(outputLines).toHaveLength(3);
    });

    it('prefixes each line with its absolute line number', async () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 3 });
      const outputLines = result.content.split('\n');
      // Line numbers should be 3, 4, 5
      expect(outputLines[0]).toMatch(/^\s*3 \| c$/);
      expect(outputLines[1]).toMatch(/^\s*4 \| d$/);
      expect(outputLines[2]).toMatch(/^\s*5 \| e$/);
    });

    it('start_line = 1 returns entire file with prefixes', async () => {
      const lines = ['x', 'y', 'z'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 1 });
      expect(result.isError).toBe(false);
      expect(result.content.split('\n')).toHaveLength(3);
    });
  });

  // ── end_line only ────────────────────────────────────────────────────────────

  describe('end_line only', () => {
    it('returns from line 1 to end_line', async () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', end_line: 3 });
      expect(result.isError).toBe(false);
      const outputLines = result.content.split('\n');
      expect(outputLines).toHaveLength(3);
    });

    it('prefixes each line with its absolute line number starting from 1', async () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', end_line: 3 });
      const outputLines = result.content.split('\n');
      expect(outputLines[0]).toMatch(/^\s*1 \| a$/);
      expect(outputLines[1]).toMatch(/^\s*2 \| b$/);
      expect(outputLines[2]).toMatch(/^\s*3 \| c$/);
    });
  });

  // ── both start_line and end_line ─────────────────────────────────────────────

  describe('both start_line and end_line', () => {
    it('returns closed interval [start_line, end_line]', async () => {
      const lines = ['a', 'b', 'c', 'd', 'e'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 2, end_line: 4 });
      expect(result.isError).toBe(false);
      const outputLines = result.content.split('\n');
      expect(outputLines).toHaveLength(3);
      expect(outputLines[0]).toMatch(/^\s*2 \| b$/);
      expect(outputLines[1]).toMatch(/^\s*3 \| c$/);
      expect(outputLines[2]).toMatch(/^\s*4 \| d$/);
    });

    it('single line range (start_line === end_line) returns exactly one line', async () => {
      const lines = ['a', 'b', 'c'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 2, end_line: 2 });
      expect(result.isError).toBe(false);
      const outputLines = result.content.split('\n');
      expect(outputLines).toHaveLength(1);
      expect(outputLines[0]).toMatch(/^\s*2 \| b$/);
    });
  });

  // ── Line prefix format ───────────────────────────────────────────────────────

  describe('line prefix format', () => {
    it('right-aligns line numbers to the width of the last line number', async () => {
      // 10-line file: last line number is 10 (width 2), so line 1 should be " 1 | "
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 1, end_line: 10 });
      const outputLines = result.content.split('\n');
      // Line 1 should be padded to width 2: " 1 | line1"
      expect(outputLines[0]).toBe(' 1 | line1');
      // Line 10 should be "10 | line10"
      expect(outputLines[9]).toBe('10 | line10');
    });

    it('uses width of total file lines, not just the range', async () => {
      // 100-line file, reading lines 1-2: width should be 3 (for "100")
      const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 1, end_line: 2 });
      const outputLines = result.content.split('\n');
      // Width = 3 (digits of 100), so line 1 = "  1 | L1"
      expect(outputLines[0]).toBe('  1 | L1');
      expect(outputLines[1]).toBe('  2 | L2');
    });
  });

  // ── Error conditions ─────────────────────────────────────────────────────────

  describe('error conditions', () => {
    it('returns isError: true when start_line < 1', async () => {
      writeLines(dir, 'test.txt', ['a', 'b', 'c']);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 0 });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/start_line must be a positive integer/i);
    });

    it('returns isError: true when start_line is negative', async () => {
      writeLines(dir, 'test.txt', ['a', 'b', 'c']);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: -5 });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/start_line must be a positive integer/i);
    });

    it('returns isError: true when end_line < start_line', async () => {
      writeLines(dir, 'test.txt', ['a', 'b', 'c']);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 3, end_line: 1 });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/end_line must be >= start_line/i);
    });

    it('returns isError: true when start_line > N (total lines)', async () => {
      const lines = ['a', 'b', 'c']; // N = 3
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 10 });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/start_line 10 exceeds file length 3/i);
    });
  });

  // ── end_line > N: silent clamp ───────────────────────────────────────────────

  describe('end_line > N (clamp to N)', () => {
    it('silently clamps end_line to last line and returns no error', async () => {
      const lines = ['a', 'b', 'c']; // N = 3
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', start_line: 1, end_line: 999 });
      expect(result.isError).toBe(false);
      const outputLines = result.content.split('\n');
      // Should return all 3 lines
      expect(outputLines).toHaveLength(3);
    });

    it('clamps when only end_line is provided and exceeds N', async () => {
      const lines = ['a', 'b', 'c'];
      writeLines(dir, 'test.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'test.txt', end_line: 100 });
      expect(result.isError).toBe(false);
      expect(result.content.split('\n')).toHaveLength(3);
    });
  });

  // ── Large file notice (> 500 lines) ─────────────────────────────────────────

  describe('large file notice', () => {
    it('prepends notice with line count when file > 500 lines and no range given', async () => {
      const lines = Array.from({ length: 501 }, (_, i) => `line${i + 1}`);
      writeLines(dir, 'big.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'big.txt' });
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/501/);
      expect(result.content).toMatch(/start_line.*end_line|end_line.*start_line/i);
    });

    it('does NOT prepend notice when file > 500 lines but a range is given', async () => {
      const lines = Array.from({ length: 501 }, (_, i) => `line${i + 1}`);
      writeLines(dir, 'big.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'big.txt', start_line: 1, end_line: 5 });
      expect(result.isError).toBe(false);
      // Notice should not appear
      expect(result.content).not.toMatch(/Notice:/i);
      expect(result.content).not.toMatch(/lines\. Consider/i);
    });

    it('does NOT prepend notice for files with exactly 500 lines and no range', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line${i + 1}`);
      writeLines(dir, 'exact500.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'exact500.txt' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toMatch(/Notice:/i);
    });

    it('does NOT prepend notice when only start_line is given on a large file', async () => {
      const lines = Array.from({ length: 501 }, (_, i) => `line${i + 1}`);
      writeLines(dir, 'big.txt', lines);
      const tool = createFileReadTool(dir);
      const result = await tool.execute({ path: 'big.txt', start_line: 490 });
      expect(result.isError).toBe(false);
      expect(result.content).not.toMatch(/Notice:/i);
    });
  });
});
