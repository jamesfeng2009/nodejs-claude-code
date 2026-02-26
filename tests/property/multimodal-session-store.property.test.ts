// Feature: multimodal-support
// Properties: 8, 23

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { SessionStore } from '../../src/session/session-store.js';
import type {
  ContentBlock,
  ImageBlock,
  FileBlock,
  TextBlock,
  SupportedImageMimeType,
  SupportedFileMimeType,
  Message,
} from '../../src/types/messages.js';
import type { Session } from '../../src/types/session.js';

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
    { minLength: 1, maxLength: 16 }
  )
  .map((groups) => groups.join(''));

const supportedImageMimeArb = fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES);
const supportedFileMimeArb = fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES);

/** TextBlock arbitrary */
const textBlockArb: fc.Arbitrary<TextBlock> = fc.record({
  type: fc.constant('text' as const),
  text: fc.string(),
});

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

/** ImageBlock with mediaId */
const imageBlockWithMediaIdArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: supportedImageMimeArb,
  mediaId: fc.hexaString({ minLength: 64, maxLength: 64 }).map((h) => `media:${h}`),
});

/** Any valid ImageBlock */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.oneof(
  imageBlockWithDataArb,
  imageBlockWithUrlArb,
  imageBlockWithMediaIdArb,
);

/** FileBlock with data */
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

/** FileBlock with mediaId */
const fileBlockWithMediaIdArb: fc.Arbitrary<FileBlock> = fc
  .record({
    type: fc.constant('file' as const),
    mimeType: supportedFileMimeArb,
    mediaId: fc.hexaString({ minLength: 64, maxLength: 64 }).map((h) => `media:${h}`),
    filename: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  })
  .map(({ filename, ...rest }) =>
    filename !== undefined ? { ...rest, filename } : rest
  );

/** Any valid ContentBlock */
const validContentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  textBlockArb,
  validImageBlockArb,
  fileBlockWithDataArb,
  fileBlockWithMediaIdArb,
);

/** Non-empty array of valid ContentBlocks */
const validContentBlocksArb: fc.Arbitrary<ContentBlock[]> = fc.array(
  validContentBlockArb,
  { minLength: 1, maxLength: 8 },
);

/** A Message with ContentBlock[] content */
const multimodalMessageArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: validContentBlocksArb,
  timestamp: fc.integer({ min: 0, max: Date.now() }),
});

/** A Message with string content */
const textMessageArb: fc.Arbitrary<Message> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: fc.string(),
  timestamp: fc.integer({ min: 0, max: Date.now() }),
});

/** Any message (string or multimodal) */
const anyMessageArb: fc.Arbitrary<Message> = fc.oneof(textMessageArb, multimodalMessageArb);

// ─── Temp directory helpers ───────────────────────────────────────────────────

function makeTempDir(): string {
  return join(tmpdir(), `test-session-store-${Date.now()}-${randomUUID()}`);
}

// ─── Property 8: Session serialization round-trip ────────────────────────────
// Feature: multimodal-support, Property 8: Session 序列化往返
// For any Session containing multimodal messages, serializing to JSON then
// deserializing should produce all Message `content` fields (including
// ContentBlock arrays) exactly equivalent to the originals.
// Validates: Requirements 4.1, 4.2, 4.3

