import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ConversationManager } from '../../src/conversation/manager.js';
import type { ConversationConfig } from '../../src/conversation/manager.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type { Message } from '../../src/types/messages.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ConversationConfig> = {}): ConversationConfig {
  return {
    highWaterMark: 1000,
    lowWaterMark: 500,
    maxContextTokens: 2000,
    ...overrides,
  };
}

function makeManager(config?: Partial<ConversationConfig>): ConversationManager {
  return new ConversationManager(makeConfig(config), new KeyEntityCache());
}

function makeMessage(
  role: Message['role'],
  content: string,
  extra: Partial<Message> = {},
): Message {
  return { role, content, timestamp: Date.now(), ...extra };
}

// Arbitrary: safe printable text (no control chars)
const textArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .map((s) => s.replace(/[\x00-\x1f]/g, 'x').trim())
  .filter((s) => s.length >= 1);

// Arbitrary: message role (non-system for conversation turns)
const roleArb = fc.constantFrom<Message['role']>('user', 'assistant', 'tool');

// Arbitrary: a single message
const messageArb = fc.record({
  role: roleArb,
  content: textArb,
  timestamp: fc.integer({ min: 1_000_000, max: 9_999_999 }),
});

// ─── Property 13: 对话历史完整性不变量 ───────────────────────────────────────
// Feature: nodejs-claude-code, Property 13: 对话历史完整性不变量
// For any sequence of messages added in order, getMessages() should return
// all added messages in the original order.
// Validates: Requirements 4.3

