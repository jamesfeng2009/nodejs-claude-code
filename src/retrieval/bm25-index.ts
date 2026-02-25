import type { Chunk } from '../types/chunks.js';
import type { ScoredChunk } from './vector-store.js';

interface DocEntry {
  chunk: Chunk;
  termFreqs: Map<string, number>;
  length: number;
}

/**
 * In-memory BM25 index for keyword-based retrieval.
 * Valid within a session (not persisted).
 */
export class BM25Index {
  private readonly docs = new Map<string, DocEntry>();
  private readonly k1: number;
  private readonly b: number;

  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
  }

  /** Add or update documents in the index. */
  addDocuments(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const terms = tokenize(chunk.content);
      const termFreqs = new Map<string, number>();
      for (const term of terms) {
        termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
      }
      this.docs.set(chunk.id, { chunk, termFreqs, length: terms.length });
    }
  }

  /** Search for the top-K most relevant chunks using BM25 scoring. */
  search(query: string, topK: number): ScoredChunk[] {
    if (this.docs.size === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const avgDocLen = this.averageDocLength();
    const N = this.docs.size;

    const scores = new Map<string, number>();

    for (const term of queryTerms) {
      const df = this.documentFrequency(term);
      if (df === 0) continue;

      // IDF with smoothing
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const [id, doc] of this.docs) {
        const tf = doc.termFreqs.get(term) ?? 0;
        if (tf === 0) continue;

        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / avgDocLen)));

        scores.set(id, (scores.get(id) ?? 0) + idf * tfNorm);
      }
    }

    const results: ScoredChunk[] = [];
    for (const [id, score] of scores) {
      const entry = this.docs.get(id)!;
      results.push({ chunk: entry.chunk, score, source: 'bm25' });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /** Remove documents from the index by chunk IDs. */
  removeDocuments(chunkIds: string[]): void {
    for (const id of chunkIds) {
      this.docs.delete(id);
    }
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.size;
  }

  private averageDocLength(): number {
    if (this.docs.size === 0) return 0;
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.length;
    }
    return total / this.docs.size;
  }

  private documentFrequency(term: string): number {
    let count = 0;
    for (const doc of this.docs.values()) {
      if (doc.termFreqs.has(term)) count++;
    }
    return count;
  }
}

/** Simple tokenizer: lowercase, split on non-alphanumeric characters. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}
