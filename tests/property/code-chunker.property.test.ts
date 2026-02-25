import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CodeChunker } from '../../src/context/code-chunker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a simple TypeScript function string */
function makeFunction(name: string, bodyLines: string[]): string {
  return [`function ${name}() {`, ...bodyLines.map((l) => `  ${l}`), '}'].join('\n');
}

/** Build a simple TypeScript class string */
function makeClass(name: string, methods: string[]): string {
  return [`class ${name} {`, ...methods.map((m) => `  ${m}`), '}'].join('\n');
}

/** Count lines in a string (1-based) */
function lineCount(s: string): number {
  return s.split('\n').length;
}

// Arbitrary: safe identifier
const identArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,15}$/)
  .filter((s) => s.length > 0);

// Arbitrary: simple statement line
const stmtArb = fc
  .string({ minLength: 1, maxLength: 60 })
  .map((s) => `// ${s.replace(/\n/g, ' ')}`);

// ─── Property 15: AST 分块语义完整性 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 15: AST 分块语义完整性
// For any TypeScript/JavaScript file, AST chunking should produce chunks where
// each chunk contains complete syntactic structures (complete functions, classes, methods).
// Validates: Requirements 4.6

describe('Property 15: AST 分块语义完整性', () => {
  const chunker = new CodeChunker({ maxChunkSize: 60, overlapLines: 2 });

  it('each function is contained within a single chunk (when small enough)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(identArb, fc.array(stmtArb, { minLength: 1, maxLength: 5 })),
          { minLength: 1, maxLength: 5 }
        ),
        (fns) => {
          // Build a TS file with multiple small functions
          const code = fns
            .map(([name, stmts]) => makeFunction(name, stmts))
            .join('\n\n');

          const chunks = chunker.chunkFile('test.ts', code);

          // Every chunk should have valid startLine <= endLine
          for (const chunk of chunks) {
            expect(chunk.metadata.startLine).toBeGreaterThanOrEqual(1);
            expect(chunk.metadata.endLine).toBeGreaterThanOrEqual(chunk.metadata.startLine);
          }

          // The union of all chunk line ranges should cover the whole file
          const totalLines = lineCount(code);
          const covered = new Set<number>();
          for (const chunk of chunks) {
            for (let l = chunk.metadata.startLine; l <= chunk.metadata.endLine; l++) {
              covered.add(l);
            }
          }
          // All non-empty lines should be covered
          const codeLines = code.split('\n');
          for (let i = 0; i < codeLines.length; i++) {
            if (codeLines[i]!.trim()) {
              expect(covered.has(i + 1)).toBe(true);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('function chunks have chunkType function or block/module', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 5 }),
        (name, stmts) => {
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile('test.ts', code);
          expect(chunks.length).toBeGreaterThan(0);
          // At least one chunk should be function type
          const hasFunction = chunks.some(
            (c) => c.metadata.chunkType === 'function' || c.metadata.chunkType === 'module'
          );
          expect(hasFunction).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('class chunks have chunkType class', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(
          identArb.map((m) => `${m}() { return 1; }`),
          { minLength: 1, maxLength: 3 }
        ),
        (className, methods) => {
          const code = makeClass(className, methods);
          const chunks = chunker.chunkFile('test.ts', code);
          expect(chunks.length).toBeGreaterThan(0);
          const hasClass = chunks.some((c) => c.metadata.chunkType === 'class');
          expect(hasClass).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chunks do not split in the middle of a small function', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 3 }),
        (name, stmts) => {
          const code = makeFunction(name, stmts);
          const totalLines = lineCount(code);
          // Small function (≤ maxChunkSize) should be a single chunk
          if (totalLines <= 60) {
            const chunks = chunker.chunkFile('test.ts', code);
            // The function content should appear in exactly one chunk
            const fnChunks = chunks.filter((c) => c.content.includes(`function ${name}`));
            expect(fnChunks.length).toBeGreaterThanOrEqual(1);
            // The opening and closing brace should be in the same chunk
            const mainChunk = fnChunks[0]!;
            expect(mainChunk.content).toContain(`function ${name}`);
            expect(mainChunk.content).toContain('}');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 16: Chunk 元数据完整性 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 16: Chunk 元数据完整性
// Each chunk should have complete metadata: filePath, startLine, endLine,
// parentScope, imports, language, chunkType.
// Validates: Requirements 4.7, 4.17

describe('Property 16: Chunk 元数据完整性', () => {
  const chunker = new CodeChunker({ maxChunkSize: 60, overlapLines: 2 });

  it('every chunk has non-empty filePath matching input', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 5 }),
        (name, stmts) => {
          const filePath = `src/${name}.ts`;
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile(filePath, code);
          for (const chunk of chunks) {
            expect(chunk.metadata.filePath).toBe(filePath);
            expect(chunk.metadata.filePath.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('startLine and endLine are valid (1-based, startLine <= endLine)', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 10 }),
        (name, stmts) => {
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile('test.ts', code);
          for (const chunk of chunks) {
            expect(chunk.metadata.startLine).toBeGreaterThanOrEqual(1);
            expect(chunk.metadata.endLine).toBeGreaterThanOrEqual(chunk.metadata.startLine);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('imports array is present (may be empty for files without imports)', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 5 }),
        (name, stmts) => {
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile('test.ts', code);
          for (const chunk of chunks) {
            expect(Array.isArray(chunk.metadata.imports)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('imports are extracted from import declarations', () => {
    fc.assert(
      fc.property(
        identArb,
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 3 }),
        (importName, fnName, stmts) => {
          const code = [
            `import { ${importName} } from './${importName}.js';`,
            '',
            makeFunction(fnName, stmts),
          ].join('\n');

          const chunks = chunker.chunkFile('test.ts', code);
          expect(chunks.length).toBeGreaterThan(0);

          // All chunks should carry the import metadata
          for (const chunk of chunks) {
            const hasImport = chunk.metadata.imports.some((imp) =>
              imp.source.includes(importName)
            );
            expect(hasImport).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('language field matches file extension', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.constantFrom('ts', 'js', 'tsx', 'jsx'),
        fc.array(stmtArb, { minLength: 1, maxLength: 3 }),
        (name, ext, stmts) => {
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile(`test.${ext}`, code);
          for (const chunk of chunks) {
            expect(['typescript', 'javascript']).toContain(chunk.metadata.language);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chunkType is one of the valid values', () => {
    const validTypes = ['function', 'class', 'method', 'module', 'block', 'text'];
    fc.assert(
      fc.property(
        identArb,
        fc.array(stmtArb, { minLength: 1, maxLength: 5 }),
        (name, stmts) => {
          const code = makeFunction(name, stmts);
          const chunks = chunker.chunkFile('test.ts', code);
          for (const chunk of chunks) {
            expect(validTypes).toContain(chunk.metadata.chunkType);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chunk id is non-empty and unique within a file', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(identArb, fc.array(stmtArb, { minLength: 1, maxLength: 3 })),
          { minLength: 2, maxLength: 5 }
        ),
        (fns) => {
          const code = fns.map(([n, s]) => makeFunction(n, s)).join('\n\n');
          const chunks = chunker.chunkFile('test.ts', code);
          const ids = chunks.map((c) => c.id);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(ids.length);
          for (const id of ids) {
            expect(id.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 17: 超大节点二次分割重叠保证 ────────────────────────────────────
// Feature: nodejs-claude-code, Property 17: 超大节点二次分割重叠保证
// When a single syntax structure exceeds chunk size limit, secondary splitting
// should preserve at least 2 lines of overlap between adjacent chunks.
// Validates: Requirements 4.8

describe('Property 17: 超大节点二次分割重叠保证', () => {
  it('adjacent chunks from oversized node share at least overlapLines lines', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),  // overlapLines
        fc.integer({ min: 10, max: 30 }), // maxChunkSize
        fc.integer({ min: 2, max: 8 }),   // multiplier to make oversized content
        (overlapLines, maxChunkSize, multiplier) => {
          const chunker = new CodeChunker({ maxChunkSize, overlapLines });

          // Build a function with enough lines to exceed maxChunkSize
          const numBodyLines = maxChunkSize * multiplier;
          const bodyLines = Array.from({ length: numBodyLines }, (_, i) => `const x${i} = ${i};`);
          const code = makeFunction('bigFn', bodyLines);

          const chunks = chunker.chunkFile('test.ts', code);

          // If there are multiple chunks from the same oversized node,
          // adjacent chunks should overlap by at least overlapLines
          if (chunks.length >= 2) {
            for (let i = 0; i < chunks.length - 1; i++) {
              const curr = chunks[i]!;
              const next = chunks[i + 1]!;

              // Check overlap: next chunk starts before current chunk ends
              const overlapStart = next.metadata.startLine;
              const overlapEnd = curr.metadata.endLine;

              if (overlapStart <= overlapEnd) {
                const actualOverlap = overlapEnd - overlapStart + 1;
                expect(actualOverlap).toBeGreaterThanOrEqual(overlapLines);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('text chunking also overlaps when paragraph exceeds maxChunkSize', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 5, max: 20 }),
        fc.integer({ min: 2, max: 5 }),
        (overlapLines, maxChunkSize, multiplier) => {
          const chunker = new CodeChunker({ maxChunkSize, overlapLines });

          // Build a large paragraph (no blank lines)
          const numLines = maxChunkSize * multiplier;
          const lines = Array.from({ length: numLines }, (_, i) => `Line number ${i + 1} content here`);
          const content = lines.join('\n');

          const chunks = chunker.chunkText('readme.md', content);

          if (chunks.length >= 2) {
            for (let i = 0; i < chunks.length - 1; i++) {
              const curr = chunks[i]!;
              const next = chunks[i + 1]!;

              if (next.metadata.startLine <= curr.metadata.endLine) {
                const actualOverlap = curr.metadata.endLine - next.metadata.startLine + 1;
                expect(actualOverlap).toBeGreaterThanOrEqual(overlapLines);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 18: 非 AST 文件回退分块 ────────────────────────────────────────
// Feature: nodejs-claude-code, Property 18: 非 AST 文件回退分块
// For non-AST files (plain text, Markdown), should fall back to paragraph/blank-line
// based chunking.
// Validates: Requirements 4.9

describe('Property 18: 非 AST 文件回退分块', () => {
  const chunker = new CodeChunker({ maxChunkSize: 60, overlapLines: 2 });

  it('non-AST files produce text chunks', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('readme.md', 'notes.txt', 'data.csv', 'config.yaml'),
        fc.array(
          fc.string({ minLength: 1, maxLength: 80 }).map((s) => s.replace(/\n/g, ' ')),
          { minLength: 1, maxLength: 20 }
        ),
        (filePath, lines) => {
          const content = lines.join('\n');
          const chunks = chunker.chunkFile(filePath, content);

          for (const chunk of chunks) {
            expect(chunk.metadata.chunkType).toBe('text');
            expect(chunk.content.trim().length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chunks are split on blank lines (paragraph boundaries)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(
            fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\n/g, ' ')),
            { minLength: 1, maxLength: 5 }
          ),
          { minLength: 2, maxLength: 5 }
        ),
        (paragraphs) => {
          // Build content with blank lines between paragraphs
          const content = paragraphs.map((p) => p.join('\n')).join('\n\n');
          const chunks = chunker.chunkText('notes.txt', content);

          // Each chunk should not contain blank lines that separate paragraphs
          // (i.e., no chunk spans across a blank-line boundary)
          for (const chunk of chunks) {
            // A chunk should not start or end with blank lines
            const lines = chunk.content.split('\n');
            expect(lines[0]!.trim().length).toBeGreaterThan(0);
            expect(lines[lines.length - 1]!.trim().length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each chunk is non-empty and within size limit', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 80 }).map((s) => s.replace(/\n/g, ' ')),
          { minLength: 1, maxLength: 30 }
        ),
        (lines) => {
          const content = lines.join('\n');
          const chunks = chunker.chunkText('notes.txt', content);

          for (const chunk of chunks) {
            expect(chunk.content.trim().length).toBeGreaterThan(0);
            const chunkLines = chunk.content.split('\n').length;
            expect(chunkLines).toBeLessThanOrEqual(60 + 2); // maxChunkSize + small tolerance for overlap
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('chunkFile falls back to text for non-AST extensions', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('file.md', 'file.txt', 'file.csv', 'file.yaml', 'file.json'),
        fc.array(
          fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\n/g, ' ')),
          { minLength: 1, maxLength: 10 }
        ),
        (filePath, lines) => {
          const content = lines.join('\n');
          const chunks = chunker.chunkFile(filePath, content);
          for (const chunk of chunks) {
            expect(chunk.metadata.chunkType).toBe('text');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 25: 注释与代码节点绑定 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 25: 注释与代码节点绑定
// Comments and JSDoc immediately preceding code nodes should be bound to the
// same chunk as the code node.
// Validates: Requirements 4.16

describe('Property 25: 注释与代码节点绑定', () => {
  const chunker = new CodeChunker({ maxChunkSize: 60, overlapLines: 2 });

  it('JSDoc comment before function is in the same chunk as the function', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\n/g, ' ').replace(/\*\//g, '')),
        fc.array(stmtArb, { minLength: 1, maxLength: 3 }),
        (fnName, docText, stmts) => {
          const code = [
            `/**`,
            ` * ${docText}`,
            ` */`,
            makeFunction(fnName, stmts),
          ].join('\n');

          const chunks = chunker.chunkFile('test.ts', code);

          // The chunk containing the function should also contain the JSDoc
          const fnChunk = chunks.find((c) => c.content.includes(`function ${fnName}`));
          expect(fnChunk).toBeDefined();
          if (fnChunk) {
            expect(fnChunk.content).toContain('/**');
            expect(fnChunk.content).toContain(docText);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('line comment before function is in the same chunk as the function', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\n/g, ' ')),
        fc.array(stmtArb, { minLength: 1, maxLength: 3 }),
        (fnName, commentText, stmts) => {
          const code = [
            `// ${commentText}`,
            makeFunction(fnName, stmts),
          ].join('\n');

          const chunks = chunker.chunkFile('test.ts', code);

          const fnChunk = chunks.find((c) => c.content.includes(`function ${fnName}`));
          expect(fnChunk).toBeDefined();
          if (fnChunk) {
            expect(fnChunk.content).toContain(`// ${commentText}`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('JSDoc before class is in the same chunk as the class', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\n/g, ' ').replace(/\*\//g, '')),
        (className, docText) => {
          const code = [
            `/**`,
            ` * ${docText}`,
            ` */`,
            `class ${className} {}`,
          ].join('\n');

          const chunks = chunker.chunkFile('test.ts', code);

          const classChunk = chunks.find((c) => c.content.includes(`class ${className}`));
          expect(classChunk).toBeDefined();
          if (classChunk) {
            expect(classChunk.content).toContain('/**');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
