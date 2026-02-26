import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { StdioTransport } from '../../../src/mcp/stdio-transport.js';
import type { MCPServerConfig } from '../../../src/mcp/types.js';

// Validates: Requirements 2.2, 2.4, 2.5

// ── Fake child process ────────────────────────────────────────────────────────

class FakeStdin extends EventEmitter {
  written: string[] = [];
  write(data: string, cb?: (err?: Error | null) => void): boolean {
    this.written.push(data);
    cb?.();
    return true;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(_signal?: string) {
    this.killed = true;
    this.emit('exit', null, _signal ?? 'SIGTERM');
  }
}

// ── Mock child_process ────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

// ── Helpers ───────────────────────────────────────────────────────────────────

const baseConfig: MCPServerConfig = {
  name: 'test-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
};

/** Build a valid JSON-RPC response line for the given request id */
function makeResponse(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

/** Emit a response on the fake process stdout after a microtask tick */
function respondTo(fakeProc: FakeProcess, id: number, result: unknown): void {
  setImmediate(() => {
    fakeProc.stdout.emit('data', Buffer.from(makeResponse(id, result)));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StdioTransport', () => {
  let fakeProc: FakeProcess;

  beforeEach(() => {
    fakeProc = new FakeProcess();
    mockSpawn.mockReturnValue(fakeProc as unknown as ReturnType<typeof spawn>);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Requirement 2.2: spawn with command/args ────────────────────────────────

  describe('normal startup and communication', () => {
    it('spawns the child process with the configured command and args', async () => {
      // Arrange: respond to the initialize handshake
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });

      const transport = new StdioTransport(baseConfig, 10_000);

      // Act
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Assert
      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        ['server.js'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('status becomes "connected" after successful handshake', async () => {
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });

      const transport = new StdioTransport(baseConfig, 10_000);
      expect(transport.status).toBe('disconnected');

      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      expect(transport.status).toBe('connected');
    });

    it('sends an initialize request via stdin during connect()', async () => {
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });

      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      expect(fakeProc.stdin.written.length).toBeGreaterThan(0);
      const initMsg = JSON.parse(fakeProc.stdin.written[0]);
      expect(initMsg.method).toBe('initialize');
      expect(initMsg.jsonrpc).toBe('2.0');
    });

    it('listTools() sends tools/list request and returns the tools array', async () => {
      // Connect first
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Arrange tools/list response
      const tools = [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
      ];
      respondTo(fakeProc, 2, { tools });

      // Act
      const listPromise = transport.listTools();
      await vi.runAllTimersAsync();
      const result = await listPromise;

      // Assert
      expect(result).toEqual(tools);
      const listMsg = JSON.parse(fakeProc.stdin.written[1]);
      expect(listMsg.method).toBe('tools/list');
    });

    it('callTool() sends tools/call request and returns the result', async () => {
      // Connect first
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Arrange tools/call response
      const toolResult = { content: [{ type: 'text', text: 'hello' }], isError: false };
      respondTo(fakeProc, 2, toolResult);

      // Act
      const callPromise = transport.callTool('read_file', { path: '/tmp/test.txt' });
      await vi.runAllTimersAsync();
      const result = await callPromise;

      // Assert
      expect(result).toEqual(toolResult);
      const callMsg = JSON.parse(fakeProc.stdin.written[1]);
      expect(callMsg.method).toBe('tools/call');
      expect(callMsg.params).toEqual({ name: 'read_file', arguments: { path: '/tmp/test.txt' } });
    });

    it('accepts a server with a different (but non-null) protocol version with a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      respondTo(fakeProc, 1, { protocolVersion: '2024-01-01' });

      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      expect(transport.status).toBe('connected');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('协议版本不匹配'));
      warnSpy.mockRestore();
    });
  });

  // ── Requirement 2.5: connection timeout ────────────────────────────────────

  describe('connection timeout', () => {
    it('rejects connect() after connectTimeoutMs when no response arrives', async () => {
      // Never respond to the initialize request
      const transport = new StdioTransport(baseConfig, 5_000);

      const connectPromise = transport.connect();
      // Suppress the unhandled rejection from the losing side of Promise.race
      connectPromise.catch(() => {});

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(5_001);

      await expect(connectPromise).rejects.toThrow(/超时|timeout/i);
    });

    it('status is "disconnected" after a timeout', async () => {
      const transport = new StdioTransport(baseConfig, 5_000);

      const connectPromise = transport.connect();
      connectPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(5_001);

      await expect(connectPromise).rejects.toThrow();
      expect(transport.status).toBe('disconnected');
    });

    it('logs an error when connection times out', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const transport = new StdioTransport(baseConfig, 5_000);
      const connectPromise = transport.connect();
      connectPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(5_001);

      await expect(connectPromise).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test-server'));
      errorSpy.mockRestore();
    });
  });

  // ── Requirement 2.5: unexpected child process exit ─────────────────────────

  describe('unexpected child process exit', () => {
    it('status becomes "disconnected" when child process exits unexpectedly', async () => {
      // Connect successfully first
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      expect(transport.status).toBe('connected');

      // Simulate unexpected exit
      fakeProc.emit('exit', 1, null);

      expect(transport.status).toBe('disconnected');
    });

    it('calls the onReconnect callback with the server name on unexpected exit', async () => {
      const onReconnect = vi.fn();

      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000, onReconnect);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Simulate unexpected exit
      fakeProc.emit('exit', 1, null);

      expect(onReconnect).toHaveBeenCalledWith('test-server');
    });

    it('does NOT call onReconnect when disconnect() is called intentionally', async () => {
      const onReconnect = vi.fn();

      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000, onReconnect);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Intentional disconnect
      await transport.disconnect();

      expect(onReconnect).not.toHaveBeenCalled();
    });

    it('rejects pending requests when child process exits unexpectedly', async () => {
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      // Start a tools/list call but don't respond to it
      const listPromise = transport.listTools();

      // Simulate unexpected exit before the response arrives
      fakeProc.emit('exit', 1, null);

      await expect(listPromise).rejects.toThrow(/意外退出/);
    });

    it('logs a warning when child process exits unexpectedly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      fakeProc.emit('exit', 1, null);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('意外退出'));
      warnSpy.mockRestore();
    });
  });

  // ── disconnect() ───────────────────────────────────────────────────────────

  describe('disconnect()', () => {
    it('kills the child process and sets status to disconnected', async () => {
      respondTo(fakeProc, 1, { protocolVersion: '2024-11-05' });
      const transport = new StdioTransport(baseConfig, 10_000);
      const connectPromise = transport.connect();
      await vi.runAllTimersAsync();
      await connectPromise;

      await transport.disconnect();

      expect(fakeProc.killed).toBe(true);
      expect(transport.status).toBe('disconnected');
    });
  });
});
