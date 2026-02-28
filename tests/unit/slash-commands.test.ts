import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SlashCommandRegistry,
  helpCommand,
  modelCommand,
  compactCommand,
  createDefaultRegistry,
  type SlashCommandContext,
  type SlashCommand,
} from '../../src/cli/slash-commands.js';
import { REPL } from '../../src/cli/repl.js';
import type { OrchestratorAgent } from '../../src/agent/orchestrator.js';
import type { StreamingRenderer } from '../../src/cli/streaming-renderer.js';
import type { ConversationManager } from '../../src/conversation/manager.js';
import type { Message } from '../../src/types/messages.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOrchestrator(): OrchestratorAgent {
  return {
    processMessage: vi.fn().mockReturnValue((async function* () {})()),
    clearConversation: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
  } as unknown as OrchestratorAgent;
}

function makeRenderer(): StreamingRenderer {
  return {
    renderToken: vi.fn(),
    renderToolCall: vi.fn(),
    renderError: vi.fn(),
    adaptToWidth: vi.fn(),
  } as unknown as StreamingRenderer;
}

function makeConversationManager(messages: Message[] = [], tokenCount = 0): ConversationManager {
  return {
    getMessages: vi.fn().mockReturnValue(messages),
    getTokenCount: vi.fn().mockReturnValue(tokenCount),
    addMessage: vi.fn(),
    clear: vi.fn(),
    compressIfNeeded: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConversationManager;
}

function makeContext(
  registry: SlashCommandRegistry,
  modelId = 'claude-sonnet-4-5',
  conversationManager?: ConversationManager,
): SlashCommandContext {
  return {
    orchestrator: makeOrchestrator(),
    conversationManager: conversationManager ?? makeConversationManager(),
    modelId,
    registry,
  };
}

// ─── SlashCommandRegistry ─────────────────────────────────────────────────────

describe('SlashCommandRegistry', () => {
  it('register and find a command by name', () => {
    const registry = new SlashCommandRegistry();
    const cmd: SlashCommand = {
      name: '/test',
      description: 'A test command',
      execute: async () => 'ok',
    };
    registry.register(cmd);
    expect(registry.find('/test')).toBe(cmd);
  });

  it('find returns undefined for unknown command', () => {
    const registry = new SlashCommandRegistry();
    expect(registry.find('/unknown')).toBeUndefined();
  });

  it('getAll returns commands sorted alphabetically by name', () => {
    const registry = new SlashCommandRegistry();
    registry.register({ name: '/zzz', description: 'z', execute: async () => {} });
    registry.register({ name: '/aaa', description: 'a', execute: async () => {} });
    registry.register({ name: '/mmm', description: 'm', execute: async () => {} });
    const names = registry.getAll().map((c) => c.name);
    expect(names).toEqual(['/aaa', '/mmm', '/zzz']);
  });

  it('getAll returns empty array when no commands registered', () => {
    const registry = new SlashCommandRegistry();
    expect(registry.getAll()).toEqual([]);
  });
});

// ─── /help command ────────────────────────────────────────────────────────────

describe('/help command', () => {
  it('lists all registered commands with their names', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext(registry);
    const output = await helpCommand.execute('', ctx);
    expect(output).toContain('/help');
    expect(output).toContain('/model');
    expect(output).toContain('/compact');
  });

  it('lists all registered commands with non-empty descriptions', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext(registry);
    const output = await helpCommand.execute('', ctx);
    // Each line should have a name and a description
    const lines = (output as string).split('\n').filter((l) => l.trim());
    for (const line of lines) {
      // Line format: "  /name       description"
      const parts = line.trim().split(/\s{2,}/);
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts[1]).toBeTruthy();
    }
  });

  it('includes /cost, /clear, /exit when registered via createDefaultRegistry + REPL', async () => {
    // The REPL registers additional commands (/cost, /clear, /exit) on top of the default registry
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repl = new REPL(makeOrchestrator(), makeRenderer());
    await repl.handleInput('/help');
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('/cost');
    expect(output).toContain('/clear');
    expect(output).toContain('/exit');
    consoleSpy.mockRestore();
  });

  it('dynamically includes newly registered commands', async () => {
    const registry = createDefaultRegistry();
    registry.register({
      name: '/custom',
      description: 'A custom command',
      execute: async () => 'custom',
    });
    const ctx = makeContext(registry);
    const output = await helpCommand.execute('', ctx);
    expect(output).toContain('/custom');
    expect(output).toContain('A custom command');
  });

  it('does not call orchestrator.processMessage', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const orchestrator = makeOrchestrator();
    const repl = new REPL(orchestrator, makeRenderer());
    await repl.handleInput('/help');
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ─── /model command ───────────────────────────────────────────────────────────

describe('/model command', () => {
  it('displays the current model identifier', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext(registry, 'claude-opus-4-5');
    const output = await modelCommand.execute('', ctx);
    expect(output).toContain('claude-opus-4-5');
  });

  it('displays a different model identifier when modelId changes', async () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext(registry, 'claude-haiku-3-5');
    const output = await modelCommand.execute('', ctx);
    expect(output).toContain('claude-haiku-3-5');
  });

  it('does not call orchestrator.processMessage', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const orchestrator = makeOrchestrator();
    const repl = new REPL(orchestrator, makeRenderer(), undefined, undefined, 'claude-sonnet-4-5');
    await repl.handleInput('/model');
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('output via REPL contains the model id passed to constructor', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repl = new REPL(makeOrchestrator(), makeRenderer(), undefined, undefined, 'my-test-model');
    await repl.handleInput('/model');
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('my-test-model');
    consoleSpy.mockRestore();
  });
});

