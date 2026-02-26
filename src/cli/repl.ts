import readline from 'readline';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import type { OrchestratorAgent } from '../agent/orchestrator.js';
import type { StreamingRenderer } from './streaming-renderer.js';
import type { ShellConfirmFn } from '../tools/implementations/shell-execute.js';
import type { ContentBlock, SupportedImageMimeType, SupportedFileMimeType } from '../types/messages.js';

/**
 * Interactive REPL for the CLI application.
 * Validates: Requirements 1.1, 1.2, 1.4, 1.5, 6.1–6.5
 */
export class REPL {
  private rl: readline.Interface | null = null;
  private isShuttingDown = false;

  /** Extension → MIME type mapping for @file syntax (Req 6.2) */
  static readonly EXT_TO_MIME: Record<string, SupportedImageMimeType | SupportedFileMimeType> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
  };

  constructor(
    private readonly orchestrator: OrchestratorAgent,
    private readonly renderer: StreamingRenderer,
  ) {}

  /**
   * Returns a ShellConfirmFn that prompts the user via readline (y/n).
   * Inject this into createShellExecuteTool() so shell commands are usable in CLI mode.
   */
  createShellConfirmFn(): ShellConfirmFn {
    return (command: string): Promise<boolean> => {
      return new Promise((resolve) => {
        if (!this.rl) {
          resolve(false);
          return;
        }
        this.rl.question(`\nAllow shell command? [y/N]\n  $ ${command}\n> `, (answer) => {
          resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
          this.rl?.setPrompt('> ');
        });
      });
    };
  }

  /**
   * Start the REPL loop using Node.js readline.
   * Shows a welcome message and `> ` prompt, reads input line by line.
   */
  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('Welcome to AI Assistant. Type /exit to quit, /clear to reset conversation.');

    // Handle terminal resize — adapt renderer width
    process.stdout.on('resize', () => {
      this.renderer.adaptToWidth(process.stdout.columns ?? 80);
    });
    // Set initial width
    this.renderer.adaptToWidth(process.stdout.columns ?? 80);

    // Graceful Ctrl+C
    process.on('SIGINT', () => {
      void this.shutdown();
    });

    this.rl.on('line', (input) => {
      void this.handleInput(input.trim());
    });

    this.rl.on('close', () => {
      if (!this.isShuttingDown) {
        void this.shutdown();
      }
    });

    this.rl.setPrompt('> ');
    this.rl.prompt();
  }

  /**
   * Parses a line of input, resolving any `@/path/to/file` references.
   * Returns a plain string if no file references are found, or a ContentBlock[]
   * for mixed text+file input (Req 6.1, 6.5).
   * Prints an error and returns null if a file is missing or has an unsupported extension (Req 6.3, 6.4).
   */
  async parseInput(input: string): Promise<string | ContentBlock[] | null> {
    // Match all @<path> tokens — path is everything up to the next whitespace
    const FILE_REF_RE = /@(\S+)/g;
    const matches = [...input.matchAll(FILE_REF_RE)];

    if (matches.length === 0) {
      return input;
    }

    const blocks: ContentBlock[] = [];
    let lastIndex = 0;

    for (const match of matches) {
      const matchStart = match.index!;
      const filePath = match[1] ?? '';

      // Add any text before this @ref as a TextBlock
      const textBefore = input.slice(lastIndex, matchStart).trim();
      if (textBefore) {
        blocks.push({ type: 'text', text: textBefore });
      }

      const ext = extname(filePath).toLowerCase();
      const mimeType = REPL.EXT_TO_MIME[ext];

      if (!mimeType) {
        console.error(`不支持的文件类型: ${ext}`);
        return null;
      }

      let fileData: Buffer;
      try {
        fileData = await readFile(filePath);
      } catch {
        console.error(`文件不存在: ${filePath}`);
        return null;
      }

      const base64 = fileData.toString('base64');
      const isImage = mimeType.startsWith('image/');

      if (isImage) {
        blocks.push({
          type: 'image',
          mimeType: mimeType as SupportedImageMimeType,
          data: base64,
        });
      } else {
        blocks.push({
          type: 'file',
          mimeType: mimeType as SupportedFileMimeType,
          data: base64,
          filename: filePath.split('/').pop() ?? filePath,
        });
      }

      lastIndex = matchStart + match[0].length;
    }

    // Add any trailing text after the last @ref
    const textAfter = input.slice(lastIndex).trim();
    if (textAfter) {
      blocks.push({ type: 'text', text: textAfter });
    }

    return blocks;
  }

  /**
   * Handle a single line of user input.
   * - `/exit` → shutdown
   * - `/clear` → clear conversation history
   * - `@/path/to/file` → parse file references and build ContentBlock[]
   * - anything else → pass to orchestrator and stream response
   */
  async handleInput(input: string): Promise<void> {
    if (input === '/exit') {
      await this.shutdown();
      return;
    }

    if (input === '/clear') {
      // Use the public clearConversation() method (P1-6 fix — no more unsafe casting)
      this.orchestrator.clearConversation();
      console.log('Conversation cleared.');
      this.rl?.prompt();
      return;
    }

    if (input === '') {
      this.rl?.prompt();
      return;
    }

    try {
      // Parse input — resolve any @file references (Req 6.1–6.5)
      const parsed = await this.parseInput(input);
      if (parsed === null) {
        // Error already printed by parseInput
        this.rl?.prompt();
        return;
      }

      // Stream the response from the orchestrator
      for await (const chunk of this.orchestrator.processMessage(parsed)) {
        if (chunk.type === 'text' && chunk.content) {
          this.renderer.renderToken(chunk.content);
        } else if (chunk.type === 'tool_call_start' && chunk.toolCall) {
          this.renderer.renderToolCall(
            chunk.toolCall.name ?? '',
            (chunk.toolCall.arguments as Record<string, unknown>) ?? {},
          );
        }
      }
      // Ensure we end on a new line after streaming
      process.stdout.write('\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.renderer.renderError(message);
    }

    this.rl?.prompt();
  }

  /**
   * Gracefully close the readline interface and print a goodbye message.
   * Does NOT call process.exit() — the caller (index.ts) is responsible for cleanup and exit.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('\nGoodbye!');
    this.rl?.close();
  }
}
