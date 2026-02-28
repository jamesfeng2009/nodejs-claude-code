import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('fs/promises');
import * as fs from 'fs/promises';

import { loadMemoryFiles, formatMemorySection } from '../../src/context/memory-loader.js';

// Helper to create an ENOENT error
function enoent(filePath: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), {
    code: 'ENOENT',
  });
}

// Helper to create an EACCES (permission) error
function eacces(filePath: string): Error {
  return Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), {
    code: 'EACCES',
  });
}

describe('loadMemoryFiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array when no CLAUDE.md exists anywhere in the tree', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    expect(result).toEqual([]);
  });

  it('returns a single file when only the workDir has CLAUDE.md', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (filePath === '/tmp/a/b/c/CLAUDE.md') return 'inner content';
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    expect(result).toHaveLength(1);
    expect(result[0].absolutePath).toBe('/tmp/a/b/c/CLAUDE.md');
    expect(result[0].content).toBe('inner content');
  });

  it('returns files in root-first order (outermost → innermost)', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (filePath === '/tmp/a/CLAUDE.md') return 'root content';
      if (filePath === '/tmp/a/b/c/CLAUDE.md') return 'inner content';
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    expect(result).toHaveLength(2);
    // Outermost (/tmp/a) must come first
    expect(result[0].absolutePath).toBe('/tmp/a/CLAUDE.md');
    expect(result[0].content).toBe('root content');
    expect(result[1].absolutePath).toBe('/tmp/a/b/c/CLAUDE.md');
    expect(result[1].content).toBe('inner content');
  });

  it('skips a file with a permission error and continues loading others', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (filePath === '/tmp/a/CLAUDE.md') return 'root content';
      if (filePath === '/tmp/a/b/CLAUDE.md') throw eacces(String(filePath));
      if (filePath === '/tmp/a/b/c/CLAUDE.md') return 'inner content';
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    // The permission-denied file (/tmp/a/b) is skipped; the other two are loaded
    expect(result).toHaveLength(2);
    expect(result[0].absolutePath).toBe('/tmp/a/CLAUDE.md');
    expect(result[1].absolutePath).toBe('/tmp/a/b/c/CLAUDE.md');
  });

  it('skips an empty CLAUDE.md file', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (filePath === '/tmp/a/b/c/CLAUDE.md') return '   \n  '; // whitespace-only
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    expect(result).toEqual([]);
  });

  it('skips an empty file but still loads a non-empty sibling ancestor', async () => {
    vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
      if (filePath === '/tmp/a/CLAUDE.md') return 'root content';
      if (filePath === '/tmp/a/b/c/CLAUDE.md') return '';
      throw enoent(String(filePath));
    });

    const result = await loadMemoryFiles('/tmp/a/b/c');
    expect(result).toHaveLength(1);
    expect(result[0].absolutePath).toBe('/tmp/a/CLAUDE.md');
  });
});

describe('formatMemorySection', () => {
  it('returns empty string for an empty files array', () => {
    expect(formatMemorySection([])).toBe('');
  });

  it('formats a single file with the correct header and content', () => {
    const files = [{ absolutePath: '/project/CLAUDE.md', content: 'hello world' }];
    const output = formatMemorySection(files);
    expect(output).toContain('## Project Memory (CLAUDE.md)');
    expect(output).toContain('--- CLAUDE.md: /project/CLAUDE.md ---');
    expect(output).toContain('hello world');
  });

  it('formats multiple files with each path header present', () => {
    const files = [
      { absolutePath: '/CLAUDE.md', content: 'outer' },
      { absolutePath: '/project/CLAUDE.md', content: 'inner' },
    ];
    const output = formatMemorySection(files);
    expect(output).toContain('--- CLAUDE.md: /CLAUDE.md ---');
    expect(output).toContain('outer');
    expect(output).toContain('--- CLAUDE.md: /project/CLAUDE.md ---');
    expect(output).toContain('inner');
    // Outer must appear before inner in the output
    expect(output.indexOf('outer')).toBeLessThan(output.indexOf('inner'));
  });
});
