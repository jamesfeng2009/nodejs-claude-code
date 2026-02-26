// Feature: multimodal-support
// Properties: 2, 15, 16

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ContentValidator } from '../../src/multimodal/content-validator.js';
import type {
  ContentBlock,
  ImageBlock,
  FileBlock,
  SupportedImageMimeType,
  SupportedFileMimeType,
} from '../../src/types/messages.js';

// ─── Supported MIME types ─────────────────────────────────────────────────────

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

const ALL_SUPPORTED_MIME_TYPES = new Set([
  ...SUPPORTED_IMAGE_MIME_TYPES,
  ...SUPPORTED_FILE_MIME_TYPES,
]);

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Valid base64 string (length multiple of 4, valid chars, correct padding) */
const validBase64Arb: fc.Arbitrary<string> = fc
  // Generate complete 4-char groups using only valid base64 chars (no padding)
  .array(
    fc.tuple(
      fc.constantFrom(...BASE64_CHARS.split('')),
      fc.constantFrom(...BASE64_CHARS.split('')),
      fc.constantFrom(...BASE64_CHARS.split('')),
      fc.constantFrom(...BASE64_CHARS.split(''))
    ).map(([a, b, c, d]) => a + b + c + d),
    { minLength: 1, maxLength: 16 }
  )
  .map((groups) => groups.join(''));

/** Valid HTTP/HTTPS URL */
const validHttpUrlArb: fc.Arbitrary<string> = fc.oneof(
  fc.webUrl({ validSchemes: ['http', 'https'] })
);

/** Arbitrary supported image mimeType */
const supportedImageMimeArb = fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES);

/** Arbitrary supported file mimeType */
const supportedFileMimeArb = fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES);

/** Arbitrary string that is NOT in any supported MIME type list */
const unsupportedMimeArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => !ALL_SUPPORTED_MIME_TYPES.has(s as SupportedImageMimeType));

/** Valid ImageBlock with data */
const imageBlockWithDataArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: supportedImageMimeArb,
  data: validBase64Arb,
});

/** Valid ImageBlock with url */
const imageBlockWithUrlArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: supportedImageMimeArb,
  url: validHttpUrlArb,
});

/** Valid ImageBlock (data or url) */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.oneof(
  imageBlockWithDataArb,
  imageBlockWithUrlArb
);

/** Valid FileBlock with data */
const fileBlockWithDataArb: fc.Arbitrary<FileBlock> = fc.record({
  type: fc.constant('file' as const),
  mimeType: supportedFileMimeArb,
  data: validBase64Arb,
});

/** Valid FileBlock with mediaId */
const fileBlockWithMediaIdArb: fc.Arbitrary<FileBlock> = fc.record({
  type: fc.constant('file' as const),
  mimeType: supportedFileMimeArb,
  mediaId: fc.string({ minLength: 1, maxLength: 64 }),
});

/** Valid FileBlock (data or mediaId — url is rejected by validator) */
const validFileBlockArb: fc.Arbitrary<FileBlock> = fc.oneof(
  fileBlockWithDataArb,
  fileBlockWithMediaIdArb
);

/** Any valid ContentBlock */
const validContentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  fc.record({ type: fc.constant('text' as const), text: fc.string() }),
  validImageBlockArb,
  validFileBlockArb
);

// ─── Property 2: Unsupported mimeType is rejected ────────────────────────────
// Feature: multimodal-support, Property 2: 不支持的 mimeType 被验证器拒绝
// For any string not in SupportedImageMimeType or SupportedFileMimeType,
// ContentValidator.validateBlock() should return valid: false.
// Validates: Requirements 1.5, 1.6, 7.1

