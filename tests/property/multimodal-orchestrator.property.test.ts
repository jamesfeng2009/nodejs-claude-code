// Feature: multimodal-support
// Properties: 21, 24

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { OrchestratorAgent } from '../../src/agent/orchestrator.js';
import { ConversationManager } from '../../src/conversation/manager.js';
import { LLMClient } from '../../src/llm/client.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type {
  ContentBlock,
  ImageBlock,
  FileBlock,
  TextBlock,
  SupportedImageMimeType,
  SupportedFileMimeType,
  Message,
} from '../../src/types/messages.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { ContextManager } from '../../src/context/context-manager.js';

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

/** Any valid ImageBlock (no mediaId) */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.oneof(
  imageBlockWithDataArb,
  imageBlockWithUrlArb,
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

/** Any valid ContentBlock (no mediaId) */
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConversationManager(): ConversationManager {
  return new ConversationManager(
    { highWaterMark: 100_000, lowWaterMark: 50_000, maxContextTokens: 200_000 },
    new KeyEntityCache(),
  );
}

function makeLLMClient(): LLMClient {
  return new LLMClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com',
    model: 'claude-3-5-sonnet',
    maxTokens: 4096,
    temperature: 0,
  });
}

/**
 * Create a mock ToolRegistry that returns no tools.
 */
function makeMockToolRegistry(): ToolRegistry {
  return {
    getAll: () => [],
    register: vi.fn(),
    get: vi.fn(),
    execute: vi.fn(),
    validateArgs: vi.fn(),
    toJSON: vi.fn(),
    loadFromFile: vi.fn(),
  } as unknown as ToolRegistry;
}

/**
 * Create a mock ContextManager that returns minimal stubs.
 */
function makeMockContextManager(): ContextManager {
  return {
    collectProjectContext: vi.fn().mockResolvedValue({
      workDir: '/test',
      directoryTree: '',
      configFiles: [],
      gitignorePatterns: [],
    }),
    getRelevantContext: vi.fn().mockResolvedValue([]),
    buildSystemPrompt: vi.fn().mockReturnValue('system prompt'),
    compressToolOutput: vi.fn().mockImplementation((output: string) => output),
  } as unknown as ContextManager;
}

/**
 * Create a mock LLMClient whose `chat()` immediately yields a done chunk
 * (no tool calls, no text), so the agentic loop exits after one iteration.
 */
function makeMockLLMClient(): LLMClient {
  async function* mockChat() {
    yield { type: 'done' as const };
  }
  return {
    chat: vi.fn().mockImplementation(mockChat),
    convertMessages: vi.fn().mockImplementation(async (messages: Message[]) => {
      return messages.map((m) => ({ role: m.role, content: m.content }));
    }),
  } as unknown as LLMClient;
}

// ─── Property 21: OrchestratorAgent accepts ContentBlock arrays ───────────────
// Feature: multimodal-support, Property 21: OrchestratorAgent 接受 ContentBlock 数组
// For any ContentBlock array, calling processMessage(blocks) results in a user
// message with `content` equal to that ContentBlock array being added to
// ConversationManager.
// Validates: Requirements 9.2

