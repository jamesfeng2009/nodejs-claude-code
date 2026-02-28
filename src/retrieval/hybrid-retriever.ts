import type { Chunk } from '../types/chunks.js';
import type { VectorStore, ScoredChunk } from './vector-store.js';
import type { BM25Index } from './bm25-index.js';
import type { EmbeddingEngine } from './embedding-engine.js';

export interface RetrieverConfig {
  vectorWeight?: number;
  bm25Weight?: number;
  similarityThreshold?: number;
  topK?: number;
  expandAdjacentChunks?: boolean;
  expandDependencyChunks?: boolean;
}

/**
 * Hybrid retriever combining vector similarity search and BM25 keyword search.
 * Uses Reciprocal Rank Fusion (RRF) for result merging.
 */
export class HybridRetriever {
  private readonly vectorWeight: number;
  private readonly bm25Weight: number;
  private readonly similarityThreshold: number;
  private readonly topK: number;
  private readonly expandAdjacentChunks: boolean;
  private readonly expandDependencyChunks: boolean;

  constructor(
    private readonly vectorStore: VectorStore,
    private readonly bm25Index: BM25Index,
    private readonly embeddingEngine: EmbeddingEngine,
    config: RetrieverConfig = {}
  ) {
    this.vectorWeight = config.vectorWeight ?? 0.7;
    this.bm25Weight = config.bm25Weight ?? 0.3;
    this.similarityThreshold = config.similarityThreshold ?? 0.5;
    this.topK = config.topK ?? 10;
    this.expandAdjacentChunks = config.expandAdjacentChunks ?? true;
    this.expandDependencyChunks = config.expandDependencyChunks ?? true;
  }

  /**
   * Remove all indexed chunks for a given file path from both the vector store
   * and the BM25 index.
   */
  async removeChunksByFile(filePath: string): Promise<void> {
    const allChunks = this.vectorStore.getAllChunks();
    const ids = allChunks
      .filter((c) => c.metadata.filePath === filePath)
      .map((c) => c.id);
    if (ids.length > 0) {
      await this.vectorStore.delete(ids);
      this.bm25Index.removeDocuments(ids);
    }
  }

