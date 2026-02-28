import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import type { SessionStore } from '../session/session-store.js';
import type { RunManager } from '../agent/run-manager.js';
import type { StateSnapshotManager } from './snapshot/state-snapshot-manager.js';
import type { IdempotencyStore } from './idempotency/idempotency-store.js';
import type { OrchestratorAgent } from '../agent/orchestrator.js';
import { BearerTokenAuth } from './middleware/auth.js';
import { CORSMiddleware } from './middleware/cors.js';
import { SSEStreamManager } from './sse/sse-stream.js';
import type { AgentRequest } from '../types/run.js';
import type { ContentBlock } from '../types/messages.js';
import { ContentValidator } from '../multimodal/content-validator.js';

export interface ServerOptions {
  port: number;
  host: string;
  validTokens: string[];
  allowedOrigins: string[];
  sessionStore: SessionStore;
  runManager: RunManager;
  snapshotManager: StateSnapshotManager;
  idempotencyStore: IdempotencyStore;
  orchestrator: OrchestratorAgent;
  /** Shared SSEStreamManager instance — must be the same one passed to StateSnapshotManager */
  sseManager: SSEStreamManager;
  /** Optional hook called when a session is deleted (e.g. to clean up shell sessions) */
  onSessionDelete?: (sessionId: string) => void;
}

/**
 * HTTP API Server based on Fastify.
 * Provides REST endpoints and SSE streaming for agent runs.
 * Requirements: 10.1–10.7, 12.1, 12.2, 12.4, 13.1, 13.2, 14.1, 14.2
 */
export class HTTPAPIServer {
  private readonly fastify: FastifyInstance;
  private readonly auth: BearerTokenAuth;
  private readonly cors: CORSMiddleware;
  private readonly sseManager: SSEStreamManager;
  private readonly options: ServerOptions;

  constructor(options: ServerOptions) {
    this.options = options;
    this.fastify = Fastify({ logger: false });
    this.auth = new BearerTokenAuth(options.validTokens);
    this.cors = new CORSMiddleware(options.allowedOrigins);
    // Use the shared sseManager injected from outside — must be the same instance
    // passed to StateSnapshotManager so getCurrentSeq() reads accurate event counts.
    this.sseManager = options.sseManager;

    // Wire the run handler so RunManager drives serial execution per session.
    // NOTE: executeRun does NOT call transitionState('running') itself —
    // enqueueRun already does that before invoking the handler.
    options.runManager.setHandler((run) =>
      this.executeRun(run.runId, run.sessionId, run.request, run.request.idempotencyKey, options.orchestrator),
    );

    this.registerMiddleware();
    this.registerRoutes();
  }

  private registerMiddleware(): void {
    this.cors.addHooks(this.fastify as unknown as Parameters<CORSMiddleware['addHooks']>[0]);

    this.fastify.addHook(
      'preHandler',
      (
        request: FastifyRequest,
        reply: FastifyReply,
        done: (err?: Error) => void,
      ) => {
        this.auth.preHandler(
          request as unknown as Parameters<BearerTokenAuth['preHandler']>[0],
          reply as unknown as Parameters<BearerTokenAuth['preHandler']>[1],
          done,
        );
      },
    );
  }

  private registerRoutes(): void {
    const { sessionStore, runManager, snapshotManager, idempotencyStore } =
      this.options;

    // POST /api/sessions — create session
    this.fastify.post('/api/sessions', async (_request, reply) => {
      const session = sessionStore.create();
      await sessionStore.save(session);
      return reply.code(201).send(session);
    });

    // GET /api/sessions — list sessions
    this.fastify.get('/api/sessions', async (_request, reply) => {
      const sessions = await sessionStore.list();
      return reply.send(sessions);
    });

    // GET /api/sessions/:sessionId — get session
    this.fastify.get<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId',
      async (request, reply) => {
        try {
          const session = await sessionStore.load(request.params.sessionId);
          return reply.send(session);
        } catch {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
      },
    );

    // DELETE /api/sessions/:sessionId — delete session
    this.fastify.delete<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId',
      async (request, reply) => {
        try {
          await sessionStore.delete(request.params.sessionId);
          this.options.onSessionDelete?.(request.params.sessionId);
          return reply.code(204).send();
        } catch {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
      },
    );

    // POST /api/sessions/:sessionId/agent — submit agent request (202 + runId)
    // Accepts Idempotency-Key from header OR body.idempotencyKey. Requirements: 12.1, 13.1, 13.2
    // Accepts content?: ContentBlock[] as alternative to message. Requirements: 3.1–3.7
    this.fastify.post<{
      Params: { sessionId: string };
      Body: { message?: string; content?: ContentBlock[]; idempotencyKey?: string };
    }>('/api/sessions/:sessionId/agent', async (request, reply) => {
      const idempotencyKey =
        (request.headers as Record<string, string | undefined>)['idempotency-key'] ??
        request.body?.idempotencyKey;

      if (!idempotencyKey) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Idempotency-Key is required (header or body.idempotencyKey)',
        });
      }

