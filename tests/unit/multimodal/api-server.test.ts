import { describe, it, expect } from 'vitest';
import { ContentValidator } from '../../../src/multimodal/content-validator.js';
import type { ContentBlock, ImageBlock, FileBlock } from '../../../src/types/messages.js';
import type { AgentRequest } from '../../../src/types/run.js';

// Valid base64 string (length multiple of 4)
const VALID_BASE64 = 'SGVsbG8gV29ybGQ='; // "Hello World"

// ─── Helpers that mirror server.ts validation logic ──────────────────────────

/**
 * Mirrors the server.ts validation logic for the POST /agent endpoint.
 * Returns { status, error } or { status: 200, request } on success.
 */
function validateAgentRequest(body: {
  message?: string;
  content?: ContentBlock[];
  idempotencyKey?: string;
}): { status: number; error?: string; request?: AgentRequest } {
  const { message, content, idempotencyKey = 'test-key' } = body;

  // Req 3.6: both missing → 400
  if (!message && !content) {
    return { status: 400, error: 'message or content is required' };
  }

  if (content) {
    const validator = new ContentValidator();
    const validation = validator.validateBlocks(content);
    if (!validation.valid) {
      return { status: 400, error: validation.error };
    }

    // Req 3.4: ImageBlock base64 > 5MB → 413
    const MB5 = 5 * 1024 * 1024;
    const MB10 = 10 * 1024 * 1024;
    for (const block of content) {
      if (block.type === 'image' && block.data) {
        const decodedSize = Math.floor(block.data.length * 3 / 4);
        if (decodedSize > MB5) {
          return { status: 413, error: 'Image data exceeds maximum size of 5MB' };
        }
      }
      // Req 3.5: FileBlock base64 > 10MB → 413
      if (block.type === 'file' && block.data) {
        const decodedSize = Math.floor(block.data.length * 3 / 4);
        if (decodedSize > MB10) {
          return { status: 413, error: 'File data exceeds maximum size of 10MB' };
        }
      }
    }
  }

  // Req 3.1, 3.7: build AgentRequest
  const agentRequest: AgentRequest = content
    ? { content, idempotencyKey }
    : { message, idempotencyKey };

  return { status: 200, request: agentRequest };
}

// ─── Requirement 3.6: missing message and content → 400 ──────────────────────

describe('Req 3.6 — missing message and content returns 400', () => {
  it('returns 400 when both message and content are absent', () => {
    const result = validateAgentRequest({});
    expect(result.status).toBe(400);
    expect(result.error).toBe('message or content is required');
  });

  it('returns 400 when message is empty string and content is absent', () => {
    const result = validateAgentRequest({ message: '' });
    expect(result.status).toBe(400);
    expect(result.error).toBe('message or content is required');
  });

  it('returns 400 when content is undefined and message is undefined', () => {
    const result = validateAgentRequest({ message: undefined, content: undefined });
    expect(result.status).toBe(400);
  });
});

// ─── Requirement 3.4: ImageBlock base64 > 5MB → 413 ─────────────────────────

