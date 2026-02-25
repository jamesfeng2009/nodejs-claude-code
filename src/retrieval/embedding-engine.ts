import type { Chunk } from '../types/chunks.js';

export interface EmbeddingConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  /** If provided, use this function instead of real API calls (for testing) */
  mockEmbed?: (text: string) => number[];
}

export class EmbeddingEngine {
  private readonly config: Required<Omit<EmbeddingConfig, 'mockEmbed'>> & {
    mockEmbed?: (text: string) => number[];
  };
  private retryQueue: Chunk[] = [];

  constructor(config: EmbeddingConfig = {}) {
    this.config = {
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      model: config.model ?? 'text-embedding-3-small',
      dimensions: config.dimensions ?? 1536,
      mockEmbed: config.mockEmbed,
    };
  }

  /**
   * Embed multiple texts, returning a 2D array of vectors.
   * Each vector has `dimensions` elements.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    if (this.config.mockEmbed) {
      return texts.map((t) => this.config.mockEmbed!(t));
    }

    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to preserve order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  /** Embed a single text string. */
  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0]!;
  }

  /**
   * Batch-embed chunks. Failed chunks are added to the retry queue and do not
   * block other chunks from being processed.
   *
   * Returns a Map from chunk.id → embedding vector.
   */
  async embedBatch(chunks: Chunk[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    const failed: Chunk[] = [];

    for (const chunk of chunks) {
      try {
        const embedding = await this.embedSingle(chunk.content);
        result.set(chunk.id, embedding);
      } catch {
        // Add to retry queue; do not block other chunks
        failed.push(chunk);
      }
    }

    // Append failed chunks to the retry queue
    this.retryQueue.push(...failed);

    return result;
  }

  /** Return the current retry queue (chunks that failed embedding). */
  getRetryQueue(): Chunk[] {
    return [...this.retryQueue];
  }

  /** Clear the retry queue (e.g., after a retry pass). */
  clearRetryQueue(): void {
    this.retryQueue = [];
  }

  /** Retry all chunks in the retry queue. */
  async retryFailed(): Promise<Map<string, number[]>> {
    const toRetry = [...this.retryQueue];
    this.retryQueue = [];
    return this.embedBatch(toRetry);
  }

  get dimensions(): number {
    return this.config.dimensions;
  }
}
