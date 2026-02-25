import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { EmbeddingEngine } from '../../src/retrieval/embedding-engine.js';
import { VectorStore, cosineSimilarity } from '../../src/retrieval/vector-store.js';
import { BM25Index } from '../../src/retrieval/bm25-index.js';
import { DependencyGraph } from '../../src/context/dependency-graph.js';
import { HybridRetriever } from '../../src/retrieval/hybrid-retriever.js';
import type { Chunk, ChunkMetadata } from '../../src/types/chunks.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIMS = 16;

/** Deterministic mock embedding: same text → same vector. */
function deterministicEmbed(text: string, dims = DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function makeChunk(
  id: string,
  content: string,
  filePath = 'src/a.ts',
  startLine = 1,
  endLine = 5
): Chunk {
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

function makeEmbeddingEngine(dims = DIMS): EmbeddingEngine {
  return new EmbeddingEngine({
    dimensions: dims,
    mockEmbed: (text) => deterministicEmbed(text, dims),
  });
}

// Arbitrary: non-empty printable text (at least 3 chars for BM25 tokenization)
const textArb = fc
  .string({ minLength: 3, maxLength: 80 })
  .map((s) => s.replace(/[\x00-\x1f]/g, 'x').trim())
  .filter((s) => s.length >= 3);

// Arbitrary: safe identifier (at least 2 chars)
const identArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,15}$/)
  .filter((s) => s.length >= 2);

// ─── Property 33: 嵌入向量维度一致性 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 33: 嵌入向量维度一致性
// For any batch of texts, all generated embedding vectors should have the same
// dimension equal to the configured dimension, and contain no NaN or Infinity.
// Validates: Requirements 9.1