describe('Property 2: 不支持的 mimeType 被验证器拒绝', () => {
  const validator = new ContentValidator();

  it('ImageBlock with unsupported mimeType is rejected', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block = {
          type: 'image' as const,
          mimeType: badMime as SupportedImageMimeType,
          data,
        };
        const result = validator.validateBlock(block);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });

  it('FileBlock with unsupported mimeType is rejected', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block = {
          type: 'file' as const,
          mimeType: badMime as SupportedFileMimeType,
          data,
        };
        const result = validator.validateBlock(block);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 15: base64 and URL validation ───────────────────────────────────
// Feature: multimodal-support, Property 15: base64 和 URL 验证
// isValidBase64() correctly distinguishes valid base64 strings from non-base64;
// isValidHttpUrl() correctly distinguishes valid HTTP/HTTPS URLs from invalid ones.
// Validates: Requirements 7.1, 7.2, 7.3, 7.4

describe('Property 15: base64 和 URL 验证', () => {
  const validator = new ContentValidator();

  it('isValidBase64() accepts valid base64 strings', () => {
    fc.assert(
      fc.property(validBase64Arb, (b64) => {
        expect(validator.isValidBase64(b64)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('isValidBase64() rejects strings with invalid base64 characters', () => {
    // Strings containing characters outside the base64 alphabet (excluding padding =)
    const invalidBase64Arb = fc
      .string({ minLength: 4, maxLength: 64 })
      .filter((s) => {
        // Must contain at least one invalid character
        return /[^A-Za-z0-9+/=]/.test(s);
      });

    fc.assert(
      fc.property(invalidBase64Arb, (s) => {
        expect(validator.isValidBase64(s)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('isValidBase64() rejects strings whose length is not a multiple of 4', () => {
    // Strings with only valid base64 chars but wrong length (not multiple of 4)
    const wrongLengthArb = fc
      .array(
        fc.constantFrom(...BASE64_CHARS.split('')),
        { minLength: 1, maxLength: 63 }
      )
      .map((chars) => chars.join(''))
      .filter((s) => s.length % 4 !== 0);

    fc.assert(
      fc.property(wrongLengthArb, (s) => {
        expect(validator.isValidBase64(s)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('isValidHttpUrl() accepts valid HTTP URLs', () => {
    fc.assert(
      fc.property(validHttpUrlArb, (url) => {
        expect(validator.isValidHttpUrl(url)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('isValidHttpUrl() rejects non-HTTP/HTTPS URLs', () => {
    // Strings that are clearly not valid HTTP/HTTPS URLs
    const invalidUrlArb = fc.oneof(
      // Plain strings without protocol
      fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.startsWith('http')),
      // ftp:// or other protocols
      fc.string({ minLength: 5, maxLength: 30 }).map((s) => `ftp://${s}`),
      // file:// protocol
      fc.string({ minLength: 1, maxLength: 30 }).map((s) => `file://${s}`)
    );

    fc.assert(
      fc.property(invalidUrlArb, (url) => {
        expect(validator.isValidHttpUrl(url)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 16: ContentValidator idempotency ───────────────────────────────
// Feature: multimodal-support, Property 16: ContentValidator 幂等性
// For any ContentBlock, calling validateBlock() twice gives the same result.
// Validates: Requirements 7.7

describe('Property 16: ContentValidator 幂等性', () => {
  const validator = new ContentValidator();

  it('validateBlock() is idempotent for valid ContentBlocks', () => {
    fc.assert(
      fc.property(validContentBlockArb, (block) => {
        const result1 = validator.validateBlock(block);
        const result2 = validator.validateBlock(block);
        expect(result1.valid).toBe(result2.valid);
        expect(result1.error).toBe(result2.error);
      }),
      { numRuns: 100 }
    );
  });

  it('validateBlock() is idempotent for ImageBlocks with unsupported mimeType', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block: ContentBlock = {
          type: 'image',
          mimeType: badMime as SupportedImageMimeType,
          data,
        };
        const result1 = validator.validateBlock(block);
        const result2 = validator.validateBlock(block);
        expect(result1.valid).toBe(result2.valid);
        expect(result1.error).toBe(result2.error);
      }),
      { numRuns: 100 }
    );
  });

  it('validateBlock() is idempotent for FileBlocks with unsupported mimeType', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block: ContentBlock = {
          type: 'file',
          mimeType: badMime as SupportedFileMimeType,
          data,
        };
        const result1 = validator.validateBlock(block);
        const result2 = validator.validateBlock(block);
        expect(result1.valid).toBe(result2.valid);
        expect(result1.error).toBe(result2.error);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 1: ContentBlock structural constraints ─────────────────────────
// Feature: multimodal-support, Property 1: ContentBlock 结构约束
// For any ImageBlock or FileBlock, exactly one of data/url/mediaId exists,
// and mimeType belongs to the corresponding supported list.
// Validates: Requirements 1.3, 1.4, 1.5, 1.6

describe('Property 1: ContentBlock 结构约束', () => {
  const validator = new ContentValidator();

  it('valid ImageBlock with data has supported mimeType and passes validation', () => {
    fc.assert(
      fc.property(imageBlockWithDataArb, (block) => {
        // mimeType must be in supported list
        expect(SUPPORTED_IMAGE_MIME_TYPES).toContain(block.mimeType);
        // data is present, url and mediaId are absent
        expect(block.data).toBeDefined();
        expect(block.url).toBeUndefined();
        expect(block.mediaId).toBeUndefined();
        // Validator must accept it
        expect(validator.validateBlock(block).valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('valid ImageBlock with url has supported mimeType and passes validation', () => {
    fc.assert(
      fc.property(imageBlockWithUrlArb, (block) => {
        expect(SUPPORTED_IMAGE_MIME_TYPES).toContain(block.mimeType);
        expect(block.url).toBeDefined();
        expect(block.data).toBeUndefined();
        expect(block.mediaId).toBeUndefined();
        expect(validator.validateBlock(block).valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('valid FileBlock with data has supported mimeType and passes validation', () => {
    fc.assert(
      fc.property(fileBlockWithDataArb, (block) => {
        expect(SUPPORTED_FILE_MIME_TYPES).toContain(block.mimeType);
        expect(block.data).toBeDefined();
        expect(block.url).toBeUndefined();
        expect(block.mediaId).toBeUndefined();
        expect(validator.validateBlock(block).valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('valid FileBlock with mediaId has supported mimeType and passes validation', () => {
    fc.assert(
      fc.property(fileBlockWithMediaIdArb, (block) => {
        expect(SUPPORTED_FILE_MIME_TYPES).toContain(block.mimeType);
        expect(block.mediaId).toBeDefined();
        expect(block.data).toBeUndefined();
        expect(block.url).toBeUndefined();
        expect(validator.validateBlock(block).valid).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('ImageBlock with unsupported mimeType is rejected regardless of data/url', () => {
    fc.assert(
      fc.property(
        unsupportedMimeArb,
        fc.oneof(
          fc.record({ data: validBase64Arb }),
          fc.record({ url: validHttpUrlArb }),
        ),
        (badMime, source) => {
          const block = {
            type: 'image' as const,
            mimeType: badMime as SupportedImageMimeType,
            ...source,
          };
          expect(validator.validateBlock(block).valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('FileBlock with unsupported mimeType is rejected regardless of data/mediaId', () => {
    fc.assert(
      fc.property(
        unsupportedMimeArb,
        validBase64Arb,
        (badMime, data) => {
          const block = {
            type: 'file' as const,
            mimeType: badMime as SupportedFileMimeType,
            data,
          };
          expect(validator.validateBlock(block).valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
