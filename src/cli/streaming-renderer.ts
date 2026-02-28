/**
 * StreamingRenderer — renders LLM stream output to the terminal.
 * Validates: Requirements 1.3, 1.6, 4.1, 5.1
 */
import { MarkdownStreamRenderer, MarkdownRenderOptions } from '../context/markdown-renderer.js';

export class StreamingRenderer {
  private terminalWidth = 80;
  private mdRenderer: MarkdownStreamRenderer;

  constructor(options?: MarkdownRenderOptions) {
    this.mdRenderer = new MarkdownStreamRenderer(options);
  }

  /**
   * Write a single token through the Markdown stream renderer.
   */
  renderToken(token: string): void {
    const rendered = this.mdRenderer.push(token);
    if (rendered) process.stdout.write(rendered);
  }

  /**
   * Flush remaining buffered Markdown content and reset renderer state.
   * Call at the end of each message.
   */
  flushMarkdown(): void {
    const remaining = this.mdRenderer.flush();
    if (remaining) process.stdout.write(remaining);
    this.mdRenderer.reset();
  }

  /**
   * Render a fenced code block with a language label and box borders.
   */
  renderCodeBlock(code: string, lang: string): void {
    const borderLen = Math.min(this.terminalWidth - 2, 60);
    const border = '─'.repeat(borderLen);
    process.stdout.write(`\n┌${border}┐\n`);
    if (lang) {
      process.stdout.write(`│ ${lang}\n`);
    }
    process.stdout.write(code);
    process.stdout.write(`\n└${border}┘\n`);
  }

  /**
   * Render a tool call with its name and JSON-formatted arguments.
   */
  renderToolCall(name: string, args: Record<string, unknown>): void {
    const borderLen = Math.min(this.terminalWidth - 2, 60);
    const border = '─'.repeat(borderLen);
    process.stdout.write(`\n┌${border}┐\n`);
    process.stdout.write(`│ Tool: ${name}\n`);
    process.stdout.write(`│ Args: ${JSON.stringify(args, null, 2).replace(/\n/g, '\n│ ')}\n`);
    process.stdout.write(`└${border}┘\n`);
  }

  /**
   * Render an error message to stderr.
   */
  renderError(error: string): void {
    process.stderr.write(`\nError: ${error}\n`);
  }

  /**
   * Update the stored terminal width used for formatting.
   * Called when the terminal is resized (SIGWINCH).
   */
  adaptToWidth(width: number): void {
    this.terminalWidth = width;
  }
}
