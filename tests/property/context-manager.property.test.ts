import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import { ContextManager } from '../../src/context/context-manager.js';
import type { ContextPriority } from '../../src/context/context-manager.js';
import type { ProjectContext } from '../../src/types/context.js';
import type { Chunk, ChunkMetadata } from '../../src/types/chunks.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChunk(id: string, content: string, filePath = 'src/a.ts', startLine = 1, endLine = 5): Chunk {
  const metadata: ChunkMetadata = {
    filePath,
    startLine,
    endLine,
    parentScope: '',
    imports: [],
    language: 'typescript',
    chunkType: 'function',
  };
  return { id, content, metadata };
}

/** Create a minimal mock HybridRetriever that returns given chunks */
function makeMockRetriever(chunks: ContextPriority[]) {
  return {
    search: async (_query: string) =>
      chunks.map((c) => ({ chunk: c.chunk, score: c.score, source: c.source as 'vector' | 'bm25' })),
  } as unknown as import('../../src/retrieval/hybrid-retriever.js').HybridRetriever;
}

function makeContextManager(chunks: ContextPriority[] = [], maxLines = 50) {
  const retriever = makeMockRetriever(chunks);
  const cache = new KeyEntityCache();
  return new ContextManager(retriever, cache, {
    maxChunkSize: 60,
    overlapLines: 2,
    toolOutputMaxLines: maxLines,
  });
}

/** Create a temp directory with given files */
function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Arbitrary: safe identifier (letters/digits only)
const identArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,15}$/);

// Arbitrary: non-empty printable text
const textArb = fc
  .string({ minLength: 3, maxLength: 80 })
  .map((s) => s.replace(/[\x00-\x1f]/g, 'x').trim())
  .filter((s) => s.length >= 3);

// ─── Property 21: 关键实体缓存提取 ───────────────────────────────────────────
// Feature: nodejs-claude-code, Property 21: 关键实体缓存提取
// For any message containing file paths, function names, or error codes,
// extractEntities should correctly identify and return them.
// Validates: Requirements 4.12

