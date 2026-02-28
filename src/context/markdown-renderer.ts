/**
 * Terminal Markdown renderer with ANSI syntax highlighting.
 * F9 — 终端 Markdown 渲染与语法高亮
 */

export const ANSI = {
  BOLD:       '\x1b[1m',
  RESET:      '\x1b[0m',
  DIM:        '\x1b[2m',
  FG_CYAN:    '\x1b[36m',
  FG_YELLOW:  '\x1b[33m',
  FG_GREEN:   '\x1b[32m',
  FG_BLUE:    '\x1b[34m',
  FG_MAGENTA: '\x1b[35m',
  FG_RED:     '\x1b[31m',
  BG_DARK:    '\x1b[48;5;236m',
} as const;

export interface MarkdownRenderOptions {
  /** Whether to output ANSI escape sequences. Defaults to process.stdout.isTTY. */
  ansi?: boolean;
  /** Terminal width for code block borders. Defaults to 80. */
  terminalWidth?: number;
}

// ─── Syntax Highlighter ───────────────────────────────────────────────────────

const TS_JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while',
  'with', 'yield', 'async', 'await', 'of', 'from', 'as', 'type',
  'interface', 'enum', 'implements', 'abstract', 'readonly', 'declare',
  'namespace', 'module', 'keyof', 'infer', 'never', 'unknown', 'any',
]);

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

const BASH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done',
  'case', 'esac', 'in', 'function', 'return', 'exit', 'echo', 'export',
  'local', 'readonly', 'source', 'unset', 'shift', 'break', 'continue',
  'true', 'false', 'test', 'set', 'unset', 'declare', 'typeset',
]);

/**
 * Apply syntax highlighting to a single line of code.
 */
function highlightLine(line: string, lang: string): string {
  switch (lang.toLowerCase()) {
    case 'typescript':
    case 'javascript':
    case 'ts':
    case 'js':
      return highlightTsJs(line);
    case 'python':
    case 'py':
      return highlightPython(line);
    case 'bash':
    case 'sh':
    case 'shell':
      return highlightBash(line);
    case 'json':
      return highlightJson(line);
    default:
      return line;
  }
}

function highlightTsJs(line: string): string {
  return tokenizeGeneric(line, TS_JS_KEYWORDS, ANSI.FG_BLUE, '//', ['\'', '"', '`']);
}

function highlightPython(line: string): string {
  return tokenizeGeneric(line, PYTHON_KEYWORDS, ANSI.FG_BLUE, '#', ['\'', '"']);
}

function highlightBash(line: string): string {
  return tokenizeGeneric(line, BASH_KEYWORDS, ANSI.FG_YELLOW, '#', ['\'', '"']);
}

/**
 * Generic tokenizer: handles keywords, strings, and line comments.
 */
function tokenizeGeneric(
  line: string,
  keywords: Set<string>,
  keywordColor: string,
  commentPrefix: string,
  quoteChars: string[],
): string {
  let result = '';
  let i = 0;

  while (i < line.length) {
    // Check for comment
    if (line.startsWith(commentPrefix, i)) {
      result += ANSI.DIM + line.slice(i) + ANSI.RESET;
      return result;
    }

    // Check for string literals
    const quoteChar = quoteChars.find(q => line[i] === q);
    if (quoteChar) {
      const start = i;
      i++; // skip opening quote
      // Handle template literals and multi-char quotes
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2; // skip escaped char
          continue;
        }
        if (line[i] === quoteChar) {
          i++; // skip closing quote
          break;
        }
        i++;
      }
      result += ANSI.FG_GREEN + line.slice(start, i) + ANSI.RESET;
      continue;
    }

    // Check for identifier/keyword
    if (/[a-zA-Z_$]/.test(line[i] ?? '')) {
      const start = i;
      while (i < line.length && /[a-zA-Z0-9_$]/.test(line[i] ?? '')) {
        i++;
      }
      const word = line.slice(start, i);
      if (keywords.has(word)) {
        result += keywordColor + word + ANSI.RESET;
      } else {
        result += word;
      }
      continue;
    }

    result += line[i];
    i++;
  }

  return result;
}

/**
 * JSON highlighter: key names in cyan, string values in green.
 */
function highlightJson(line: string): string {
  // Match JSON key: "key":
  // Match JSON string value: : "value"
  let result = '';
  let i = 0;

  while (i < line.length) {
    if (line[i] === '"') {
      const start = i;
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        i++;
      }
      const str = line.slice(start, i);
      // Look ahead for colon to determine if this is a key
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      if (line[j] === ':') {
        result += ANSI.FG_CYAN + str + ANSI.RESET;
      } else {
        result += ANSI.FG_GREEN + str + ANSI.RESET;
      }
      continue;
    }
    result += line[i];
    i++;
  }

  return result;
}

// ─── Line Renderer ────────────────────────────────────────────────────────────

/**
 * Apply inline formatting rules (bold, inline code) to a line of text.
 * Only applied outside code blocks.
 */
