// Feature: multimodal-support
// Properties: 9, 10, 11, 12, 22

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ConversationManager } from '../../src/conversation/manager.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type {
  Message,
  ContentBlock,
  ImageBlock,
  FileBlock,
  TextBlock,
  SupportedImageMimeType,
  SupportedFileMimeType,
} from '../../src/types/messages.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_MIME_TYPES: SupportedImageMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

const SUPPORTED_FILE_MIME_TYPES: SupportedFileMimeType[] = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
];

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeManager(): ConversationManager {
  return new ConversationManager(
    { highWaterMark: 100_000, lowWaterMark: 50_000, maxContextTokens: 200_000 },
    new KeyEntityCache(),
  );
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Valid base64 string (length multiple of 4, valid chars) */
const validBase64Arb: fc.Arbitrary<string> = fc
  .array(
    fc
      .tuple(
        fc.constantFrom(...BASE64_CHARS.split('')),
        fc.constantFrom(...BASE64_CHARS.split('')),
        fc.constantFrom(...BASE64_CHARS.split('')),
        fc.constantFrom(...BASE64_CHARS.split(''))
      )
      .map(([a, b, c, d]) => a + b + c + d),
    { minLength: 1, maxLength: 32 }
  )
  .map((groups) => groups.join(''));

const supportedImageMimeArb = fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES);
const supportedFileMimeArb = fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES);

/** ImageBlock with data */
const imageBlockWithDataArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: supportedImageMimeArb,
  data: validBase64Arb,
});

/** ImageBlock with url */
const imageBlockWithUrlArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: supportedImageMimeArb,
  url: fc.webUrl({ validSchemes: ['http', 'https'] }),
});

/** Any valid ImageBlock */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.oneof(
  imageBlockWithDataArb,
  imageBlockWithUrlArb,
);

/** FileBlock with data and optional filename */
const fileBlockWithDataArb: fc.Arbitrary<FileBlock> = fc
  .record({
    type: fc.constant('file' as const),
    mimeType: supportedFileMimeArb,
    data: validBase64Arb,
    filename: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  })
  .map(({ filename, ...rest }) =>
    filename !== undefined ? { ...rest, filename } : rest
  );

/** TextBlock */
const textBlockArb: fc.Arbitrary<TextBlock> = fc.record({
  type: fc.constant('text' as const),
  text: fc.string(),
});

/** Any valid ContentBlock */
const validContentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  textBlockArb,
  validImageBlockArb,
  fileBlockWithDataArb,
);

/** Non-empty array of valid ContentBlocks */
const validContentBlocksArb: fc.Arbitrary<ContentBlock[]> = fc.array(
  validContentBlockArb,
  { minLength: 1, maxLength: 8 },
);

/** Build a Message with ContentBlock[] content */
function makeMessage(
  role: Message['role'],
  content: string | ContentBlock[],
  extra?: Partial<Message>,
): Message {
  return { role, content, timestamp: Date.now(), ...extra };
}

// ─── Property 9: ImageBlock token estimation formula ─────────────────────────
// Feature: multimodal-support, Property 9: ImageBlock token 估算公式
// For any ImageBlock with `data`, token estimate = Math.ceil(data.length / 4).
// For any ImageBlock with `url`, token estimate = 20.
// Validates: Requirements 5.1