      const { message, content } = request.body ?? {};

      // Req 3.6: both message and content missing → 400
      if (!message && !content) {
        return reply.code(400).send({ error: 'Bad Request', message: 'message or content is required' });
      }

      // Req 3.2, 3.3: validate content blocks if present
      if (content) {
        const validator = new ContentValidator();
        const validation = validator.validateBlocks(content);
        if (!validation.valid) {
          return reply.code(400).send({ error: 'Bad Request', message: validation.error });
        }

        // Req 3.4: ImageBlock base64 > 5MB → 413
        const MB5 = 5 * 1024 * 1024;
        const MB10 = 10 * 1024 * 1024;
        for (const block of content) {
          if (block.type === 'image' && block.data) {
            // base64 encodes 3 bytes as 4 chars; decoded size ≈ data.length * 3/4
            const decodedSize = Math.floor(block.data.length * 3 / 4);
            if (decodedSize > MB5) {
              return reply.code(413).send({ error: 'Payload Too Large', message: 'Image data exceeds maximum size of 5MB' });
            }
          }
          // Req 3.5: FileBlock base64 > 10MB → 413
          if (block.type === 'file' && block.data) {
            const decodedSize = Math.floor(block.data.length * 3 / 4);
            if (decodedSize > MB10) {
              return reply.code(413).send({ error: 'Payload Too Large', message: 'File data exceeds maximum size of 10MB' });
            }
          }
        }
      }

      // Two-layer idempotency check
      const idempotencyResult = idempotencyStore.check(idempotencyKey);
      if (idempotencyResult.status === 'completed') {
        // Return cached result — run already finished
        return reply.code(200).send(idempotencyResult.result);
      }
      if (idempotencyResult.status === 'in_flight') {
        // A run for this key is already executing.
        // Look up the existing runId so the client can subscribe to SSE.
        const existingRunId = idempotencyStore.getRunId(idempotencyKey);
        return reply.code(202).send({
          runId: existingRunId,
          message: 'Request is already being processed',
        });
      }

      // New request — submit run and enqueue for serial session execution
      // Req 3.1, 3.7: pass content or message to AgentRequest
      const agentRequest: AgentRequest = content
        ? { content, idempotencyKey }
        : { message, idempotencyKey };
      const run = runManager.submit(request.params.sessionId, agentRequest);

      // Record the runId in the idempotency store so in_flight retries can find it
      idempotencyStore.setRunId(idempotencyKey, run.runId);

      // Create SSE stream before kicking off async work so subscribers never miss events
      this.sseManager.createStream(run.runId);

      // Enqueue: RunManager ensures at most one run executes per session at a time
      runManager.enqueueRun(run);

