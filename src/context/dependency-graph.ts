import type { Chunk } from '../types/chunks.js';
import type { DependencyEdge } from '../types/dependency.js';

/**
 * Dependency graph tracking file-level import/require relationships.
 */
export class DependencyGraph {
  private readonly edges: DependencyEdge[] = [];
  /** filePath → list of files it imports */
  private readonly adjacencyList = new Map<string, string[]>();
  /** filePath → list of files that import it */
  private readonly reverseList = new Map<string, string[]>();

  addEdge(edge: DependencyEdge): void {
    this.edges.push(edge);

    // Forward: from → to
    const fwd = this.adjacencyList.get(edge.from) ?? [];
    if (!fwd.includes(edge.to)) {
      fwd.push(edge.to);
    }
    this.adjacencyList.set(edge.from, fwd);

    // Reverse: to → from
    const rev = this.reverseList.get(edge.to) ?? [];
    if (!rev.includes(edge.from)) {
      rev.push(edge.from);
    }
    this.reverseList.set(edge.to, rev);
  }

  /** Get direct dependencies (files imported by filePath). */
  getDependencies(filePath: string): string[] {
    return this.adjacencyList.get(filePath) ?? [];
  }

  /** Get direct dependents (files that import filePath). */
  getDependents(filePath: string): string[] {
    return this.reverseList.get(filePath) ?? [];
  }

  /**
   * Get transitive dependencies up to `depth` hops.
   * depth=1 returns direct dependencies only.
   */
  getTransitiveDependencies(filePath: string, depth: number): string[] {
    const visited = new Set<string>();
    const queue: Array<{ path: string; d: number }> = [{ path: filePath, d: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.d >= depth) continue;

      for (const dep of this.getDependencies(item.path)) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push({ path: dep, d: item.d + 1 });
        }
      }
    }

    return Array.from(visited);
  }

  /** Get all edges in the graph. */
  getEdges(): DependencyEdge[] {
    return [...this.edges];
  }

  /**
   * Build a DependencyGraph from a set of chunks by analysing their
   * import/require metadata.
   * Uses multi-candidate resolution to handle index.ts and .tsx variants (P1-5 fix).
   */
  static buildFromChunks(chunks: Chunk[]): DependencyGraph {
    const graph = new DependencyGraph();
    // Build a set of known file paths for candidate resolution
    const knownFiles = new Set(chunks.map((c) => c.metadata.filePath));

    for (const chunk of chunks) {
      const fromFile = chunk.metadata.filePath;

      for (const imp of chunk.metadata.imports) {
        if (!imp.isRelative) continue;

        // Try each candidate in preference order; use the first known file
        const candidates = resolveRelativeImportCandidates(fromFile, imp.source);
        const toFile = candidates.find((c) => knownFiles.has(c)) ?? candidates[0];
        if (!toFile) continue;

        graph.addEdge({
          from: fromFile,
          to: toFile,
          specifiers: imp.specifiers,
        });
      }
    }

    return graph;
  }
}

/**
 * Resolve a relative import path to an absolute-like project path.
 * e.g. fromFile="src/a/b.ts", importSource="./c" → "src/a/c.ts"
 *
 * Handles:
 * - Bare relative paths (./c → src/a/c.ts or src/a/c/index.ts)
 * - Already-extensioned paths (./c.js → src/a/c.ts, normalised to .ts)
 * - Index imports (./utils → src/a/utils/index.ts if no extension)
 * - .tsx / .jsx extensions
 *
 * Returns an array of candidate paths in preference order.
 * Callers should use the first candidate that exists on disk, or the first
 * one for heuristic purposes.
 */
function resolveRelativeImport(fromFile: string, importSource: string): string | null {
  if (!importSource.startsWith('.')) return null;

  // Strip known JS/TS extensions from the import source so we can normalise
  const stripped = importSource.replace(/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/, '');

  // Get directory of the source file
  const parts = fromFile.split('/');
  parts.pop(); // remove filename
  const dir = [...parts];

  // Resolve the relative path segments
  const importParts = stripped.split('/');
  for (const part of importParts) {
    if (part === '..') {
      dir.pop();
    } else if (part !== '.') {
      dir.push(part);
    }
  }

  const base = dir.join('/');

  // If the original import already had a TSX/JSX extension, use it directly
  if (/\.(tsx|jsx)$/.test(importSource)) {
    return base + '.tsx';
  }

  // Return .ts as the canonical form for heuristic dependency expansion.
  // The dependency graph is used for context expansion, not strict module resolution.
  // Callers that need exact resolution should also check base/index.ts.
  return base + '.ts';
}

/**
 * Returns all candidate resolved paths for a relative import, in preference order:
 * 1. base.ts
 * 2. base.tsx
 * 3. base/index.ts
 * 4. base/index.tsx
 *
 * Useful when the caller wants to stat the filesystem for exact resolution.
 */
export function resolveRelativeImportCandidates(fromFile: string, importSource: string): string[] {
  if (!importSource.startsWith('.')) return [];

  const stripped = importSource.replace(/\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/, '');
  const parts = fromFile.split('/');
  parts.pop();
  const dir = [...parts];

  for (const part of stripped.split('/')) {
    if (part === '..') dir.pop();
    else if (part !== '.') dir.push(part);
  }

  const base = dir.join('/');

  if (/\.(tsx|jsx)$/.test(importSource)) {
    return [base + '.tsx', base + '/index.tsx'];
  }

  return [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx'];
}
