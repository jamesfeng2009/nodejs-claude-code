import { parse, type ParseResult } from '@babel/parser';
import type { File, Node, Statement, Comment } from '@babel/types';
import { createHash } from 'crypto';
import type { Chunk, ChunkMetadata, ImportDeclaration } from '../types/chunks.js';

export interface ChunkerConfig {
  maxChunkSize: number;  // max lines per chunk, default 60
  overlapLines: number;  // overlap lines for secondary splits, default 2
}

const DEFAULT_CONFIG: ChunkerConfig = {
  maxChunkSize: 60,
  overlapLines: 2,
};

// ─── Language detection ───────────────────────────────────────────────────────

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
  };
  return map[ext] ?? 'text';
}

function isASTSupported(language: string): boolean {
  return language === 'typescript' || language === 'javascript';
}

// ─── Chunk ID ─────────────────────────────────────────────────────────────────

function makeChunkId(filePath: string, startLine: number): string {
  return createHash('sha256').update(`${filePath}:${startLine}`).digest('hex').slice(0, 16);
}

// ─── Import extraction ────────────────────────────────────────────────────────

function extractImports(ast: ParseResult<File>): ImportDeclaration[] {
  const imports: ImportDeclaration[] = [];
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      const specifiers: string[] = node.specifiers.map((s) => {
        if (s.type === 'ImportDefaultSpecifier') return s.local.name;
        if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
        if (s.type === 'ImportSpecifier') {
          const imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
          return imported === s.local.name ? imported : `${imported} as ${s.local.name}`;
        }
        return '';
      }).filter(Boolean);
      imports.push({ source, specifiers, isRelative: source.startsWith('.') });
    } else if (
      node.type === 'VariableDeclaration' ||
      node.type === 'ExpressionStatement'
    ) {
      // require() calls
      const decl = node.type === 'VariableDeclaration' ? node.declarations[0]?.init : (node as any).expression;
      if (decl?.type === 'CallExpression' && decl.callee?.name === 'require') {
        const arg = decl.arguments[0];
        if (arg?.type === 'StringLiteral') {
          imports.push({ source: arg.value, specifiers: [], isRelative: arg.value.startsWith('.') });
        }
      }
    }
  }
  return imports;
}

// ─── Line utilities ───────────────────────────────────────────────────────────

function getLines(content: string): string[] {
  return content.split('\n');
}

/** 1-based line number from 0-based offset */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function extractLines(lines: string[], startLine: number, endLine: number): string {
  // startLine and endLine are 1-based inclusive
  return lines.slice(startLine - 1, endLine).join('\n');
}

// ─── Comment binding ──────────────────────────────────────────────────────────

/**
 * Find leading comments for a node (comments immediately before it).
 * Returns the earliest line of those comments.
 */
function getLeadingCommentStartLine(node: Node, content: string): number | null {
  const comments: Comment[] = (node as any).leadingComments ?? [];
  if (comments.length === 0) return null;
  const firstComment = comments[0] as Comment | undefined;
  if (!firstComment || firstComment.start == null) return null;
  return lineOf(content, firstComment.start);
}

// ─── AST node classification ──────────────────────────────────────────────────

type ChunkType = ChunkMetadata['chunkType'];

function classifyNode(node: Node): ChunkType {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class';
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ObjectMethod':
      return 'method';
    default:
      return 'block';
  }
}

// ─── Secondary splitting ──────────────────────────────────────────────────────

/**
 * Split a large block of lines into overlapping chunks.
 * Each chunk is at most maxSize lines, with overlapLines overlap.
 */