  /**
   * Embed and index a set of chunks into both the vector store and BM25 index.
   */
  async indexChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const embeddingMap = await this.embeddingEngine.embedBatch(chunks);
    const toUpsert: Chunk[] = [];
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      const emb = embeddingMap.get(chunk.id);
      if (emb) {
        toUpsert.push(chunk);
        embeddings.push(emb);
      }
    }
    if (toUpsert.length > 0) {
      await this.vectorStore.upsert(toUpsert, embeddings);
      this.bm25Index.addDocuments(toUpsert);
    }
  }

  /**
   * Perform hybrid retrieval:
   * 1. Vector similarity search
   * 2. BM25 keyword search
   * 3. Fuse results (with low-similarity BM25 boost if needed)
   * 4. Expand adjacent chunks
   * 5. Expand dependency chunks
   */
  async search(query: string): Promise<ScoredChunk[]> {
    // 1. Vector search
    const queryEmbedding = await this.embeddingEngine.embedSingle(query);
    const vectorResults = await this.vectorStore.search(queryEmbedding, this.topK);

    // 2. BM25 search
    const bm25Results = this.bm25Index.search(query, this.topK);

    // 3. Determine if we need to boost BM25 weight
    const maxVectorSimilarity = vectorResults.length > 0 ? vectorResults[0]!.score : 0;
    const lowSimilarity = maxVectorSimilarity < this.similarityThreshold;

    // 4. Fuse results
    const fused = this.fuseResults(vectorResults, bm25Results, lowSimilarity);

    // 5. Expand adjacent chunks
    let expanded = this.expandAdjacentChunks
      ? this.expandWithAdjacentChunks(fused)
      : fused;

    // 6. Expand dependency chunks
    if (this.expandDependencyChunks) {
      expanded = this.expandWithDependencyChunks(expanded);
    }

    return expanded;
  }

  /**
   * Fuse vector and BM25 results using Reciprocal Rank Fusion (RRF).
   * When lowSimilarity is true, BM25 weight is boosted.
   */
  fuseResults(
    vectorResults: ScoredChunk[],
    bm25Results: ScoredChunk[],
    lowSimilarity = false
  ): ScoredChunk[] {
    const effectiveVectorWeight = lowSimilarity ? this.vectorWeight * 0.5 : this.vectorWeight;
    const effectiveBm25Weight = lowSimilarity ? Math.min(1 - effectiveVectorWeight, 0.8) : this.bm25Weight;

    const rrfK = 60; // RRF constant
    const scores = new Map<string, { chunk: Chunk; score: number; sources: Set<string> }>();

    // Add vector results
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const item = vectorResults[rank]!;
      const rrfScore = effectiveVectorWeight / (rrfK + rank + 1);
      const existing = scores.get(item.chunk.id);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.add('vector');
      } else {
        scores.set(item.chunk.id, {
          chunk: item.chunk,
          score: rrfScore,
          sources: new Set(['vector']),
        });
      }
    }

    // Add BM25 results
    for (let rank = 0; rank < bm25Results.length; rank++) {
      const item = bm25Results[rank]!;
      const rrfScore = effectiveBm25Weight / (rrfK + rank + 1);
      const existing = scores.get(item.chunk.id);
      if (existing) {
        existing.score += rrfScore;
        existing.sources.add('bm25');
      } else {
        scores.set(item.chunk.id, {
          chunk: item.chunk,
          score: rrfScore,
          sources: new Set(['bm25']),
        });
      }
    }

    const results: ScoredChunk[] = Array.from(scores.values()).map((entry) => ({
      chunk: entry.chunk,
      score: entry.score,
      source: entry.sources.has('vector') ? 'vector' : 'bm25',
    }));

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.topK);
  }

  /**
   * Expand results by including adjacent chunks from the same file.
   * Adjacent = chunks whose line ranges are immediately before or after a hit chunk.
   */
  expandWithAdjacentChunks(chunks: ScoredChunk[]): ScoredChunk[] {
    const allChunks = this.vectorStore.getAllChunks();
    const resultIds = new Set(chunks.map((c) => c.chunk.id));
    const toAdd: ScoredChunk[] = [];

    for (const scored of chunks) {
      const { filePath, startLine, endLine } = scored.chunk.metadata;

      // Find adjacent chunks in the same file
      for (const candidate of allChunks) {
        if (candidate.metadata.filePath !== filePath) continue;
        if (resultIds.has(candidate.id)) continue;

        const cStart = candidate.metadata.startLine;
        const cEnd = candidate.metadata.endLine;

        // Adjacent: immediately before or after (within 1 line gap)
        const isAdjacentBefore = cEnd >= startLine - 2 && cEnd < startLine;
        const isAdjacentAfter = cStart <= endLine + 2 && cStart > endLine;

        if (isAdjacentBefore || isAdjacentAfter) {
          resultIds.add(candidate.id);
          toAdd.push({
            chunk: candidate,
            score: scored.score * 0.8, // slightly lower score for adjacent
            source: scored.source,
          });
        }
      }
    }

    const combined = [...chunks, ...toAdd];
    combined.sort((a, b) => b.score - a.score);
    return combined;
  }

  /**
   * Expand results by including chunks from dependency files.
   * For each hit chunk, look up its file's dependencies and include
   * relevant chunks from those files.
   * Limits total results to topK * 2 to avoid prompt bloat in large projects (P1-4 fix).
   */
  expandWithDependencyChunks(chunks: ScoredChunk[]): ScoredChunk[] {
    const allChunks = this.vectorStore.getAllChunks();
    const resultIds = new Set(chunks.map((c) => c.chunk.id));
    const toAdd: ScoredChunk[] = [];
    // Cap: at most topK extra chunks from dependency expansion
    const maxExtra = this.topK;

    // Collect all dependency files for hit chunks
    const depFiles = new Set<string>();
    for (const scored of chunks) {
      const deps = this.vectorStore.getDependencies(scored.chunk.metadata.filePath);
      for (const dep of deps) {
        depFiles.add(dep);
      }
    }

    // Add chunks from dependency files, respecting the cap
    for (const depFile of depFiles) {
      if (toAdd.length >= maxExtra) break;
      const depChunks = allChunks.filter((c) => c.metadata.filePath === depFile);
      for (const depChunk of depChunks) {
        if (toAdd.length >= maxExtra) break;
        if (!resultIds.has(depChunk.id)) {
          resultIds.add(depChunk.id);
          toAdd.push({
            chunk: depChunk,
            score: 0.1, // low score for dependency-expanded chunks
            source: 'vector',
          });
        }
      }
    }

    const combined = [...chunks, ...toAdd];
    combined.sort((a, b) => b.score - a.score);
    return combined;
  }
}