describe('Property 13: 对话历史完整性不变量', () => {
  it('getMessages returns all added messages in insertion order', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 20 }),
        (msgs) => {
          const manager = makeManager();
          for (const msg of msgs) {
            manager.addMessage(msg);
          }

          const result = manager.getMessages();

          // Same length
          expect(result).toHaveLength(msgs.length);

          // Same order and content
          for (let i = 0; i < msgs.length; i++) {
            expect(result[i]!.role).toBe(msgs[i]!.role);
            expect(result[i]!.content).toBe(msgs[i]!.content);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getMessages returns a copy — mutations do not affect internal state', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        (msgs) => {
          const manager = makeManager();
          for (const msg of msgs) {
            manager.addMessage(msg);
          }

          const result = manager.getMessages();
          // Mutate the returned array
          result.push(makeMessage('user', 'injected'));

          // Internal state should be unchanged
          expect(manager.getMessages()).toHaveLength(msgs.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('clear resets message list to empty', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        (msgs) => {
          const manager = makeManager();
          for (const msg of msgs) {
            manager.addMessage(msg);
          }
          expect(manager.getMessages().length).toBeGreaterThan(0);

          manager.clear();
          expect(manager.getMessages()).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getTokenCount increases as messages are added', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ role: roleArb, content: textArb, timestamp: fc.constant(1) }),
          { minLength: 2, maxLength: 10 },
        ),
        (msgs) => {
          const manager = makeManager();
          let prevCount = manager.getTokenCount();

          for (const msg of msgs) {
            manager.addMessage(msg);
            const newCount = manager.getTokenCount();
            expect(newCount).toBeGreaterThanOrEqual(prevCount);
            prevCount = newCount;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 22: 结构化摘要保留关键实体 ─────────────────────────────────────
// Feature: nodejs-claude-code, Property 22: 结构化摘要保留关键实体
// Structured summary should preserve key entities (file paths, function
// signatures, error messages, user-confirmed operation decisions).
// Validates: Requirements 4.13

describe('Property 22: 结构化摘要保留关键实体', () => {
  it('summary keyEntities includes file paths mentioned in messages', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,10}$/),
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{1,10}$/),
        fc.constantFrom('ts', 'js', 'json'),
        (dir, file, ext) => {
          const manager = makeManager();
          const filePath = `${dir}/${file}.${ext}`;
          const msgs: Message[] = [
            makeMessage('user', `Please look at ${filePath}`),
            makeMessage('assistant', `I will read ${filePath} now`),
          ];

          const summary = manager.generateStructuredSummary(msgs);

          // At least one keyEntity should reference the file
          const hasFile = summary.keyEntities.some((e) =>
            e.includes(file) && e.includes(ext),
          );
          expect(hasFile).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary errors includes content from error tool results', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z][A-Z_]{2,10}$/),
        (errSuffix) => {
          const manager = makeManager();
          const errorMsg = `ERR_${errSuffix}: operation failed`;
          const msgs: Message[] = [
            makeMessage('tool', errorMsg, { name: 'file_read' }),
          ];

          const summary = manager.generateStructuredSummary(msgs);

          // Error content should appear in errors array
          expect(summary.errors.length).toBeGreaterThan(0);
          expect(summary.errors.some((e) => e.includes(errorMsg))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary decisions includes user confirmation messages', () => {
    const confirmations = ['yes', 'confirm', 'ok', 'proceed', 'go ahead'];
    fc.assert(
      fc.property(
        fc.constantFrom(...confirmations),
        (confirmation) => {
          const manager = makeManager();
          const msgs: Message[] = [
            makeMessage('user', confirmation),
          ];

          const summary = manager.generateStructuredSummary(msgs);

          expect(summary.decisions.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary operationHistory includes assistant tool call summaries', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z_]{2,15}$/),
        (toolName) => {
          const manager = makeManager();
          const msgs: Message[] = [
            makeMessage('assistant', '', {
              toolCalls: [{ id: 'tc1', name: toolName, arguments: {} }],
            }),
          ];

          const summary = manager.generateStructuredSummary(msgs);

          expect(summary.operationHistory.length).toBeGreaterThan(0);
          expect(summary.operationHistory.some((op) => op.includes(toolName))).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary has the four required fields', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 0, maxLength: 5 }),
        (msgs) => {
          const manager = makeManager();
          const summary = manager.generateStructuredSummary(msgs);

          expect(Array.isArray(summary.keyEntities)).toBe(true);
          expect(Array.isArray(summary.decisions)).toBe(true);
          expect(Array.isArray(summary.errors)).toBe(true);
          expect(Array.isArray(summary.operationHistory)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 23: 高低水位线压缩保证 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 23: 高低水位线压缩保证
// When token count reaches high watermark, compression should reduce token
// count to below low watermark, and the most recent complete conversation
// turns should be preserved.
// Validates: Requirements 4.14

describe('Property 23: 高低水位线压缩保证', () => {
  it('after compression token count is at or below lowWaterMark', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 400 }),
        fc.integer({ min: 50, max: 150 }),
        async (highWaterMark, gap) => {
          const lowWaterMark = highWaterMark - gap;
          fc.pre(lowWaterMark > 0);
          // Ensure lowWaterMark is large enough to hold summary + last message
          // Each message is 100 chars = 25 tokens; summary is ~30 tokens
          // So lowWaterMark must be > 55 to guarantee compression is possible
          fc.pre(lowWaterMark > 60);

          const manager = makeManager({ highWaterMark, lowWaterMark });

          // Add enough messages to exceed the high watermark
          // Each message ~25 tokens (100 chars / 4)
          const msgContent = 'x'.repeat(100);
          const numMessages = Math.ceil((highWaterMark * 4) / 100) + 5;

          for (let i = 0; i < numMessages; i++) {
            manager.addMessage(makeMessage(i % 2 === 0 ? 'user' : 'assistant', msgContent));
          }

          // Verify we're above the high watermark
          expect(manager.getTokenCount()).toBeGreaterThanOrEqual(highWaterMark);

          await manager.compressIfNeeded();

          // After compression, token count should be at or below lowWaterMark
          expect(manager.getTokenCount()).toBeLessThanOrEqual(lowWaterMark);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('compressIfNeeded does nothing when below highWaterMark', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 500, max: 1000 }),
        async (highWaterMark) => {
          const manager = makeManager({ highWaterMark, lowWaterMark: 200 });

          // Add a small number of messages (well below high watermark)
          manager.addMessage(makeMessage('user', 'hello'));
          manager.addMessage(makeMessage('assistant', 'hi there'));

          const countBefore = manager.getTokenCount();
          expect(countBefore).toBeLessThan(highWaterMark);

          await manager.compressIfNeeded();

          // Messages should be unchanged
          expect(manager.getTokenCount()).toBe(countBefore);
          expect(manager.getMessages()).toHaveLength(2);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('most recent user message is preserved after compression', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ]{5,30}$/),
        async (lastUserContent) => {
          const highWaterMark = 100;
          const lowWaterMark = 50;
          const manager = makeManager({ highWaterMark, lowWaterMark });

          // Fill with old messages to exceed high watermark
          const filler = 'x'.repeat(80);
          for (let i = 0; i < 8; i++) {
            manager.addMessage(makeMessage(i % 2 === 0 ? 'user' : 'assistant', filler));
          }

          // Add the most recent turn
          manager.addMessage(makeMessage('user', lastUserContent));
          manager.addMessage(makeMessage('assistant', 'response to last'));

          expect(manager.getTokenCount()).toBeGreaterThanOrEqual(highWaterMark);

          await manager.compressIfNeeded();

          const remaining = manager.getMessages();
          const hasLastUser = remaining.some(
            (m) => m.role === 'user' && m.content === lastUserContent,
          );
          expect(hasLastUser).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('compressed history still contains a system summary message', async () => {
    const highWaterMark = 100;
    const lowWaterMark = 50;
    const manager = makeManager({ highWaterMark, lowWaterMark });

    const filler = 'x'.repeat(80);
    for (let i = 0; i < 8; i++) {
      manager.addMessage(makeMessage(i % 2 === 0 ? 'user' : 'assistant', filler));
    }

    expect(manager.getTokenCount()).toBeGreaterThanOrEqual(highWaterMark);

    await manager.compressIfNeeded();

    const remaining = manager.getMessages();
    const hasSummary = remaining.some(
      (m) => m.role === 'system' && m.content.includes('[Conversation Summary]'),
    );
    expect(hasSummary).toBe(true);
  });
});

// ─── Property 24: 差异化工具结果压缩 ─────────────────────────────────────────
// Feature: nodejs-claude-code, Property 24: 差异化工具结果压缩
// Error tool results should not be compressed; file content tool results
// can be summarised.
// Validates: Requirements 4.15

describe('Property 24: 差异化工具结果压缩', () => {
  it('error tool results are NOT marked for compression', () => {
    const errorPhrases = [
      'Error: file not found',
      'ERR_PERMISSION_DENIED: access denied',
      'Operation failed: timeout',
      'Exception: null pointer',
      'Permission denied',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...errorPhrases),
        (errorContent) => {
          const manager = makeManager();
          const msg = makeMessage('tool', errorContent, { name: 'file_read' });

          expect(manager.shouldCompressToolResult(msg)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-error file content tool results ARE marked for compression', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 \n]{20,100}$/),
        (fileContent) => {
          // Ensure content doesn't accidentally contain error keywords
          fc.pre(
            !fileContent.toLowerCase().includes('error') &&
            !fileContent.toLowerCase().includes('failed') &&
            !fileContent.toLowerCase().includes('exception') &&
            !fileContent.toLowerCase().includes('not found') &&
            !fileContent.toLowerCase().includes('denied'),
          );

          const manager = makeManager();
          const msg = makeMessage('tool', fileContent, { name: 'file_read' });

          expect(manager.shouldCompressToolResult(msg)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-tool messages always return false from shouldCompressToolResult', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Message['role']>('user', 'assistant', 'system'),
        textArb,
        (role, content) => {
          const manager = makeManager();
          const msg = makeMessage(role, content);

          expect(manager.shouldCompressToolResult(msg)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('user-confirmed operation tool results are NOT compressed', () => {
    const confirmedPhrases = [
      'Shell command executed successfully',
      'User confirmed: file deleted',
      'Approved operation completed',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...confirmedPhrases),
        (content) => {
          const manager = makeManager();
          const msg = makeMessage('tool', content, { name: 'shell_execute' });

          expect(manager.shouldCompressToolResult(msg)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
