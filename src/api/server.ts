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
    this.sseManager = new SSEStreamManager();

    this.registerMiddleware();
    this.registerRoutes();
  }

  private registerMiddleware(): void {
    // Register CORS hooks
    this.cors.addHooks(this.fastify as unknown as Parameters<CORSMiddleware['addHooks']>[0]);

    // Register auth as a preHandler on all routes
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
    const { sessionStore, runManager, snapshotManager, idempotencyStore, orchestrator } =
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
          return reply.code(204).send();
        } catch {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
      },
    );

    // POST /api/sessions/:sessionId/agent — submit agent request (202 + runId)
    // Requires Idempotency-Key header. Requirements: 12.1, 13.1, 13.2
    this.fastify.post<{
      Params: { sessionId: string };
      Body: { message: string };
    }>('/api/sessions/:sessionId/agent', async (request, reply) => {
      const idempotencyKey = (request.headers as Record<string, string | undefined>)['idempotency-key'];

      if (!idempotencyKey) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Idempotency-Key header is required',
        });
      }

      const { message } = request.body ?? {};
      if (!message) {
        return reply.code(400).send({ error: 'Bad Request', message: 'message is required' });
      }

      // Check idempotency
      const idempotencyResult = idempotencyStore.check(idempotencyKey);
      if (idempotencyResult.status === 'completed') {
        return reply.code(200).send(idempotencyResult.result);
      }
      if (idempotencyResult.status === 'in_flight') {
        return reply.code(202).send({ message: 'Request is already being processed' });
      }

      // Submit new run
      const agentRequest: AgentRequest = { message, idempotencyKey };
      const run = runManager.submit(request.params.sessionId, agentRequest);

      // Create SSE stream for this run
      this.sseManager.createStream(run.runId);

      // Process the run asynchronously
      this.processRunAsync(run.runId, request.params.sessionId, agentRequest, idempotencyKey, orchestrator).catch(
        (err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          try {
            runManager.transitionState(run.runId, 'failed');
          } catch {
            // already transitioned
          }
          this.sseManager.pushEvent(run.runId, {
            event: 'run_failed',
            data: { runId: run.runId, error: errorMsg },
          });
          idempotencyStore.fail(idempotencyKey);
        },
      );

      idempotencyStore.complete(idempotencyKey, { runId: run.runId });

      return reply.code(202).send({ runId: run.runId });
    });

    // GET /api/sessions/:sessionId/runs/:runId/events — SSE event stream
    // Requirements: 10.2, 14.2
    this.fastify.get<{ Params: { sessionId: string; runId: string } }>(
      '/api/sessions/:sessionId/runs/:runId/events',
      async (request, reply) => {
        const { runId } = request.params;
        const run = runManager.getStatus(runId);

        if (!run) {
          return reply.code(404).send({ error: 'Not Found', message: 'Run not found' });
        }

        // Set SSE headers
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // If run is already done, send a final state_summary and close
        const summary = snapshotManager.getRunSummary(runId);
        if (summary) {
          const event = this.sseManager.resubscribe(runId, summary);
          reply.raw.write(this.formatSSEEvent(event));
        }

        reply.raw.end();
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

  private formatSSEEvent(event: {
    id: string;
    seq: number;
    event: string;
    data: unknown;
    timestamp: number;
  }): string {
    return [
      `id: ${event.id}`,
      `event: ${event.event}`,
      `data: ${JSON.stringify({ seq: event.seq, timestamp: event.timestamp, ...((event.data as object) ?? {}) })}`,
      '',
      '',
    ].join('\n');
  }

  private async processRunAsync(
    runId: string,
    _sessionId: string,
    request: AgentRequest,
    _idempotencyKey: string,
    orchestrator: OrchestratorAgent,
  ): Promise<void> {
    const { runManager } = this.options;

    runManager.transitionState(runId, 'running');
    this.sseManager.pushEvent(runId, {
      event: 'run_status',
      data: { runId, status: 'running' },
    });

    try {
      for await (const chunk of orchestrator.processMessage(request.message)) {
        if (chunk.type === 'text' && chunk.content) {
          this.sseManager.pushEvent(runId, {
            event: 'text_delta',
            data: { content: chunk.content },
          });
        } else if (chunk.type === 'tool_call_start') {
          this.sseManager.pushEvent(runId, {
            event: 'tool_call_start',
            data: { toolCall: chunk.toolCall },
          });
        } else if (chunk.type === 'tool_call_end') {
          this.sseManager.pushEvent(runId, {
            event: 'tool_call_result',
            data: { toolCall: chunk.toolCall },
          });
        }
      }

      runManager.transitionState(runId, 'completed');
      this.sseManager.pushEvent(runId, {
        event: 'run_complete',
        data: { runId, status: 'completed' },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      runManager.transitionState(runId, 'failed');
      this.sseManager.pushEvent(runId, {
        event: 'run_failed',
        data: { runId, error: errorMsg },
      });
      throw err;
    } finally {
      this.sseManager.closeStream(runId);
    }
  }

  /**
   * Starts the Fastify server.
   */
  async start(): Promise<void> {
    await this.fastify.listen({ port: this.options.port, host: this.options.host });
  }

  /**
   * Stops the Fastify server.
   */
  async stop(): Promise<void> {
    await this.fastify.close();
  }
}
