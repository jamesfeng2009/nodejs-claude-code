import { describe, it, expect, vi } from 'vitest';
import { LLMClient } from '../../../src/llm/client.js';
import type { Message } from '../../../src/types/messages.js';
import type { MediaStore } from '../../../src/media/media-store.js';

const VALID_BASE64 = 'SGVsbG8gV29ybGQ='; // "Hello World"

const BASE_CONFIG = {
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com',
  model: 'claude-3-5-sonnet',
  maxTokens: 1024,
  temperature: 0,
};

function makeMessage(content: Message['content']): Message {
  return { role: 'user', content, timestamp: 0 };
}

// ─── Requirement 2.5: missing data, url, and mediaId throws ──────────────────

describe('Req 2.5 — throws when ImageBlock/FileBlock has no data, url, or mediaId', () => {
  it('throws for ImageBlock with no data, url, or mediaId', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/png' },
    ]);
    await expect(client.convertMessages([msg])).rejects.toThrow(
      'ContentBlock must have either data, url, or mediaId'
    );
  });

  it('throws for FileBlock with no data, url, or mediaId', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'file', mimeType: 'application/pdf' },
    ]);
    await expect(client.convertMessages([msg])).rejects.toThrow(
      'ContentBlock must have either data, url, or mediaId'
    );
  });
});

// ─── FileBlock with url — converts to document with url source ───────────────
// ContentValidator rejects FileBlock url, but LLMClient still handles it gracefully
// (converts to document with url source) per the design table.

describe('FileBlock with url — converts to document with url source', () => {
  it('converts FileBlock url to Claude document block with url source', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'file', mimeType: 'application/pdf', url: 'https://example.com/doc.pdf' },
    ]);
    const [converted] = await client.convertMessages([msg]);
    expect(converted.content).toEqual([
      {
        type: 'document',
        source: { type: 'url', url: 'https://example.com/doc.pdf' },
      },
    ]);
  });
});

// ─── ImageBlock with data → Claude image block with base64 source ─────────────

describe('ImageBlock with data → Claude image block with base64 source', () => {
  it('converts ImageBlock data to Claude image base64 block', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/jpeg', data: VALID_BASE64 },
    ]);
    const [converted] = await client.convertMessages([msg]);
    expect(converted.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: VALID_BASE64 },
      },
    ]);
  });

  it('preserves mimeType in the source', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/png', data: VALID_BASE64 },
    ]);
    const [converted] = await client.convertMessages([msg]);
    const block = (converted.content as Array<{ type: string; source: { media_type: string } }>)[0];
    expect(block.source.media_type).toBe('image/png');
  });
});

// ─── ImageBlock with url → Claude image block with url source ─────────────────

describe('ImageBlock with url → Claude image block with url source', () => {
  it('converts ImageBlock url to Claude image url block', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/webp', url: 'https://example.com/photo.webp' },
    ]);
    const [converted] = await client.convertMessages([msg]);
    expect(converted.content).toEqual([
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/photo.webp' },
      },
    ]);
  });
});

// ─── FileBlock with data → Claude document block with base64 source ───────────

describe('FileBlock with data → Claude document block with base64 source', () => {
  it('converts FileBlock data to Claude document base64 block', async () => {
    const client = new LLMClient(BASE_CONFIG);
    const msg = makeMessage([
      { type: 'file', mimeType: 'application/pdf', data: VALID_BASE64 },
    ]);
    const [converted] = await client.convertMessages([msg]);
    expect(converted.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: VALID_BASE64 },
      },
    ]);
  });
});

// ─── FileBlock with mediaId → resolves via MediaStore → base64 document ───────

describe('FileBlock with mediaId — resolves via MediaStore', () => {
  it('calls mediaStore.resolve() and returns document with base64 source', async () => {
    const mockMediaStore: MediaStore = {
      resolve: vi.fn().mockResolvedValue({ data: VALID_BASE64, mimeType: 'application/pdf' }),
      store: vi.fn(),
      cleanOrphans: vi.fn(),
    } as unknown as MediaStore;

    const client = new LLMClient(BASE_CONFIG, mockMediaStore);
    const msg = makeMessage([
      { type: 'file', mimeType: 'application/pdf', mediaId: 'media:abc123' },
    ]);
    const [converted] = await client.convertMessages([msg]);

    expect(mockMediaStore.resolve).toHaveBeenCalledWith('media:abc123');
    expect(converted.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: VALID_BASE64 },
      },
    ]);
  });

  it('also resolves ImageBlock with mediaId via MediaStore', async () => {
    const mockMediaStore: MediaStore = {
      resolve: vi.fn().mockResolvedValue({ data: VALID_BASE64, mimeType: 'image/png' }),
      store: vi.fn(),
      cleanOrphans: vi.fn(),
    } as unknown as MediaStore;

    const client = new LLMClient(BASE_CONFIG, mockMediaStore);
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/png', mediaId: 'media:deadbeef' },
    ]);
    const [converted] = await client.convertMessages([msg]);

    expect(mockMediaStore.resolve).toHaveBeenCalledWith('media:deadbeef');
    expect(converted.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: VALID_BASE64 },
      },
    ]);
  });
});

// ─── mediaId not found — error propagates ─────────────────────────────────────

describe('mediaId not found — error propagates', () => {
  it('propagates error from MediaStore.resolve() when mediaId is not found', async () => {
    const mockMediaStore: MediaStore = {
      resolve: vi.fn().mockRejectedValue(
        new Error('Media file not found for mediaId: media:missing')
      ),
      store: vi.fn(),
      cleanOrphans: vi.fn(),
    } as unknown as MediaStore;

    const client = new LLMClient(BASE_CONFIG, mockMediaStore);
    const msg = makeMessage([
      { type: 'file', mimeType: 'application/pdf', mediaId: 'media:missing' },
    ]);

    await expect(client.convertMessages([msg])).rejects.toThrow(
      'Media file not found for mediaId: media:missing'
    );
  });

  it('throws when mediaId is used but no MediaStore is injected', async () => {
    const client = new LLMClient(BASE_CONFIG); // no mediaStore
    const msg = makeMessage([
      { type: 'image', mimeType: 'image/jpeg', mediaId: 'media:abc' },
    ]);

    await expect(client.convertMessages([msg])).rejects.toThrow(
      'Media file not found for mediaId: media:abc'
    );
  });
});
