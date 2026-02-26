import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { MCPManager } from '../../src/mcp/manager.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { MCPConfig, MCPServerConfig } from '../../src/mcp/types.js';

// ── Mock transports ───────────────────────────────────────────────────────────
// We mock both transport modules to avoid real connections.

const mockStdioConnect = vi.fn().mockResolvedValue(undefined);
const mockStdioDisconnect = vi.fn().mockResolvedValue(undefined);
const mockStdioListTools = vi.fn().mockResolvedValue([]);

const mockHttpConnect = vi.fn().mockResolvedValue(undefined);
const mockHttpDisconnect = vi.fn().mockResolvedValue(undefined);
const mockHttpListTools = vi.fn().mockResolvedValue([]);

vi.mock('../../src/mcp/stdio-transport.js', () => ({
  StdioTransport: vi
    .fn()
    .mockImplementation(
      (serverConfig: { name: string }, _timeout: number, _onDisconnect: (name: string) => void) => ({
        serverName: serverConfig.name,
        get status() {
          return 'connected';
        },
        connect: mockStdioConnect,
        disconnect: mockStdioDisconnect,
        listTools: mockStdioListTools,
        callTool: vi.fn(),
      }),
    ),
}));

vi.mock('../../src/mcp/streamable-http-transport.js', () => ({
  StreamableHttpTransport: vi
    .fn()
    .mockImplementation((serverConfig: { name: string }) => ({
      serverName: serverConfig.name,
      get status() {
        return 'connected';
      },
      connect: mockHttpConnect,
      disconnect: mockHttpDisconnect,
      listTools: mockHttpListTools,
      callTool: vi.fn(),
    })),
}));

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** Safe identifier: starts with letter, followed by letters/digits/hyphens/underscores */
const identArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
  .filter((s) => s.length > 0);

/** Arbitrary valid stdio server config */
const stdioServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.record({
    name: fc.constant(name),
    transport: fc.constant('stdio' as const),
    command: fc.constant('node'),
    enabled: fc.constant(true as const),
  });

/** Arbitrary valid streamable-http server config */
const httpServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.record({
    name: fc.constant(name),
    transport: fc.constant('streamable-http' as const),
    url: fc.constant('https://example.com/mcp'),
    enabled: fc.constant(true as const),
  });

/** Arbitrary valid server config (either stdio or streamable-http), always enabled */
const enabledServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.oneof(stdioServerArb(name), httpServerArb(name));

/** Arbitrary valid MCPConfig with 1–5 uniquely-named, all-enabled servers */
const validMCPConfigArb: fc.Arbitrary<MCPConfig> = fc
  .uniqueArray(identArb, { minLength: 1, maxLength: 5 })
  .chain((names) =>
    fc.tuple(...names.map((n) => enabledServerArb(n))).map((servers) => ({
      servers,
      toolCallTimeoutMs: 30000,
      connectTimeoutMs: 10000,
    })),
  );

// ── Property 9: getConnectionStatus 键集合完整性 ──────────────────────────────
// Feature: mcp-integration, Property 9: getConnectionStatus 键集合完整性
// For any MCPManager with N configured (enabled) servers, getConnectionStatus()
// returns a Map whose key set is exactly equal to the set of all enabled server
// names in the config. Disabled servers must NOT appear in the status map.
// Validates: Requirements 2.7

describe('Property 9: getConnectionStatus 键集合完整性', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Restore default resolved values after each run
    mockStdioConnect.mockResolvedValue(undefined);
    mockStdioDisconnect.mockResolvedValue(undefined);
    mockStdioListTools.mockResolvedValue([]);
    mockHttpConnect.mockResolvedValue(undefined);
    mockHttpDisconnect.mockResolvedValue(undefined);
    mockHttpListTools.mockResolvedValue([]);
  });

  it(
    'getConnectionStatus() key set equals the set of all enabled server names',
    async () => {
      await fc.assert(
        fc.asyncProperty(validMCPConfigArb, async (config) => {
          // Reset mocks for each iteration
          mockStdioConnect.mockResolvedValue(undefined);
          mockStdioListTools.mockResolvedValue([]);
          mockHttpConnect.mockResolvedValue(undefined);
          mockHttpListTools.mockResolvedValue([]);

          const registry = new ToolRegistry();
          const manager = new MCPManager(config, registry);
          await manager.initialize();

          const statusMap = manager.getConnectionStatus();

          // Compute the expected key set: only servers with enabled !== false
          const expectedNames = new Set(
            config.servers
              .filter((s) => s.enabled !== false)
              .map((s) => s.name),
          );

          const actualNames = new Set(statusMap.keys());

          // Key sets must be identical
          expect(actualNames).toEqual(expectedNames);

          // Cleanup: shutdown to clear any pending timers
          await manager.shutdown();
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'disabled servers do NOT appear in getConnectionStatus()',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a config where at least one server is disabled
          fc
            .uniqueArray(identArb, { minLength: 2, maxLength: 5 })
            .chain((names) => {
              // First name will be disabled, rest enabled
              const [disabledName, ...enabledNames] = names;
              return fc
                .tuple(
                  fc.oneof(stdioServerArb(disabledName!), httpServerArb(disabledName!)),
                  ...enabledNames.map((n) => enabledServerArb(n)),
                )
                .map(([disabledServer, ...enabledServers]) => ({
                  servers: [
                    { ...disabledServer, enabled: false as const },
                    ...enabledServers,
                  ],
                  toolCallTimeoutMs: 30000,
                  connectTimeoutMs: 10000,
                }));
            }),
          async (config) => {
            mockStdioConnect.mockResolvedValue(undefined);
            mockStdioListTools.mockResolvedValue([]);
            mockHttpConnect.mockResolvedValue(undefined);
            mockHttpListTools.mockResolvedValue([]);

            const registry = new ToolRegistry();
            const manager = new MCPManager(config, registry);
            await manager.initialize();

            const statusMap = manager.getConnectionStatus();

            // The disabled server must not appear
            const disabledServer = config.servers.find((s) => s.enabled === false)!;
            expect(statusMap.has(disabledServer.name)).toBe(false);

            // All enabled servers must appear
            const enabledServers = config.servers.filter((s) => s.enabled !== false);
            for (const s of enabledServers) {
              expect(statusMap.has(s.name)).toBe(true);
            }

            await manager.shutdown();
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
