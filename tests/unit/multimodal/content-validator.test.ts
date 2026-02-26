import { describe, it, expect, beforeEach } from 'vitest';
import { ContentValidator } from '../../../src/multimodal/content-validator.js';
import type { ImageBlock, FileBlock } from '../../../src/types/messages.js';

// Valid base64 strings (length multiple of 4, valid chars)
const VALID_BASE64 = 'SGVsbG8gV29ybGQ='; // "Hello World"
const VALID_BASE64_NO_PADDING = 'AAAA'; // 4 chars, no padding needed

describe('ContentValidator', () => {
  let validator: ContentValidator;

  beforeEach(() => {
    validator = new ContentValidator();
  });

  // ─── Requirement 7.5: data takes priority over url ───────────────────────

  describe('Req 7.5 — data takes priority when both data and url are present', () => {
    it('ImageBlock with both data and url returns valid: true (data wins)', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/png',
        data: VALID_BASE64,
        url: 'https://example.com/image.png',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('FileBlock with both data and url — url is rejected regardless (FileBlock url not supported)', () => {
      // FileBlock url is always rejected by the validator per design decision.
      // When both data and url are present, the url field triggers rejection before data is checked.
      const block: FileBlock = {
        type: 'file',
        mimeType: 'application/pdf',
        data: VALID_BASE64,
        url: 'https://example.com/file.pdf',
      };
      // FileBlock url is rejected by the validator (Claude API does not support document url)
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'FileBlock url is not supported by Claude API, use data or mediaId'
      );
    });
  });

  // ─── Requirement 7.6: missing data and url returns error ─────────────────

  describe('Req 7.6 — error when both data and url are missing (and no mediaId)', () => {
    it('ImageBlock with no data, url, or mediaId returns error', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/jpeg',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('ContentBlock must have either data or url');
    });

    it('FileBlock with no data, url, or mediaId returns error', () => {
      const block: FileBlock = {
        type: 'file',
        mimeType: 'text/plain',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('ContentBlock must have either data or url');
    });
  });

  // ─── FileBlock url rejection ──────────────────────────────────────────────

  describe('FileBlock url field rejection', () => {
    it('FileBlock with url is rejected with the correct error message', () => {
      const block: FileBlock = {
        type: 'file',
        mimeType: 'application/pdf',
        url: 'https://example.com/doc.pdf',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'FileBlock url is not supported by Claude API, use data or mediaId'
      );
    });
  });

  // ─── Valid ImageBlock with data ───────────────────────────────────────────

  describe('Valid ImageBlock with data', () => {
    it('accepts ImageBlock with valid base64 data', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/jpeg',
        data: VALID_BASE64,
      };
      expect(validator.validateBlock(block)).toEqual({ valid: true });
    });

    it('accepts all supported image mimeTypes with data', () => {
      const mimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
      for (const mimeType of mimeTypes) {
        const block: ImageBlock = { type: 'image', mimeType, data: VALID_BASE64_NO_PADDING };
        expect(validator.validateBlock(block).valid).toBe(true);
      }
    });
  });

  // ─── Valid ImageBlock with url ────────────────────────────────────────────

  describe('Valid ImageBlock with url', () => {
    it('accepts ImageBlock with valid https URL', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/png',
        url: 'https://example.com/photo.png',
      };
      expect(validator.validateBlock(block)).toEqual({ valid: true });
    });

    it('accepts ImageBlock with valid http URL', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/webp',
        url: 'http://example.com/photo.webp',
      };
      expect(validator.validateBlock(block)).toEqual({ valid: true });
    });
  });

  // ─── Valid FileBlock with data ────────────────────────────────────────────

  describe('Valid FileBlock with data', () => {
    it('accepts FileBlock with valid base64 data', () => {
      const block: FileBlock = {
        type: 'file',
        mimeType: 'application/pdf',
        data: VALID_BASE64,
      };
      expect(validator.validateBlock(block)).toEqual({ valid: true });
    });

    it('accepts all supported file mimeTypes with data', () => {
      const mimeTypes = [
        'application/pdf',
        'text/plain',
        'text/csv',
        'text/html',
        'text/xml',
        'application/json',
      ] as const;
      for (const mimeType of mimeTypes) {
        const block: FileBlock = { type: 'file', mimeType, data: VALID_BASE64_NO_PADDING };
        expect(validator.validateBlock(block).valid).toBe(true);
      }
    });
  });

  // ─── Valid FileBlock with mediaId ─────────────────────────────────────────

  describe('Valid FileBlock with mediaId', () => {
    it('accepts FileBlock with mediaId', () => {
      const block: FileBlock = {
        type: 'file',
        mimeType: 'application/pdf',
        mediaId: 'media:abc123def456',
      };
      expect(validator.validateBlock(block)).toEqual({ valid: true });
    });
  });

  // ─── Invalid base64 data ──────────────────────────────────────────────────

  describe('Invalid base64 data', () => {
    it('rejects ImageBlock with base64 containing invalid characters', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/jpeg',
        data: 'not-valid-base64!!',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid base64 data in image block');
    });

    it('rejects ImageBlock with base64 whose length is not a multiple of 4', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/png',
        data: 'ABC', // length 3, not multiple of 4
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid base64 data in image block');
    });

    it('rejects FileBlock with invalid base64 data', () => {
      const block: FileBlock = {
        type: 'file',
        mimeType: 'text/plain',
        data: 'not valid!!',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid base64 data in file block');
    });

    it('rejects empty string as base64 data', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/gif',
        data: '',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
    });
  });

  // ─── Invalid URL ──────────────────────────────────────────────────────────

  describe('Invalid URL', () => {
    it('rejects ImageBlock with a non-HTTP URL (ftp)', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/jpeg',
        url: 'ftp://example.com/image.jpg',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid URL in image block');
    });

    it('rejects ImageBlock with a plain string as URL', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/png',
        url: 'not-a-url',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid URL in image block');
    });

    it('rejects ImageBlock with a file:// URL', () => {
      const block: ImageBlock = {
        type: 'image',
        mimeType: 'image/webp',
        url: 'file:///local/image.webp',
      };
      const result = validator.validateBlock(block);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid URL in image block');
    });
  });

  // ─── validateBlocks (array) ───────────────────────────────────────────────

  describe('validateBlocks()', () => {
    it('returns valid: true for an empty array', () => {
      expect(validator.validateBlocks([])).toEqual({ valid: true });
    });

    it('returns valid: true when all blocks are valid', () => {
      const blocks = [
        { type: 'text' as const, text: 'hello' },
        { type: 'image' as const, mimeType: 'image/png' as const, data: VALID_BASE64 },
        { type: 'file' as const, mimeType: 'application/pdf' as const, data: VALID_BASE64 },
      ];
      expect(validator.validateBlocks(blocks).valid).toBe(true);
    });

    it('returns the first error when a block is invalid (fail-fast)', () => {
      const blocks = [
        { type: 'text' as const, text: 'hello' },
        { type: 'image' as const, mimeType: 'image/jpeg' as const }, // missing data/url
        { type: 'image' as const, mimeType: 'image/png' as const }, // also invalid
      ];
      const result = validator.validateBlocks(blocks);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('ContentBlock must have either data or url');
    });
  });
});
