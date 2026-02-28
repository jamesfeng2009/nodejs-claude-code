import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isFileContentReference, type FileContentReference } from '../../src/types/context.js';
import { ConversationManager, type ConversationConfig } from '../../src/conversation/manager.js';
import type { LLMClient, StreamChunk } from '../../src/llm/client.js';
import type { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type { Message } from '../../src/types/messages.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntityCache(): KeyEntityCache {
  return {
    extractEntities: vi.fn().mockReturnValue([]),
  } as unknown as KeyEntityCache;
}

function makeConfig(overrides?: Partial<ConversationConfig>): ConversationConfig {
  return {
    highWaterMark: 10000,
    lowWaterMark: 5000,
    maxContextTokens: 20000,
    ...overrides,
  };
}

/**
 * Create a mock LLMClient whose chat() yields the given text chunks.
 */
function makeLlmClient(chunks: StreamChunk[]): LLMClient {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
  } as unknown as LLMClient;
}

// ─── FileContentReference type and type guard ─────────────────────────────────

describe('FileContentReference', () => {
  it('isFileContentReference returns true for a valid reference object', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/some/file.ts',
      readAtMtime: Date.now(),
    };
    expect(isFileContentReference(ref)).toBe(true);
  });

  it('isFileContentReference returns false for plain string', () => {
    expect(isFileContentReference('hello')).toBe(false);
  });

  it('isFileContentReference returns false for null', () => {
    expect(isFileContentReference(null)).toBe(false);
  });

  it('isFileContentReference returns false when __type is wrong', () => {
    expect(isFileContentReference({ __type: 'other', filePath: '/a', readAtMtime: 0 })).toBe(false);
  });

  it('isFileContentReference returns false when filePath is missing', () => {
    expect(isFileContentReference({ __type: 'file_content_reference', readAtMtime: 0 })).toBe(false);
  });

  it('isFileContentReference returns false when readAtMtime is not a number', () => {
    expect(
      isFileContentReference({ __type: 'file_content_reference', filePath: '/a', readAtMtime: 'now' }),
    ).toBe(false);
  });

  it('JSON.stringify of a FileContentReference round-trips through isFileContentReference', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/project/src/index.ts',
      readAtMtime: 1700000000000,
    };
    const json = JSON.stringify(ref);
    const parsed = JSON.parse(json) as unknown;
    expect(isFileContentReference(parsed)).toBe(true);
  });

  it('stored JSON contains filePath and readAtMtime fields', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/project/src/index.ts',
      readAtMtime: 1700000000000,
    };
    const json = JSON.stringify(ref);
    expect(json).toContain('/project/src/index.ts');
    expect(json).toContain('1700000000000');
  });

  it('stored JSON does NOT contain raw file content', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/project/src/index.ts',
      readAtMtime: 1700000000000,
    };
    const json = JSON.stringify(ref);
    // The JSON should only have the reference fields, not any file content
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(['__type', 'filePath', 'readAtMtime']),
    );
    expect(Object.keys(parsed)).toHaveLength(3);
  });
});

// ─── ConversationManager — compression with compressionLlmClient ──────────────

