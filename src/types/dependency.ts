export interface DependencyEdge {
  from: string;
  to: string;
  specifiers: string[];
}

export interface DependencyGraph {
  edges: DependencyEdge[];
  adjacencyList: Map<string, string[]>;
  reverseList: Map<string, string[]>;
}