describe('Property 21: OrchestratorAgent 接受 ContentBlock 数组', () => {
  it('processMessage(blocks) adds a user message with content equal to the ContentBlock array', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();
        const mockLLMClient = makeMockLLMClient();
        const mockToolRegistry = makeMockToolRegistry();
        const mockContextManager = makeMockContextManager();

        const orchestrator = new OrchestratorAgent(
          mockLLMClient,
          mockToolRegistry,
          mockContextManager,
          conversationManager,
        );

        // Consume the generator to completion
        const gen = orchestrator.processMessage(blocks);
        for await (const _chunk of gen) {
          // drain
        }

        const messages = conversationManager.getMessages();
        const userMessages = messages.filter((m) => m.role === 'user');

        // There should be exactly one user message
        expect(userMessages.length).toBeGreaterThanOrEqual(1);

        // The first user message should have content equal to the original blocks array
        const userMsg = userMessages[0]!;
        expect(Array.isArray(userMsg.content)).toBe(true);

        const content = userMsg.content as ContentBlock[];
        expect(content).toHaveLength(blocks.length);

        // Each block should be deeply equal to the original
        for (let i = 0; i < blocks.length; i++) {
          expect(content[i]).toEqual(blocks[i]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('processMessage(blocks) does NOT stringify the ContentBlock array', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();
        const mockLLMClient = makeMockLLMClient();
        const mockToolRegistry = makeMockToolRegistry();
        const mockContextManager = makeMockContextManager();

        const orchestrator = new OrchestratorAgent(
          mockLLMClient,
          mockToolRegistry,
          mockContextManager,
          conversationManager,
        );

        const gen = orchestrator.processMessage(blocks);
        for await (const _chunk of gen) {
          // drain
        }

        const messages = conversationManager.getMessages();
        const userMessages = messages.filter((m) => m.role === 'user');
        const userMsg = userMessages[0]!;

        // content must be an array, not a string like "[object Object]"
        expect(typeof userMsg.content).not.toBe('string');
        expect(Array.isArray(userMsg.content)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('processMessage(blocks) preserves block types (text/image/file)', async () => {
    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();
        const mockLLMClient = makeMockLLMClient();
        const mockToolRegistry = makeMockToolRegistry();
        const mockContextManager = makeMockContextManager();

        const orchestrator = new OrchestratorAgent(
          mockLLMClient,
          mockToolRegistry,
          mockContextManager,
          conversationManager,
        );

        const gen = orchestrator.processMessage(blocks);
        for await (const _chunk of gen) {
          // drain
        }

        const messages = conversationManager.getMessages();
        const userMsg = messages.find((m) => m.role === 'user')!;
        const content = userMsg.content as ContentBlock[];

        // Block types must be preserved in order
        for (let i = 0; i < blocks.length; i++) {
          expect(content[i]!.type).toBe(blocks[i]!.type);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 24: End-to-end round-trip semantic equivalence ─────────────────
// Feature: multimodal-support, Property 24: 端到端往返语义等价
// For any ContentBlock array, after addMessage → getMessages → convertMessages
// pipeline, the content sent to Claude API is semantically equivalent to the
// original ContentBlock array (types, mimeTypes, data sources preserved).
// Validates: Requirements 9.6

describe('Property 24: 端到端往返语义等价', () => {
  it('addMessage → getMessages → convertMessages preserves ContentBlock types and mimeTypes', async () => {
    const llmClient = makeLLMClient();

    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();

        // Step 1: addMessage
        conversationManager.addMessage({
          role: 'user',
          content: blocks,
          timestamp: Date.now(),
        });

        // Step 2: getMessages
        const messages = conversationManager.getMessages();
        const userMsg = messages.find((m) => m.role === 'user')!;
        expect(Array.isArray(userMsg.content)).toBe(true);

        // Step 3: convertMessages
        const converted = await llmClient.convertMessages(messages);
        const convertedUserMsg = converted.find((m) => m.role === 'user')!;

        expect(Array.isArray(convertedUserMsg.content)).toBe(true);
        const claudeBlocks = convertedUserMsg.content as Array<{
          type: string;
          text?: string;
          source?: {
            type: string;
            media_type?: string;
            data?: string;
            url?: string;
          };
        }>;

        expect(claudeBlocks).toHaveLength(blocks.length);

        for (let i = 0; i < blocks.length; i++) {
          const original = blocks[i]!;
          const claude = claudeBlocks[i]!;

          if (original.type === 'text') {
            // TextBlock → Claude text block
            expect(claude.type).toBe('text');
            expect(claude.text).toBe(original.text);
          } else if (original.type === 'image') {
            // ImageBlock → Claude image block
            expect(claude.type).toBe('image');
            if (original.data) {
              expect(claude.source?.type).toBe('base64');
              expect(claude.source?.media_type).toBe(original.mimeType);
              expect(claude.source?.data).toBe(original.data);
            } else if (original.url) {
              expect(claude.source?.type).toBe('url');
              expect(claude.source?.url).toBe(original.url);
            }
          } else if (original.type === 'file') {
            // FileBlock → Claude document block
            expect(claude.type).toBe('document');
            expect(claude.source?.type).toBe('base64');
            expect(claude.source?.media_type).toBe(original.mimeType);
            expect(claude.source?.data).toBe(original.data);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('round-trip preserves block count through the full pipeline', async () => {
    const llmClient = makeLLMClient();

    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();

        conversationManager.addMessage({
          role: 'user',
          content: blocks,
          timestamp: Date.now(),
        });

        const messages = conversationManager.getMessages();
        const converted = await llmClient.convertMessages(messages);

        const convertedUserMsg = converted.find((m) => m.role === 'user')!;
        const claudeBlocks = convertedUserMsg.content as unknown[];

        // Block count must be preserved
        expect(claudeBlocks).toHaveLength(blocks.length);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trip: ImageBlock data is preserved exactly through the pipeline', async () => {
    const llmClient = makeLLMClient();

    await fc.assert(
      fc.asyncProperty(imageBlockWithDataArb, async (block) => {
        const conversationManager = makeConversationManager();

        conversationManager.addMessage({
          role: 'user',
          content: [block],
          timestamp: Date.now(),
        });

        const messages = conversationManager.getMessages();
        const converted = await llmClient.convertMessages(messages);

        const convertedUserMsg = converted.find((m) => m.role === 'user')!;
        const claudeBlocks = convertedUserMsg.content as Array<{
          type: string;
          source: { type: string; media_type: string; data: string };
        }>;

        expect(claudeBlocks[0]!.type).toBe('image');
        expect(claudeBlocks[0]!.source.type).toBe('base64');
        expect(claudeBlocks[0]!.source.media_type).toBe(block.mimeType);
        expect(claudeBlocks[0]!.source.data).toBe(block.data);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip: FileBlock data is preserved exactly through the pipeline', async () => {
    const llmClient = makeLLMClient();

    await fc.assert(
      fc.asyncProperty(fileBlockWithDataArb, async (block) => {
        const conversationManager = makeConversationManager();

        conversationManager.addMessage({
          role: 'user',
          content: [block],
          timestamp: Date.now(),
        });

        const messages = conversationManager.getMessages();
        const converted = await llmClient.convertMessages(messages);

        const convertedUserMsg = converted.find((m) => m.role === 'user')!;
        const claudeBlocks = convertedUserMsg.content as Array<{
          type: string;
          source: { type: string; media_type: string; data: string };
        }>;

        expect(claudeBlocks[0]!.type).toBe('document');
        expect(claudeBlocks[0]!.source.type).toBe('base64');
        expect(claudeBlocks[0]!.source.media_type).toBe(block.mimeType);
        expect(claudeBlocks[0]!.source.data).toBe(block.data);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip: mixed ContentBlock array preserves all block semantics', async () => {
    const llmClient = makeLLMClient();

    await fc.assert(
      fc.asyncProperty(validContentBlocksArb, async (blocks) => {
        const conversationManager = makeConversationManager();

        conversationManager.addMessage({
          role: 'user',
          content: blocks,
          timestamp: Date.now(),
        });

        const messages = conversationManager.getMessages();
        const converted = await llmClient.convertMessages(messages);

        const convertedUserMsg = converted.find((m) => m.role === 'user')!;
        const claudeBlocks = convertedUserMsg.content as Array<{
          type: string;
          text?: string;
          source?: { type: string; media_type?: string; data?: string; url?: string };
        }>;

        // Verify semantic equivalence for each block
        for (let i = 0; i < blocks.length; i++) {
          const orig = blocks[i]!;
          const conv = claudeBlocks[i]!;

          // Type mapping is preserved
          if (orig.type === 'text') {
            expect(conv.type).toBe('text');
          } else if (orig.type === 'image') {
            expect(conv.type).toBe('image');
            // mimeType preserved via media_type (for base64 source)
            if (orig.data) {
              expect(conv.source?.media_type).toBe(orig.mimeType);
            }
          } else if (orig.type === 'file') {
            expect(conv.type).toBe('document');
            expect(conv.source?.media_type).toBe(orig.mimeType);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