// ─── /compact command ─────────────────────────────────────────────────────────

describe('/compact command', () => {
  describe('with fewer than 2 non-system messages', () => {
    it('shows a notice when history is empty', async () => {
      const registry = createDefaultRegistry();
      const cm = makeConversationManager([]);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      const output = await compactCommand.execute('', ctx);
      expect(output).toBeTruthy();
      // Should mention insufficient history
      expect(output).toMatch(/不足|insufficient|无需/i);
    });

    it('does NOT call compressIfNeeded when history is empty', async () => {
      const registry = createDefaultRegistry();
      const cm = makeConversationManager([]);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      await compactCommand.execute('', ctx);
      expect(cm.compressIfNeeded).not.toHaveBeenCalled();
    });

    it('shows a notice when there is only 1 non-system message', async () => {
      const registry = createDefaultRegistry();
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
      ];
      const cm = makeConversationManager(messages);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      const output = await compactCommand.execute('', ctx);
      expect(output).toMatch(/不足|insufficient|无需/i);
    });

    it('does NOT call compressIfNeeded when there is only 1 non-system message', async () => {
      const registry = createDefaultRegistry();
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
      ];
      const cm = makeConversationManager(messages);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      await compactCommand.execute('', ctx);
      expect(cm.compressIfNeeded).not.toHaveBeenCalled();
    });

    it('does NOT call compressIfNeeded when only system messages exist', async () => {
      const registry = createDefaultRegistry();
      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.', timestamp: Date.now() },
      ];
      const cm = makeConversationManager(messages);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      await compactCommand.execute('', ctx);
      expect(cm.compressIfNeeded).not.toHaveBeenCalled();
    });
  });

  describe('with sufficient history (≥ 2 non-system messages)', () => {
    function makeSufficientMessages(): Message[] {
      return [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
        { role: 'assistant', content: 'Hi there!', timestamp: Date.now() },
      ];
    }

    it('calls compressIfNeeded with force=true', async () => {
      const registry = createDefaultRegistry();
      const messages = makeSufficientMessages();
      const cm = makeConversationManager(messages, 500);
      // After compression, simulate fewer messages
      (cm.getMessages as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(messages)   // first call: before count
        .mockReturnValue([               // subsequent calls: after compression
          { role: 'assistant', content: 'Summary', timestamp: Date.now() },
        ]);
      (cm.getTokenCount as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(500)  // before
        .mockReturnValue(100);    // after
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      await compactCommand.execute('', ctx);
      expect(cm.compressIfNeeded).toHaveBeenCalledWith(true);
    });

    it('returns a confirmation message containing token counts', async () => {
      const registry = createDefaultRegistry();
      const messages = makeSufficientMessages();
      const cm = makeConversationManager(messages, 500);
      (cm.getMessages as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(messages)
        .mockReturnValue([
          { role: 'assistant', content: 'Summary', timestamp: Date.now() },
        ]);
      (cm.getTokenCount as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(500)
        .mockReturnValue(100);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      const output = await compactCommand.execute('', ctx);
      expect(output).toContain('500');
      expect(output).toContain('100');
    });

    it('returns a confirmation message mentioning message counts', async () => {
      const registry = createDefaultRegistry();
      const messages = makeSufficientMessages();
      const cm = makeConversationManager(messages, 500);
      (cm.getMessages as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(messages)
        .mockReturnValue([
          { role: 'assistant', content: 'Summary', timestamp: Date.now() },
        ]);
      (cm.getTokenCount as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(500)
        .mockReturnValue(100);
      const ctx = makeContext(registry, 'claude-sonnet-4-5', cm);
      const output = await compactCommand.execute('', ctx);
      // Should mention "2" (before) and "1" (after)
      expect(output).toContain('2');
      expect(output).toContain('1');
    });
  });
});

// ─── Unknown command via REPL.handleInput ─────────────────────────────────────

describe('Unknown slash command', () => {
  it('prints an error message for an unknown command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repl = new REPL(makeOrchestrator(), makeRenderer());
    await repl.handleInput('/unknown');
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('/unknown');
    consoleSpy.mockRestore();
  });

  it('error message suggests using /help', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repl = new REPL(makeOrchestrator(), makeRenderer());
    await repl.handleInput('/foobar');
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('/help');
    consoleSpy.mockRestore();
  });

  it('does not call orchestrator.processMessage for unknown command', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const orchestrator = makeOrchestrator();
    const repl = new REPL(orchestrator, makeRenderer());
    await repl.handleInput('/notacommand');
    expect(orchestrator.processMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('includes the unknown command name in the error message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const repl = new REPL(makeOrchestrator(), makeRenderer());
    await repl.handleInput('/xyz123');
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('/xyz123');
    consoleSpy.mockRestore();
  });
});