describe('Property 9: ImageBlock token 估算公式', () => {
  it('ImageBlock with data: token estimate = Math.ceil(data.length / 4)', () => {
    fc.assert(
      fc.property(imageBlockWithDataArb, (block) => {
        const manager = makeManager();
        manager.addMessage(makeMessage('user', [block]));
        const tokens = manager.getTokenCount();
        const expected = Math.ceil(block.data!.length / 4);
        expect(tokens).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('ImageBlock with url: token estimate = 20', () => {
    fc.assert(
      fc.property(imageBlockWithUrlArb, (block) => {
        const manager = makeManager();
        manager.addMessage(makeMessage('user', [block]));
        const tokens = manager.getTokenCount();
        // url → 80 chars → Math.ceil(80/4) = 20
        expect(tokens).toBe(20);
      }),
      { numRuns: 100 },
    );
  });

  it('message with only ImageBlocks: total tokens = sum of individual estimates', () => {
    fc.assert(
      fc.property(
        fc.array(validImageBlockArb, { minLength: 1, maxLength: 6 }),
        (blocks) => {
          const manager = makeManager();
          manager.addMessage(makeMessage('user', blocks));
          const tokens = manager.getTokenCount();

          const expected = Math.ceil(
            blocks.reduce((sum, b) => {
              if (b.data) return sum + b.data.length;
              if (b.url) return sum + 80; // 20 tokens * 4
              return sum;
            }, 0) / 4,
          );
          expect(tokens).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 10: Compression replaces multimodal content with placeholders ──
// Feature: multimodal-support, Property 10: 压缩时多模态内容替换为占位符
// For any tool result message containing ImageBlock or FileBlock, after
// compression, ImageBlock is replaced with `[图片已压缩: {mimeType}]` and
// FileBlock with `[文件已压缩: {filename ?? mimeType}]`.
// Validates: Requirements 5.2, 5.3

describe('Property 10: 压缩时多模态内容替换为占位符', () => {
  it('ImageBlock in tool result is replaced with placeholder after compression', async () => {
    await fc.assert(
      fc.asyncProperty(imageBlockWithDataArb, async (block) => {
        // Use a large lowWaterMark so the sliding window keeps all messages,
        // but a tiny highWaterMark to force compression to trigger.
        const manager = new ConversationManager(
          { highWaterMark: 1, lowWaterMark: 500_000, maxContextTokens: 1_000_000 },
          new KeyEntityCache(),
        );
        // Add a user message to anchor the conversation
        manager.addMessage(makeMessage('user', 'trigger compression'));
        // Add a tool result with an ImageBlock
        manager.addMessage(makeMessage('tool', [block], { name: 'some_tool' }));

        await manager.compressIfNeeded();

        const messages = manager.getMessages();
        // After compression, the tool result content should be a string with the placeholder
        const hasPlaceholder = messages.some((m) => {
          if (typeof m.content === 'string') {
            return m.content.includes(`[图片已压缩: ${block.mimeType}]`);
          }
          return false;
        });
        expect(hasPlaceholder).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('FileBlock in tool result is replaced with placeholder after compression', async () => {
    await fc.assert(
      fc.asyncProperty(fileBlockWithDataArb, async (block) => {
        const manager = new ConversationManager(
          { highWaterMark: 1, lowWaterMark: 500_000, maxContextTokens: 1_000_000 },
          new KeyEntityCache(),
        );
        manager.addMessage(makeMessage('user', 'trigger compression'));
        manager.addMessage(makeMessage('tool', [block], { name: 'some_tool' }));

        await manager.compressIfNeeded();

        const messages = manager.getMessages();
        const expectedPlaceholder = `[文件已压缩: ${block.filename ?? block.mimeType}]`;
        const hasPlaceholder = messages.some((m) => {
          if (typeof m.content === 'string') {
            return m.content.includes(expectedPlaceholder);
          }
          return false;
        });
        expect(hasPlaceholder).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('shouldCompressToolResult returns true for tool messages with multimodal content', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(validImageBlockArb, { minLength: 1, maxLength: 4 }),
          fc.array(fileBlockWithDataArb, { minLength: 1, maxLength: 4 }),
        ) as fc.Arbitrary<ContentBlock[]>,
        (blocks) => {
          const manager = makeManager();
          const msg = makeMessage('tool', blocks, { name: 'tool' });
          expect(manager.shouldCompressToolResult(msg)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 11: User messages' multimodal content is not compressed ─────────
// Feature: multimodal-support, Property 11: 用户消息中的多模态内容不被压缩
// For any user message containing ContentBlock arrays, regardless of how many
// compressions occur, the message's `content` field remains unchanged.
// Validates: Requirements 5.4

describe('Property 11: 用户消息中的多模态内容不被压缩', () => {
  it('user message ContentBlock[] content is preserved after compression', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const manager = new ConversationManager(
          { highWaterMark: 1, lowWaterMark: 1, maxContextTokens: 200_000 },
          new KeyEntityCache(),
        );
        // Add the user message with multimodal content
        manager.addMessage(makeMessage('user', blocks));
        // Add a tool result to give the compressor something to work with
        manager.addMessage(
          makeMessage('tool', 'some tool output that is long enough to compress', { name: 'tool' }),
        );

        await manager.compressIfNeeded();

        const messages = manager.getMessages();
        // The user message's content must still be the original ContentBlock array
        const userMessages = messages.filter((m) => m.role === 'user');
        const hasOriginalContent = userMessages.some((m) => {
          if (!Array.isArray(m.content)) return false;
          if (m.content.length !== blocks.length) return false;
          return m.content.every((b, i) => {
            const orig = blocks[i]!;
            return JSON.stringify(b) === JSON.stringify(orig);
          });
        });
        expect(hasOriginalContent).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('shouldCompressToolResult returns false for user messages', () => {
    fc.assert(
      fc.property(validContentBlocksArb, (blocks) => {
        const manager = makeManager();
        const msg = makeMessage('user', blocks);
        expect(manager.shouldCompressToolResult(msg)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 12: Structured summary records multimodal content ───────────────
// Feature: multimodal-support, Property 12: 结构化摘要记录多模态内容
// For any message list containing ImageBlock or FileBlock,
// generateStructuredSummary() returns keyEntities containing entries in format
// `image:{mimeType}` or `file:{filename ?? mimeType}`.
// Validates: Requirements 5.5

describe('Property 12: 结构化摘要记录多模态内容', () => {
  it('ImageBlock in message produces image:{mimeType} in keyEntities', () => {
    fc.assert(
      fc.property(validImageBlockArb, (block) => {
        const manager = makeManager();
        const messages: Message[] = [makeMessage('user', [block])];
        const summary = manager.generateStructuredSummary(messages);
        expect(summary.keyEntities).toContain(`image:${block.mimeType}`);
      }),
      { numRuns: 100 },
    );
  });

  it('FileBlock with filename produces file:{filename} in keyEntities', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant('file' as const),
          mimeType: supportedFileMimeArb,
          data: validBase64Arb,
          filename: fc.string({ minLength: 1, maxLength: 40 }),
        }),
        (block: FileBlock) => {
          const manager = makeManager();
          const messages: Message[] = [makeMessage('user', [block])];
          const summary = manager.generateStructuredSummary(messages);
          expect(summary.keyEntities).toContain(`file:${block.filename}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('FileBlock without filename produces file:{mimeType} in keyEntities', () => {
    fc.assert(
      fc.property(
        fc.record({
          type: fc.constant('file' as const),
          mimeType: supportedFileMimeArb,
          data: validBase64Arb,
        }),
        (block: FileBlock) => {
          const manager = makeManager();
          const messages: Message[] = [makeMessage('user', [block])];
          const summary = manager.generateStructuredSummary(messages);
          expect(summary.keyEntities).toContain(`file:${block.mimeType}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('mixed ContentBlock array: all ImageBlocks and FileBlocks appear in keyEntities', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(validImageBlockArb, fileBlockWithDataArb) as fc.Arbitrary<ImageBlock | FileBlock>,
          { minLength: 1, maxLength: 6 },
        ),
        (blocks) => {
          const manager = makeManager();
          const messages: Message[] = [makeMessage('user', blocks)];
          const summary = manager.generateStructuredSummary(messages);

          for (const block of blocks) {
            if (block.type === 'image') {
              expect(summary.keyEntities).toContain(`image:${block.mimeType}`);
            } else {
              const key = `file:${(block as FileBlock).filename ?? block.mimeType}`;
              expect(summary.keyEntities).toContain(key);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 22: ConversationManager correctly handles ContentBlock arrays ───
// Feature: multimodal-support, Property 22: ConversationManager 正确处理 ContentBlock 数组
// For any Message with ContentBlock[] content, estimateTokens(), generateStructuredSummary(),
// and shouldCompressToolResult() execute without throwing, and results are consistent
// with processing each ContentBlock individually.
// Validates: Requirements 9.4

describe('Property 22: ConversationManager 正确处理 ContentBlock 数组', () => {
  it('getTokenCount() does not throw for any ContentBlock[] message', () => {
    fc.assert(
      fc.property(
        validContentBlocksArb,
        fc.constantFrom('user', 'assistant', 'tool', 'system') as fc.Arbitrary<Message['role']>,
        (blocks, role) => {
          const manager = makeManager();
          manager.addMessage(makeMessage(role, blocks));
          expect(() => manager.getTokenCount()).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('generateStructuredSummary() does not throw for any ContentBlock[] message', () => {
    fc.assert(
      fc.property(
        validContentBlocksArb,
        fc.constantFrom('user', 'assistant', 'tool', 'system') as fc.Arbitrary<Message['role']>,
        (blocks, role) => {
          const manager = makeManager();
          const messages: Message[] = [makeMessage(role, blocks)];
          expect(() => manager.generateStructuredSummary(messages)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('shouldCompressToolResult() does not throw for any ContentBlock[] message', () => {
    fc.assert(
      fc.property(
        validContentBlocksArb,
        fc.constantFrom('user', 'assistant', 'tool', 'system') as fc.Arbitrary<Message['role']>,
        (blocks, role) => {
          const manager = makeManager();
          const msg = makeMessage(role, blocks);
          expect(() => manager.shouldCompressToolResult(msg)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getTokenCount() result is consistent with per-block estimation', () => {
    fc.assert(
      fc.property(validContentBlocksArb, (blocks) => {
        const manager = makeManager();
        manager.addMessage(makeMessage('user', blocks));
        const total = manager.getTokenCount();

        // Compute expected: sum of per-block char counts, divided by 4
        let chars = 0;
        for (const block of blocks) {
          if (block.type === 'text') {
            chars += block.text.length;
          } else if (block.type === 'image' || block.type === 'file') {
            if (block.data) {
              chars += block.data.length;
            } else if (block.url) {
              chars += 80; // 20 tokens * 4 chars/token
            }
          }
        }
        const expected = Math.ceil(chars / 4);
        expect(total).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('generateStructuredSummary() keyEntities includes all multimodal blocks', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(validImageBlockArb, fileBlockWithDataArb) as fc.Arbitrary<ImageBlock | FileBlock>,
          { minLength: 1, maxLength: 6 },
        ),
        (blocks) => {
          const manager = makeManager();
          const messages: Message[] = [makeMessage('user', blocks)];
          const summary = manager.generateStructuredSummary(messages);

          // Every image/file block should appear in keyEntities
          for (const block of blocks) {
            if (block.type === 'image') {
              expect(summary.keyEntities).toContain(`image:${block.mimeType}`);
            } else {
              const key = `file:${(block as FileBlock).filename ?? block.mimeType}`;
              expect(summary.keyEntities).toContain(key);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('shouldCompressToolResult() returns false for non-tool roles regardless of content', () => {
    fc.assert(
      fc.property(
        validContentBlocksArb,
        fc.constantFrom('user', 'assistant', 'system') as fc.Arbitrary<Message['role']>,
        (blocks, role) => {
          const manager = makeManager();
          const msg = makeMessage(role, blocks);
          expect(manager.shouldCompressToolResult(msg)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
