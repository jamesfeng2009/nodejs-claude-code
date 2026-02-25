export interface EntityReference {
  type: 'file_path' | 'function_name' | 'variable_name' | 'error_code' | 'class_name';
  value: string;
  lastMentionedTurn: number;
}

/**
 * Cache for key entities mentioned in conversation.
 * Ensures critical references (file paths, function names, etc.) survive
 * conversation compression.
 */
export class KeyEntityCache {
  private entities: Map<string, EntityReference> = new Map();
  private currentTurn = 0;

  add(entity: EntityReference): void {
    const key = `${entity.type}:${entity.value}`;
    this.entities.set(key, entity);
  }

  getAll(): EntityReference[] {
    return Array.from(this.entities.values());
  }

  getByType(type: EntityReference['type']): EntityReference[] {
    return Array.from(this.entities.values()).filter((e) => e.type === type);
  }

  clear(): void {
    this.entities.clear();
    this.currentTurn = 0;
  }

  /**
   * Extract key entities from a message string.
   * Detects: file paths, function names, class names, variable names, error codes.
   */
  extractEntities(message: string): EntityReference[] {
    const found: EntityReference[] = [];
    const turn = this.currentTurn++;

    // File paths: strings ending with common extensions or containing path separators
    // Matches: ./foo/bar.ts, /abs/path.js, src/utils.ts, file.json, etc.
    const filePathRegex = /(?:^|[\s"'`(,])(\/?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|env|sh|py|go|rs|java|c|cpp|h|css|html|txt))\b/g;
    let match: RegExpExecArray | null;
    while ((match = filePathRegex.exec(message)) !== null) {
      const value = match[1]!.trim();
      if (value.length > 2) {
        found.push({ type: 'file_path', value, lastMentionedTurn: turn });
      }
    }

    // Error codes: patterns like ERR_*, ENOENT, HTTP 404, Error: ..., TypeError, etc.
    const errorCodeRegex = /\b(ERR_[A-Z_]+|E[A-Z]{2,}|[A-Z][A-Z_]*Error|[A-Z][A-Z_]*Exception|HTTP\s+\d{3}|\d{3}\s+[A-Z][a-zA-Z\s]+)\b/g;
    while ((match = errorCodeRegex.exec(message)) !== null) {
      found.push({ type: 'error_code', value: match[1]!, lastMentionedTurn: turn });
    }

    // Class names: PascalCase identifiers (at least 2 chars, starts with uppercase)
    // Avoid matching error codes already captured
    const classNameRegex = /\b([A-Z][a-z][A-Za-z0-9]{1,}(?:[A-Z][a-z][A-Za-z0-9]*)*)\b/g;
    const errorCodeValues = new Set(found.filter((e) => e.type === 'error_code').map((e) => e.value));
    while ((match = classNameRegex.exec(message)) !== null) {
      const value = match[1]!;
      if (!errorCodeValues.has(value)) {
        found.push({ type: 'class_name', value, lastMentionedTurn: turn });
      }
    }

    // Function names: camelCase identifiers followed by ( or common patterns like `functionName(`
    const functionNameRegex = /\b([a-z][a-zA-Z0-9]{1,})\s*\(/g;
    while ((match = functionNameRegex.exec(message)) !== null) {
      const value = match[1]!;
      // Skip common keywords
      if (!COMMON_KEYWORDS.has(value)) {
        found.push({ type: 'function_name', value, lastMentionedTurn: turn });
      }
    }

    // Variable names: camelCase or snake_case identifiers in code-like contexts
    // Look for patterns like `const foo`, `let bar`, `var baz`, `foo =`
    const variableNameRegex = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    while ((match = variableNameRegex.exec(message)) !== null) {
      found.push({ type: 'variable_name', value: match[1]!, lastMentionedTurn: turn });
    }

    // Deduplicate by type+value
    const seen = new Set<string>();
    const deduped: EntityReference[] = [];
    for (const entity of found) {
      const key = `${entity.type}:${entity.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(entity);
      }
    }

    // Add all found entities to the cache
    for (const entity of deduped) {
      this.add(entity);
    }

    return deduped;
  }
}

const COMMON_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'delete',
  'typeof', 'instanceof', 'void', 'await', 'async', 'function', 'class', 'import',
  'export', 'require', 'console', 'process', 'module', 'describe', 'it', 'test',
  'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
]);
