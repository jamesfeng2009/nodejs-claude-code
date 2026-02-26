import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPL } from '../../../src/cli/repl.js';
import type { OrchestratorAgent } from '../../../src/agent/orchestrator.js';
import type { StreamingRenderer } from '../../../src/cli/streaming-renderer.js';

// Minimal mock orchestrator — processMessage is never called in these tests
function makeOrchestrator(): OrchestratorAgent {
  return {
    processMessage: vi.fn().mockReturnValue((async function* () {})()),
    clearConversation: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
  } as unknown as OrchestratorAgent;
}

// Minimal mock renderer
function makeRenderer(): StreamingRenderer {
  return {
    renderToken: vi.fn(),
    renderToolCall: vi.fn(),
    renderError: vi.fn(),
    adaptToWidth: vi.fn(),
  } as unknown as StreamingRenderer;
}

describe('REPL.parseInput()', () => {
  let tmpDir: string;
  let repl: REPL;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'repl-test-'));
    repl = new REPL(makeOrchestrator(), makeRenderer());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Req 6.3: file not found → error, no submission ──────────────────────

  describe('Req 6.3 — file not found prints error and returns null', () => {
    it('returns null when @file path does not exist', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await repl.parseInput('@/nonexistent/path/image.png');
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('文件不存在'));
      consoleSpy.mockRestore();
    });

    it('error message includes the file path', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const missingPath = '/definitely/does/not/exist/file.jpg';
      await repl.parseInput(`@${missingPath}`);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(missingPath));
      consoleSpy.mockRestore();
    });

    it('returns null even when text precedes the missing file ref', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await repl.parseInput('describe this @/missing/file.png');
      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  // ─── Req 6.4: unsupported extension → error, no submission ───────────────

  describe('Req 6.4 — unsupported extension prints error and returns null', () => {
    it('returns null for .bmp extension', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const filePath = join(tmpDir, 'image.bmp');
      await writeFile(filePath, 'fake bmp data');
      const result = await repl.parseInput(`@${filePath}`);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('不支持的文件类型'));
      consoleSpy.mockRestore();
    });

    it('error message includes the extension', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const filePath = join(tmpDir, 'archive.zip');
      await writeFile(filePath, 'fake zip');
      await repl.parseInput(`@${filePath}`);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('.zip'));
      consoleSpy.mockRestore();
    });
  });

  // ─── Req 6.5: mixed text + file references ────────────────────────────────

  describe('Req 6.5 — mixed text and file references build ContentBlock[]', () => {
    it('text-only input returns the original string', async () => {
      const result = await repl.parseInput('Hello, world!');
      expect(result).toBe('Hello, world!');
    });

    it('single image file reference returns ContentBlock[] with one ImageBlock', async () => {
      const filePath = join(tmpDir, 'photo.png');
      await writeFile(filePath, Buffer.from('fake png data'));
      const result = await repl.parseInput(`@${filePath}`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('image');
      if (blocks[0].type === 'image') {
        expect(blocks[0].mimeType).toBe('image/png');
        expect(blocks[0].data).toBeDefined();
      }
    });

    it('single file reference returns ContentBlock[] with one FileBlock', async () => {
      const filePath = join(tmpDir, 'document.pdf');
      await writeFile(filePath, Buffer.from('fake pdf data'));
      const result = await repl.parseInput(`@${filePath}`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('file');
      if (blocks[0].type === 'file') {
        expect(blocks[0].mimeType).toBe('application/pdf');
        expect(blocks[0].data).toBeDefined();
      }
    });

    it('text before file reference produces [TextBlock, ImageBlock]', async () => {
      const filePath = join(tmpDir, 'photo.jpg');
      await writeFile(filePath, Buffer.from('fake jpg data'));
      const result = await repl.parseInput(`Describe this image @${filePath}`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('text');
      expect(blocks[1].type).toBe('image');
      if (blocks[0].type === 'text') {
        expect(blocks[0].text).toBe('Describe this image');
      }
    });

    it('text after file reference produces [ImageBlock, TextBlock]', async () => {
      const filePath = join(tmpDir, 'photo.webp');
      await writeFile(filePath, Buffer.from('fake webp data'));
      const result = await repl.parseInput(`@${filePath} what is in this image?`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].type).toBe('image');
      expect(blocks[1].type).toBe('text');
      if (blocks[1].type === 'text') {
        expect(blocks[1].text).toBe('what is in this image?');
      }
    });

    it('multiple file references in one input', async () => {
      const imgPath = join(tmpDir, 'photo.png');
      const docPath = join(tmpDir, 'report.pdf');
      await writeFile(imgPath, Buffer.from('fake png'));
      await writeFile(docPath, Buffer.from('fake pdf'));
      const result = await repl.parseInput(`Compare @${imgPath} with @${docPath}`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      // Should have: TextBlock("Compare"), ImageBlock, TextBlock("with"), FileBlock
      const types = blocks.map((b) => b.type);
      expect(types).toContain('image');
      expect(types).toContain('file');
    });

    it('file data is base64 encoded', async () => {
      const filePath = join(tmpDir, 'test.txt');
      const content = 'Hello, World!';
      await writeFile(filePath, content);
      const result = await repl.parseInput(`@${filePath}`);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
      const fileBlock = blocks.find((b) => b.type === 'file');
      expect(fileBlock).toBeDefined();
      if (fileBlock?.type === 'file' && fileBlock.data) {
        const decoded = Buffer.from(fileBlock.data, 'base64').toString('utf-8');
        expect(decoded).toBe(content);
      }
    });
  });

  // ─── Extension → MIME type mapping ───────────────────────────────────────

  describe('Extension to MIME type mapping', () => {
    const cases: [string, string, string][] = [
      ['.jpg', 'image/jpeg', 'image'],
      ['.jpeg', 'image/jpeg', 'image'],
      ['.png', 'image/png', 'image'],
      ['.gif', 'image/gif', 'image'],
      ['.webp', 'image/webp', 'image'],
      ['.pdf', 'application/pdf', 'file'],
      ['.txt', 'text/plain', 'file'],
      ['.csv', 'text/csv', 'file'],
    ];

    for (const [ext, expectedMime, expectedType] of cases) {
      it(`${ext} → ${expectedMime} (${expectedType} block)`, async () => {
        const filePath = join(tmpDir, `test${ext}`);
        await writeFile(filePath, Buffer.from('test data'));
        const result = await repl.parseInput(`@${filePath}`);
        expect(Array.isArray(result)).toBe(true);
        const blocks = result as import('../../../src/types/messages.js').ContentBlock[];
        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe(expectedType);
        if (blocks[0].type === 'image' || blocks[0].type === 'file') {
          expect(blocks[0].mimeType).toBe(expectedMime);
        }
      });
    }
  });
});
