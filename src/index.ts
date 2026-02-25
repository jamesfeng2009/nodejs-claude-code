/**
 * Entry point for the AI programming assistant.
 * Supports two modes:
 *   --http   Start the HTTP API server (default port 3000)
 *   (none)   Start the interactive CLI REPL
 *
 * Validates: Requirements 1.1, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 10.1, 10.3
 */
import { ConfigManager } from './config/config-manager.js';
import { LLMClient } from './llm/client.js';
import { ToolRegistry } from './tools/registry.js';
import { EmbeddingEngine } from './retrieval/embedding-engine.js';
import { VectorStore } from './retrieval/vector-store.js';
import { BM25Index } from './retrieval/bm25-index.js';
import { DependencyGraph } from './context/dependency-graph.js';
import { HybridRetriever } from './retrieval/hybrid-retriever.js';
import { KeyEntityCache } from './context/key-entity-cache.js';
import { ContextManager } from './context/context-manager.js';
import { ConversationManager } from './conversation/manager.js';
import { SubAgentManager } from './agent/sub-agent-manager.js';
import { OrchestratorAgent } from './agent/orchestrator.js';
import { SessionStore } from './session/session-store.js';
import { IdempotencyStore } from './api/idempotency/idempotency-store.js';
import { SSEStreamManager } from './api/sse/sse-stream.js';
import { StateSnapshotManager } from './api/snapshot/state-snapshot-manager.js';
import { RunManager } from './agent/run-manager.js';
import { HTTPAPIServer } from './api/server.js';
import { createFileReadTool } from './tools/implementations/file-read.js';
import { createFileWriteTool } from './tools/implementations/file-write.js';
import { createFileEditTool } from './tools/implementations/file-edit.js';
import { createShellExecuteTool } from './tools/implementations/shell-execute.js';
import { createGrepSearchTool } from './tools/implementations/grep-search.js';
import { createListDirectoryTool } from './tools/implementations/list-directory.js';
import { StreamingRenderer } from './cli/streaming-renderer.js';
import { REPL } from './cli/repl.js';

async function main(): Promise<void> {
  const workDir = process.cwd();
  const args = process.argv.slice(2);
  const httpMode = args.includes('--http');

  // Load configuration (env vars > project config > global config > defaults)
  const config = ConfigManager.load(workDir);

  // Validate API key
  if (!config.llm.apiKey) {
    console.error(
      'Error: No API key configured. Set AI_ASSISTANT_API_KEY or ANTHROPIC_API_KEY environment variable, ' +
      'or add "llm.apiKey" to .ai-assistant.json.',
    );
    process.exit(1);
  }

  // ── Core LLM client ──────────────────────────────────────────────────────
  const llmClient = new LLMClient({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
  });

  // ── Tool registry + built-in tools ───────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createFileReadTool(workDir));
  toolRegistry.register(createFileWriteTool(workDir));
  toolRegistry.register(createFileEditTool(workDir));
  toolRegistry.register(createShellExecuteTool(workDir));
  toolRegistry.register(createGrepSearchTool(workDir));
  toolRegistry.register(createListDirectoryTool(workDir));

  // ── Retrieval stack ───────────────────────────────────────────────────────
  const embeddingEngine = new EmbeddingEngine({
    apiKey: config.llm.apiKey,
    // Use a dedicated embedding base URL if configured; otherwise default to OpenAI.
    baseUrl: process.env['AI_ASSISTANT_EMBEDDING_BASE_URL'],
  });
  const vectorStore = new VectorStore({ dimensions: embeddingEngine.dimensions });
  const bm25Index = new BM25Index();
  const _dependencyGraph = new DependencyGraph();

  const hybridRetriever = new HybridRetriever(vectorStore, bm25Index, embeddingEngine, {
    vectorWeight: config.retriever.vectorWeight,
    bm25Weight: config.retriever.bm25Weight,
    similarityThreshold: config.retriever.similarityThreshold,
    topK: config.retriever.topK,
    expandAdjacentChunks: config.retriever.expandAdjacentChunks,
    expandDependencyChunks: config.retriever.expandDependencyChunks,
  });

  // ── Context & conversation management ────────────────────────────────────
  const keyEntityCache = new KeyEntityCache();
  const contextManager = new ContextManager(hybridRetriever, keyEntityCache, {
    maxChunkSize: config.context.maxChunkSize,
    overlapLines: config.context.overlapLines,
    toolOutputMaxLines: config.context.toolOutputMaxLines,
  });

  // Conversation config: highWaterMark / lowWaterMark are fractions in config,
  // convert to absolute token counts.
  const maxTokens = config.conversation.maxContextTokens;
  const conversationManager = new ConversationManager(
    {
      highWaterMark: Math.floor(config.conversation.highWaterMark * maxTokens),
      lowWaterMark: Math.floor(config.conversation.lowWaterMark * maxTokens),
      maxContextTokens: maxTokens,
    },
    keyEntityCache,
  );

  // ── Agent layer ───────────────────────────────────────────────────────────
  const subAgentManager = new SubAgentManager(llmClient, toolRegistry);
  const orchestrator = new OrchestratorAgent(
    llmClient,
    toolRegistry,
    contextManager,
    conversationManager,
    subAgentManager,
  );

  // ── Session store ─────────────────────────────────────────────────────────
  const sessionStore = new SessionStore(workDir);

  if (httpMode) {
    // ── HTTP API Server mode (P1-9 fix) ──────────────────────────────────
    const runManager = new RunManager();
    const sseManager = new SSEStreamManager();
    const snapshotManager = new StateSnapshotManager(sessionStore, runManager, sseManager);
    const idempotencyStore = new IdempotencyStore(config.idempotency.ttlMs);

    // Bearer token: wrap single string into array for BearerTokenAuth
    const validTokens = config.httpApi.bearerToken ? [config.httpApi.bearerToken] : [];

    const server = new HTTPAPIServer({
      port: config.httpApi.port,
      host: config.httpApi.host,
      validTokens,
      allowedOrigins: config.httpApi.corsAllowedOrigins,
      sessionStore,
      runManager,
      snapshotManager,
      idempotencyStore,
      orchestrator,
    });

    await server.start();
    console.log(`HTTP API server listening on ${config.httpApi.host}:${config.httpApi.port}`);
  } else {
    // ── CLI REPL mode ─────────────────────────────────────────────────────
    const renderer = new StreamingRenderer();
    const repl = new REPL(orchestrator, renderer);
    await repl.start();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
