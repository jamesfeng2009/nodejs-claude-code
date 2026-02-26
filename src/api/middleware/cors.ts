/**
 * CORS middleware for Fastify.
 * Requirements: 10.6, 10.7
 */
export class CORSMiddleware {
  private readonly allowedOrigins: Set<string>;

  constructor(allowedOrigins: string[]) {
    this.allowedOrigins = new Set(allowedOrigins);
  }

  /**
   * Adds Fastify hooks for CORS handling.
   * Sets Access-Control-Allow-Origin if origin is in allowedOrigins.
   * Handles OPTIONS preflight requests.
   */
  addHooks(fastify: {
    addHook: (
      event: string,
      handler: (
        request: { headers: Record<string, string | string[] | undefined>; method: string },
        reply: {
          header: (name: string, value: string) => unknown;
          code: (status: number) => { send: (body?: unknown) => void };
        },
        done: (err?: Error) => void,
      ) => void,
    ) => void;
  }): void {
    fastify.addHook('onRequest', (request, reply, done) => {
      const originHeader = request.headers['origin'];
      const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;

      if (origin) {
        // If allowedOrigins is empty, allow all origins (open mode).
        const allowed = this.allowedOrigins.size === 0 || this.allowedOrigins.has(origin);
        if (allowed) {
          const responseOrigin = this.allowedOrigins.size === 0 ? '*' : origin;
          reply.header('Access-Control-Allow-Origin', responseOrigin);
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
          if (this.allowedOrigins.size > 0) {
            reply.header('Access-Control-Allow-Credentials', 'true');
          }

          if (request.method === 'OPTIONS') {
            reply.code(204).send();
            return;
          }
        } else {
          reply.code(403).send({ error: 'Forbidden', message: 'Origin not allowed' });
          return;
        }
      }

      done();
    });
  }

  /**
   * Checks if an origin is allowed (for testing purposes).
   */
  isAllowedOrigin(origin: string): boolean {
    return this.allowedOrigins.has(origin);
  }
}
