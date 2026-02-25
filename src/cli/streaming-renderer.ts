/**
 * StreamingRenderer — renders LLM stream output to the terminal.
 * Validates: Requirements 1.3, 1.6
 */
export class StreamingRenderer {
  private terminalWidth = 80;

  /**
   * Write a single token directly to stdout (no newline).
   */
  renderToken(token: string): void {
    process.stdout.write(token);
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
