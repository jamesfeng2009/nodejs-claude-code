import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamableHttpTransport } from '../../../src/mcp/streamable-http-transport.js';
import type { MCPServerConfig } from '../../../src/mcp/types.js';

// Validates: Requirements 2.3, 2.4, 2.5

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseConfig: MCPServerConfig = {
  name: 'test-http-server',
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
};

/** Build a JSON-RPC response body */
function jsonRpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

/** Create a mock Response with application/json content-type */
function jsonResponse(id: number, result: unknown, status = 200): Response {
  return new Response(jsonRpcResult(id, result), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Encode SSE lines into a ReadableStream of Uint8Array chunks */
function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

/** Create a mock SSE Response */
function sseResponse(events: string[]): Response {
  return new Response(sseStream(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StreamableHttpTransport', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Requirement 2.3 / 2.4: JSON response ─────────────────────────────────

  describe('JSON response', () => {
    it('connect() succeeds and status becomes "connected"', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(1, { protocolVersion: '2024-11-05' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      expect(transport.status).toBe('disconnected');

      await transport.connect();

      expect(transport.status).toBe('connected');
    });

    it('connect() sends an initialize request with correct headers', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(1, { protocolVersion: '2024-11-05' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.method).toBe('initialize');
      expect(body.jsonrpc).toBe('2.0');
    });

    it('listTools() returns the tools array from a JSON response', async () => {
      const tools = [
        { name: 'search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } },
      ];

      // connect
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      // listTools
      mockFetch.mockResolvedValueOnce(jsonResponse(2, { tools }));
      const result = await transport.listTools();

      expect(result).toEqual(tools);
      const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(body.method).toBe('tools/list');
    });

    it('callTool() returns the result from a JSON response', async () => {
      const toolResult = { content: [{ type: 'text', text: 'result text' }], isError: false };

      // connect
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      // callTool
      mockFetch.mockResolvedValueOnce(jsonResponse(2, toolResult));
      const result = await transport.callTool('search', { query: 'hello' });

      expect(result).toEqual(toolResult);
      const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(body.method).toBe('tools/call');
      expect(body.params).toEqual({ name: 'search', arguments: { query: 'hello' } });
    });

    it('accepts a different protocol version with a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2023-01-01' }));

      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      expect(transport.status).toBe('connected');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('协议版本不匹配'));
      warnSpy.mockRestore();
    });

    it('forwards custom headers from config', async () => {
      const configWithHeaders: MCPServerConfig = {
        ...baseConfig,
        headers: { Authorization: 'Bearer token123' },
      };

      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(configWithHeaders, 10_000);
      await transport.connect();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token123' }),
        }),
      );
    });
  });

  // ── Requirement 2.3: SSE streaming response ───────────────────────────────

  describe('SSE streaming response (multiple fragments)', () => {
    it('callTool() collects all content parts from multiple SSE events', async () => {
      // connect via JSON
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      // SSE stream with two data events
      const part1 = JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: 'Hello' }], isError: false },
      });
      const part2 = JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: ' World' }], isError: false },
      });

      mockFetch.mockResolvedValueOnce(
        sseResponse([
          `data: ${part1}\n\n`,
          `data: ${part2}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );

      const result = await transport.callTool('search', { query: 'test' });

      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' });
      expect(result.content[1]).toEqual({ type: 'text', text: ' World' });
      expect(result.isError).toBe(false);
    });

    it('callTool() sets isError=true when any SSE event has isError', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      const errorEvent = JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: 'error occurred' }], isError: true },
      });

      mockFetch.mockResolvedValueOnce(
        sseResponse([`data: ${errorEvent}\n\n`]),
      );

      const result = await transport.callTool('search', { query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'error occurred' });
    });

    it('callTool() handles a single-chunk SSE stream', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      const event = JSON.stringify({
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: 'single chunk' }], isError: false },
      });

      mockFetch.mockResolvedValueOnce(
        sseResponse([`data: ${event}\n\n`]),
      );

      const result = await transport.callTool('search', {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe('single chunk');
    });

    it('callTool() returns empty content for an empty SSE stream', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();

      mockFetch.mockResolvedValueOnce(sseResponse([]));

      const result = await transport.callTool('search', {});

      expect(result.content).toHaveLength(0);
      expect(result.isError).toBe(false);
    });
  });

  // ── Requirement 2.5: connection timeout ──────────────────────────────────

  describe('connection timeout', () => {
    it('connect() rejects after connectTimeoutMs when fetch never resolves', async () => {
      vi.useFakeTimers();

      // fetch never resolves — simulate by returning a promise that only resolves
      // after the abort signal fires (which is what the real implementation does)
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              (err as NodeJS.ErrnoException).name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const transport = new StreamableHttpTransport(baseConfig, 5_000);
      const connectPromise = transport.connect();
      connectPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5_001);

      await expect(connectPromise).rejects.toThrow(/超时|timeout/i);
    });

    it('status is "disconnected" after a connection timeout', async () => {
      vi.useFakeTimers();

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              (err as NodeJS.ErrnoException).name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const transport = new StreamableHttpTransport(baseConfig, 5_000);
      const connectPromise = transport.connect();
      connectPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5_001);
      await expect(connectPromise).rejects.toThrow();

      expect(transport.status).toBe('disconnected');
    });

    it('logs an error when connection times out', async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              (err as NodeJS.ErrnoException).name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const transport = new StreamableHttpTransport(baseConfig, 5_000);
      const connectPromise = transport.connect();
      connectPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(5_001);
      await expect(connectPromise).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test-http-server'));
      errorSpy.mockRestore();
    });
  });

  // ── Requirement 2.3: HTTP error status codes ─────────────────────────────

  describe('HTTP error status codes', () => {
    it('throws an error containing the status code for a 404 response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404, statusText: 'Not Found' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);

      await expect(transport.connect()).rejects.toThrow('404');
    });

    it('throws an error containing the status code for a 500 response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);

      await expect(transport.connect()).rejects.toThrow('500');
    });

    it('status is "disconnected" after an HTTP error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403, statusText: 'Forbidden' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await expect(transport.connect()).rejects.toThrow();

      expect(transport.status).toBe('disconnected');
    });

    it('throws an error for a 401 Unauthorized response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
      );

      const transport = new StreamableHttpTransport(baseConfig, 10_000);

      await expect(transport.connect()).rejects.toThrow('401');
    });
  });

  // ── disconnect() ──────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('sets status to "disconnected"', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(1, { protocolVersion: '2024-11-05' }));
      const transport = new StreamableHttpTransport(baseConfig, 10_000);
      await transport.connect();
      expect(transport.status).toBe('connected');

      await transport.disconnect();

      expect(transport.status).toBe('disconnected');
    });
  });
});
