import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFileWriteTool } from '../../src/tools/implementations/file-write.js';
import { createFileEditTool } from '../../src/tools/implementations/file-edit.js';
import type { ContextManager } from '../../src/context/context-manager.js';
import type { HybridRetriever } from '../../src/retrieval/hybrid-retriever.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-update-test-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('F11 — index update integration', () => {
  let dir: string;
  let cleanup: () => void;
  let mockContextManager: ContextManager;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());

    mockContextManager = {
      invalidateAndReindex: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContextManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  // ── createFileWriteTool ───────────────────────────────────────────────────

  describe('createFileWriteTool', () => {
    it('calls invalidateAndReindex after successful write', async () => {
      const tool = createFileWriteTool(dir, undefined, mockContextManager);
      const filePath = 'hello.ts';
      const absPath = path.resolve(dir, filePath);

      const result = await tool.execute({ path: filePath, content: 'const x = 1;' });

      expect(result.isError).toBe(false);
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledOnce();
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledWith(absPath);
    });

    it('does not call invalidateAndReindex when contextManager is undefined', async () => {
      const tool = createFileWriteTool(dir, undefined, undefined);

      const result = await tool.execute({ path: 'no-ctx.ts', content: 'export {}' });

      expect(result.isError).toBe(false);
      // No mock to assert on — just ensure no crash occurred
    });

    it('creates a new file and indexes it', async () => {
      const newFile = 'brand-new.ts';
      const absPath = path.resolve(dir, newFile);

      // Ensure file does not exist yet
      expect(fs.existsSync(absPath)).toBe(false);

      const tool = createFileWriteTool(dir, undefined, mockContextManager);
      const result = await tool.execute({ path: newFile, content: 'export const answer = 42;' });

      expect(result.isError).toBe(false);
      expect(fs.existsSync(absPath)).toBe(true);
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledWith(absPath);
    });
  });

  // ── createFileEditTool ────────────────────────────────────────────────────

  describe('createFileEditTool', () => {
    it('calls invalidateAndReindex after successful replace edit', async () => {
      const filePath = 'edit-me.ts';
      const absPath = path.resolve(dir, filePath);
      fs.writeFileSync(absPath, 'const foo = 1;\nconst bar = 2;\n', 'utf-8');

      const tool = createFileEditTool(dir, undefined, mockContextManager);
      const result = await tool.execute({
        path: filePath,
        old_text: 'const foo = 1;',
        new_text: 'const foo = 99;',
      });

      expect(result.isError).toBe(false);
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledOnce();
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledWith(absPath);
    });

    it('calls invalidateAndReindex after successful insert edit', async () => {
      const filePath = 'insert-me.ts';
      const absPath = path.resolve(dir, filePath);
      fs.writeFileSync(absPath, 'line1\nline2\nline3\n', 'utf-8');

      const tool = createFileEditTool(dir, undefined, mockContextManager);
      const result = await tool.execute({
        path: filePath,
        operation: 'insert',
        line: 1,
        insert_position: 'after',
        content: '// inserted comment',
        old_text: '',
        new_text: '',
      });

      expect(result.isError).toBe(false);
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledOnce();
      expect(mockContextManager.invalidateAndReindex).toHaveBeenCalledWith(absPath);
    });

    it('does not call invalidateAndReindex when contextManager is undefined', async () => {
      const filePath = 'no-ctx-edit.ts';
      const absPath = path.resolve(dir, filePath);
      fs.writeFileSync(absPath, 'const a = 1;\n', 'utf-8');

      const tool = createFileEditTool(dir, undefined, undefined);
      const result = await tool.execute({
        path: filePath,
        old_text: 'const a = 1;',
        new_text: 'const a = 2;',
      });

      expect(result.isError).toBe(false);
      // No crash — contextManager was undefined
    });
  });

  // ── invalidateAndReindex: deleted file ────────────────────────────────────

  describe('invalidateAndReindex: removes entries for deleted file without re-indexing', () => {
    it('calls removeChunksByFile but not indexChunks when file does not exist', async () => {
      // Build a minimal mock HybridRetriever
      const mockRetriever = {
        removeChunksByFile: vi.fn().mockResolvedValue(undefined),
        indexChunks: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
      } as unknown as HybridRetriever;

      // Import the real ContextManager to test invalidateAndReindex directly
      const { ContextManager } = await import('../../src/context/context-manager.js');

      const cm = new ContextManager(
        mockRetriever,
        {} as never, // entityCache not needed for this test
        { maxChunkSize: 100, overlapLines: 2, toolOutputMaxLines: 50 }
      );

      const nonExistentPath = path.join(dir, 'deleted-file.ts');
      // Ensure it really doesn't exist
      expect(fs.existsSync(nonExistentPath)).toBe(false);

      await cm.invalidateAndReindex(nonExistentPath);

      expect(mockRetriever.removeChunksByFile).toHaveBeenCalledOnce();
      expect(mockRetriever.removeChunksByFile).toHaveBeenCalledWith(nonExistentPath);
      expect(mockRetriever.indexChunks).not.toHaveBeenCalled();
    });
  });
});
