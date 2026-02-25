export interface AppConfig {
  llm: {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
    temperature: number;
  };
  context: {
    maxChunkSize: number;
    overlapLines: number;
    toolOutputMaxLines: number;
  };
  conversation: {
    highWaterMark: number;
    lowWaterMark: number;
    maxContextTokens: number;
  };
  retriever: {
    vectorWeight: number;
    bm25Weight: number;
    similarityThreshold: number;
    topK: number;
    expandAdjacentChunks: boolean;
    expandDependencyChunks: boolean;
  };
  security: {
    sensitiveFilePatterns: string[];
    confirmShellCommands: boolean;
  };
  httpApi: {
    port: number;
    host: string;
    bearerToken: string;
    corsAllowedOrigins: string[];
  };
  session: {
    storagePath: string;
    expirationDays: number;
  };
  idempotency: {
    ttlMs: number;
  };
}
