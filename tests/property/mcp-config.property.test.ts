import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ConfigValidator } from '../../src/mcp/config-validator.js';
import { AppError, ErrorCode } from '../../src/types/errors.js';
import type { MCPConfig, MCPServerConfig } from '../../src/mcp/types.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Safe identifier: letters, digits, hyphens, underscores; non-empty */
const identArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/)
  .filter((s) => s.length > 0);

/** Arbitrary valid stdio server config */
const stdioServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.record({
    name: fc.constant(name),
    transport: fc.constant('stdio' as const),
    command: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_/-]{0,19}$/).filter((s) => s.length > 0),
    args: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }), {
      nil: undefined,
    }),
    enabled: fc.option(fc.boolean(), { nil: undefined }),
  });

/** Arbitrary valid streamable-http server config */
const httpServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.record({
    name: fc.constant(name),
    transport: fc.constant('streamable-http' as const),
    url: fc.webUrl(),
    enabled: fc.option(fc.boolean(), { nil: undefined }),
  });

/** Arbitrary valid server config (either stdio or streamable-http) */
const validServerArb = (name: string): fc.Arbitrary<MCPServerConfig> =>
  fc.oneof(stdioServerArb(name), httpServerArb(name));

/** Arbitrary valid MCPConfig with unique server names */
const validMCPConfigArb: fc.Arbitrary<MCPConfig> = fc
  .uniqueArray(identArb, { minLength: 1, maxLength: 5 })
  .chain((names) =>
    fc
      .tuple(...names.map((n) => validServerArb(n)))
      .map((servers) => ({
        servers,
        toolCallTimeoutMs: undefined as number | undefined,
        connectTimeoutMs: undefined as number | undefined,
      }))
  )
  .chain((base) =>
    fc.record({
      servers: fc.constant(base.servers),
      toolCallTimeoutMs: fc.option(fc.integer({ min: 1000, max: 60000 }), { nil: undefined }),
      connectTimeoutMs: fc.option(fc.integer({ min: 1000, max: 30000 }), { nil: undefined }),
    })
  );

/** Arbitrary string that is NOT 'stdio' or 'streamable-http' */
const invalidTransportArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s !== 'stdio' && s !== 'streamable-http');

// ─── Property 1: 配置往返序列化 ───────────────────────────────────────────────
// Feature: mcp-integration, Property 1: 配置往返序列化
// For any valid MCPConfig, serializing to JSON and deserializing should produce
// a semantically equivalent object.
// Validates: Requirements 1.3, 1.4, 7.5

describe('Property 1: 配置往返序列化', () => {
  it('JSON round-trip produces semantically equivalent MCPConfig', () => {
    fc.assert(
      fc.property(validMCPConfigArb, (config) => {
        const serialized = JSON.stringify(config);
        const deserialized = JSON.parse(serialized) as MCPConfig;

        // Server count must match
        expect(deserialized.servers.length).toBe(config.servers.length);

        // Each server's key fields must be preserved
        for (let i = 0; i < config.servers.length; i++) {
          const orig = config.servers[i]!;
          const copy = deserialized.servers[i]!;

          expect(copy.name).toBe(orig.name);
          expect(copy.transport).toBe(orig.transport);

          if (orig.transport === 'stdio') {
            expect(copy.command).toBe(orig.command);
          }
          if (orig.transport === 'streamable-http') {
            expect(copy.url).toBe(orig.url);
          }
        }

        // Optional top-level fields must be preserved
        if (config.toolCallTimeoutMs !== undefined) {
          expect(deserialized.toolCallTimeoutMs).toBe(config.toolCallTimeoutMs);
        }
        if (config.connectTimeoutMs !== undefined) {
          expect(deserialized.connectTimeoutMs).toBe(config.connectTimeoutMs);
        }

        // The round-tripped config must still pass validation
        expect(() => ConfigValidator.validate(deserialized)).not.toThrow();
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 2: 非法 transport 被拒绝 ───────────────────────────────────────
// Feature: mcp-integration, Property 2: 非法 transport 被拒绝
// For any string that is NOT 'stdio' or 'streamable-http' used as transport,
// ConfigValidator.validate() should throw an error containing the server name
// and invalid value.
// Validates: Requirements 1.3, 1.4, 7.5

describe('Property 2: 非法 transport 被拒绝', () => {
  it('invalid transport value causes ConfigValidator.validate() to throw with server name and value', () => {
    fc.assert(
      fc.property(identArb, invalidTransportArb, (serverName, badTransport) => {
        const config = {
          servers: [
            {
              name: serverName,
              transport: badTransport,
              // provide command/url so only transport triggers the error
              command: 'node',
              url: 'https://example.com',
            },
          ],
        } as unknown as MCPConfig;

        let threw = false;
        try {
          ConfigValidator.validate(config);
        } catch (e) {
          threw = true;
          expect(e).toBeInstanceOf(AppError);
          expect((e as AppError).code).toBe(ErrorCode.MCP_CONFIG_ERROR);
          // Error message must contain the server name
          expect((e as AppError).message).toContain(serverName);
          // Error message must contain the invalid transport value
          expect((e as AppError).message).toContain(badTransport);
        }

        expect(threw).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: 重复 name 被拒绝 ────────────────────────────────────────────
// Feature: mcp-integration, Property 3: 重复 name 被拒绝
// For any server config array containing two or more entries with the same name,
// ConfigValidator.validate() should throw a config error containing the duplicate name.
// Validates: Requirements 1.7

describe('Property 3: 重复 name 被拒绝', () => {
  it('duplicate server name causes ConfigValidator.validate() to throw with the duplicate name', () => {
    fc.assert(
      fc.property(
        identArb,
        fc.integer({ min: 2, max: 5 }),
        (dupName, totalCount) => {
          // Build an array where dupName appears at least twice
          const servers: MCPServerConfig[] = Array.from({ length: totalCount }, (_, i) => ({
            name: i === 0 ? dupName : i === 1 ? dupName : `unique-server-${i}`,
            transport: 'stdio' as const,
            command: 'node',
          }));

          const config: MCPConfig = { servers };

          let threw = false;
          try {
            ConfigValidator.validate(config);
          } catch (e) {
            threw = true;
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).code).toBe(ErrorCode.MCP_CONFIG_ERROR);
            // Error message must contain the duplicate name
            expect((e as AppError).message).toContain(dupName);
          }

          expect(threw).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
