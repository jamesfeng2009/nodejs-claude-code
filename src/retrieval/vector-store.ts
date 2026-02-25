import type { Chunk } from '../types/chunks.js';
import type { DependencyGraph } from '../types/dependency.js';

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  source: 'vector' | 'bm25';
}

export interface VectorStoreConfig {
  /** Path for persistence (not used in in-memory MVP) */
  dbPath?: string;
  dimensions?: number;
}

interface StoredEntry {
  chunk: Chunk;
  embedding: number[];
}

/**
 * In-memory vector store using cosine similarity search.
 * Supports incremental updates via file content hashes.
 */
export class VectorStore {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly fileHashes = new Map<string, string>();
  private dependencyGraph: DependencyGraph | null = null;
  readonly dimensions: number;

  constructor(config: VectorStoreConfig = {}) {
    this.dimensions = config.dimensions ?? 1536;
  }

  /** Insert or update chunks with their embeddings. */
  async upsert(chunks: Chunk[], embeddings: number[][]): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error('chunks and embeddings arrays must have the same length');
    }
    for (let i = 0; i < chunks.length; i++) {
      this.entries.set(chunks[i]!.id, {
        chunk: chunks[i]!,
        embedding: embeddings[i]!,
      });
    }
  }

  /**
   * Search for the top-K most similar chunks using cosine similarity.
   * Results are sorted in descending order of similarity.
   */
  async search(queryEmbedding: number[], topK: number): Promise<ScoredChunk[]> {
    const results: ScoredChunk[] = [];

    for (const entry of this.entries.values()) {
      const score = cosineSimilarity(queryEmbedding, entry.embedding);
      results.push({ chunk: entry.chunk, score, source: 'vector' });
    }

    // Sort descending by score
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Delete chunks by their IDs. */
  async delete(chunkIds: string[]): Promise<void> {
    for (const id of chunkIds) {
      this.entries.delete(id);
    }
  }

  /** Get the stored content hash for a file path. */
  getFileHash(filePath: string): string | null {
    return this.fileHashes.get(filePath) ?? null;
  }

  /** Store the content hash for a file path. */
  setFileHash(filePath: string, hash: string): void {
    this.fileHashes.set(filePath, hash);
  }

  /** Store the dependency graph. */
  async storeDependencyGraph(graph: DependencyGraph): Promise<void> {
    this.dependencyGraph = graph;
  }

  /** Get direct dependencies of a file. */
  getDependencies(filePath: string): string[] {
    if (!this.dependencyGraph) return [];
    // Support both class instances (with getDependencies method) and plain objects
    if (typeof this.dependencyGraph.getDependencies === 'function') {
      return this.dependencyGraph.getDependencies(filePath);
    }
    return this.dependencyGraph.adjacencyList.get(filePath) ?? [];
  }

  /** Get all chunks currently stored. */
  getAllChunks(): Chunk[] {
    return Array.from(this.entries.values()).map((e) => e.chunk);
  }

  /** Get the number of stored entries. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value in [-1, 1]; higher means more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
