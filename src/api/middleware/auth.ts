/**
 * Bearer Token authentication middleware for Fastify.
 * Requirements: 10.4, 10.5
 */
export class BearerTokenAuth {
  private readonly validTokens: Set<string>;

  constructor(validTokens: string[]) {
    this.validTokens = new Set(validTokens);
  }

  /**
   * Fastify preHandler hook.
   * Checks Authorization header for 'Bearer <token>'.
   * Returns 401 if missing or invalid.
   */
  preHandler = (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (status: number) => { send: (body: unknown) => void } },
    done: (err?: Error) => void,
  ): void => {
    const authHeader = request.headers['authorization'];
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!headerValue || !headerValue.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Missing or invalid Bearer token' });
      return;
    }

    const token = headerValue.slice('Bearer '.length);
    if (!this.validTokens.has(token)) {
      reply.code(401).send({ error: 'Unauthorized', message: 'Invalid Bearer token' });
      return;
    }

    done();
  };

  /**
   * Validates a token directly (for testing purposes).
   */
  isValidToken(token: string): boolean {
    return this.validTokens.has(token);
  }
}
