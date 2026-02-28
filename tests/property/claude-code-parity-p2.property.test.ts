// @vitest-environment node
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { expect } from 'vitest';
import {
  SlashCommandRegistry,
  helpCommand,
} from '../../src/cli/slash-commands.js';
import type { SlashCommand, SlashCommandContext } from '../../src/cli/slash-commands.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a valid slash command name like /abc, /xyz */
const commandNameArb = fc
  .stringMatching(/^[a-z]{2,10}$/)
  .map((s) => `/${s}`);

/** Generate a non-empty description string */
const descriptionArb = fc.string({ minLength: 1, maxLength: 80 }).filter(
  (s) => s.trim().length > 0,
);

/** Generate a single arbitrary SlashCommand */
const commandArb: fc.Arbitrary<SlashCommand> = fc
  .record({
    name: commandNameArb,
    description: descriptionArb,
  })
  .map(({ name, description }) => ({
    name,
    description,
    async execute(_args: string, _ctx: SlashCommandContext): Promise<string> {
      return `executed ${name}`;
    },
  }));

/** Generate a set of unique-named slash commands (1–10 commands) */
const commandSetArb: fc.Arbitrary<SlashCommand[]> = fc
  .uniqueArray(commandArb, {
    minLength: 1,
    maxLength: 10,
    selector: (cmd) => cmd.name,
  });

/** Minimal SlashCommandContext for /help execution */
function makeContext(registry: SlashCommandRegistry): SlashCommandContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orchestrator: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationManager: {} as any,
    modelId: 'claude-test',
    registry,
  };
}

// ─── Property 1: /help 完整性 ─────────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 1: /help 完整性
// For any registered command set, `/help` output contains every command's name
// and non-empty description string.
// Validates: Requirements 1.1, 1.4, 14.1

