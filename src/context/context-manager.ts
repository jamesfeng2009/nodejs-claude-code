import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProjectContext, ConfigFileInfo } from '../types/context.js';
import type { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import type { ScoredChunk } from '../retrieval/vector-store.js';
import type { KeyEntityCache } from './key-entity-cache.js';
import { CodeChunker } from './code-chunker.js';

export interface ContextConfig {
  maxChunkSize: number;
  overlapLines: number;
  toolOutputMaxLines: number;
}

export interface ContextPriority {
  chunk: import('../types/chunks.js').Chunk;
  score: number;
  source: 'vector' | 'bm25' | 'entity_cache' | 'project_structure';
}

/** Config files to look for in the project root */
const CONFIG_FILE_NAMES = [
  'package.json',
  'tsconfig.json',
  '.ai-assistant.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  '.eslintrc.json',
  '.eslintrc.js',
  'vite.config.ts',
  'vitest.config.ts',
];

/**
 * Manages project context collection, relevant context retrieval,
 * system prompt assembly, and tool output compression.
 */
export class ContextManager {
  private readonly chunker: CodeChunker;

  constructor(
    private readonly retriever: HybridRetriever,
    private readonly entityCache: KeyEntityCache,
    private readonly config: ContextConfig
  ) {
    this.chunker = new CodeChunker({
      maxChunkSize: config.maxChunkSize,
      overlapLines: config.overlapLines,
    });
  }

  /**
   * Collect project structure info from workDir, respecting .gitignore rules.
   */
  async collectProjectContext(workDir: string): Promise<ProjectContext> {
    const gitignorePatterns = this.readGitignorePatterns(workDir);
    const directoryTree = this.buildDirectoryTree(workDir, workDir, gitignorePatterns, 0, 3);
    const configFiles = this.readConfigFiles(workDir);

    return {
      workDir,
      directoryTree,
      configFiles,
      gitignorePatterns,
    };
  }

  /**
   * Get relevant context for a query via HybridRetriever, sorted by priority.
   * High-relevance context is placed at attention-strongest positions.
   */
  async getRelevantContext(query: string): Promise<ContextPriority[]> {
    const results: ScoredChunk[] = await this.retriever.search(query);

    const priorities: ContextPriority[] = results.map((r) => ({
      chunk: r.chunk,
      score: r.score,
      source: r.source as 'vector' | 'bm25',
    }));

    // Sort by score descending (highest relevance first)
    priorities.sort((a, b) => b.score - a.score);
    return priorities;
  }

  /**
   * Invalidate all Code_Chunk_Index entries for the given file path and
   * re-index the file content.
   *
   * - If the file does not exist (ENOENT): remove entries only, no re-index.
   * - If the file read fails for another reason: log warning, retain old
   *   entries (do not remove), return without error.
   * - Completes before returning so the next retrieval sees updated index.
   */
  async invalidateAndReindex(absoluteFilePath: string): Promise<void> {
    let content: string;
    try {
      content = fs.readFileSync(absoluteFilePath, 'utf-8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // File deleted — remove entries, no re-index
        await this.retriever.removeChunksByFile(absoluteFilePath);
        return;
      }
      // Other read failure — retain old entries, log warning
      console.warn(
        `[ContextManager] Failed to read file for re-indexing: ${absoluteFilePath}:`,
        (err as Error).message
      );
      return;
    }

    // Remove old chunks, then re-chunk and re-index
    await this.retriever.removeChunksByFile(absoluteFilePath);
    const newChunks = this.chunker.chunkFile(absoluteFilePath, content);
    await this.retriever.indexChunks(newChunks);
  }

  /**
   * Build system prompt from project context and relevant chunks.
   * High-relevance context is placed at the beginning (strongest attention position).
   */
  buildSystemPrompt(projectContext: ProjectContext, relevantChunks: ContextPriority[]): string {
    const parts: string[] = [];

    parts.push('You are an AI programming assistant. You help developers with coding tasks.');
    parts.push('');

    // Project structure (always included)
    parts.push('## Project Structure');
    parts.push(`Working directory: ${projectContext.workDir}`);
    parts.push('');
    parts.push('Directory tree:');
    parts.push(projectContext.directoryTree);
    parts.push('');

    // Config files
    if (projectContext.configFiles.length > 0) {
      parts.push('## Configuration Files');
      for (const cf of projectContext.configFiles) {
        parts.push(`### ${cf.path}`);
        parts.push('```');
        parts.push(cf.content);
        parts.push('```');
        parts.push('');
      }
    }

    // Relevant code context — sorted by score, highest first (attention-strongest position)
    if (relevantChunks.length > 0) {
      parts.push('## Relevant Code Context');
      // Sort descending by score to place highest relevance at top
      const sorted = [...relevantChunks].sort((a, b) => b.score - a.score);
      for (const ctx of sorted) {
        const meta = ctx.chunk.metadata;
        parts.push(`### ${meta.filePath} (lines ${meta.startLine}-${meta.endLine})`);
        parts.push('```' + meta.language);
        parts.push(ctx.chunk.content);
        parts.push('```');
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  /**
   * Intelligently truncate/summarize large tool outputs.
   * Preserves error messages and key code snippets.
   */
  compressToolOutput(output: string, _toolType: string): string {
    const lines = output.split('\n');
    const maxLines = this.config.toolOutputMaxLines;

    if (lines.length <= maxLines) {
      return output;
    }

    // For shell/error outputs: keep first and last portions
    const keepHead = Math.floor(maxLines * 0.6);
    const keepTail = maxLines - keepHead;

    const head = lines.slice(0, keepHead);
    const tail = lines.slice(lines.length - keepTail);
    const omitted = lines.length - keepHead - keepTail;

    return [
      ...head,
      `... [${omitted} lines truncated] ...`,
      ...tail,
    ].join('\n');
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private readGitignorePatterns(workDir: string): string[] {
    const gitignorePath = path.join(workDir, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    } catch {
      return [];
    }
  }

  private isIgnored(relativePath: string, patterns: string[]): boolean {
    const name = path.basename(relativePath);
    for (const pattern of patterns) {
      if (this.matchesGitignorePattern(relativePath, name, pattern)) {
        return true;
      }
    }
    return false;
  }

  private matchesGitignorePattern(relativePath: string, name: string, pattern: string): boolean {
    // Normalize separators
    const p = pattern.replace(/\\/g, '/');
    const rp = relativePath.replace(/\\/g, '/');

    // Directory pattern (ends with /)
    if (p.endsWith('/')) {
      const dirPattern = p.slice(0, -1);
      return name === dirPattern || rp === dirPattern || rp.startsWith(dirPattern + '/');
    }

    // Wildcard pattern — convert glob to regex safely (P1-8 fix)
    if (p.includes('*') || p.includes('?')) {
      return this.globMatch(name, p) || this.globMatch(rp, p);
    }

    // Exact match against name or relative path
    return name === p || rp === p || rp.startsWith(p + '/');
  }

  /**
   * Convert a simple glob pattern to a RegExp and test the string.
   * Supports * (any chars except /) and ** (any chars including /).
   * P1-8 fix: replaced the broken UUID-based escape with a correct implementation.
   */
  private globMatch(str: string, pattern: string): boolean {
    // Escape all regex special chars except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Replace ** before * to avoid double-replacement
    const regexStr = escaped
      .replace(/\*\*/g, '\x00') // placeholder for **
      .replace(/\*/g, '[^/]*')  // * matches anything except /
      .replace(/\?/g, '[^/]')   // ? matches single char except /
      .replace(/\x00/g, '.*');  // ** matches anything including /
    try {
      return new RegExp(`^${regexStr}$`).test(str);
    } catch {
      return false;
    }
  }

  private buildDirectoryTree(
    rootDir: string,
    currentDir: string,
    gitignorePatterns: string[],
    depth: number,
    maxDepth: number
  ): string {
    if (depth > maxDepth) return '';

    const lines: string[] = [];
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return '';
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      // Always skip hidden dirs like .git
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (this.isIgnored(relativePath, gitignorePatterns)) {
        continue;
      }

      const indent = '  '.repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        const subtree = this.buildDirectoryTree(
          rootDir,
          fullPath,
          gitignorePatterns,
          depth + 1,
          maxDepth
        );
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }

    return lines.join('\n');
  }

  private readConfigFiles(workDir: string): ConfigFileInfo[] {
    const result: ConfigFileInfo[] = [];
    for (const name of CONFIG_FILE_NAMES) {
      const filePath = path.join(workDir, name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        result.push({ path: name, content });
      } catch {
        // File doesn't exist, skip
      }
    }
    return result;
  }
}