function splitWithOverlap(
  lines: string[],
  startLine: number,  // 1-based
  filePath: string,
  imports: ImportDeclaration[],
  language: string,
  parentScope: string,
  chunkType: ChunkType,
  maxSize: number,
  overlapLines: number
): Chunk[] {
  const chunks: Chunk[] = [];
  const totalLines = lines.length;
  let pos = 0; // 0-based index into lines

  while (pos < totalLines) {
    const chunkStart = pos;
    const chunkEnd = Math.min(pos + maxSize - 1, totalLines - 1);
    const chunkLines = lines.slice(chunkStart, chunkEnd + 1);
    const absStart = startLine + chunkStart;
    const absEnd = startLine + chunkEnd;

    chunks.push({
      id: makeChunkId(filePath, absStart),
      content: chunkLines.join('\n'),
      metadata: {
        filePath,
        startLine: absStart,
        endLine: absEnd,
        parentScope,
        imports,
        language,
        chunkType,
      },
    });

    if (chunkEnd >= totalLines - 1) break;
    // Advance by (maxSize - overlapLines) to create overlap
    pos += maxSize - overlapLines;
  }

  return chunks;
}

// ─── Top-level node chunking ──────────────────────────────────────────────────

interface TopLevelNode {
  node: Node;
  startLine: number;
  endLine: number;
  commentStartLine: number;
  chunkType: ChunkType;
  parentScope: string;
}

function collectTopLevelNodes(ast: ParseResult<File>, content: string): TopLevelNode[] {
  const result: TopLevelNode[] = [];

  for (const node of ast.program.body) {
    if (node.start == null || node.end == null) continue;

    const nodeStart = lineOf(content, node.start);
    const nodeEnd = lineOf(content, node.end - 1);
    const commentStart = getLeadingCommentStartLine(node, content) ?? nodeStart;
    const chunkType = classifyNode(node);

    // For class declarations, also collect methods as sub-nodes
    if (node.type === 'ClassDeclaration' || (node as any).type === 'ClassExpression') {
      const className = (node as any).id?.name ?? 'anonymous';
      result.push({
        node,
        startLine: commentStart,
        endLine: nodeEnd,
        commentStartLine: commentStart,
        chunkType: 'class',
        parentScope: className,
      });
    } else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'ExportDefaultDeclaration' ||
      node.type === 'ExportNamedDeclaration'
    ) {
      // Unwrap export declarations
      let inner: Node = node;
      if (
        (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportNamedDeclaration') &&
        (node as any).declaration
      ) {
        inner = (node as any).declaration;
      }
      const innerType = classifyNode(inner);
      const name = (inner as any).id?.name ?? 'anonymous';
      result.push({
        node,
        startLine: commentStart,
        endLine: nodeEnd,
        commentStartLine: commentStart,
        chunkType: innerType,
        parentScope: name,
      });
    } else {
      result.push({
        node,
        startLine: commentStart,
        endLine: nodeEnd,
        commentStartLine: commentStart,
        chunkType,
        parentScope: '',
      });
    }
  }

  return result;
}

// ─── CodeChunker ─────────────────────────────────────────────────────────────

export class CodeChunker {
  private config: ChunkerConfig;

