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
   */
  static buildFromChunks(chunks: Chunk[]): DependencyGraph {
    const graph = new DependencyGraph();

    for (const chunk of chunks) {
      const fromFile = chunk.metadata.filePath;

      for (const imp of chunk.metadata.imports) {
        if (!imp.isRelative) continue; // Only track relative (project-internal) imports

        // Resolve the import source relative to the chunk's file
        const toFile = resolveRelativeImport(fromFile, imp.source);
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
 * e.g. fromFile="src/a/b.ts", importSource="./c" → "src/a/c"
 */
function resolveRelativeImport(fromFile: string, importSource: string): string | null {
  if (!importSource.startsWith('.')) return null;

  // Get directory of the source file
  const parts = fromFile.split('/');
  parts.pop(); // remove filename
  const dir = parts;

  // Resolve the relative path
  const importParts = importSource.split('/');
  for (const part of importParts) {
    if (part === '..') {
      dir.pop();
    } else if (part !== '.') {
      dir.push(part);
    }
  }

  return dir.join('/');
}
