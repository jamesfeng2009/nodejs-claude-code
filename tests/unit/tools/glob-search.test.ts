import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createGlobSearchTool } from '../../../src/tools/implementations/glob-search.js';

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `glob-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function touch(dir: string, relPath: string): void {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '', 'utf-8');
}

describe('glob_search tool', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
  });

  afterEach(() => {
    cleanup();
  });

  // ── Empty pattern ────────────────────────────────────────────────────────────

  describe('empty pattern', () => {
    it('returns isError: true with message when pattern is empty string', async () => {
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/pattern must not be empty/i);
    });

    it('returns isError: true when pattern is whitespace only', async () => {
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '   ' });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/pattern must not be empty/i);
    });
  });

  // ── No matches ───────────────────────────────────────────────────────────────

  describe('no matches', () => {
    it('returns isError: false with no-match message when nothing matches', async () => {
      touch(dir, 'hello.txt');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.xyz' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No files found matching pattern '**/*.xyz'");
    });

    it('returns isError: false with no-match message in empty directory', async () => {
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('No files found matching pattern');
    });
  });

  // ── Basic matching ───────────────────────────────────────────────────────────

  describe('basic pattern matching', () => {
    it('matches TypeScript files with **/*.ts pattern', async () => {
      touch(dir, 'src/foo.ts');
      touch(dir, 'src/bar.ts');
      touch(dir, 'src/baz.js');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('src/foo.ts');
      expect(result.content).toContain('src/bar.ts');
      expect(result.content).not.toContain('src/baz.js');
    });

    it('matches files in root with simple pattern', async () => {
      touch(dir, 'README.md');
      touch(dir, 'package.json');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '*.md' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('README.md');
      expect(result.content).not.toContain('package.json');
    });
  });

  // ── Alphabetical sorting ─────────────────────────────────────────────────────

  describe('alphabetical sorting', () => {
    it('returns results sorted in ascending lexicographic order', async () => {
      touch(dir, 'z.ts');
      touch(dir, 'a.ts');
      touch(dir, 'm.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '*.ts' });
      expect(result.isError).toBe(false);
      const lines = result.content.split('\n');
      expect(lines).toEqual(['a.ts', 'm.ts', 'z.ts']);
    });

    it('sorts nested paths lexicographically', async () => {
      touch(dir, 'src/z/file.ts');
      touch(dir, 'src/a/file.ts');
      touch(dir, 'lib/file.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts' });
      expect(result.isError).toBe(false);
      const lines = result.content.split('\n').filter(l => !l.startsWith('Results'));
      expect(lines).toEqual(['lib/file.ts', 'src/a/file.ts', 'src/z/file.ts']);
    });
  });

  // ── > 200 results truncation ─────────────────────────────────────────────────

  describe('truncation at 200 results', () => {
    it('returns first 200 results and appends truncation notice when > 200 matches', async () => {
      // Create 210 .ts files
      for (let i = 0; i < 210; i++) {
        touch(dir, `file${String(i).padStart(3, '0')}.ts`);
      }
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '*.ts' });
      expect(result.isError).toBe(false);

      const lines = result.content.split('\n');
      // Last line is the truncation notice
      const notice = lines[lines.length - 1];
      expect(notice).toMatch(/Results truncated\. Found 210 total matches, showing first 200\./);

      // Exactly 200 file paths + 1 notice line
      expect(lines).toHaveLength(201);
    });

    it('does NOT append truncation notice when exactly 200 matches', async () => {
      for (let i = 0; i < 200; i++) {
        touch(dir, `file${String(i).padStart(3, '0')}.ts`);
      }
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '*.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('Results truncated');
      expect(result.content.split('\n')).toHaveLength(200);
    });
  });

  // ── Noise directory exclusion ────────────────────────────────────────────────

  describe('noise directory exclusion', () => {
    it('excludes files inside node_modules', async () => {
      touch(dir, 'node_modules/lodash/index.js');
      touch(dir, 'src/index.js');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.js' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('src/index.js');
      expect(result.content).not.toContain('node_modules');
    });

    it('excludes files inside .git', async () => {
      touch(dir, '.git/config');
      touch(dir, 'src/config.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('.git');
      expect(result.content).toContain('src/config.ts');
    });

    it('excludes files inside dist', async () => {
      touch(dir, 'dist/bundle.js');
      touch(dir, 'src/app.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.js' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('dist');
    });

    it('excludes files inside build', async () => {
      touch(dir, 'build/output.js');
      touch(dir, 'src/app.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.js' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('build');
    });

    it('excludes all four noise dirs simultaneously', async () => {
      touch(dir, 'node_modules/pkg/index.js');
      touch(dir, '.git/HEAD');
      touch(dir, 'dist/main.js');
      touch(dir, 'build/out.js');
      touch(dir, 'src/real.js');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('node_modules');
      expect(result.content).not.toContain('.git');
      expect(result.content).not.toContain('dist/');
      expect(result.content).not.toContain('build/');
      expect(result.content).toContain('src/real.js');
    });
  });

  // ── exclude parameter ────────────────────────────────────────────────────────

  describe('exclude parameter', () => {
    it('omits files matching the exclude pattern', async () => {
      touch(dir, 'src/foo.test.ts');
      touch(dir, 'src/foo.ts');
      touch(dir, 'src/bar.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts', exclude: '**/*.test.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('foo.test.ts');
      expect(result.content).toContain('src/foo.ts');
      expect(result.content).toContain('src/bar.ts');
    });

    it('applies exclude on top of noise dir exclusions', async () => {
      touch(dir, 'node_modules/pkg/index.ts');
      touch(dir, 'src/foo.ts');
      touch(dir, 'src/foo.spec.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts', exclude: '**/*.spec.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).not.toContain('node_modules');
      expect(result.content).not.toContain('.spec.ts');
      expect(result.content).toContain('src/foo.ts');
    });

    it('returns no-match message when exclude filters out all results', async () => {
      touch(dir, 'src/foo.test.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts', exclude: '**/*.test.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('No files found matching pattern');
    });

    it('without exclude, does not filter non-noise files', async () => {
      touch(dir, 'src/foo.test.ts');
      touch(dir, 'src/bar.ts');
      const tool = createGlobSearchTool(dir);
      const result = await tool.execute({ pattern: '**/*.ts' });
      expect(result.isError).toBe(false);
      expect(result.content).toContain('src/foo.test.ts');
      expect(result.content).toContain('src/bar.ts');
    });
  });
});
