import { describe, it, expect } from 'vitest';
import { ConfigValidator } from '../../../src/mcp/config-validator.js';
import { AppError, ErrorCode } from '../../../src/types/errors.js';
import type { MCPConfig } from '../../../src/mcp/types.js';

// Validates: Requirements 1.7, 7.2, 7.3, 7.4

describe('ConfigValidator', () => {
  it('throws on duplicate server name', () => {
    const config: MCPConfig = {
      servers: [
        { name: 'my-server', transport: 'stdio', command: 'node' },
        { name: 'my-server', transport: 'stdio', command: 'node' },
      ],
    };

    expect(() => ConfigValidator.validate(config)).toThrow(AppError);
    expect(() => ConfigValidator.validate(config)).toThrow(/my-server/);
    expect(() => ConfigValidator.validate(config)).toSatisfy((fn: () => void) => {
      try { fn(); } catch (e) {
        return e instanceof AppError && e.code === ErrorCode.MCP_CONFIG_ERROR;
      }
      return false;
    });
  });

  it('throws when stdio transport is missing command', () => {
    const config: MCPConfig = {
      servers: [{ name: 'stdio-server', transport: 'stdio' }],
    };

    expect(() => ConfigValidator.validate(config)).toThrow(AppError);
    expect(() => ConfigValidator.validate(config)).toThrow(/stdio-server/);
    expect(() => ConfigValidator.validate(config)).toThrow(/command/);
  });

  it('throws when streamable-http transport is missing url', () => {
    const config: MCPConfig = {
      servers: [{ name: 'http-server', transport: 'streamable-http' }],
    };

    expect(() => ConfigValidator.validate(config)).toThrow(AppError);
    expect(() => ConfigValidator.validate(config)).toThrow(/http-server/);
    expect(() => ConfigValidator.validate(config)).toThrow(/url/);
  });

  it('throws on invalid transport value', () => {
    const config = {
      servers: [{ name: 'bad-server', transport: 'websocket' }],
    } as unknown as MCPConfig;

    expect(() => ConfigValidator.validate(config)).toThrow(AppError);
    expect(() => ConfigValidator.validate(config)).toThrow(/bad-server/);
    expect(() => ConfigValidator.validate(config)).toThrow(/websocket/);
  });

  it('error code is MCP_CONFIG_ERROR for all validation failures', () => {
    const cases: MCPConfig[] = [
      {
        servers: [
          { name: 'dup', transport: 'stdio', command: 'node' },
          { name: 'dup', transport: 'stdio', command: 'node' },
        ],
      },
      { servers: [{ name: 'no-cmd', transport: 'stdio' }] },
      { servers: [{ name: 'no-url', transport: 'streamable-http' }] },
    ];

    for (const config of cases) {
      try {
        ConfigValidator.validate(config);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe(ErrorCode.MCP_CONFIG_ERROR);
      }
    }
  });

  it('passes for a valid stdio config', () => {
    const config: MCPConfig = {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/server-fs'] },
      ],
    };

    expect(() => ConfigValidator.validate(config)).not.toThrow();
  });

  it('passes for a valid streamable-http config', () => {
    const config: MCPConfig = {
      servers: [
        { name: 'search', transport: 'streamable-http', url: 'https://example.com/mcp' },
      ],
    };

    expect(() => ConfigValidator.validate(config)).not.toThrow();
  });

  it('passes for a mixed valid config with multiple servers', () => {
    const config: MCPConfig = {
      servers: [
        { name: 'fs', transport: 'stdio', command: 'node', args: ['server.js'] },
        { name: 'api', transport: 'streamable-http', url: 'https://api.example.com/mcp' },
      ],
      toolCallTimeoutMs: 30000,
      connectTimeoutMs: 10000,
    };

    expect(() => ConfigValidator.validate(config)).not.toThrow();
  });

  it('passes for an empty servers array', () => {
    const config: MCPConfig = { servers: [] };

    expect(() => ConfigValidator.validate(config)).not.toThrow();
  });
});