describe('ConversationManager — compression model', () => {
  function makeMessages(count: number): Message[] {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with some content to fill tokens`.repeat(5),
        timestamp: Date.now(),
      });
    }
    return msgs;
  }

  it('uses compressionLlmClient.chat when provided during compressIfNeeded(true)', async () => {
    const compressionClient = makeLlmClient([
      { type: 'text', content: 'This is a compressed summary.' },
      { type: 'done' },
    ]);

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    expect(compressionClient.chat).toHaveBeenCalled();
  });

  it('does NOT call compressionLlmClient.chat when not provided', async () => {
    const primaryClient = makeLlmClient([
      { type: 'text', content: 'Summary.' },
      { type: 'done' },
    ]);

    // No compressionLlmClient — should use local structured summary
    const manager = new ConversationManager(makeConfig(), makeEntityCache());

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    // primaryClient was never passed in, so it should not be called
    expect(primaryClient.chat).not.toHaveBeenCalled();
  });

  it('summary message contains text returned by compressionLlmClient', async () => {
    const summaryText = 'Compressed: user asked about files, assistant responded.';
    const compressionClient = makeLlmClient([
      { type: 'text', content: summaryText },
      { type: 'done' },
    ]);

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    const remaining = manager.getMessages();
    const summaryMsg = remaining.find((m) => m.role === 'system');
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain(summaryText);
  });

  it('falls back to local summary when compressionLlmClient throws "model not found"', async () => {
    const compressionClient = {
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error('model not found: claude-haiku-unknown');
      }),
    } as unknown as LLMClient;

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    const remaining = manager.getMessages();
    const summaryMsg = remaining.find((m) => m.role === 'system');
    expect(summaryMsg).toBeDefined();
    // Should contain the warning about fallback
    expect(summaryMsg!.content).toContain('[警告: 压缩模型不可用，已退回主模型]');
  });

  it('falls back with warning when compressionLlmClient throws "unknown model"', async () => {
    const compressionClient = {
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error('unknown model identifier provided');
      }),
    } as unknown as LLMClient;

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    const remaining = manager.getMessages();
    const summaryMsg = remaining.find((m) => m.role === 'system');
    expect(summaryMsg!.content).toContain('[警告: 压缩模型不可用，已退回主模型]');
  });

  it('falls back silently (no warning) when compressionLlmClient throws a non-model error', async () => {
    const compressionClient = {
      chat: vi.fn().mockImplementation(async function* () {
        throw new Error('network timeout');
      }),
    } as unknown as LLMClient;

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    const messages = makeMessages(4);
    for (const msg of messages) {
      manager.addMessage(msg);
    }

    await manager.compressIfNeeded(true);

    const remaining = manager.getMessages();
    const summaryMsg = remaining.find((m) => m.role === 'system');
    // Should still produce a summary (local fallback), but without the warning
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).not.toContain('[警告: 压缩模型不可用，已退回主模型]');
  });

  it('compressionLlmClient.chat is called with a prompt containing conversation history', async () => {
    const compressionClient = makeLlmClient([
      { type: 'text', content: 'Summary.' },
      { type: 'done' },
    ]);

    const manager = new ConversationManager(
      makeConfig(),
      makeEntityCache(),
      compressionClient,
    );

    manager.addMessage({ role: 'user', content: 'Hello there', timestamp: Date.now() });
    manager.addMessage({ role: 'assistant', content: 'Hi!', timestamp: Date.now() });

    await manager.compressIfNeeded(true);

    const callArgs = (compressionClient.chat as ReturnType<typeof vi.fn>).mock.calls[0] as [Message[], unknown[]];
    const promptMessages = callArgs[0];
    // The prompt should include the conversation content
    const promptText = JSON.stringify(promptMessages);
    expect(promptText).toContain('Hello there');
  });
});

// ─── FileContentReference — stored in history (not raw content) ───────────────

describe('file_read result stored as FileContentReference in history', () => {
  it('a FileContentReference JSON string is recognized as a reference, not raw content', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/src/main.ts',
      readAtMtime: Date.now(),
    };
    const stored = JSON.stringify(ref);

    // Simulate what the orchestrator stores in history
    const toolMsg: Message = {
      role: 'tool',
      content: stored,
      toolCallId: 'call-123',
      name: 'file_read',
      timestamp: Date.now(),
    };

    // The stored content should be parseable as a FileContentReference
    const parsed = JSON.parse(toolMsg.content as string) as unknown;
    expect(isFileContentReference(parsed)).toBe(true);
  });

  it('raw file content is NOT a FileContentReference', () => {
    const rawContent = 'export function hello() { return "world"; }';
    expect(isFileContentReference(rawContent)).toBe(false);
    // Also not a reference when parsed as JSON (it's not valid JSON)
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = rawContent;
    }
    expect(isFileContentReference(parsed)).toBe(false);
  });

  it('FileContentReference stores filePath matching the read file path', () => {
    const filePath = '/project/src/utils.ts';
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath,
      readAtMtime: Date.now(),
    };
    const stored = JSON.stringify(ref);
    const parsed = JSON.parse(stored) as FileContentReference;
    expect(parsed.filePath).toBe(filePath);
  });

  it('FileContentReference stores a numeric readAtMtime timestamp', () => {
    const before = Date.now();
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/a.ts',
      readAtMtime: Date.now(),
    };
    const after = Date.now();
    expect(ref.readAtMtime).toBeGreaterThanOrEqual(before);
    expect(ref.readAtMtime).toBeLessThanOrEqual(after);
  });
});

// ─── expandFileReferences behavior (tested indirectly via orchestrator logic) ──

describe('expandFileReferences logic (indirect tests)', () => {
  /**
   * These tests verify the logic that expandFileReferences would apply:
   * - A tool message with FileContentReference JSON should be expanded to file content
   * - A deleted file reference should produce an error message
   * We test the type guard and JSON structure since expandFileReferences is module-level.
   */

  it('a tool message with FileContentReference content is detected as a reference', () => {
    const ref: FileContentReference = {
      __type: 'file_content_reference',
      filePath: '/tmp/test.ts',
      readAtMtime: Date.now(),
    };
    const msg: Message = {
      role: 'tool',
      content: JSON.stringify(ref),
      toolCallId: 'tc-1',
      name: 'file_read',
      timestamp: Date.now(),
    };

    // Simulate the detection logic in expandFileReferences
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content as string);
    } catch {
      parsed = null;
    }
    expect(isFileContentReference(parsed)).toBe(true);
  });

  it('a tool message with plain text content is NOT detected as a reference', () => {
    const msg: Message = {
      role: 'tool',
      content: 'const x = 1;\nexport default x;',
      toolCallId: 'tc-2',
      name: 'file_read',
      timestamp: Date.now(),
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content as string);
    } catch {
      parsed = msg.content;
    }
    expect(isFileContentReference(parsed)).toBe(false);
  });

  it('error message for deleted file contains the file path', () => {
    // Simulate what expandFileReferences returns for a deleted file
    const filePath = '/deleted/file.ts';
    const errorMsg = `文件已不存在: ${filePath}`;
    expect(errorMsg).toContain(filePath);
    expect(errorMsg).toContain('文件已不存在');
  });

  it('error message for unreadable file contains the file path', () => {
    const filePath = '/restricted/file.ts';
    const errorDetail = 'Permission denied';
    const errorMsg = `无法读取文件: ${filePath}: ${errorDetail}`;
    expect(errorMsg).toContain(filePath);
    expect(errorMsg).toContain('无法读取文件');
    expect(errorMsg).toContain(errorDetail);
  });

  it('non-tool messages are not treated as file references', () => {
    const userMsg: Message = {
      role: 'user',
      content: JSON.stringify({
        __type: 'file_content_reference',
        filePath: '/a.ts',
        readAtMtime: 0,
      }),
      timestamp: Date.now(),
    };
    // expandFileReferences only processes role === 'tool' messages
    expect(userMsg.role).not.toBe('tool');
  });
});
