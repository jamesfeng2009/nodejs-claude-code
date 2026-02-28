import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PermissionChecker, DEFAULT_PERMISSION_CONFIG } from '../../src/context/permission-checker.js';

// Mock fs/promises so no real file I/O occurs
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
    },
  };
});

import * as fs from 'fs';

const mockReadFile = fs.promises.readFile as ReturnType<typeof vi.fn>;

describe('PermissionChecker', () => {
  const workDir = '/fake/workdir';
  let checker: PermissionChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    checker = new PermissionChecker(workDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── load() ──────────────────────────────────────────────────────────────────

  describe('load() — valid JSON', () => {
    it('parses allowlist, denylist, and pathWhitelist correctly', async () => {
      const config = {
        allowlist: ['file_read', 'file_write'],
        denylist: ['shell_execute'],
        pathWhitelist: ['src/**', '*.json'],
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(config));

      await checker.load();

      const result = checker.getConfig();
      expect(result.allowlist).toEqual(['file_read', 'file_write']);
      expect(result.denylist).toEqual(['shell_execute']);
      expect(result.pathWhitelist).toEqual(['src/**', '*.json']);
    });

    it('parses empty arrays correctly', async () => {
      const config = { allowlist: [], denylist: [], pathWhitelist: [] };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(config));

      await checker.load();

      const result = checker.getConfig();
      expect(result).toEqual(DEFAULT_PERMISSION_CONFIG);
    });

    it('defaults missing fields to empty arrays', async () => {
      // Only denylist provided
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ denylist: ['shell_execute'] }));

      await checker.load();

      const result = checker.getConfig();
      expect(result.allowlist).toEqual([]);
      expect(result.denylist).toEqual(['shell_execute']);
      expect(result.pathWhitelist).toEqual([]);
    });
  });

  describe('load() — missing file', () => {
    it('applies default allow-all policy when file does not exist', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);

      await checker.load();

      expect(checker.getConfig()).toEqual(DEFAULT_PERMISSION_CONFIG);
    });

    it('does not throw when file is missing', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);

      await expect(checker.load()).resolves.toBeUndefined();
    });
  });

  describe('load() — invalid JSON', () => {
    it('applies default policy when JSON is malformed', async () => {
      mockReadFile.mockResolvedValueOnce('{ not valid json !!');

      await checker.load();

      expect(checker.getConfig()).toEqual(DEFAULT_PERMISSION_CONFIG);
    });

    it('logs an error when JSON is invalid', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockReadFile.mockResolvedValueOnce('{ bad json }');

      await checker.load();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('applies default policy when JSON root is not an object', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify([1, 2, 3]));

      await checker.load();

      expect(checker.getConfig()).toEqual(DEFAULT_PERMISSION_CONFIG);
    });
  });

  // ── check() — denylist ───────────────────────────────────────────────────────

  describe('check() — denylist blocks tool execution', () => {
    beforeEach(async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: [], denylist: ['shell_execute'], pathWhitelist: [] })
      );
      await checker.load();
    });

    it('returns allowed: false for a tool in the denylist', () => {
      const result = checker.check('shell_execute', {});
      expect(result.allowed).toBe(false);
    });

    it('includes an error message when tool is denied', () => {
      const result = checker.check('shell_execute', {});
      expect(result.reason).toBeTruthy();
      expect(result.reason).toContain('shell_execute');
    });

    it('allows a tool not in the denylist', () => {
      const result = checker.check('file_read', {});
      expect(result.allowed).toBe(true);
    });
  });

  // ── check() — allowlist ──────────────────────────────────────────────────────

  describe('check() — non-empty allowlist blocks unlisted tool', () => {
    beforeEach(async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: ['file_read', 'file_write'], denylist: [], pathWhitelist: [] })
      );
      await checker.load();
    });

    it('returns allowed: false for a tool not in the allowlist', () => {
      const result = checker.check('shell_execute', {});
      expect(result.allowed).toBe(false);
    });

    it('includes an error message when tool is not in allowlist', () => {
      const result = checker.check('shell_execute', {});
      expect(result.reason).toBeTruthy();
      expect(result.reason).toContain('shell_execute');
    });

    it('allows a tool that is in the allowlist', () => {
      const result = checker.check('file_read', {});
      expect(result.allowed).toBe(true);
    });

    it('allows all tools when allowlist is empty', async () => {
      const checker2 = new PermissionChecker(workDir);
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: [], denylist: [], pathWhitelist: [] })
      );
      await checker2.load();

      expect(checker2.check('any_tool', {}).allowed).toBe(true);
    });
  });

  // ── check() — path whitelist ─────────────────────────────────────────────────

  describe('check() — path whitelist blocks non-matching path', () => {
    beforeEach(async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: [], denylist: [], pathWhitelist: ['src/**', 'tests/**'] })
      );
      await checker.load();
    });

    it('blocks file_write to a path not matching any pattern', () => {
      const result = checker.check('file_write', { path: 'dist/output.js' });
      expect(result.allowed).toBe(false);
    });

    it('includes an error message mentioning the blocked path', () => {
      const result = checker.check('file_write', { path: 'dist/output.js' });
      expect(result.reason).toBeTruthy();
      expect(result.reason).toContain('dist/output.js');
    });

    it('allows file_write to a path matching a pattern', () => {
      const result = checker.check('file_write', { path: 'src/utils/helper.ts' });
      expect(result.allowed).toBe(true);
    });

    it('allows file_edit to a path matching a pattern', () => {
      const result = checker.check('file_edit', { path: 'tests/unit/foo.test.ts' });
      expect(result.allowed).toBe(true);
    });

    it('blocks file_edit to a path not matching any pattern', () => {
      const result = checker.check('file_edit', { path: 'node_modules/pkg/index.js' });
      expect(result.allowed).toBe(false);
    });

    it('does not apply path check to non-file-operation tools', () => {
      // shell_execute is not a file operation tool — path whitelist should not apply
      const result = checker.check('shell_execute', { path: 'dist/output.js' });
      expect(result.allowed).toBe(true);
    });
  });

  describe('check() — empty path whitelist allows all paths', () => {
    beforeEach(async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: [], denylist: [], pathWhitelist: [] })
      );
      await checker.load();
    });

    it('allows file_write to any path when pathWhitelist is empty', () => {
      expect(checker.check('file_write', { path: 'anywhere/file.ts' }).allowed).toBe(true);
    });

    it('allows file_edit to any path when pathWhitelist is empty', () => {
      expect(checker.check('file_edit', { path: '/absolute/path/file.ts' }).allowed).toBe(true);
    });
  });

  // ── check() — denylist takes precedence over allowlist ───────────────────────

  describe('check() — denylist takes precedence over allowlist', () => {
    beforeEach(async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          allowlist: ['shell_execute', 'file_read'],
          denylist: ['shell_execute'],
          pathWhitelist: [],
        })
      );
      await checker.load();
    });

    it('denies a tool that appears in both allowlist and denylist', () => {
      const result = checker.check('shell_execute', {});
      expect(result.allowed).toBe(false);
    });

    it('still allows a tool that is only in the allowlist', () => {
      const result = checker.check('file_read', {});
      expect(result.allowed).toBe(true);
    });

    it('error message references the denied tool name', () => {
      const result = checker.check('shell_execute', {});
      expect(result.reason).toContain('shell_execute');
    });
  });

  // ── DEFAULT_PERMISSION_CONFIG ────────────────────────────────────────────────

  describe('DEFAULT_PERMISSION_CONFIG', () => {
    it('has empty allowlist, denylist, and pathWhitelist', () => {
      expect(DEFAULT_PERMISSION_CONFIG.allowlist).toEqual([]);
      expect(DEFAULT_PERMISSION_CONFIG.denylist).toEqual([]);
      expect(DEFAULT_PERMISSION_CONFIG.pathWhitelist).toEqual([]);
    });
  });

  // ── getConfig() ──────────────────────────────────────────────────────────────

  describe('getConfig()', () => {
    it('returns default config before load() is called', () => {
      expect(checker.getConfig()).toEqual(DEFAULT_PERMISSION_CONFIG);
    });

    it('returns a new object each call (top-level copy)', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ allowlist: ['file_read'], denylist: [], pathWhitelist: [] })
      );
      await checker.load();

      const config1 = checker.getConfig();
      const config2 = checker.getConfig();
      expect(config1).not.toBe(config2);
    });
  });
});
