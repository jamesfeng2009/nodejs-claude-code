import type { OrchestratorAgent } from '../agent/orchestrator.js';
import type { ConversationManager } from '../conversation/manager.js';

/**
 * Context passed to every slash command during execution.
 */
export interface SlashCommandContext {
  orchestrator: OrchestratorAgent;
  conversationManager: ConversationManager;
  /** Current primary model identifier */
  modelId: string;
  /** The registry itself, so /help can enumerate all commands */
  registry: SlashCommandRegistry;
}

/**
 * A single slash command that can be registered and executed in the REPL.
 */
export interface SlashCommand {
  /** Command name including the leading slash, e.g. "/help" */
  name: string;
  /** One-line description shown in /help output */
  description: string;
  /** Execute the command and return an optional string to print */
  execute(args: string, context: SlashCommandContext): Promise<string | void>;
}

/**
 * Registry of slash commands. Supports register/find/getAll operations.
 * getAll() returns commands sorted alphabetically by name.
 */
export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /** Returns all registered commands sorted by name */
  getAll(): SlashCommand[] {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}

// ─── Built-in commands ────────────────────────────────────────────────────────

/** /help — list all registered commands with their descriptions */
export const helpCommand: SlashCommand = {
  name: '/help',
  description: '显示所有可用命令及其说明',
  async execute(_args, ctx) {
    const lines = ctx.registry.getAll().map(
      (cmd) => `  ${cmd.name.padEnd(12)} ${cmd.description}`,
    );
    return lines.join('\n');
  },
};

/** /model — display the current primary model identifier */
export const modelCommand: SlashCommand = {
  name: '/model',
  description: '显示当前使用的模型名称',
  async execute(_args, ctx) {
    return `当前模型: ${ctx.modelId}`;
  },
};

/** /compact — manually trigger conversation history compression */
export const compactCommand: SlashCommand = {
  name: '/compact',
  description: '手动压缩对话历史以释放上下文空间',
  async execute(_args, ctx) {
    const messages = ctx.conversationManager.getMessages();
    // Exclude system messages when counting history length
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const before = nonSystemMessages.length;

    if (before < 2) {
      return '对话历史不足，无需压缩。';
    }

    const tokensBefore = ctx.conversationManager.getTokenCount();

    // Force compression regardless of watermark threshold
    await ctx.conversationManager.compressIfNeeded(true);

    const tokensAfter = ctx.conversationManager.getTokenCount();
    const after = ctx.conversationManager
      .getMessages()
      .filter((m) => m.role !== 'system').length;

    return `已压缩 ${before} 条消息 → ${after} 条摘要，Token 从 ${tokensBefore} 减少至 ${tokensAfter}。`;
  },
};

/**
 * Create and return a SlashCommandRegistry pre-populated with all built-in commands.
 */
export function createDefaultRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();
  registry.register(helpCommand);
  registry.register(modelCommand);
  registry.register(compactCommand);
  return registry;
}
