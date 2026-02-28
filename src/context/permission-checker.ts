import * as fs from 'fs';
import * as path from 'path';

export interface PermissionConfig {
  /** 允许执行的工具名称列表，空数组表示允许所有 */
  allowlist: string[];
  /** 明确禁止执行的工具名称列表 */
  denylist: string[];
  /** 允许文件操作工具访问的路径 glob 模式列表，空数组表示允许所有路径 */
  pathWhitelist: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  /** 被拒绝时的错误消息 */
  reason?: string;
}

/** 默认允许所有的权限配置 */
export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  allowlist: [],
  denylist: [],
  pathWhitelist: [],
};

/** File operation tools that require path whitelist checking */
const FILE_OPERATION_TOOLS = new Set(['file_write', 'file_edit']);

/**
 * Simple glob matching without external dependencies.
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/`
 * - `?` matches a single character except `/`
 * - Exact string match if no wildcards
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // Escape all regex special chars except * and ?
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace ** before * to avoid double-replacement
  const regexStr = escaped
    .replace(/\*\*/g, '\x00') // placeholder for **
    .replace(/\*/g, '[^/]*')  // * matches anything except /
    .replace(/\?/g, '[^/]')   // ? matches single char except /
    .replace(/\x00/g, '.*');  // ** matches anything including /
  try {
    return new RegExp(`^${regexStr}$`).test(filePath);
  } catch {
    return false;
  }
}

export class PermissionChecker {
  private config: PermissionConfig = { ...DEFAULT_PERMISSION_CONFIG };
  private loadWarning: string | undefined;

  constructor(private readonly workDir: string) {}

  /**
   * 加载 .kiro/permissions.json。
   * 文件不存在时应用默认允许策略；JSON 无效时记录错误并应用默认策略。
   * 每次 Session 开始时调用。
   */
  async load(): Promise<void> {
    const permissionsPath = path.join(this.workDir, '.kiro', 'permissions.json');
    this.loadWarning = undefined;

    let raw: string;
    try {
      raw = await fs.promises.readFile(permissionsPath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File not found — apply default policy silently
        this.config = { ...DEFAULT_PERMISSION_CONFIG };
      } else {
        // Other read errors — apply default policy with warning
        console.warn(`[PermissionChecker] Could not read permissions.json: ${(err as Error).message}`);
        this.config = { ...DEFAULT_PERMISSION_CONFIG };
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('[PermissionChecker] Invalid JSON in permissions.json, using default policy');
      this.loadWarning = '警告: .kiro/permissions.json 包含无效 JSON，已应用默认允许策略。';
      this.config = { ...DEFAULT_PERMISSION_CONFIG };
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.error('[PermissionChecker] Invalid JSON in permissions.json, using default policy');
      this.loadWarning = '警告: .kiro/permissions.json 包含无效 JSON，已应用默认允许策略。';
      this.config = { ...DEFAULT_PERMISSION_CONFIG };
      return;
    }

    const obj = parsed as Record<string, unknown>;
    this.config = {
      allowlist: Array.isArray(obj['allowlist']) ? (obj['allowlist'] as string[]) : [],
      denylist: Array.isArray(obj['denylist']) ? (obj['denylist'] as string[]) : [],
      pathWhitelist: Array.isArray(obj['pathWhitelist']) ? (obj['pathWhitelist'] as string[]) : [],
    };
  }

  /**
   * 检查工具调用是否被允许。
   * Decision tree:
   * 1. toolName in denylist → denied
   * 2. allowlist non-empty AND toolName not in allowlist → denied
   * 3. file operation tool AND pathWhitelist non-empty → check path
   * 4. allowed
   */
  check(toolName: string, args: Record<string, unknown>): PermissionCheckResult {
    // Step 1: denylist check
    if (this.config.denylist.includes(toolName)) {
      return { allowed: false, reason: `工具 ${toolName} 在拒绝列表中` };
    }

    // Step 2: allowlist check
    if (this.config.allowlist.length > 0 && !this.config.allowlist.includes(toolName)) {
      return { allowed: false, reason: `工具 ${toolName} 不在允许列表中` };
    }

    // Step 3: path whitelist check for file operation tools
    if (FILE_OPERATION_TOOLS.has(toolName) && this.config.pathWhitelist.length > 0) {
      const filePath = args['path'];
      if (typeof filePath === 'string') {
        const matches = this.config.pathWhitelist.some(pattern => matchesPattern(filePath, pattern));
        if (!matches) {
          return { allowed: false, reason: `路径 ${filePath} 不在路径白名单中` };
        }
      }
      // If no path provided, allow (can't check)
    }

    return { allowed: true };
  }

  /** 返回当前生效的权限配置（用于测试和调试） */
  getConfig(): PermissionConfig {
    return { ...this.config };
  }

  /** 返回加载时产生的警告消息（如有） */
  getLoadWarning(): string | undefined {
    return this.loadWarning;
  }
}