function applyInlineFormatting(text: string, ansi: boolean): string {
  if (!ansi) {
    // Strip markdown markers but keep text
    text = text.replace(/\*\*(.+?)\*\*/g, '$1');
    text = text.replace(/__(.+?)__/g, '$1');
    text = text.replace(/`([^`]+)`/g, '$1');
    return text;
  }

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, `${ANSI.BOLD}$1${ANSI.RESET}`);
  text = text.replace(/__(.+?)__/g, `${ANSI.BOLD}$1${ANSI.RESET}`);

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, `${ANSI.FG_CYAN}$1${ANSI.RESET}`);

  return text;
}

/**
 * Render a single line according to Markdown rules.
 * Returns the rendered line (without trailing newline).
 */
function renderLine(
  line: string,
  inCodeBlock: boolean,
  codeBlockLang: string,
  ansi: boolean,
): string {
  if (inCodeBlock) {
    if (ansi && codeBlockLang) {
      return highlightLine(line, codeBlockLang);
    }
    return line;
  }

  // ATX heading: ^#{1,6} text
  const headingMatch = line.match(/^(#{1,6}) (.+)$/);
  if (headingMatch) {
    const text = headingMatch[2] ?? '';
    if (ansi) {
      return ANSI.BOLD + applyInlineFormatting(text, ansi) + ANSI.RESET;
    }
    return applyInlineFormatting(text, ansi);
  }

  // Unordered list: ^(- |\* )
  const ulMatch = line.match(/^[-*] (.+)$/);
  if (ulMatch) {
    return '  \u2022 ' + applyInlineFormatting(ulMatch[1] ?? '', ansi);
  }

  // Ordered list: ^\d+\. text
  const olMatch = line.match(/^(\d+)\. (.+)$/);
  if (olMatch) {
    return `  ${olMatch[1] ?? ''}. ` + applyInlineFormatting(olMatch[2] ?? '', ansi);
  }

  // Plain text with inline formatting
  return applyInlineFormatting(line, ansi);
}

// ─── renderMarkdown ───────────────────────────────────────────────────────────

/**
 * Render a complete Markdown string to a terminal-displayable string.
 * Pure function with no side effects.
 */
export function renderMarkdown(text: string, options?: MarkdownRenderOptions): string {
  const ansi = options?.ansi ?? (process.stdout.isTTY === true);
  const lines = text.split('\n');
  const output: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Detect fenced code block opening/closing
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch !== null) {
      if (!inCodeBlock) {
        // Opening fence
        inCodeBlock = true;
        codeBlockLang = fenceMatch[1] ?? '';
        // Output the fence line as-is
        output.push(line);
      } else {
        // Closing fence
        inCodeBlock = false;
        codeBlockLang = '';
        output.push(line);
      }
      continue;
    }

    output.push(renderLine(line, inCodeBlock, codeBlockLang, ansi));
  }

  // Auto-close unclosed code block
  if (inCodeBlock) {
    output.push('```');
  }

  return output.join('\n');
}

// ─── MarkdownStreamRenderer ───────────────────────────────────────────────────

interface RendererState {
  inCodeBlock: boolean;
  codeBlockLang: string;
  lineBuffer: string;
}

/**
 * Streaming Markdown renderer that maintains state across tokens.
 * Each call to push(token) returns immediately-outputtable rendered text.
 * flush() returns any remaining buffered content.
 */
export class MarkdownStreamRenderer {
  private ansi: boolean;
  private state: RendererState;

  constructor(options?: MarkdownRenderOptions) {
    this.ansi = options?.ansi ?? (process.stdout.isTTY === true);
    this.state = {
      inCodeBlock: false,
      codeBlockLang: '',
      lineBuffer: '',
    };
  }

  /**
   * Push a token (partial text) into the renderer.
   * Returns rendered output that can be written immediately.
   */
  push(token: string): string {
    this.state.lineBuffer += token;
    let output = '';

    // Process complete lines from the buffer
    let newlineIdx: number;
    while ((newlineIdx = this.state.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.state.lineBuffer.slice(0, newlineIdx);
      this.state.lineBuffer = this.state.lineBuffer.slice(newlineIdx + 1);
      output += this.processLine(line) + '\n';
    }

    return output;
  }

  /**
   * Flush any remaining buffered content.
   * Auto-closes unclosed code blocks and bold markers.
   */
  flush(): string {
    let output = '';

    if (this.state.lineBuffer.length > 0) {
      output += this.processLine(this.state.lineBuffer);
      this.state.lineBuffer = '';
    }

    // Auto-close unclosed code block
    if (this.state.inCodeBlock) {
      output += '\n```';
      this.state.inCodeBlock = false;
      this.state.codeBlockLang = '';
    }

    return output;
  }

  /**
   * Reset renderer state (call after each message is complete).
   */
  reset(): void {
    this.state = {
      inCodeBlock: false,
      codeBlockLang: '',
      lineBuffer: '',
    };
  }

  private processLine(line: string): string {
    // Detect fenced code block opening/closing
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch !== null) {
      if (!this.state.inCodeBlock) {
        this.state.inCodeBlock = true;
        this.state.codeBlockLang = fenceMatch[1] ?? '';
      } else {
        this.state.inCodeBlock = false;
        this.state.codeBlockLang = '';
      }
      return line;
    }

    return renderLine(line, this.state.inCodeBlock, this.state.codeBlockLang, this.ansi);
  }
}
