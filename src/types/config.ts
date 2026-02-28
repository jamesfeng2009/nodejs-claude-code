import { MCPConfig } from '../mcp/types.js';

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
    /** Optional model identifier for compression calls (default: 'claude-haiku-20240307') */
    compressionModel?: string;
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
  mcp?: MCPConfig;
}
