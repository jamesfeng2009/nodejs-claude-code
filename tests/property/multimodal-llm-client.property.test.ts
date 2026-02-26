// Feature: multimodal-support
// Properties: 3, 4, 5

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { LLMClient } from '../../src/llm/client.js';
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

function makeLLMClient(): LLMClient {
  return new LLMClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com',
    model: 'claude-3-5-sonnet',
    maxTokens: 4096,
    temperature: 0,
  });
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
    { minLength: 1, maxLength: 16 }
  )
  .map((groups) => groups.join(''));

/** Valid HTTP/HTTPS URL */
const validHttpUrlArb: fc.Arbitrary<string> = fc.webUrl({
  validSchemes: ['http', 'https'],
});

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
  url: validHttpUrlArb,
});

/** Any valid ImageBlock (no mediaId — avoids needing MediaStore) */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.oneof(
  imageBlockWithDataArb,
  imageBlockWithUrlArb
);

/** FileBlock with data */
const fileBlockWithDataArb: fc.Arbitrary<FileBlock> = fc.record({
  type: fc.constant('file' as const),
  mimeType: supportedFileMimeArb,
  data: validBase64Arb,
});

/** Any valid FileBlock without mediaId */
const validFileBlockArb: fc.Arbitrary<FileBlock> = fileBlockWithDataArb;

/** Any valid ContentBlock (no mediaId) */
const validContentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  textBlockArb,
  validImageBlockArb,
  validFileBlockArb
);

/** Non-empty array of valid ContentBlocks */
const validContentBlocksArb: fc.Arbitrary<ContentBlock[]> = fc.array(
  validContentBlockArb,
  { minLength: 1, maxLength: 8 }
);

/** A Message with ContentBlock[] content */
function makeMultimodalMessage(blocks: ContentBlock[]): Message {
  return {
    role: 'user',
    content: blocks,
    timestamp: Date.now(),
  };
}

/** A Message with plain string content */
function makeTextMessage(text: string, role: 'user' | 'assistant' | 'system' = 'user'): Message {
  return {
    role,
    content: text,
    timestamp: Date.now(),
  };
}

// ─── Property 3: ContentBlock converts to Claude API format ──────────────────
// Feature: multimodal-support, Property 3: ContentBlock 转换为 Claude API 格式
// For any valid ContentBlock array, convertMessages() converts each block:
//   ImageBlock  → Claude `image` type
//   FileBlock   → Claude `document` type
//   TextBlock   → string content (text type)
// source.type matches original data/url source.
// Validates: Requirements 2.1, 2.2, 2.3

