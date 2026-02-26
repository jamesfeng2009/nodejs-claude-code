import { MCPConfig } from './types';
import { AppError, ErrorCode } from '../types/errors';

export class ConfigValidator {
  static validate(config: MCPConfig): void {
    const names = new Set<string>();

    for (const server of config.servers) {
      if (names.has(server.name)) {
        throw new AppError(ErrorCode.MCP_CONFIG_ERROR, `重复的 server name: '${server.name}'`);
      }
      names.add(server.name);

      if (server.transport === 'stdio' && !server.command) {
        throw new AppError(ErrorCode.MCP_CONFIG_ERROR, `server '${server.name}' 缺少必填字段 'command'`);
      }

      if (server.transport === 'streamable-http' && !server.url) {
        throw new AppError(ErrorCode.MCP_CONFIG_ERROR, `server '${server.name}' 缺少必填字段 'url'`);
      }

      if (server.transport !== 'stdio' && server.transport !== 'streamable-http') {
        throw new AppError(ErrorCode.MCP_CONFIG_ERROR, `server '${server.name}' 的 transport 值非法: '${server.transport}'`);
      }
    }
  }
}
