import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createFileEditTool } from '../../../src/tools/implementations/file-edit.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'file-edit-insert-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeLines(dir: string, name: string, lines: string[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8').split('\n');
}

describe('file_edit tool — insert operation', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  // ── Basic insert after ───────────────────────────────────────────────────────

  it('insert after: inserts line after target line in middle of file', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2', 'line3', 'line4']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 2,
      insert_position: 'after',
      content: 'inserted',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully inserted 1 line(s) at line 3 in 'test.txt'");
    expect(readLines(dir + '/test.txt')).toEqual(['line1', 'line2', 'inserted', 'line3', 'line4']);
  });

  // ── Basic insert before ──────────────────────────────────────────────────────

  it('insert before: inserts line before target line in middle of file', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2', 'line3', 'line4']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 3,
      insert_position: 'before',
      content: 'inserted',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully inserted 1 line(s) at line 3 in 'test.txt'");
    expect(readLines(dir + '/test.txt')).toEqual(['line1', 'line2', 'inserted', 'line3', 'line4']);
  });

  // ── Insert after last line (append) ─────────────────────────────────────────

  it('insert after last line appends to end of file', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2', 'line3']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 3,
      insert_position: 'after',
      content: 'appended',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully inserted 1 line(s) at line 4 in 'test.txt'");
    expect(readLines(dir + '/test.txt')).toEqual(['line1', 'line2', 'line3', 'appended']);
  });

  // ── Multi-line content ───────────────────────────────────────────────────────

  it('inserts multiple lines and reports correct range', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2', 'line3']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 1,
      insert_position: 'after',
      content: 'new1\nnew2\nnew3',
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Successfully inserted 3 line(s) at line 2..4 in 'test.txt'");
    expect(readLines(dir + '/test.txt')).toEqual(['line1', 'new1', 'new2', 'new3', 'line2', 'line3']);
  });

  // ── Error: missing line param ────────────────────────────────────────────────

  it('returns error when line param is missing', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      insert_position: 'after',
      content: 'new line',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('line parameter is required for insert operation');
  });

  // ── Error: line < 1 ─────────────────────────────────────────────────────────

  it('returns error when line is less than 1', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 0,
      insert_position: 'after',
      content: 'new line',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('line must be a positive integer');
  });

  // ── Error: line > N ──────────────────────────────────────────────────────────

  it('returns error when line exceeds file length', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2', 'line3']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 10,
      insert_position: 'after',
      content: 'new line',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('line 10 exceeds file length 3');
  });

  // ── Error: invalid insert_position ──────────────────────────────────────────

  it('returns error when insert_position is invalid', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 1,
      insert_position: 'middle',
      content: 'new line',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(`insert_position must be 'before' or 'after'`);
  });

  it('returns error when insert_position is missing', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 1,
      content: 'new line',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(`insert_position must be 'before' or 'after'`);
  });

  // ── Error: empty content ─────────────────────────────────────────────────────

  it('returns error when content is empty string', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 1,
      insert_position: 'after',
      content: '',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('insert content must not be empty');
  });

  // ── Error: missing content ───────────────────────────────────────────────────

  it('returns error when content is missing', async () => {
    writeLines(dir, 'test.txt', ['line1', 'line2']);
    const tool = createFileEditTool(dir);

    const result = await tool.execute({
      path: 'test.txt',
      operation: 'insert',
      line: 1,
      insert_position: 'after',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('insert content must not be empty');
  });
});