describe('Property 3: ContentBlock 转换为 Claude API 格式', () => {
  it('ImageBlock with data converts to Claude image block with base64 source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(imageBlockWithDataArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        expect(result).toHaveLength(1);
        const content = result[0].content;
        expect(Array.isArray(content)).toBe(true);
        const claudeBlocks = content as Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }>;
        expect(claudeBlocks).toHaveLength(1);

        const claudeBlock = claudeBlocks[0];
        expect(claudeBlock.type).toBe('image');
        expect(claudeBlock.source?.type).toBe('base64');
        expect(claudeBlock.source?.media_type).toBe(block.mimeType);
        expect(claudeBlock.source?.data).toBe(block.data);
      }),
      { numRuns: 100 }
    );
  });

  it('ImageBlock with url converts to Claude image block with url source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(imageBlockWithUrlArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{ type: string; source?: { type: string; url?: string } }>;
        const claudeBlock = content[0];
        expect(claudeBlock.type).toBe('image');
        expect(claudeBlock.source?.type).toBe('url');
        expect(claudeBlock.source?.url).toBe(block.url);
      }),
      { numRuns: 100 }
    );
  });

  it('FileBlock with data converts to Claude document block with base64 source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(fileBlockWithDataArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }>;
        const claudeBlock = content[0];
        expect(claudeBlock.type).toBe('document');
        expect(claudeBlock.source?.type).toBe('base64');
        expect(claudeBlock.source?.media_type).toBe(block.mimeType);
        expect(claudeBlock.source?.data).toBe(block.data);
      }),
      { numRuns: 100 }
    );
  });

  it('TextBlock converts to Claude text block', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(textBlockArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{ type: string; text?: string }>;
        const claudeBlock = content[0];
        expect(claudeBlock.type).toBe('text');
        expect(claudeBlock.text).toBe(block.text);
      }),
      { numRuns: 100 }
    );
  });

  it('mixed ContentBlock array converts each block to correct Claude type', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const messages = [makeMultimodalMessage(blocks)];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{ type: string; source?: { type: string }; text?: string }>;
        expect(content).toHaveLength(blocks.length);

        for (let i = 0; i < blocks.length; i++) {
          const original = blocks[i];
          const converted = content[i];

          if (original.type === 'image') {
            expect(converted.type).toBe('image');
            const src = converted.source!;
            if (original.data) {
              expect(src.type).toBe('base64');
            } else if (original.url) {
              expect(src.type).toBe('url');
            }
          } else if (original.type === 'file') {
            expect(converted.type).toBe('document');
            expect(converted.source?.type).toBe('base64');
          } else {
            expect(converted.type).toBe('text');
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 4: Plain text message conversion behavior unchanged ─────────────
// Feature: multimodal-support, Property 4: 纯文本消息转换行为不变
// For any Message with string content, convertMessages() output is identical
// to pre-multimodal behavior (content stays as a plain string).
// Validates: Requirements 2.4

describe('Property 4: 纯文本消息转换行为不变', () => {
  it('string content messages are passed through unchanged', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(fc.string(), async (text) => {
        const message = makeTextMessage(text);
        const result = await client.convertMessages([message]);

        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe(text);
      }),
      { numRuns: 100 }
    );
  });

  it('multiple string content messages preserve order and content', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.string(),
            fc.constantFrom('user', 'assistant', 'system') as fc.Arbitrary<'user' | 'assistant' | 'system'>
          ),
          { minLength: 1, maxLength: 6 }
        ),
        async (pairs) => {
          const messages = pairs.map(([text, role]) => makeTextMessage(text, role));
          const result = await client.convertMessages(messages);

          expect(result).toHaveLength(messages.length);
          for (let i = 0; i < messages.length; i++) {
            expect(result[i].content).toBe(messages[i].content);
            expect(result[i].role).toBe(messages[i].role);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 5: LLMClient conversion round-trip semantic equivalence ─────────
// Feature: multimodal-support, Property 5: LLMClient 转换往返语义等价
// For any valid multimodal Message (no mediaId), converting to Claude API format
// preserves type, mimeType, and data source semantics.
// Validates: Requirements 2.6

describe('Property 5: LLMClient 转换往返语义等价', () => {
  it('round-trip preserves ImageBlock type and mimeType for data source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(imageBlockWithDataArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{
          type: string;
          source: { type: string; media_type: string; data: string };
        }>;
        const converted = content[0];

        // Type preserved: image → image
        expect(converted.type).toBe('image');
        // mimeType preserved via media_type
        expect(converted.source.media_type).toBe(block.mimeType);
        // data preserved exactly
        expect(converted.source.data).toBe(block.data);
        // source type is base64
        expect(converted.source.type).toBe('base64');
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip preserves ImageBlock type and url for url source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(imageBlockWithUrlArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{
          type: string;
          source: { type: string; url: string };
        }>;
        const converted = content[0];

        expect(converted.type).toBe('image');
        expect(converted.source.type).toBe('url');
        expect(converted.source.url).toBe(block.url);
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip preserves FileBlock type and mimeType for data source', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(fileBlockWithDataArb, async (block) => {
        const messages = [makeMultimodalMessage([block])];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{
          type: string;
          source: { type: string; media_type: string; data: string };
        }>;
        const converted = content[0];

        // FileBlock → document type
        expect(converted.type).toBe('document');
        expect(converted.source.media_type).toBe(block.mimeType);
        expect(converted.source.data).toBe(block.data);
        expect(converted.source.type).toBe('base64');
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip preserves all blocks in a mixed multimodal message', async () => {
    const client = makeLLMClient();
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const messages = [makeMultimodalMessage(blocks)];
        const result = await client.convertMessages(messages);

        const content = result[0].content as Array<{
          type: string;
          text?: string;
          source?: { type: string; media_type?: string; data?: string; url?: string };
        }>;

        // Same number of blocks
        expect(content).toHaveLength(blocks.length);

        for (let i = 0; i < blocks.length; i++) {
          const original = blocks[i];
          const converted = content[i];

          if (original.type === 'text') {
            expect(converted.type).toBe('text');
            expect(converted.text).toBe(original.text);
          } else if (original.type === 'image') {
            expect(converted.type).toBe('image');
            if (original.data) {
              expect(converted.source?.type).toBe('base64');
              expect(converted.source?.media_type).toBe(original.mimeType);
              expect(converted.source?.data).toBe(original.data);
            } else if (original.url) {
              expect(converted.source?.type).toBe('url');
              expect(converted.source?.url).toBe(original.url);
            }
          } else if (original.type === 'file') {
            expect(converted.type).toBe('document');
            expect(converted.source?.type).toBe('base64');
            expect(converted.source?.media_type).toBe(original.mimeType);
            expect(converted.source?.data).toBe(original.data);
          }
        }
      }),
      { numRuns: 500 }
    );
  });
});