describe('Property 21: 关键实体缓存提取', () => {
  it('extracts file paths from messages containing known extensions', () => {
    fc.assert(
      fc.property(
        identArb,
        identArb,
        fc.constantFrom('ts', 'js', 'json', 'md', 'py'),
        (dir, file, ext) => {
          const cache = new KeyEntityCache();
          const filePath = `${dir}/${file}.${ext}`;
          const message = `Please look at ${filePath} for the implementation`;

          const entities = cache.extractEntities(message);
          const filePaths = entities.filter((e) => e.type === 'file_path').map((e) => e.value);

          expect(filePaths.some((fp) => fp.includes(file) && fp.endsWith(`.${ext}`))).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracts error codes matching ERR_ prefix pattern', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z][A-Z_]{2,10}$/),
        (suffix) => {
          const cache = new KeyEntityCache();
          const errorCode = `ERR_${suffix}`;
          const message = `The operation failed with ${errorCode}`;

          const entities = cache.extractEntities(message);
          const errorCodes = entities.filter((e) => e.type === 'error_code').map((e) => e.value);

          expect(errorCodes).toContain(errorCode);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('extracted entities are added to the cache', () => {
    fc.assert(
      fc.property(
        identArb,
        (file) => {
          const cache = new KeyEntityCache();
          const message = `Check src/${file}.ts for details`;

          cache.extractEntities(message);
          const all = cache.getAll();

          expect(all.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('getByType returns only entities of the requested type', () => {
    fc.assert(
      fc.property(
        identArb,
        identArb,
        (file, fn) => {
          const cache = new KeyEntityCache();
          const message = `In src/${file}.ts, call ${fn}() to fix ERR_SOME_ERROR`;

          cache.extractEntities(message);

          const filePaths = cache.getByType('file_path');
          const errorCodes = cache.getByType('error_code');

          for (const e of filePaths) {
            expect(e.type).toBe('file_path');
          }
          for (const e of errorCodes) {
            expect(e.type).toBe('error_code');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('clear removes all cached entities', () => {
    fc.assert(
      fc.property(
        identArb,
        (file) => {
          const cache = new KeyEntityCache();
          cache.extractEntities(`Check src/${file}.ts`);
          expect(cache.getAll().length).toBeGreaterThan(0);

          cache.clear();
          expect(cache.getAll().length).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('add and getAll round-trip preserves entity data', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'file_path' | 'function_name' | 'variable_name' | 'error_code' | 'class_name'>('file_path', 'function_name', 'variable_name', 'error_code', 'class_name'),
        textArb,
        fc.integer({ min: 0, max: 100 }),
        (type, value, turn) => {
          const cache = new KeyEntityCache();
          const entity = { type, value, lastMentionedTurn: turn };
          cache.add(entity);

          const all = cache.getAll();
          const found = all.find((e) => e.type === type && e.value === value);
          expect(found).toBeDefined();
          expect(found!.lastMentionedTurn).toBe(turn);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 12: 项目上下文注入系统提示词 ────────────────────────────────────
// Feature: nodejs-claude-code, Property 12: 项目上下文注入系统提示词
// For any project context, buildSystemPrompt should include the project
// structure information in the system prompt.
// Validates: Requirements 4.2

describe('Property 12: 项目上下文注入系统提示词', () => {
  it('system prompt contains the working directory', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        (workDir, treeContent) => {
          const manager = makeContextManager();
          const projectContext: ProjectContext = {
            workDir: `/home/user/${workDir}`,
            directoryTree: treeContent,
            configFiles: [],
            gitignorePatterns: [],
          };

          const prompt = manager.buildSystemPrompt(projectContext, []);
          expect(prompt).toContain(projectContext.workDir);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('system prompt contains the directory tree', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        (workDir, treeContent) => {
          const manager = makeContextManager();
          const projectContext: ProjectContext = {
            workDir: `/home/user/${workDir}`,
            directoryTree: treeContent,
            configFiles: [],
            gitignorePatterns: [],
          };

          const prompt = manager.buildSystemPrompt(projectContext, []);
          expect(prompt).toContain(treeContent);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('system prompt contains config file content when present', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        textArb,
        (workDir, configName, configContent) => {
          const manager = makeContextManager();
          const projectContext: ProjectContext = {
            workDir: `/home/user/${workDir}`,
            directoryTree: 'src/',
            configFiles: [{ path: configName, content: configContent }],
            gitignorePatterns: [],
          };

          const prompt = manager.buildSystemPrompt(projectContext, []);
          expect(prompt).toContain(configContent);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('system prompt contains relevant chunk content', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true }),
        (chunkId, chunkContent, score) => {
          const chunk = makeChunk(chunkId, chunkContent);
          const relevantChunks: ContextPriority[] = [
            { chunk, score, source: 'vector' },
          ];
          const manager = makeContextManager(relevantChunks);
          const projectContext: ProjectContext = {
            workDir: '/home/user/project',
            directoryTree: 'src/',
            configFiles: [],
            gitignorePatterns: [],
          };

          const prompt = manager.buildSystemPrompt(projectContext, relevantChunks);
          expect(prompt).toContain(chunkContent);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 14: .gitignore 排除正确性 ──────────────────────────────────────
// Feature: nodejs-claude-code, Property 14: .gitignore 排除正确性
// Files matching .gitignore patterns should be excluded from project context.
// Validates: Requirements 4.5

describe('Property 14: .gitignore 排除正确性', () => {
  it('files matching gitignore patterns are excluded from directory tree', async () => {
    await fc.assert(
      fc.asyncProperty(
        identArb,
        identArb,
        async (ignoredDir, normalFile) => {
          fc.pre(ignoredDir !== normalFile);

          const tmpDir = makeTempDir({
            '.gitignore': `${ignoredDir}/\n`,
            [`${ignoredDir}/secret.ts`]: 'secret content',
            [`${normalFile}.ts`]: 'normal content',
          });

          try {
            const manager = makeContextManager();
            const ctx = await manager.collectProjectContext(tmpDir);

            // The ignored directory should not appear in the tree
            expect(ctx.directoryTree).not.toContain(ignoredDir + '/');
            // The normal file should appear
            expect(ctx.directoryTree).toContain(`${normalFile}.ts`);
            // gitignore patterns should be loaded
            expect(ctx.gitignorePatterns).toContain(`${ignoredDir}/`);
          } finally {
            cleanupDir(tmpDir);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('node_modules is excluded when listed in .gitignore', async () => {
    const tmpDir = makeTempDir({
      '.gitignore': 'node_modules/\n',
      'node_modules/some-pkg/index.js': 'module content',
      'src/index.ts': 'main content',
    });

    try {
      const manager = makeContextManager();
      const ctx = await manager.collectProjectContext(tmpDir);

      expect(ctx.directoryTree).not.toContain('node_modules');
      expect(ctx.directoryTree).toContain('src');
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('gitignorePatterns is empty when no .gitignore exists', async () => {
    const tmpDir = makeTempDir({
      'src/index.ts': 'content',
    });

    try {
      const manager = makeContextManager();
      const ctx = await manager.collectProjectContext(tmpDir);
      expect(ctx.gitignorePatterns).toEqual([]);
    } finally {
      cleanupDir(tmpDir);
    }
  });

  it('wildcard patterns exclude matching files', async () => {
    await fc.assert(
      fc.asyncProperty(
        identArb,
        async (baseName) => {
          const tmpDir = makeTempDir({
            '.gitignore': '*.log\n',
            [`${baseName}.log`]: 'log content',
            [`${baseName}.ts`]: 'ts content',
          });

          try {
            const manager = makeContextManager();
            const ctx = await manager.collectProjectContext(tmpDir);

            expect(ctx.directoryTree).not.toContain(`${baseName}.log`);
            expect(ctx.directoryTree).toContain(`${baseName}.ts`);
          } finally {
            cleanupDir(tmpDir);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 19: 上下文优先级排序 ───────────────────────────────────────────
// Feature: nodejs-claude-code, Property 19: 上下文优先级排序
// Context chunks with higher relevance scores should appear earlier in the
// assembled prompt.
// Validates: Requirements 4.10

describe('Property 19: 上下文优先级排序', () => {
  it('higher-score chunks appear before lower-score chunks in the prompt', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            identArb,
            textArb,
            fc.float({ min: Math.fround(0.01), max: Math.fround(1.0), noNaN: true })
          ),
          { minLength: 2, maxLength: 6 }
        ),
        (chunkData) => {
          // Ensure distinct scores
          const uniqueScores = new Set(chunkData.map(([, , s]) => s));
          fc.pre(uniqueScores.size >= 2);

          const chunks: ContextPriority[] = chunkData.map(([id, content, score]) => ({
            chunk: makeChunk(id, content),
            score,
            source: 'vector' as const,
          }));

          const manager = makeContextManager(chunks);
          const projectContext: ProjectContext = {
            workDir: '/project',
            directoryTree: '',
            configFiles: [],
            gitignorePatterns: [],
          };

          const prompt = manager.buildSystemPrompt(projectContext, chunks);

          // Sort chunks by score descending
          const sorted = [...chunks].sort((a, b) => b.score - a.score);

          // Find positions of each chunk content in the prompt
          const positions = sorted.map((c) => prompt.indexOf(c.chunk.content));

          // All chunks should be present
          for (const pos of positions) {
            expect(pos).toBeGreaterThanOrEqual(0);
          }

          // Higher-score chunks should appear at earlier positions
          for (let i = 0; i < positions.length - 1; i++) {
            if (sorted[i]!.score > sorted[i + 1]!.score) {
              expect(positions[i]).toBeLessThan(positions[i + 1]!);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('getRelevantContext returns chunks sorted by score descending', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(identArb, textArb, fc.float({ min: Math.fround(0.01), max: Math.fround(1.0), noNaN: true })),
          { minLength: 2, maxLength: 6 }
        ),
        async (chunkData) => {
          const chunks: ContextPriority[] = chunkData.map(([id, content, score]) => ({
            chunk: makeChunk(id, content),
            score,
            source: 'vector' as const,
          }));

          const manager = makeContextManager(chunks);
          const result = await manager.getRelevantContext('test query');

          // Results should be sorted descending by score
          for (let i = 0; i < result.length - 1; i++) {
            expect(result[i]!.score).toBeGreaterThanOrEqual(result[i + 1]!.score);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 20: 大型工具输出截断 ───────────────────────────────────────────
// Feature: nodejs-claude-code, Property 20: 大型工具输出截断
// Tool outputs exceeding the configured line threshold should be truncated,
// with a note indicating truncation.
// Validates: Requirements 4.11

describe('Property 20: 大型工具输出截断', () => {
  it('output exceeding maxLines is truncated and contains truncation marker', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom('shell', 'file_read', 'grep'),
        (maxLines, extraLines, toolType) => {
          const totalLines = maxLines + extraLines;
          const output = Array.from({ length: totalLines }, (_, i) => `line ${i + 1}`).join('\n');

          const manager = makeContextManager([], maxLines);
          const compressed = manager.compressToolOutput(output, toolType);

          const compressedLines = compressed.split('\n');
          // The compressed output should contain the truncation marker
          expect(compressed).toContain('truncated');
          // The compressed output should have fewer content lines than the original
          // (the truncation marker replaces omitted lines, so total lines may be similar
          // but the actual content lines are fewer)
          expect(compressedLines.length).toBeLessThanOrEqual(maxLines + 1); // head + marker + tail
        }
      ),
      { numRuns: 100 }
    );
  });

  it('output within maxLines is returned unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 50 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom('shell', 'file_read'),
        (maxLines, fewLines, toolType) => {
          const output = Array.from({ length: fewLines }, (_, i) => `line ${i + 1}`).join('\n');

          const manager = makeContextManager([], maxLines);
          const result = manager.compressToolOutput(output, toolType);

          expect(result).toBe(output);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('truncated output is shorter than original', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 5, max: 50 }),
        (maxLines, extraLines) => {
          const totalLines = maxLines + extraLines;
          const output = Array.from({ length: totalLines }, (_, i) => `line content ${i}`).join('\n');

          const manager = makeContextManager([], maxLines);
          const compressed = manager.compressToolOutput(output, 'shell');

          expect(compressed.length).toBeLessThan(output.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('truncated output preserves first and last lines', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 20 }),
        fc.integer({ min: 5, max: 20 }),
        (maxLines, extraLines) => {
          const totalLines = maxLines + extraLines;
          const lines = Array.from({ length: totalLines }, (_, i) => `unique-line-${i}`);
          const output = lines.join('\n');

          const manager = makeContextManager([], maxLines);
          const compressed = manager.compressToolOutput(output, 'shell');

          // First line should be preserved
          expect(compressed).toContain(lines[0]!);
          // Last line should be preserved
          expect(compressed).toContain(lines[lines.length - 1]!);
        }
      ),
      { numRuns: 100 }
    );
  });
});