  constructor(config: Partial<ChunkerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * AST-aware chunking for JS/TS files.
   * Falls back to chunkText for unsupported file types.
   */
  chunkFile(filePath: string, content: string): Chunk[] {
    const language = detectLanguage(filePath);

    if (!isASTSupported(language)) {
      return this.chunkText(filePath, content);
    }

    try {
      return this._chunkAST(filePath, content, language);
    } catch {
      // AST parse failure → fall back to text chunking
      return this.chunkText(filePath, content);
    }
  }

  private _chunkAST(filePath: string, content: string, language: string): Chunk[] {
    const ast = parse(content, {
      sourceType: 'module',
      plugins: language === 'typescript' ? ['typescript', 'jsx'] : ['jsx'],
      attachComment: true,
      errorRecovery: true,
    });

    const imports = extractImports(ast);
    const lines = getLines(content);
    const totalLines = lines.length;

    if (totalLines === 0) return [];

    const topNodes = collectTopLevelNodes(ast, content);

    if (topNodes.length === 0) {
      // No top-level nodes → treat whole file as a module chunk
      return this._makeChunksFromRange(
        lines, 1, totalLines, filePath, imports, language, '', 'module'
      );
    }

    const chunks: Chunk[] = [];
    let coveredUpTo = 0; // last line covered (1-based)

    for (const tn of topNodes) {
      const { startLine, endLine, chunkType, parentScope } = tn;

      // Gap before this node (e.g., module-level statements between functions)
      if (startLine > coveredUpTo + 1) {
        const gapStart = coveredUpTo + 1;
        const gapEnd = startLine - 1;
        const gapLines = lines.slice(gapStart - 1, gapEnd);
        // Only emit gap if it has non-whitespace content
        if (gapLines.some((l) => l.trim())) {
          const gapChunks = this._makeChunksFromRange(
            lines, gapStart, gapEnd, filePath, imports, language, '', 'module'
          );
          chunks.push(...gapChunks);
        }
      }

      // The node itself
      const nodeChunks = this._makeChunksFromRange(
        lines, startLine, endLine, filePath, imports, language, parentScope, chunkType
      );
      chunks.push(...nodeChunks);

      coveredUpTo = Math.max(coveredUpTo, endLine);
    }

    // Trailing content after last node
    if (coveredUpTo < totalLines) {
      const trailLines = lines.slice(coveredUpTo);
      if (trailLines.some((l) => l.trim())) {
        const trailChunks = this._makeChunksFromRange(
          lines, coveredUpTo + 1, totalLines, filePath, imports, language, '', 'module'
        );
        chunks.push(...trailChunks);
      }
    }

    return chunks;
  }

  private _makeChunksFromRange(
    allLines: string[],
    startLine: number,
    endLine: number,
    filePath: string,
    imports: ImportDeclaration[],
    language: string,
    parentScope: string,
    chunkType: ChunkType
  ): Chunk[] {
    const rangeLines = allLines.slice(startLine - 1, endLine);
    const size = rangeLines.length;

    if (size <= this.config.maxChunkSize) {
      return [{
        id: makeChunkId(filePath, startLine),
        content: rangeLines.join('\n'),
        metadata: { filePath, startLine, endLine, parentScope, imports, language, chunkType },
      }];
    }

    // Secondary split with overlap
    return splitWithOverlap(
      rangeLines,
      startLine,
      filePath,
      imports,
      language,
      parentScope,
      chunkType,
      this.config.maxChunkSize,
      this.config.overlapLines
    );
  }

  /**
   * Fallback: paragraph/blank-line based chunking for non-AST files.
   */
  chunkText(filePath: string, content: string): Chunk[] {
    const language = detectLanguage(filePath);
    const lines = getLines(content);
    const chunks: Chunk[] = [];

    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      return [];
    }

    // Split into paragraphs (groups separated by blank lines)
    const paragraphs: Array<{ start: number; end: number }> = [];
    let paraStart: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const isBlank = lines[i]!.trim() === '';
      if (!isBlank && paraStart === null) {
        paraStart = i;
      } else if (isBlank && paraStart !== null) {
        paragraphs.push({ start: paraStart, end: i - 1 });
        paraStart = null;
      }
    }
    if (paraStart !== null) {
      paragraphs.push({ start: paraStart, end: lines.length - 1 });
    }

    for (const para of paragraphs) {
      const paraLines = lines.slice(para.start, para.end + 1);
      const startLine = para.start + 1; // 1-based
      const endLine = para.end + 1;

      if (paraLines.length <= this.config.maxChunkSize) {
        chunks.push({
          id: makeChunkId(filePath, startLine),
          content: paraLines.join('\n'),
          metadata: {
            filePath,
            startLine,
            endLine,
            parentScope: '',
            imports: [],
            language,
            chunkType: 'text',
          },
        });
      } else {
        // Split oversized paragraph with overlap
        const subChunks = splitWithOverlap(
          paraLines,
          startLine,
          filePath,
          [],
          language,
          '',
          'text',
          this.config.maxChunkSize,
          this.config.overlapLines
        );
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }
}