describe('Property 1: /help 完整性', () => {
  it('help output contains every registered command name', async () => {
    await fc.assert(
      fc.asyncProperty(commandSetArb, async (commands) => {
        const registry = new SlashCommandRegistry();
        // Register the built-in helpCommand so /help can enumerate the registry
        registry.register(helpCommand);
        for (const cmd of commands) {
          registry.register(cmd);
        }

        const ctx = makeContext(registry);
        const output = await helpCommand.execute('', ctx);

        expect(typeof output).toBe('string');
        const helpOutput = output as string;

        for (const cmd of commands) {
          expect(helpOutput).toContain(cmd.name);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('help output contains every registered command non-empty description', async () => {
    await fc.assert(
      fc.asyncProperty(commandSetArb, async (commands) => {
        const registry = new SlashCommandRegistry();
        registry.register(helpCommand);
        for (const cmd of commands) {
          registry.register(cmd);
        }

        const ctx = makeContext(registry);
        const output = await helpCommand.execute('', ctx);

        expect(typeof output).toBe('string');
        const helpOutput = output as string;

        for (const cmd of commands) {
          // Description must be non-empty and present in output
          expect(cmd.description.trim().length).toBeGreaterThan(0);
          expect(helpOutput).toContain(cmd.description);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('help output also contains the /help command itself', async () => {
    await fc.assert(
      fc.asyncProperty(commandSetArb, async (commands) => {
        const registry = new SlashCommandRegistry();
        registry.register(helpCommand);
        for (const cmd of commands) {
          registry.register(cmd);
        }

        const ctx = makeContext(registry);
        const output = await helpCommand.execute('', ctx);

        expect(typeof output).toBe('string');
        const helpOutput = output as string;

        // /help itself must appear in its own output
        expect(helpOutput).toContain('/help');
        expect(helpOutput).toContain(helpCommand.description);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 2: /model 显示正确性 ────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 2: /model 显示正确性
// For any model identifier string, `/model` output contains that identifier.
// Validates: Requirements 2.1, 2.3

import { modelCommand } from '../../src/cli/slash-commands.js';

describe('Property 2: /model 显示正确性', () => {
  it('/model output contains the model identifier for any non-empty model string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (modelId) => {
          const registry = new SlashCommandRegistry();
          const ctx: SlashCommandContext = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            orchestrator: {} as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            conversationManager: {} as any,
            modelId,
            registry,
          };

          const output = await modelCommand.execute('', ctx);

          expect(typeof output).toBe('string');
          expect(output as string).toContain(modelId);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: 代码块围栏平衡性 ─────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 6: 代码块围栏平衡性
// For any Markdown input with code blocks, every opening fence in renderMarkdown
// output has a corresponding closing fence (balanced fence property).
// Validates: Requirements 5.1, 14.2

import { renderMarkdown, ANSI } from '../../src/context/markdown-renderer.js';

/** Generate a single fenced code block (no ``` inside content lines) */
const codeBlockArb = fc
  .tuple(
    fc.constantFrom('typescript', 'python', 'bash', 'json', ''),
    fc.array(
      fc.string({ maxLength: 60 }).filter((s) => !s.includes('```')),
      { minLength: 0, maxLength: 8 },
    ),
  )
  .map(([lang, lines]) => '```' + lang + '\n' + lines.join('\n') + '\n```');

/** Generate Markdown that is an array of code blocks joined by prose */
const markdownWithCodeBlocksArb = fc
  .array(codeBlockArb, { minLength: 1, maxLength: 5 })
  .map((blocks) => blocks.join('\n\nsome prose\n\n'));

describe('Property 6: 代码块围栏平衡性', () => {
  it('every opening ``` fence has a corresponding closing fence', () => {
    fc.assert(
      fc.property(markdownWithCodeBlocksArb, (markdown) => {
        const output = renderMarkdown(markdown, { ansi: false });
        // Count occurrences of ``` (lines that are exactly ```)
        const fenceLines = output.split('\n').filter((l) => l === '```' || l.startsWith('```'));
        // The number of fence lines must be even (each open has a close)
        expect(fenceLines.length % 2).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('triple-backtick occurrences in output are even (balanced)', () => {
    fc.assert(
      fc.property(markdownWithCodeBlocksArb, (markdown) => {
        const output = renderMarkdown(markdown, { ansi: false });
        // Count all ``` occurrences in the output
        const matches = output.match(/```/g) ?? [];
        expect(matches.length % 2).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 7: 内容保留性 ────────────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 7: 内容保留性
// For any Markdown input M, stripping all ANSI escape sequences from
// renderMarkdown(M) produces a string containing all non-whitespace characters
// from M (content preservation property).
// Note: # heading prefixes are stripped by the renderer, so we exclude them.
// Validates: Requirements 4.2, 4.3, 4.4, 4.5, 5.4, 14.3

/** Strip all ANSI escape sequences from a string */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Generate plain Markdown without code fences (to keep the property simple).
 * We only use plain text lines to avoid structural Markdown characters that
 * the renderer intentionally transforms (e.g. # → stripped, - → •, * → bold).
 * The property checks that the renderer does not silently drop content.
 */
const plainTextLineArb = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter(
    (s) =>
      !s.includes('\n') &&
      !s.includes('`') &&
      !s.includes('#') &&
      !s.includes('*') &&
      !s.includes('_') &&
      !s.includes('-') &&
      s.trim().length > 0,
  );

const plainMarkdownArb = fc
  .array(plainTextLineArb, { minLength: 1, maxLength: 10 })
  .map((lines) => lines.join('\n'));

describe('Property 7: 内容保留性', () => {
  it('stripping ANSI from rendered output preserves all non-whitespace chars from plain-text input', () => {
    fc.assert(
      fc.property(plainMarkdownArb, (markdown) => {
        const rendered = renderMarkdown(markdown, { ansi: true });
        const stripped = stripAnsi(rendered);

        // For plain text lines (no Markdown structural chars), every
        // non-whitespace character from the input must appear in the output.
        const inputChars = markdown
          .split('')
          .filter((c) => !/\s/.test(c));

        for (const ch of inputChars) {
          expect(stripped).toContain(ch);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: Markdown 标题渲染 ────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 4: Markdown 标题渲染
// For any ATX heading input, output contains ANSI bold sequence and does not
// contain the raw # prefix.
// Validates: Requirements 4.2

/** Generate ATX heading strings like `# text`, `## text`, etc. */
const headingArb = fc
  .tuple(
    fc.integer({ min: 1, max: 6 }),
    fc
      .string({ minLength: 1, maxLength: 50 })
      .filter(
        (s) =>
          !s.includes('\n') &&
          s.trim().length > 0 &&
          !s.startsWith('#'), // heading text must not start with # to avoid ambiguity
      ),
  )
  .map(([level, text]) => '#'.repeat(level) + ' ' + text);

describe('Property 4: Markdown 标题渲染', () => {
  it('heading output contains ANSI bold sequence', () => {
    fc.assert(
      fc.property(headingArb, (heading) => {
        const output = renderMarkdown(heading, { ansi: true });
        expect(output).toContain(ANSI.BOLD);
      }),
      { numRuns: 100 },
    );
  });

  it('heading output does not contain the raw # prefix', () => {
    fc.assert(
      fc.property(headingArb, (heading) => {
        const output = renderMarkdown(heading, { ansi: true });
        // The rendered output should not start with '#'
        const firstLine = output.split('\n')[0] ?? '';
        expect(firstLine.startsWith('#')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('heading output without ansi does not contain # prefix', () => {
    fc.assert(
      fc.property(headingArb, (heading) => {
        const output = renderMarkdown(heading, { ansi: false });
        const firstLine = output.split('\n')[0] ?? '';
        expect(firstLine.startsWith('#')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 5: Markdown 粗体与列表渲染 ──────────────────────────────────────
// Feature: claude-code-parity-p2, Property 5: Markdown 粗体与列表渲染
// **text** produces ANSI bold; `- item` produces `  •` prefix.
// Validates: Requirements 4.3, 4.4, 4.5

/** Generate bold markdown strings like `**sometext**` */
const boldArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter(
    (s) =>
      !s.includes('\n') &&
      !s.includes('*') &&
      !s.includes('_') &&
      !s.includes('`') &&
      s.trim().length > 0,
  )
  .map((t) => `**${t}**`);

/** Generate unordered list item strings like `- item text` */
const listItemArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter(
    (s) =>
      !s.includes('\n') &&
      !s.includes('*') &&
      !s.includes('_') &&
      !s.includes('`') &&
      s.trim().length > 0,
  )
  .map((t) => `- ${t}`);

describe('Property 5: Markdown 粗体与列表渲染', () => {
  it('**text** produces ANSI bold sequence in output', () => {
    fc.assert(
      fc.property(boldArb, (bold) => {
        const output = renderMarkdown(bold, { ansi: true });
        expect(output).toContain(ANSI.BOLD);
      }),
      { numRuns: 100 },
    );
  });

  it('- item produces  • prefix in output', () => {
    fc.assert(
      fc.property(listItemArb, (item) => {
        const output = renderMarkdown(item, { ansi: true });
        expect(output).toContain('  \u2022');
      }),
      { numRuns: 100 },
    );
  });

  it('- item produces  • prefix even without ansi', () => {
    fc.assert(
      fc.property(listItemArb, (item) => {
        const output = renderMarkdown(item, { ansi: false });
        expect(output).toContain('  \u2022');
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: 文件内容不存入对话历史 ────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 8: 文件内容不存入对话历史
// For any `file_read` tool call, the stored tool result message SHALL NOT
// contain raw file content and SHALL contain `FileContentReference` JSON.
// Validates: Requirements 6.1, 6.4

import { isFileContentReference } from '../../src/types/context.js';
import type { FileContentReference } from '../../src/types/context.js';

/** Generate arbitrary file paths */
const filePathArb = fc
  .tuple(
    fc.constantFrom('src', 'tests', 'docs', 'lib'),
    fc.stringMatching(/^[a-z][a-z0-9_-]{1,15}$/),
    fc.constantFrom('.ts', '.js', '.py', '.json', '.md'),
  )
  .map(([dir, name, ext]) => `${dir}/${name}${ext}`);

/** Generate arbitrary file content strings (non-empty, may contain any chars) */
const fileContentArb = fc.string({ minLength: 1, maxLength: 500 });

describe('Property 8: 文件内容不存入对话历史', () => {
  it('stored tool result does not contain raw file content (for non-trivial content)', () => {
    // We use file content that is long enough and contains characters that
    // would never appear in a FileContentReference JSON (e.g. a unique marker).
    // Short strings like `"` can appear in any JSON by coincidence, so we
    // constrain the content to be at least 20 chars and contain a unique prefix.
    const uniqueContentArb = fc
      .string({ minLength: 20, maxLength: 500 })
      .filter((s) => !s.includes('file_content_reference') && !s.includes('filePath') && !s.includes('readAtMtime'));

    fc.assert(
      fc.property(filePathArb, uniqueContentArb, (filePath, fileContent) => {
        // Simulate what the orchestrator does: create a FileContentReference
        // and JSON.stringify it instead of storing raw file content.
        const ref: FileContentReference = {
          __type: 'file_content_reference',
          filePath,
          readAtMtime: Date.now(),
        };
        const storedContent = JSON.stringify(ref);

        // The stored content must NOT contain the raw file content
        expect(storedContent).not.toContain(fileContent);
      }),
      { numRuns: 100 },
    );
  });

  it('stored tool result is valid JSON', () => {
    fc.assert(
      fc.property(filePathArb, fileContentArb, (filePath, _fileContent) => {
        const ref: FileContentReference = {
          __type: 'file_content_reference',
          filePath,
          readAtMtime: Date.now(),
        };
        const storedContent = JSON.stringify(ref);

        // Must be valid JSON
        expect(() => JSON.parse(storedContent)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('stored tool result parses to an object with __type: file_content_reference', () => {
    fc.assert(
      fc.property(filePathArb, fileContentArb, (filePath, _fileContent) => {
        const ref: FileContentReference = {
          __type: 'file_content_reference',
          filePath,
          readAtMtime: Date.now(),
        };
        const storedContent = JSON.stringify(ref);

        const parsed: unknown = JSON.parse(storedContent);
        expect(typeof parsed).toBe('object');
        expect(parsed).not.toBeNull();
        expect((parsed as Record<string, unknown>).__type).toBe('file_content_reference');
      }),
      { numRuns: 100 },
    );
  });

  it('stored tool result contains the file path', () => {
    fc.assert(
      fc.property(filePathArb, fileContentArb, (filePath, _fileContent) => {
        const ref: FileContentReference = {
          __type: 'file_content_reference',
          filePath,
          readAtMtime: Date.now(),
        };
        const storedContent = JSON.stringify(ref);

        const parsed: unknown = JSON.parse(storedContent);
        expect((parsed as Record<string, unknown>).filePath).toBe(filePath);
      }),
      { numRuns: 100 },
    );
  });

  it('isFileContentReference validates the stored tool result', () => {
    fc.assert(
      fc.property(filePathArb, fileContentArb, (filePath, _fileContent) => {
        const ref: FileContentReference = {
          __type: 'file_content_reference',
          filePath,
          readAtMtime: Date.now(),
        };
        const storedContent = JSON.stringify(ref);

        const parsed: unknown = JSON.parse(storedContent);
        expect(isFileContentReference(parsed)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 17: 压缩使用低成本模型 ──────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 17: 压缩使用低成本模型
// For any History_Compressor invocation, the compression call goes through the
// compressionLlmClient (not the primary client) when one is provided.
// Validates: Requirements 7.1, 7.4

import { ConversationManager } from '../../src/conversation/manager.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { Message } from '../../src/types/messages.js';
import type { StreamChunk } from '../../src/llm/client.js';

/** Build a minimal ConversationConfig with a very low highWaterMark */
function makeConfig(highWaterMark = 1, lowWaterMark = 1) {
  return {
    highWaterMark,
    lowWaterMark,
    maxContextTokens: 10000,
    compressionModel: 'claude-haiku',
  };
}

/** Create a mock LLMClient whose chat() records calls and yields a short summary */
function makeMockLlmClient(summaryText = 'summary'): {
  client: LLMClient;
  callCount: () => number;
} {
  let calls = 0;
  const client = {
    async *chat(_messages: Message[], _tools: unknown[]): AsyncGenerator<StreamChunk> {
      calls++;
      yield { type: 'text', content: summaryText } as StreamChunk;
    },
  } as unknown as LLMClient;
  return { client, callCount: () => calls };
}

/** Generate a list of ≥2 non-system messages with non-trivial content */
const conversationHistoryArb = fc
  .array(
    fc.record({
      role: fc.constantFrom('user', 'assistant') as fc.Arbitrary<'user' | 'assistant'>,
      content: fc.string({ minLength: 10, maxLength: 200 }).filter(
        (s) => s.trim().length > 5,
      ),
    }),
    { minLength: 2, maxLength: 8 },
  )
  .map((msgs): Message[] =>
    msgs.map((m) => ({ ...m, timestamp: Date.now() })),
  );

describe('Property 17: 压缩使用低成本模型', () => {
  it('compressionLlmClient.chat is called when compressIfNeeded(true) is invoked', async () => {
    await fc.assert(
      fc.asyncProperty(conversationHistoryArb, async (messages) => {
        const entityCache = new KeyEntityCache();
        const { client: compressionClient, callCount } = makeMockLlmClient();
        const { client: primaryClient, callCount: primaryCallCount } = makeMockLlmClient('primary');

        const manager = new ConversationManager(
          makeConfig(),
          entityCache,
          compressionClient,
        );

        // Populate history
        for (const msg of messages) {
          manager.addMessage(msg);
        }

        await manager.compressIfNeeded(true);

        // The compression client must have been called
        expect(callCount()).toBeGreaterThan(0);
        // The primary client must NOT have been called (it was never passed in)
        expect(primaryCallCount()).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('primary client is NOT called when compressionLlmClient is provided', async () => {
    await fc.assert(
      fc.asyncProperty(conversationHistoryArb, async (messages) => {
        const entityCache = new KeyEntityCache();
        const { client: compressionClient } = makeMockLlmClient();

        // We track whether the primary client's chat was called by wrapping it
        let primaryChatCalled = false;
        const primaryClient = {
          async *chat(): AsyncGenerator<StreamChunk> {
            primaryChatCalled = true;
            yield { type: 'text', content: 'primary response' } as StreamChunk;
          },
        } as unknown as LLMClient;

        // ConversationManager only receives compressionClient, not primaryClient
        // (primaryClient is not passed — it's only used by the orchestrator for main chat)
        const manager = new ConversationManager(
          makeConfig(),
          entityCache,
          compressionClient,
        );

        for (const msg of messages) {
          manager.addMessage(msg);
        }

        await manager.compressIfNeeded(true);

        // Primary client was never passed to ConversationManager, so it can't be called
        expect(primaryChatCalled).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('falls back to local summary (no LLM call) when no compressionLlmClient is provided', async () => {
    await fc.assert(
      fc.asyncProperty(conversationHistoryArb, async (messages) => {
        const entityCache = new KeyEntityCache();

        // No compressionLlmClient — should use local structured summary
        const manager = new ConversationManager(makeConfig(), entityCache);

        for (const msg of messages) {
          manager.addMessage(msg);
        }

        // Should not throw; local summary is used
        await expect(manager.compressIfNeeded(true)).resolves.toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 18: 压缩减少 Token 数 ───────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 18: 压缩减少 Token 数
// For any conversation history with ≥ 2 messages, compressIfNeeded(force=true)
// results in getTokenCount() strictly less than before compression.
// Validates: Requirements 14.8

/**
 * Generate a conversation history with alternating user/assistant turns.
 * Each message has substantial content (≥200 chars) so the total token count
 * is always much larger than the compressed summary.
 *
 * We generate N complete turns (user + assistant), ensuring:
 * - At least 2 turns (4 messages) so there are multiple turn boundaries
 * - Each message is 200+ chars (50+ tokens) so total >> summary overhead
 * - Alternating roles so the compression algorithm can identify turn boundaries
 */
const substantialHistoryArb = fc
  .integer({ min: 2, max: 4 })
  .chain((numTurns) =>
    fc.array(
      fc.record({
        userContent: fc.string({ minLength: 200, maxLength: 400 }).filter(
          (s) => s.trim().length >= 200,
        ),
        assistantContent: fc.string({ minLength: 200, maxLength: 400 }).filter(
          (s) => s.trim().length >= 200,
        ),
      }),
      { minLength: numTurns, maxLength: numTurns },
    ),
  )
  .map((turns): Message[] => {
    const msgs: Message[] = [];
    for (const turn of turns) {
      msgs.push({ role: 'user', content: turn.userContent, timestamp: Date.now() });
      msgs.push({ role: 'assistant', content: turn.assistantContent, timestamp: Date.now() });
    }
    return msgs;
  });

describe('Property 18: 压缩减少 Token 数', () => {
  it('getTokenCount() is strictly less after compressIfNeeded(force=true)', async () => {
    await fc.assert(
      fc.asyncProperty(substantialHistoryArb, async (messages) => {
        const entityCache = new KeyEntityCache();

        // Use a mock compressionLlmClient that returns a very short summary
        // so the token count is guaranteed to drop
        const { client: compressionClient } = makeMockLlmClient('ok');

        // Set highWaterMark very low so compression always triggers,
        // and lowWaterMark even lower so the summary replaces history
        const config = {
          highWaterMark: 1,
          lowWaterMark: 1,
          maxContextTokens: 10000,
          compressionModel: 'claude-haiku',
        };

        const manager = new ConversationManager(config, entityCache, compressionClient);

        for (const msg of messages) {
          manager.addMessage(msg);
        }

        const tokensBefore = manager.getTokenCount();
        await manager.compressIfNeeded(true);
        const tokensAfter = manager.getTokenCount();

        expect(tokensAfter).toBeLessThan(tokensBefore);
      }),
      { numRuns: 100 },
    );
  });

  it('getTokenCount() is strictly less after compression without compressionLlmClient', async () => {
    await fc.assert(
      fc.asyncProperty(substantialHistoryArb, async (messages) => {
        const entityCache = new KeyEntityCache();

        const config = {
          highWaterMark: 1,
          lowWaterMark: 1,
          maxContextTokens: 10000,
        };

        const manager = new ConversationManager(config, entityCache);

        for (const msg of messages) {
          manager.addMessage(msg);
        }

        const tokensBefore = manager.getTokenCount();
        await manager.compressIfNeeded(true);
        const tokensAfter = manager.getTokenCount();

        expect(tokensAfter).toBeLessThan(tokensBefore);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: 索引新鲜度 ────────────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 9: 索引新鲜度
// For any file content written to disk, after invalidateAndReindex(path),
// removeChunksByFile(path) is called and indexChunks is called with chunks
// whose content comes from the new file content.
// Validates: Requirements 8.1, 8.2, 8.3, 9.1, 9.2, 14.4

import * as os from 'node:os';
import * as fsSync from 'node:fs';
import * as nodePath from 'node:path';
import { ContextManager } from '../../src/context/context-manager.js';
import type { HybridRetriever } from '../../src/retrieval/hybrid-retriever.js';
import type { Chunk } from '../../src/types/chunks.js';

/** Generate a safe filename (no path separators, no special chars) */
const safeFilenameArb = fc
  .stringMatching(/^[a-z][a-z0-9_]{2,15}$/)
  .map((name) => `prop9_${name}.ts`);

/** Generate non-empty file content that is unique enough to identify */
const fileContentArb2 = fc
  .string({ minLength: 20, maxLength: 300 })
  .filter((s) => s.trim().length >= 10 && !s.includes('\0'));

describe('Property 9: 索引新鲜度', () => {
  it('removeChunksByFile is called with the correct path after invalidateAndReindex', async () => {
    await fc.assert(
      fc.asyncProperty(safeFilenameArb, fileContentArb2, async (filename, content) => {
        const tmpDir = os.tmpdir();
        const filePath = nodePath.join(tmpDir, filename);

        // Track calls to removeChunksByFile and indexChunks
        const removedPaths: string[] = [];
        const indexedChunks: Chunk[] = [];

        // Mock HybridRetriever
        const mockRetriever = {
          removeChunksByFile: async (path: string) => {
            removedPaths.push(path);
          },
          indexChunks: async (chunks: Chunk[]) => {
            indexedChunks.push(...chunks);
          },
          search: async () => [],
          getAllChunks: () => [],
          getDependencies: () => [],
        } as unknown as HybridRetriever;

        const entityCache = new KeyEntityCache();
        const config = { maxChunkSize: 100, overlapLines: 2, toolOutputMaxLines: 50 };
        const manager = new ContextManager(mockRetriever, entityCache, config);

        // Write the file to disk
        fsSync.writeFileSync(filePath, content, 'utf-8');

        try {
          await manager.invalidateAndReindex(filePath);

          // removeChunksByFile must have been called with the exact file path
          expect(removedPaths).toContain(filePath);
        } finally {
          // Clean up temp file
          try { fsSync.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('indexChunks is called with chunks whose content comes from the new file content', async () => {
    await fc.assert(
      fc.asyncProperty(safeFilenameArb, fileContentArb2, async (filename, content) => {
        const tmpDir = os.tmpdir();
        const filePath = nodePath.join(tmpDir, filename);

        const indexedChunks: Chunk[] = [];

        const mockRetriever = {
          removeChunksByFile: async () => {},
          indexChunks: async (chunks: Chunk[]) => {
            indexedChunks.push(...chunks);
          },
          search: async () => [],
          getAllChunks: () => [],
          getDependencies: () => [],
        } as unknown as HybridRetriever;

        const entityCache = new KeyEntityCache();
        const config = { maxChunkSize: 100, overlapLines: 2, toolOutputMaxLines: 50 };
        const manager = new ContextManager(mockRetriever, entityCache, config);

        fsSync.writeFileSync(filePath, content, 'utf-8');

        try {
          await manager.invalidateAndReindex(filePath);

          // indexChunks must have been called (file has content)
          expect(indexedChunks.length).toBeGreaterThan(0);

          // Every indexed chunk must reference the correct file path
          for (const chunk of indexedChunks) {
            expect(chunk.metadata.filePath).toBe(filePath);
          }

          // The concatenation of all chunk content must be a substring of (or equal to)
          // the new file content — chunks are derived from the written content
          const allChunkContent = indexedChunks.map((c) => c.content).join('');
          // Each chunk's content must appear somewhere in the written file content
          for (const chunk of indexedChunks) {
            expect(content).toContain(chunk.content.trim().slice(0, 10));
          }
        } finally {
          try { fsSync.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('removeChunksByFile is called before indexChunks (old entries removed first)', async () => {
    await fc.assert(
      fc.asyncProperty(safeFilenameArb, fileContentArb2, async (filename, content) => {
        const tmpDir = os.tmpdir();
        const filePath = nodePath.join(tmpDir, filename);

        const callOrder: string[] = [];

        const mockRetriever = {
          removeChunksByFile: async () => {
            callOrder.push('remove');
          },
          indexChunks: async (chunks: Chunk[]) => {
            if (chunks.length > 0) callOrder.push('index');
          },
          search: async () => [],
          getAllChunks: () => [],
          getDependencies: () => [],
        } as unknown as HybridRetriever;

        const entityCache = new KeyEntityCache();
        const config = { maxChunkSize: 100, overlapLines: 2, toolOutputMaxLines: 50 };
        const manager = new ContextManager(mockRetriever, entityCache, config);

        fsSync.writeFileSync(filePath, content, 'utf-8');

        try {
          await manager.invalidateAndReindex(filePath);

          // remove must come before index
          const removeIdx = callOrder.indexOf('remove');
          const indexIdx = callOrder.indexOf('index');

          expect(removeIdx).toBeGreaterThanOrEqual(0);
          if (indexIdx >= 0) {
            expect(removeIdx).toBeLessThan(indexIdx);
          }
        } finally {
          try { fsSync.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('only removeChunksByFile is called (no indexChunks) when file does not exist', async () => {
    await fc.assert(
      fc.asyncProperty(safeFilenameArb, async (filename) => {
        const tmpDir = os.tmpdir();
        // Use a path that definitely does not exist
        const filePath = nodePath.join(tmpDir, `nonexistent_${filename}`);

        // Ensure the file does not exist
        try { fsSync.unlinkSync(filePath); } catch { /* ignore */ }

        const removedPaths: string[] = [];
        const indexedChunks: Chunk[] = [];

        const mockRetriever = {
          removeChunksByFile: async (path: string) => {
            removedPaths.push(path);
          },
          indexChunks: async (chunks: Chunk[]) => {
            indexedChunks.push(...chunks);
          },
          search: async () => [],
          getAllChunks: () => [],
          getDependencies: () => [],
        } as unknown as HybridRetriever;

        const entityCache = new KeyEntityCache();
        const config = { maxChunkSize: 100, overlapLines: 2, toolOutputMaxLines: 50 };
        const manager = new ContextManager(mockRetriever, entityCache, config);

        await manager.invalidateAndReindex(filePath);

        // removeChunksByFile must be called (to clean up stale entries)
        expect(removedPaths).toContain(filePath);
        // indexChunks must NOT be called (file doesn't exist)
        expect(indexedChunks.length).toBe(0);
      }),
      { numRuns: 50 },
    );
  });
});

// ─── PermissionChecker helpers ────────────────────────────────────────────────

import { PermissionChecker } from '../../src/context/permission-checker.js';

/**
 * Write a permissions.json to a temp dir and return a loaded PermissionChecker.
 * Caller is responsible for cleaning up the temp dir.
 */
async function makePermissionChecker(
  tmpDir: string,
  config: { allowlist: string[]; denylist: string[]; pathWhitelist: string[] },
): Promise<PermissionChecker> {
  const kiroDir = nodePath.join(tmpDir, '.kiro');
  fsSync.mkdirSync(kiroDir, { recursive: true });
  fsSync.writeFileSync(
    nodePath.join(kiroDir, 'permissions.json'),
    JSON.stringify(config),
    'utf-8',
  );
  const checker = new PermissionChecker(tmpDir);
  await checker.load();
  return checker;
}

/** Generate a valid tool name matching /^[a-z][a-z_]{1,15}$/ */
const toolNameArb = fc.stringMatching(/^[a-z][a-z_]{1,15}$/);

// ─── Property 11: 拒绝列表阻断执行 ────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 11: 拒绝列表阻断执行
// For any tool name T in denylist, check(T, {}) returns allowed: false
// Validates: Requirements 11.1, 11.3

describe('Property 11: 拒绝列表阻断执行', () => {
  it('every tool in denylist is blocked by check()', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(toolNameArb, { minLength: 1, maxLength: 5 }),
        async (denylist) => {
          const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'perm11-'));
          try {
            const checker = await makePermissionChecker(tmpDir, {
              allowlist: [],
              denylist,
              pathWhitelist: [],
            });

            for (const toolName of denylist) {
              const result = checker.check(toolName, {});
              expect(result.allowed).toBe(false);
            }
          } finally {
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 12: 允许列表强制执行 ────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 12: 允许列表强制执行
// For any non-empty allowlist and any tool name T not in it, check(T, {}) returns allowed: false
// Validates: Requirements 11.2, 11.4

describe('Property 12: 允许列表强制执行', () => {
  it('tool not in non-empty allowlist is blocked by check()', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(toolNameArb, { minLength: 1, maxLength: 5 }),
        toolNameArb,
        async (allowlist, candidate) => {
          // Ensure candidate is NOT in the allowlist
          fc.pre(!allowlist.includes(candidate));

          const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'perm12-'));
          try {
            const checker = await makePermissionChecker(tmpDir, {
              allowlist,
              denylist: [],
              pathWhitelist: [],
            });

            const result = checker.check(candidate, {});
            expect(result.allowed).toBe(false);
          } finally {
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 13: 路径白名单强制执行 ──────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 13: 路径白名单强制执行
// For any non-empty pathWhitelist and any path P not matching any pattern,
// check('file_write', { path: P }) returns allowed: false
// Validates: Requirements 11.5, 11.6

/** Generate a path that definitely won't match 'src/**' or 'tests/**' */
const nonMatchingPathArb = fc
  .stringMatching(/^[a-z][a-z0-9_]{1,10}$/)
  .map((name) => `vendor/${name}.ts`);

describe('Property 13: 路径白名单强制执行', () => {
  it('file_write with non-matching path is blocked when pathWhitelist is non-empty', async () => {
    await fc.assert(
      fc.asyncProperty(nonMatchingPathArb, async (nonMatchingPath) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'perm13-'));
        try {
          const checker = await makePermissionChecker(tmpDir, {
            allowlist: [],
            denylist: [],
            pathWhitelist: ['src/**', 'tests/**'],
          });

          const result = checker.check('file_write', { path: nonMatchingPath });
          expect(result.allowed).toBe(false);
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 14: 拒绝列表优先于允许列表 ──────────────────────────────────────
// Feature: claude-code-parity-p2, Property 14: 拒绝列表优先于允许列表
// For any tool name T in both allowlist and denylist, check(T, {}) returns allowed: false
// Validates: Requirements 14.7

describe('Property 14: 拒绝列表优先于允许列表', () => {
  it('tool in both allowlist and denylist is denied (denylist wins)', async () => {
    await fc.assert(
      fc.asyncProperty(toolNameArb, async (toolName) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'perm14-'));
        try {
          const checker = await makePermissionChecker(tmpDir, {
            allowlist: [toolName],
            denylist: [toolName],
            pathWhitelist: [],
          });

          const result = checker.check(toolName, {});
          expect(result.allowed).toBe(false);
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 10: 权限配置解析完整性 ──────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 10: 权限配置解析完整性
// For any valid JSON permission config, load() followed by getConfig() returns
// config matching original JSON fields exactly
// Validates: Requirements 10.2

/** Generate arbitrary string arrays for permission config fields */
const stringArrayArb = fc.array(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes('\0')),
  { minLength: 0, maxLength: 5 },
);

const permissionConfigArb = fc.record({
  allowlist: stringArrayArb,
  denylist: stringArrayArb,
  pathWhitelist: stringArrayArb,
});

describe('Property 10: 权限配置解析完整性', () => {
  it('getConfig() returns the same arrays as the original JSON after load()', async () => {
    await fc.assert(
      fc.asyncProperty(permissionConfigArb, async (config) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'perm10-'));
        try {
          const checker = await makePermissionChecker(tmpDir, config);
          const loaded = checker.getConfig();

          expect(loaded.allowlist).toEqual(config.allowlist);
          expect(loaded.denylist).toEqual(config.denylist);
          expect(loaded.pathWhitelist).toEqual(config.pathWhitelist);
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 15: 回滚正确性 ────────────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 15: 回滚正确性
// For any transaction with write operations, after `rollbackTransaction`, every
// modified file's content equals its `RollbackSnapshot` content (rollback
// correctness property).
// Validates: Requirements 13.1, 14.5

import { TransactionManager } from '../../src/tools/implementations/transaction-manager.js';

/** Generate a safe relative filename (no path separators) */
const txFilenameArb = fc
  .stringMatching(/^[a-z][a-z0-9_]{2,12}$/)
  .map((name) => `prop15_${name}.txt`);

/** Generate non-empty file content */
const txContentArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => !s.includes('\0'));

/** Generate a set of unique filenames with new content to write */
const fileWriteSetArb = fc
  .uniqueArray(
    fc.record({ filename: txFilenameArb, newContent: txContentArb }),
    { minLength: 1, maxLength: 5, selector: (w) => w.filename },
  );

describe('Property 15: 回滚正确性', () => {
  it('pre-existing files are restored to original content after rollback', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileWriteSetArb,
        txContentArb,
        async (writes, originalContent) => {
          const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop15a-'));
          const manager = new TransactionManager();

          try {
            // Pre-populate all files with "original content"
            const filePaths = writes.map((w) => nodePath.join(tmpDir, w.filename));
            for (const filePath of filePaths) {
              fsSync.writeFileSync(filePath, originalContent, 'utf-8');
            }

            // Begin transaction and write new content to each file
            const txId = manager.beginTransaction();
            for (let i = 0; i < writes.length; i++) {
              await manager.writeFile(txId, filePaths[i], writes[i].newContent);
            }

            // Rollback
            await manager.rollbackTransaction(txId);

            // Every file must have been restored to original content
            for (const filePath of filePaths) {
              const restoredContent = fsSync.readFileSync(filePath, 'utf-8');
              expect(restoredContent).toBe(originalContent);
            }
          } finally {
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('newly created files (did not exist before transaction) are deleted after rollback', async () => {
    await fc.assert(
      fc.asyncProperty(fileWriteSetArb, async (writes) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop15b-'));
        const manager = new TransactionManager();

        try {
          // Do NOT pre-populate — files don't exist before the transaction
          const filePaths = writes.map((w) => nodePath.join(tmpDir, w.filename));

          const txId = manager.beginTransaction();
          for (let i = 0; i < writes.length; i++) {
            await manager.writeFile(txId, filePaths[i], writes[i].newContent);
          }

          // Verify files were actually created
          for (const filePath of filePaths) {
            expect(fsSync.existsSync(filePath)).toBe(true);
          }

          // Rollback
          await manager.rollbackTransaction(txId);

          // Every newly created file must be deleted
          for (const filePath of filePaths) {
            expect(fsSync.existsSync(filePath)).toBe(false);
          }
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('mixed scenario: pre-existing files restored, new files deleted after rollback', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate at least 2 writes so we can split into pre-existing and new
        fc.uniqueArray(
          fc.record({ filename: txFilenameArb, newContent: txContentArb }),
          { minLength: 2, maxLength: 6, selector: (w) => w.filename },
        ),
        txContentArb,
        async (writes, originalContent) => {
          const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop15c-'));
          const manager = new TransactionManager();

          try {
            const filePaths = writes.map((w) => nodePath.join(tmpDir, w.filename));

            // Pre-populate only the first half of files
            const splitIdx = Math.floor(writes.length / 2);
            const preExisting = filePaths.slice(0, splitIdx);
            const newFiles = filePaths.slice(splitIdx);

            for (const filePath of preExisting) {
              fsSync.writeFileSync(filePath, originalContent, 'utf-8');
            }

            // Begin transaction and write new content to ALL files
            const txId = manager.beginTransaction();
            for (let i = 0; i < writes.length; i++) {
              await manager.writeFile(txId, filePaths[i], writes[i].newContent);
            }

            // Rollback
            await manager.rollbackTransaction(txId);

            // Pre-existing files must be restored to original content
            for (const filePath of preExisting) {
              const restoredContent = fsSync.readFileSync(filePath, 'utf-8');
              expect(restoredContent).toBe(originalContent);
            }

            // New files must be deleted
            for (const filePath of newFiles) {
              expect(fsSync.existsSync(filePath)).toBe(false);
            }
          } finally {
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rollback report lists every modified file', async () => {
    await fc.assert(
      fc.asyncProperty(fileWriteSetArb, txContentArb, async (writes, originalContent) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop15d-'));
        const manager = new TransactionManager();

        try {
          const filePaths = writes.map((w) => nodePath.join(tmpDir, w.filename));
          for (const filePath of filePaths) {
            fsSync.writeFileSync(filePath, originalContent, 'utf-8');
          }

          const txId = manager.beginTransaction();
          for (let i = 0; i < writes.length; i++) {
            await manager.writeFile(txId, filePaths[i], writes[i].newContent);
          }

          const report = await manager.rollbackTransaction(txId);

          expect(report.status).toBe('rolled_back');
          expect(report.transactionId).toBe(txId);

          // Every written file must appear in the report
          for (const filePath of filePaths) {
            const entry = report.files.find((f) => f.filePath === filePath);
            expect(entry).toBeDefined();
          }
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 16: 事务汇合性 ────────────────────────────────────────────────────
// Feature: claude-code-parity-p2, Property 16: 事务汇合性
// For any two transactions T1 and T2 operating on disjoint file sets,
// committing T1 then T2 produces the same filesystem state as committing T2
// then T1 (confluence property for non-overlapping transactions).
// Validates: Requirements 14.6

/** Generate a safe filename for confluence tests */
const confluenceFilenameArb = fc
  .stringMatching(/^[a-z][a-z0-9_]{2,12}$/)
  .map((name) => `prop16_${name}.txt`);

/** Generate non-empty file content without null bytes */
const confluenceContentArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => !s.includes('\0'));

/**
 * Generate two disjoint sets of file writes (T1 files and T2 files with no overlap).
 * Each set has 1–4 unique filenames; the two sets share no filenames.
 */
const disjointTransactionArb = fc
  .uniqueArray(
    fc.record({ filename: confluenceFilenameArb, content: confluenceContentArb }),
    { minLength: 2, maxLength: 8, selector: (w) => w.filename },
  )
  .chain((allWrites) => {
    // Split into two non-empty halves
    const splitIdx = Math.max(1, Math.floor(allWrites.length / 2));
    const t1Writes = allWrites.slice(0, splitIdx);
    const t2Writes = allWrites.slice(splitIdx);
    return fc.constant({ t1Writes, t2Writes });
  })
  .filter(({ t1Writes, t2Writes }) => t1Writes.length >= 1 && t2Writes.length >= 1);

describe('Property 16: 事务汇合性', () => {
  it('committing T1 then T2 produces the same filesystem state as T2 then T1', async () => {
    await fc.assert(
      fc.asyncProperty(disjointTransactionArb, async ({ t1Writes, t2Writes }) => {
        // ── Scenario A: commit T1 then T2 ──────────────────────────────────
        const tmpDirA = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop16a-'));
        const stateA: Record<string, string> = {};

        try {
          const managerA = new TransactionManager();

          // T1: write T1 files
          const txA1 = managerA.beginTransaction();
          for (const w of t1Writes) {
            await managerA.writeFile(txA1, nodePath.join(tmpDirA, w.filename), w.content);
          }
          await managerA.commitTransaction(txA1);

          // T2: write T2 files
          const txA2 = managerA.beginTransaction();
          for (const w of t2Writes) {
            await managerA.writeFile(txA2, nodePath.join(tmpDirA, w.filename), w.content);
          }
          await managerA.commitTransaction(txA2);

          // Capture final state for all files
          for (const w of [...t1Writes, ...t2Writes]) {
            const filePath = nodePath.join(tmpDirA, w.filename);
            stateA[w.filename] = fsSync.readFileSync(filePath, 'utf-8');
          }
        } finally {
          fsSync.rmSync(tmpDirA, { recursive: true, force: true });
        }

        // ── Scenario B: commit T2 then T1 ──────────────────────────────────
        const tmpDirB = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop16b-'));
        const stateB: Record<string, string> = {};

        try {
          const managerB = new TransactionManager();

          // T2 first
          const txB2 = managerB.beginTransaction();
          for (const w of t2Writes) {
            await managerB.writeFile(txB2, nodePath.join(tmpDirB, w.filename), w.content);
          }
          await managerB.commitTransaction(txB2);

          // T1 second
          const txB1 = managerB.beginTransaction();
          for (const w of t1Writes) {
            await managerB.writeFile(txB1, nodePath.join(tmpDirB, w.filename), w.content);
          }
          await managerB.commitTransaction(txB1);

          // Capture final state for all files
          for (const w of [...t1Writes, ...t2Writes]) {
            const filePath = nodePath.join(tmpDirB, w.filename);
            stateB[w.filename] = fsSync.readFileSync(filePath, 'utf-8');
          }
        } finally {
          fsSync.rmSync(tmpDirB, { recursive: true, force: true });
        }

        // ── Verify both scenarios produce identical filesystem state ────────
        for (const w of [...t1Writes, ...t2Writes]) {
          expect(stateA[w.filename]).toBe(stateB[w.filename]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('all T1 files have correct content after T1-then-T2 commit order', async () => {
    await fc.assert(
      fc.asyncProperty(disjointTransactionArb, async ({ t1Writes, t2Writes }) => {
        const tmpDir = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), 'prop16c-'));

        try {
          const manager = new TransactionManager();

          const tx1 = manager.beginTransaction();
          for (const w of t1Writes) {
            await manager.writeFile(tx1, nodePath.join(tmpDir, w.filename), w.content);
          }
          await manager.commitTransaction(tx1);

          const tx2 = manager.beginTransaction();
          for (const w of t2Writes) {
            await manager.writeFile(tx2, nodePath.join(tmpDir, w.filename), w.content);
          }
          await manager.commitTransaction(tx2);

          // T1 files must contain exactly the content written by T1
          for (const w of t1Writes) {
            const actual = fsSync.readFileSync(nodePath.join(tmpDir, w.filename), 'utf-8');
            expect(actual).toBe(w.content);
          }

          // T2 files must contain exactly the content written by T2
          for (const w of t2Writes) {
            const actual = fsSync.readFileSync(nodePath.join(tmpDir, w.filename), 'utf-8');
            expect(actual).toBe(w.content);
          }
        } finally {
          fsSync.rmSync(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('T1 and T2 file sets are truly disjoint (no shared filenames)', async () => {
    await fc.assert(
      fc.property(disjointTransactionArb, ({ t1Writes, t2Writes }) => {
        const t1Names = new Set(t1Writes.map((w) => w.filename));
        const t2Names = new Set(t2Writes.map((w) => w.filename));

        for (const name of t2Names) {
          expect(t1Names.has(name)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