      return reply.code(202).send({ runId: run.runId });
    });

    // GET /api/sessions/:sessionId/runs/:runId/events — SSE event stream
    // Keeps the connection open and streams events until the run completes.
    // On resubscribe, sends state_summary first then continues streaming.
    // Requirements: 10.2, 14.2
    this.fastify.get<{ Params: { sessionId: string; runId: string } }>(
      '/api/sessions/:sessionId/runs/:runId/events',
      async (request, reply) => {
        const { runId } = request.params;
        const run = runManager.getStatus(runId);

        if (!run) {
          return reply.code(404).send({ error: 'Not Found', message: 'Run not found' });
        }

        // Must use raw response to keep the connection open for SSE
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const summary = snapshotManager.getRunSummary(runId);

        if (run.status === 'completed' || run.status === 'failed') {
          // Run already finished — send state_summary and close immediately.
          // Re-create a temporary stream so pushEvent can write to this response.
          if (summary) {
            this.sseManager.createStream(runId);
            this.sseManager.subscribe(runId, reply.raw);
            this.sseManager.pushEvent(runId, {
              event: 'state_summary',
              data: { summary },
            });
            this.sseManager.closeStream(runId);
          } else {
            reply.raw.end();
          }
        } else {
          // Run still in progress — subscribe and keep connection open.
          // closeStream() will call res.end() on all subscribers when the run finishes.
          if (summary) {
            this.sseManager.resubscribe(runId, reply.raw, summary);
          } else {
            this.sseManager.subscribe(runId, reply.raw);
          }
        }

        return reply;
      },
    );

    // GET /api/sessions/:sessionId/runs/:runId — get run status
    // Requirements: 12.4
    this.fastify.get<{ Params: { sessionId: string; runId: string } }>(
      '/api/sessions/:sessionId/runs/:runId',
      async (request, reply) => {
        const run = runManager.getStatus(request.params.runId);
        if (!run) {
          return reply.code(404).send({ error: 'Not Found', message: 'Run not found' });
        }
        return reply.send(run);
      },
    );

    // GET /api/sessions/:sessionId/snapshot — get state snapshot
    // Requirements: 14.1
    this.fastify.get<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/snapshot',
      async (_request, reply) => {
        const snapshot = await snapshotManager.generateSnapshot();
        return reply.send(snapshot);
      },
    );
  }

  /**
   * Runs the agent for a single run, pushing SSE events to subscribers.
   * Called by RunManager's handler — guaranteed serial per session.
   * The run is already in 'running' state when this is called (enqueueRun transitions it).
   * Idempotency is marked complete/failed here — after the run actually finishes.
   * Persists conversation history to session after each run (P2-1 fix).
   * Requirements: 12.2, 13.4, 13.6
   */
  private async executeRun(
    runId: string,
    sessionId: string,
    request: AgentRequest,
    idempotencyKey: string,
    orchestrator: OrchestratorAgent,
  ): Promise<void> {
    const { idempotencyStore, sessionStore } = this.options;

    // The run is already in 'running' state (enqueueRun transitioned it).
    // Just push the status event.
    this.sseManager.pushEvent(runId, {
      event: 'run_status',
      data: { runId, status: 'running' },
    });

    try {
      for await (const chunk of orchestrator.processMessage(request.message ?? request.content!)) {
        if (chunk.type === 'text' && chunk.content) {
          this.sseManager.pushEvent(runId, {
            event: 'text_delta',
            data: { content: chunk.content },
          });
        } else if (chunk.type === 'tool_call_start' && chunk.toolCall?.id && chunk.toolCall.name) {
          this.sseManager.pushEvent(runId, {
            event: 'tool_call_start',
            data: {
              toolCall: {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
                arguments: chunk.toolCall.arguments ?? {},
              },
            },
          });
        } else if (chunk.type === 'tool_call_end' && chunk.toolCall?.id && chunk.toolCall.name) {
          this.sseManager.pushEvent(runId, {
            event: 'tool_call_result',
            data: {
              toolCall: {
                id: chunk.toolCall.id,
                name: chunk.toolCall.name,
              },
            },
          });
        }
      }

      // RunManager.enqueueRun will transition to 'completed' after handler returns.
      this.sseManager.pushEvent(runId, {
        event: 'run_complete',
        data: { runId, status: 'completed' },
      });

      // Mark idempotency complete only after the run has actually finished
      idempotencyStore.complete(idempotencyKey, { runId, status: 'completed' });

      // Persist conversation history back to session (P2-1 fix)
      try {
        const session = await sessionStore.load(sessionId);
        session.conversationHistory = orchestrator.getConversationHistory();
        session.updatedAt = Date.now();
        await sessionStore.save(session);
      } catch {
        // Non-fatal: session may not exist (e.g. created in-memory only)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.sseManager.pushEvent(runId, {
        event: 'run_failed',
        data: { runId, error: errorMsg },
      });
      // Release the in-flight record so retries can re-execute
      idempotencyStore.fail(idempotencyKey);
      // Re-throw so enqueueRun can transition to 'failed'
      throw err;
    } finally {
      // Close all subscriber connections for this run
      this.sseManager.closeStream(runId);
    }
  }

  async start(): Promise<void> {
    await this.fastify.listen({ port: this.options.port, host: this.options.host });
  }

  async stop(): Promise<void> {
    await this.fastify.close();
  }
}