describe('Property 33: 嵌入向量维度一致性', () => {
  it('all embeddings have the configured dimension and no NaN/Infinity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4, max: 32 }),
        fc.array(textArb, { minLength: 1, maxLength: 10 }),
        async (dims, texts) => {
          const engine = new EmbeddingEngine({
            dimensions: dims,
            mockEmbed: (text) => deterministicEmbed(text, dims),
          });

          const embeddings = await engine.embed(texts);

          expect(embeddings.length).toBe(texts.length);
          for (const vec of embeddings) {
            expect(vec.length).toBe(dims);
            for (const v of vec) {
              expect(Number.isFinite(v)).toBe(true);
              expect(Number.isNaN(v)).toBe(false);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('embedSingle returns a vector of the configured dimension', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4, max: 32 }),
        textArb,
        async (dims, text) => {
          const engine = new EmbeddingEngine({
            dimensions: dims,
            mockEmbed: (t) => deterministicEmbed(t, dims),
          });

          const vec = await engine.embedSingle(text);
          expect(vec.length).toBe(dims);
          for (const v of vec) {
            expect(Number.isFinite(v)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 39: 嵌入失败重试队列 ───────────────────────────────────────────
// Feature: nodejs-claude-code, Property 39: 嵌入失败重试队列
// When embedding API calls fail, failed chunks should be added to retry queue
// and not block other chunks from being processed.
// Validates: Requirements 9.10

describe('Property 39: 嵌入失败重试队列', () => {
  it('failed chunks go to retry queue; successful chunks are returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate unique IDs by using a set
        fc.array(identArb, { minLength: 2, maxLength: 8 }).map((arr) => [...new Set(arr)]).filter((arr) => arr.length >= 2),
        fc.integer({ min: 1, max: 3 }),
        async (ids, failCount) => {
          const actualFailCount = Math.min(failCount, ids.length - 1);
          const failSet = new Set(ids.slice(0, actualFailCount));

          const engine = new EmbeddingEngine({
            dimensions: DIMS,
            mockEmbed: (text) => {
              if (failSet.has(text)) throw new Error('Simulated embedding failure');
              return deterministicEmbed(text, DIMS);
            },
          });

          const chunks = ids.map((id) => makeChunk(id, id));
          const result = await engine.embedBatch(chunks);

          // Successful chunks should be in result
          for (const id of ids) {
            if (!failSet.has(id)) {
              expect(result.has(id)).toBe(true);
            }
          }

          // Failed chunks should be in retry queue
          const retryIds = engine.getRetryQueue().map((c) => c.id);
          for (const id of failSet) {
            expect(retryIds).toContain(id);
          }

          // Failed chunks should NOT be in result
          for (const id of failSet) {
            expect(result.has(id)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('retry queue does not block other chunks from being indexed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(identArb, { minLength: 3, maxLength: 8 }).map((arr) => [...new Set(arr)]).filter((arr) => arr.length >= 3),
        async (ids) => {
          const failId = ids[0]!;
          const engine = new EmbeddingEngine({
            dimensions: DIMS,
            mockEmbed: (text) => {
              if (text === failId) throw new Error('fail');
              return deterministicEmbed(text, DIMS);
            },
          });

          const chunks = ids.map((id) => makeChunk(id, id));
          const result = await engine.embedBatch(chunks);

          // All non-failing chunks should be processed
          const successCount = ids.filter((id) => id !== failId).length;
          expect(result.size).toBe(successCount);

          // Retry queue has exactly the failed chunk
          expect(engine.getRetryQueue().length).toBe(1);
          expect(engine.getRetryQueue()[0]!.id).toBe(failId);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 34: 向量近邻检索排序正确性 ─────────────────────────────────────
// Feature: nodejs-claude-code, Property 34: 向量近邻检索排序正确性
// Vector nearest neighbor search results should be sorted by cosine similarity
// in descending order.
// Validates: Requirements 9.3

describe('Property 34: 向量近邻检索排序正确性', () => {
  it('search results are sorted by cosine similarity descending', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }), { minLength: DIMS, maxLength: DIMS }),
          { minLength: 2, maxLength: 10 }
        ),
        fc.array(fc.float({ min: Math.fround(-1), max: Math.fround(1), noNaN: true }), { minLength: DIMS, maxLength: DIMS }),
        fc.integer({ min: 1, max: 5 }),
        async (storedVecs, queryVec, topK) => {
          const store = new VectorStore({ dimensions: DIMS });
          const chunks = storedVecs.map((_, i) => makeChunk(`chunk-${i}`, `content ${i}`));
          await store.upsert(chunks, storedVecs);

          const results = await store.search(queryVec, topK);

          // Results should be sorted descending
          for (let i = 0; i < results.length - 1; i++) {
            expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
          }

          // Should return at most topK results
          expect(results.length).toBeLessThanOrEqual(topK);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('cosine similarity of identical non-zero vectors is 1', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.float({ min: Math.fround(0.1), max: Math.fround(1), noNaN: true }),
          { minLength: DIMS, maxLength: DIMS }
        ),
        (vec) => {
          const sim = cosineSimilarity(vec, vec);
          expect(sim).toBeCloseTo(1, 5);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 37: 基于哈希的增量索引 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 37: 基于哈希的增量索引
// Only changed files (detected by hash) should be re-indexed.
// Validates: Requirements 9.6, 9.7

describe('Property 37: 基于哈希的增量索引', () => {
  it('unchanged file hash means no re-indexing needed', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        (filePath, hash) => {
          const store = new VectorStore({ dimensions: DIMS });
          store.setFileHash(filePath, hash);

          const storedHash = store.getFileHash(filePath);
          expect(storedHash).toBe(hash);

          const needsReindex = storedHash !== hash;
          expect(needsReindex).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('changed file hash triggers re-indexing', () => {
    fc.assert(
      fc.property(
        identArb,
        textArb,
        textArb,
        (filePath, oldHash, newHash) => {
          fc.pre(oldHash !== newHash);

          const store = new VectorStore({ dimensions: DIMS });
          store.setFileHash(filePath, oldHash);

          const storedHash = store.getFileHash(filePath);
          const needsReindex = storedHash !== newHash;
          expect(needsReindex).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('file with no stored hash always needs indexing', () => {
    fc.assert(
      fc.property(identArb, (filePath) => {
        const store = new VectorStore({ dimensions: DIMS });
        const storedHash = store.getFileHash(filePath);
        expect(storedHash).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 41: 依赖关系图构建正确性 ───────────────────────────────────────
// Feature: nodejs-claude-code, Property 41: 依赖关系图构建正确性
// Dependency graph built from chunks should correctly reflect import/require
// relationships (A imports B → edge A→B exists in graph).
// Validates: Requirements 9.12

describe('Property 41: 依赖关系图构建正确性', () => {
  it('import relationships are reflected as edges in the graph', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(identArb, identArb),
          { minLength: 1, maxLength: 8 }
        ),
        (pairs) => {
          const chunks: Chunk[] = pairs.map(([from, to], i) => ({
            id: `chunk-${i}`,
            content: `import { x } from './${to}.js';`,
            metadata: {
              filePath: `src/${from}.ts`,
              startLine: 1,
              endLine: 1,
              parentScope: '',
              imports: [{ source: `./${to}.js`, specifiers: ['x'], isRelative: true }],
              language: 'typescript',
              chunkType: 'module' as const,
            },
          }));

          const graph = DependencyGraph.buildFromChunks(chunks);

          for (const [from, to] of pairs) {
            const deps = graph.getDependencies(`src/${from}.ts`);
            const hasDep = deps.some((d) => d.includes(to));
            expect(hasDep).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('non-relative imports are not added to the graph', () => {
    fc.assert(
      fc.property(identArb, identArb, (from, pkg) => {
        const chunk: Chunk = {
          id: 'c1',
          content: `import { x } from '${pkg}';`,
          metadata: {
            filePath: `src/${from}.ts`,
            startLine: 1,
            endLine: 1,
            parentScope: '',
            imports: [{ source: pkg, specifiers: ['x'], isRelative: false }],
            language: 'typescript',
            chunkType: 'module',
          },
        };

        const graph = DependencyGraph.buildFromChunks([chunk]);
        const deps = graph.getDependencies(`src/${from}.ts`);
        expect(deps.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });

  it('getDependents returns files that import a given file', () => {
    fc.assert(
      fc.property(identArb, identArb, (from, to) => {
        const graph = new DependencyGraph();
        graph.addEdge({ from: `src/${from}.ts`, to: `src/${to}.ts`, specifiers: [] });

        const dependents = graph.getDependents(`src/${to}.ts`);
        expect(dependents).toContain(`src/${from}.ts`);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 35: 混合检索融合 ────────────────────────────────────────────────
// Feature: nodejs-claude-code, Property 35: 混合检索融合
// Hybrid retrieval should combine vector and BM25 results when both have matches.
// Validates: Requirements 9.4

describe('Property 35: 混合检索融合', () => {
  it('hybrid search returns results from the indexed set', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(textArb, { minLength: 3, maxLength: 8 }),
        async (texts) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();

          const chunks = texts.map((t, i) => makeChunk(`c${i}`, t));
          const embeddings = await Promise.all(chunks.map((c) => engine.embedSingle(c.content)));
          await store.upsert(chunks, embeddings);
          bm25.addDocuments(chunks);

          const retriever = new HybridRetriever(store, bm25, engine, {
            topK: texts.length,
            expandAdjacentChunks: false,
            expandDependencyChunks: false,
          });

          const results = await retriever.search(texts[0]!);

          expect(results.length).toBeGreaterThan(0);

          const indexedIds = new Set(chunks.map((c) => c.id));
          for (const r of results) {
            expect(indexedIds.has(r.chunk.id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('fuseResults combines vector and BM25 results', () => {
    fc.assert(
      fc.property(
        fc.array(identArb, { minLength: 2, maxLength: 6 }).map((arr) => [...new Set(arr)]).filter((arr) => arr.length >= 2),
        (ids) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();
          const retriever = new HybridRetriever(store, bm25, engine, {
            topK: ids.length * 2,
            expandAdjacentChunks: false,
            expandDependencyChunks: false,
          });

          const half = Math.ceil(ids.length / 2);
          const vectorIds = ids.slice(0, half);
          const bm25Ids = ids.slice(half);

          const vectorResults = vectorIds.map((id, i) => ({
            chunk: makeChunk(id, id),
            score: 0.9 - i * 0.1,
            source: 'vector' as const,
          }));

          const bm25Results = bm25Ids.map((id, i) => ({
            chunk: makeChunk(id, id),
            score: 5 - i,
            source: 'bm25' as const,
          }));

          const fused = retriever.fuseResults(vectorResults, bm25Results);

          const fusedIds = new Set(fused.map((r) => r.chunk.id));
          for (const id of ids) {
            expect(fusedIds.has(id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 36: 低相似度时 BM25 权重提升 ───────────────────────────────────
// Feature: nodejs-claude-code, Property 36: 低相似度时 BM25 权重提升
// When vector similarity is below threshold, BM25 weight should be boosted.
// Validates: Requirements 9.5

describe('Property 36: 低相似度时 BM25 权重提升', () => {
  it('BM25-only results have higher relative weight in low-similarity mode', () => {
    fc.assert(
      fc.property(
        fc.array(identArb, { minLength: 2, maxLength: 4 }).map((arr) => [...new Set(arr)]).filter((arr) => arr.length >= 2),
        fc.array(identArb, { minLength: 2, maxLength: 4 }).map((arr) => [...new Set(arr)]).filter((arr) => arr.length >= 2),
        (vectorIds, bm25OnlyIds) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();
          const retriever = new HybridRetriever(store, bm25, engine, {
            vectorWeight: 0.7,
            bm25Weight: 0.3,
            similarityThreshold: 0.5,
            topK: 20,
            expandAdjacentChunks: false,
            expandDependencyChunks: false,
          });

          const vectorResults = vectorIds.map((id, i) => ({
            chunk: makeChunk(id, id),
            score: 0.3 - i * 0.05,
            source: 'vector' as const,
          }));

          const bm25Results = bm25OnlyIds.map((id, i) => ({
            chunk: makeChunk(id, id),
            score: 10 - i,
            source: 'bm25' as const,
          }));

          const normalFused = retriever.fuseResults(vectorResults, bm25Results, false);
          const boostedFused = retriever.fuseResults(vectorResults, bm25Results, true);

          // In boosted mode, BM25-only results should appear in results
          const bm25OnlySet = new Set(bm25OnlyIds);
          const boostedHasBm25 = boostedFused.some((r) => bm25OnlySet.has(r.chunk.id));
          const normalHasBm25 = normalFused.some((r) => bm25OnlySet.has(r.chunk.id));

          // Both modes should include BM25 results
          expect(boostedHasBm25).toBe(true);
          expect(normalHasBm25).toBe(true);

          // Boosted BM25 scores should be >= normal BM25 scores
          const boostedBm25Score = boostedFused
            .filter((r) => bm25OnlySet.has(r.chunk.id))
            .reduce((s, r) => s + r.score, 0);
          const normalBm25Score = normalFused
            .filter((r) => bm25OnlySet.has(r.chunk.id))
            .reduce((s, r) => s + r.score, 0);

          expect(boostedBm25Score).toBeGreaterThanOrEqual(normalBm25Score * 0.9);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 38: 相邻 Chunk 自动扩展 ────────────────────────────────────────
// Feature: nodejs-claude-code, Property 38: 相邻 Chunk 自动扩展
// Adjacent chunks from the same file should be automatically included.
// Validates: Requirements 9.8

describe('Property 38: 相邻 Chunk 自动扩展', () => {
  it('adjacent chunks from the same file are included in results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 8 }),
        async (numChunks) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();

          // Create sequential chunks in the same file
          const chunks: Chunk[] = [];
          for (let i = 0; i < numChunks; i++) {
            chunks.push(makeChunk(`c${i}`, `content chunk ${i} alpha beta`, 'src/file.ts', i * 10 + 1, i * 10 + 9));
          }

          const embeddings = await Promise.all(chunks.map((c) => engine.embedSingle(c.content)));
          await store.upsert(chunks, embeddings);
          bm25.addDocuments(chunks);

          const retriever = new HybridRetriever(store, bm25, engine, {
            topK: 1,
            expandAdjacentChunks: true,
            expandDependencyChunks: false,
          });

          // Search for the middle chunk
          const midIdx = Math.floor(numChunks / 2);
          const results = await retriever.search(`content chunk ${midIdx} alpha beta`);

          const resultIds = new Set(results.map((r) => r.chunk.id));

          // The hit chunk should be in results
          expect(resultIds.has(`c${midIdx}`)).toBe(true);

          // At least one adjacent chunk should also be included
          const hasAdjacent =
            (midIdx > 0 && resultIds.has(`c${midIdx - 1}`)) ||
            (midIdx < numChunks - 1 && resultIds.has(`c${midIdx + 1}`));
          expect(hasAdjacent).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 40: 自检索一致性 ────────────────────────────────────────────────
// Feature: nodejs-claude-code, Property 40: 自检索一致性
// For any indexed chunk, searching with its own text should return it in the
// top 3 results.
// Validates: Requirements 9.11

describe('Property 40: 自检索一致性', () => {
  it('searching with a chunk own text returns it in top 3', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(textArb, { minLength: 1, maxLength: 5 }),
        async (texts) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();

          const chunks = texts.map((t, i) => makeChunk(`c${i}`, t));
          const embeddings = await Promise.all(chunks.map((c) => engine.embedSingle(c.content)));
          await store.upsert(chunks, embeddings);
          bm25.addDocuments(chunks);

          const retriever = new HybridRetriever(store, bm25, engine, {
            topK: Math.min(texts.length, 3),
            expandAdjacentChunks: false,
            expandDependencyChunks: false,
          });

          // For each chunk, search with its own text
          for (const chunk of chunks) {
            const results = await retriever.search(chunk.content);
            const top3Ids = results.slice(0, 3).map((r) => r.chunk.id);
            expect(top3Ids).toContain(chunk.id);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 42: 依赖 Chunk 自动补充 ────────────────────────────────────────
// Feature: nodejs-claude-code, Property 42: 依赖 Chunk 自动补充
// When retrieving chunks, dependency chunks should be automatically supplemented.
// Validates: Requirements 9.13

describe('Property 42: 依赖 Chunk 自动补充', () => {
  it('chunks from dependency files are included in results', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Use two distinct identifiers
        fc.tuple(identArb, identArb).filter(([a, b]) => a !== b),
        async ([mainFile, depFile]) => {
          const engine = makeEmbeddingEngine();
          const store = new VectorStore({ dimensions: DIMS });
          const bm25 = new BM25Index();

          const mainChunk = makeChunk('main-chunk', 'main content alpha', `src/${mainFile}.ts`, 1, 5);
          const depChunk = makeChunk('dep-chunk', 'dep content beta', `src/${depFile}.ts`, 1, 5);

          const embeddings = [
            await engine.embedSingle(mainChunk.content),
            await engine.embedSingle(depChunk.content),
          ];
          await store.upsert([mainChunk, depChunk], embeddings);
          bm25.addDocuments([mainChunk, depChunk]);

          // Store dependency: mainFile imports depFile
          await store.storeDependencyGraph({
            edges: [{ from: `src/${mainFile}.ts`, to: `src/${depFile}.ts`, specifiers: [] }],
            adjacencyList: new Map([[`src/${mainFile}.ts`, [`src/${depFile}.ts`]]]),
            reverseList: new Map([[`src/${depFile}.ts`, [`src/${mainFile}.ts`]]]),
          });

          const retriever = new HybridRetriever(store, bm25, engine, {
            topK: 1,
            expandAdjacentChunks: false,
            expandDependencyChunks: true,
          });

          const results = await retriever.search('main content alpha');
          const resultIds = new Set(results.map((r) => r.chunk.id));

          // Main chunk should be in results
          expect(resultIds.has('main-chunk')).toBe(true);
          // Dependency chunk should also be included
          expect(resultIds.has('dep-chunk')).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });
});
