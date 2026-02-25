import { resolve, relative, isAbsolute } from 'path';

const DEFAULT_SENSITIVE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
  /\.secret$/,
];

/**
 * Check if a resolved absolute path is within the working directory.
 * Prevents path traversal attacks.
 */
export function isWithinWorkDir(absPath: string, workDir: string): boolean {
  const resolvedWork = resolve(workDir);
  const resolvedTarget = resolve(absPath);
  const rel = relative(resolvedWork, resolvedTarget);
  // If relative path starts with '..', it's outside
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Check if a file path matches any sensitive file pattern.
 */
export function isSensitiveFile(
  filePath: string,
  patterns: RegExp[] = DEFAULT_SENSITIVE_PATTERNS
): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  return patterns.some((p) => p.test(basename) || p.test(filePath));
}
