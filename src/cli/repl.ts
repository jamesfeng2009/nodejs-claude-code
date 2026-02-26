import readline from 'readline';
import type { OrchestratorAgent } from '../agent/orchestrator.js';
import type { StreamingRenderer } from './streaming-renderer.js';
import type { ShellConfirmFn } from '../tools/implementations/shell-execute.js';

/**
 * Interactive REPL for the CLI application.
 * Validates: Requirements 1.1, 1.2, 1.4, 1.5
 */
export class REPL {
  private rl: readline.Interface | null = null;
  private isShuttingDown = false;

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
   * Handle a single line of user input.
   * - `/exit` → shutdown
   * - `/clear` → clear conversation history
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
      // Stream the response from the orchestrator
      for await (const chunk of this.orchestrator.processMessage(input)) {
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