describe('Property 8: Session 序列化往返', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('save() then load() preserves ContentBlock arrays exactly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(multimodalMessageArb, { minLength: 1, maxLength: 5 }),
        async (messages) => {
          const session = store.create();
          session.conversationHistory = messages;

          await store.save(session);
          const loaded = await store.load(session.sessionId);

          expect(loaded.conversationHistory).toHaveLength(messages.length);

          for (let i = 0; i < messages.length; i++) {
            const original = messages[i]!;
            const restored = loaded.conversationHistory[i]!;

            // content must be deeply equal
            expect(restored.content).toEqual(original.content);

            // content must still be an array (not stringified)
            expect(Array.isArray(restored.content)).toBe(true);

            const originalBlocks = original.content as ContentBlock[];
            const restoredBlocks = restored.content as ContentBlock[];

            expect(restoredBlocks).toHaveLength(originalBlocks.length);

            for (let j = 0; j < originalBlocks.length; j++) {
              expect(restoredBlocks[j]).toEqual(originalBlocks[j]);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('save() then load() preserves mixed string and ContentBlock[] messages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyMessageArb, { minLength: 1, maxLength: 6 }),
        async (messages) => {
          const session = store.create();
          session.conversationHistory = messages;

          await store.save(session);
          const loaded = await store.load(session.sessionId);

          expect(loaded.conversationHistory).toHaveLength(messages.length);

          for (let i = 0; i < messages.length; i++) {
            const original = messages[i]!;
            const restored = loaded.conversationHistory[i]!;

            expect(restored.content).toEqual(original.content);
            expect(restored.role).toBe(original.role);
            expect(restored.timestamp).toBe(original.timestamp);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('round-trip preserves block types (text/image/file) in order', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const session = store.create();
        const message: Message = {
          role: 'user',
          content: blocks,
          timestamp: Date.now(),
        };
        session.conversationHistory = [message];

        await store.save(session);
        const loaded = await store.load(session.sessionId);

        const restoredBlocks = loaded.conversationHistory[0]!.content as ContentBlock[];
        expect(restoredBlocks).toHaveLength(blocks.length);

        for (let i = 0; i < blocks.length; i++) {
          expect(restoredBlocks[i]!.type).toBe(blocks[i]!.type);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip preserves ImageBlock mimeType and data/url/mediaId fields', async () => {
    await fc.assert(
      fc.asyncProperty(validImageBlockArb, async (block) => {
        const session = store.create();
        session.conversationHistory = [
          { role: 'user', content: [block], timestamp: Date.now() },
        ];

        await store.save(session);
        const loaded = await store.load(session.sessionId);

        const restored = (loaded.conversationHistory[0]!.content as ContentBlock[])[0] as ImageBlock;
        expect(restored.type).toBe('image');
        expect(restored.mimeType).toBe(block.mimeType);
        expect(restored.data).toBe(block.data);
        expect(restored.url).toBe(block.url);
        expect(restored.mediaId).toBe(block.mediaId);
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip preserves FileBlock mimeType, data/mediaId, and optional filename', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fileBlockWithDataArb, fileBlockWithMediaIdArb),
        async (block) => {
          const session = store.create();
          session.conversationHistory = [
            { role: 'user', content: [block], timestamp: Date.now() },
          ];

          await store.save(session);
          const loaded = await store.load(session.sessionId);

          const restored = (loaded.conversationHistory[0]!.content as ContentBlock[])[0] as FileBlock;
          expect(restored.type).toBe('file');
          expect(restored.mimeType).toBe(block.mimeType);
          expect(restored.data).toBe(block.data);
          expect(restored.mediaId).toBe(block.mediaId);
          expect(restored.filename).toBe(block.filename);
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ─── Property 23: SessionStore.list() multimodal message summary ──────────────
// Feature: multimodal-support, Property 23: SessionStore.list() 多模态消息摘要
// For any Session where the last message's `content` is a ContentBlock array
// of length N, SessionStore.list() should return a SessionSummary.lastMessage
// equal to "[multimodal: N blocks]".
// Validates: Requirements 9.5

describe('Property 23: SessionStore.list() 多模态消息摘要', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('list() returns "[multimodal: N blocks]" when last message content is a ContentBlock array', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const session = store.create();
        session.conversationHistory = [
          { role: 'user', content: blocks, timestamp: Date.now() },
        ];

        await store.save(session);
        const summaries = await store.list();

        const summary = summaries.find((s) => s.sessionId === session.sessionId);
        expect(summary).toBeDefined();
        expect(summary!.lastMessage).toBe(`[multimodal: ${blocks.length} blocks]`);
      }),
      { numRuns: 100 }
    );
  });

  it('list() summary N matches the exact ContentBlock array length', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.array(validContentBlockArb, { minLength: n, maxLength: n })
          )
        ),
        async ([n, blocks]) => {
          const session = store.create();
          session.conversationHistory = [
            { role: 'user', content: blocks, timestamp: Date.now() },
          ];

          await store.save(session);
          const summaries = await store.list();

          const summary = summaries.find((s) => s.sessionId === session.sessionId);
          expect(summary).toBeDefined();
          expect(summary!.lastMessage).toBe(`[multimodal: ${n} blocks]`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('list() uses the LAST message content for the summary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(anyMessageArb, { minLength: 1, maxLength: 4 }),
        validContentBlocksArb,
        async (priorMessages, lastBlocks) => {
          const session = store.create();
          const lastMessage: Message = {
            role: 'user',
            content: lastBlocks,
            timestamp: Date.now(),
          };
          session.conversationHistory = [...priorMessages, lastMessage];

          await store.save(session);
          const summaries = await store.list();

          const summary = summaries.find((s) => s.sessionId === session.sessionId);
          expect(summary).toBeDefined();
          expect(summary!.lastMessage).toBe(`[multimodal: ${lastBlocks.length} blocks]`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('list() returns plain string content when last message is text (not multimodal)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (textContent) => {
        const session = store.create();
        session.conversationHistory = [
          { role: 'user', content: textContent, timestamp: Date.now() },
        ];

        await store.save(session);
        const summaries = await store.list();

        const summary = summaries.find((s) => s.sessionId === session.sessionId);
        expect(summary).toBeDefined();
        expect(summary!.lastMessage).toBe(textContent);
        // Must NOT be in multimodal format
        expect(summary!.lastMessage).not.toMatch(/^\[multimodal: \d+ blocks\]$/);
      }),
      { numRuns: 100 }
    );
  });

  it('list() handles multiple sessions with mixed content types correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            validContentBlocksArb.map((blocks) => ({ type: 'multimodal' as const, blocks })),
            fc.string().map((text) => ({ type: 'text' as const, text }))
          ),
          { minLength: 2, maxLength: 5 }
        ),
        async (sessionContents) => {
          const sessionIds: string[] = [];

          for (const item of sessionContents) {
            const session = store.create();
            const content = item.type === 'multimodal' ? item.blocks : item.text;
            session.conversationHistory = [
              { role: 'user', content, timestamp: Date.now() },
            ];
            await store.save(session);
            sessionIds.push(session.sessionId);
          }

          const summaries = await store.list();

          for (let i = 0; i < sessionContents.length; i++) {
            const item = sessionContents[i]!;
            const summary = summaries.find((s) => s.sessionId === sessionIds[i]);
            expect(summary).toBeDefined();

            if (item.type === 'multimodal') {
              expect(summary!.lastMessage).toBe(`[multimodal: ${item.blocks.length} blocks]`);
            } else {
              expect(summary!.lastMessage).toBe(item.text);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