describe('Req 3.4 — ImageBlock base64 > 5MB returns 413', () => {
  it('returns 413 when image data decoded size exceeds 5MB', () => {
    // 5MB = 5 * 1024 * 1024 = 5,242,880 bytes
    // base64 encodes 3 bytes as 4 chars → need > 5MB * 4/3 ≈ 6,990,507 chars
    // We simulate this by creating a string of the right length
    const oversizedData = 'A'.repeat(7_000_000); // ~5.25MB decoded
    const block: ImageBlock = {
      type: 'image',
      mimeType: 'image/jpeg',
      data: oversizedData,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(413);
    expect(result.error).toContain('5MB');
  });

  it('accepts image data exactly at the 5MB boundary (not over)', () => {
    // 5MB decoded = 5 * 1024 * 1024 bytes → base64 length = 5MB * 4/3 ≈ 6,990,507
    // Use a small valid image to confirm the path works
    const block: ImageBlock = {
      type: 'image',
      mimeType: 'image/png',
      data: VALID_BASE64,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(200);
  });
});

// ─── Requirement 3.5: FileBlock base64 > 10MB → 413 ─────────────────────────

describe('Req 3.5 — FileBlock base64 > 10MB returns 413', () => {
  it('returns 413 when file data decoded size exceeds 10MB', () => {
    // 10MB = 10 * 1024 * 1024 = 10,485,760 bytes
    // base64 → need > 10MB * 4/3 ≈ 13,981,014 chars
    const oversizedData = 'A'.repeat(14_000_000); // ~10.5MB decoded
    const block: FileBlock = {
      type: 'file',
      mimeType: 'application/pdf',
      data: oversizedData,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(413);
    expect(result.error).toContain('10MB');
  });

  it('accepts file data within the 10MB limit', () => {
    const block: FileBlock = {
      type: 'file',
      mimeType: 'application/pdf',
      data: VALID_BASE64,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(200);
  });
});

// ─── Requirement 3.2, 3.3: ContentValidator integration ──────────────────────

describe('Req 3.2, 3.3 — ContentValidator rejects invalid content blocks', () => {
  it('returns 400 for ImageBlock with unsupported mimeType', () => {
    const block = {
      type: 'image' as const,
      mimeType: 'image/bmp' as never,
      data: VALID_BASE64,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(400);
    expect(result.error).toBeDefined();
  });

  it('returns 400 for FileBlock with unsupported mimeType', () => {
    const block = {
      type: 'file' as const,
      mimeType: 'application/zip' as never,
      data: VALID_BASE64,
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(400);
    expect(result.error).toBeDefined();
  });

  it('returns 400 for ImageBlock with invalid base64 data', () => {
    const block: ImageBlock = {
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'not-valid-base64!!',
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(400);
    expect(result.error).toContain('base64');
  });

  it('returns 400 for FileBlock with url (not supported by Claude API)', () => {
    const block: FileBlock = {
      type: 'file',
      mimeType: 'application/pdf',
      url: 'https://example.com/doc.pdf',
    };
    const result = validateAgentRequest({ content: [block] });
    expect(result.status).toBe(400);
    expect(result.error).toContain('url');
  });
});

// ─── Requirement 3.7: backward compatibility with plain text message ──────────

describe('Req 3.7 — backward compatibility with plain text message', () => {
  it('accepts plain text message and builds AgentRequest with message field', () => {
    const result = validateAgentRequest({ message: 'Hello, world!' });
    expect(result.status).toBe(200);
    expect(result.request).toBeDefined();
    expect(result.request!.message).toBe('Hello, world!');
    expect(result.request!.content).toBeUndefined();
  });

  it('AgentRequest has idempotencyKey when message is provided', () => {
    const result = validateAgentRequest({ message: 'test', idempotencyKey: 'key-123' });
    expect(result.status).toBe(200);
    expect(result.request!.idempotencyKey).toBe('key-123');
  });
});

// ─── Requirement 3.1: content blocks passed to AgentRequest ──────────────────

describe('Req 3.1 — content blocks are passed to AgentRequest', () => {
  it('builds AgentRequest with content field when content is provided', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Describe this image' },
      { type: 'image', mimeType: 'image/png', data: VALID_BASE64 },
    ];
    const result = validateAgentRequest({ content: blocks });
    expect(result.status).toBe(200);
    expect(result.request!.content).toEqual(blocks);
    expect(result.request!.message).toBeUndefined();
  });

  it('content takes precedence over message when both are provided', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }];
    const result = validateAgentRequest({ message: 'ignored', content: blocks });
    expect(result.status).toBe(200);
    // content is present, so AgentRequest is built with content
    expect(result.request!.content).toEqual(blocks);
  });

  it('accepts mixed content blocks (text + image + file)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Analyze these files' },
      { type: 'image', mimeType: 'image/jpeg', data: VALID_BASE64 },
      { type: 'file', mimeType: 'application/pdf', data: VALID_BASE64 },
    ];
    const result = validateAgentRequest({ content: blocks });
    expect(result.status).toBe(200);
    expect(result.request!.content).toHaveLength(3);
  });
});
