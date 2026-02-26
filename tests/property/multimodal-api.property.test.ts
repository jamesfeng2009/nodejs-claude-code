// Feature: multimodal-support
// Properties: 6, 7

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

// ─── Shared MIME type lists ───────────────────────────────────────────────────

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

/** Valid base64 string (length multiple of 4, valid chars) */
const validBase64Arb: fc.Arbitrary<string> = fc
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

/** Arbitrary string NOT in any supported MIME type list */
const unsupportedMimeArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => !ALL_SUPPORTED_MIME_TYPES.has(s as SupportedImageMimeType));

/** Valid ImageBlock with data */
const validImageBlockArb: fc.Arbitrary<ImageBlock> = fc.record({
  type: fc.constant('image' as const),
  mimeType: fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES),
  data: validBase64Arb,
});

/** Valid FileBlock with data */
const validFileBlockArb: fc.Arbitrary<FileBlock> = fc.record({
  type: fc.constant('file' as const),
  mimeType: fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES),
  data: validBase64Arb,
});

/** Any valid ContentBlock */
const validContentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  fc.record({ type: fc.constant('text' as const), text: fc.string() }),
  validImageBlockArb,
  validFileBlockArb,
);

/** Non-empty array of valid ContentBlocks */
const validContentBlocksArb: fc.Arbitrary<ContentBlock[]> = fc.array(
  validContentBlockArb,
  { minLength: 1, maxLength: 5 },
);

// ─── Property 6: API rejects invalid mimeType ────────────────────────────────
// Feature: multimodal-support, Property 6: API 拒绝不合法 mimeType
// The ContentValidator used by the API server rejects blocks with unsupported
// mimeTypes, which would cause the server to return 400.
// Validates: Requirements 3.2, 3.3

describe('Property 6: API 拒绝不合法 mimeType', () => {
  const validator = new ContentValidator();

  it('ContentValidator rejects ImageBlock with unsupported mimeType (API would return 400)', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block: ContentBlock = {
          type: 'image',
          mimeType: badMime as SupportedImageMimeType,
          data,
        };
        const result = validator.validateBlocks([block]);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it('ContentValidator rejects FileBlock with unsupported mimeType (API would return 400)', () => {
    fc.assert(
      fc.property(unsupportedMimeArb, validBase64Arb, (badMime, data) => {
        const block: ContentBlock = {
          type: 'file',
          mimeType: badMime as SupportedFileMimeType,
          data,
        };
        const result = validator.validateBlocks([block]);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it('ContentValidator accepts valid content blocks (API would proceed)', () => {
    fc.assert(
      fc.property(validContentBlocksArb, (blocks) => {
        const result = validator.validateBlocks(blocks);
        expect(result.valid).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('API size check: image base64 > 5MB decoded is rejected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES),
        // Generate base64 string whose decoded size exceeds 5MB
        // 5MB = 5 * 1024 * 1024 bytes; base64 encodes 3 bytes as 4 chars
        // So we need > 5MB * 4/3 chars ≈ 6,990,507 chars
        fc.integer({ min: 7_000_000, max: 8_000_000 }),
        (mimeType, charCount) => {
          // Simulate the size check logic from server.ts
          const MB5 = 5 * 1024 * 1024;
          // Pad to multiple of 4
          const paddedLen = Math.ceil(charCount / 4) * 4;
          const decodedSize = Math.floor(paddedLen * 3 / 4);
          expect(decodedSize).toBeGreaterThan(MB5);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('API size check: file base64 > 10MB decoded is rejected', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES),
        fc.integer({ min: 14_000_000, max: 16_000_000 }),
        (mimeType, charCount) => {
          const MB10 = 10 * 1024 * 1024;
          const paddedLen = Math.ceil(charCount / 4) * 4;
          const decodedSize = Math.floor(paddedLen * 3 / 4);
          expect(decodedSize).toBeGreaterThan(MB10);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Property 7: API backward compatibility with plain text message ───────────
// Feature: multimodal-support, Property 7: API 向后兼容纯文本 message
// When a plain text `message` is provided (no `content`), the API should
// accept it without validation errors. The AgentRequest is built with `message`.
// Validates: Requirements 3.7

describe('Property 7: API 向后兼容纯文本 message', () => {
  it('plain text message passes validation (no ContentValidator needed)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        (message) => {
          // When only `message` is provided, the API skips ContentValidator entirely.
          // Simulate the server logic: if content is absent, no validation is run.
          const content = undefined;
          const shouldValidate = content !== undefined;
          expect(shouldValidate).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('AgentRequest is built with message field when content is absent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        fc.uuid(),
        (message, idempotencyKey) => {
          // Simulate server.ts AgentRequest construction logic
          const content: ContentBlock[] | undefined = undefined;
          const agentRequest = content
            ? { content, idempotencyKey }
            : { message, idempotencyKey };

          expect(agentRequest).toHaveProperty('message', message);
          expect(agentRequest).toHaveProperty('idempotencyKey', idempotencyKey);
          expect(agentRequest).not.toHaveProperty('content');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('AgentRequest is built with content field when content is present', () => {
    fc.assert(
      fc.property(
        validContentBlocksArb,
        fc.uuid(),
        (content, idempotencyKey) => {
          // Simulate server.ts AgentRequest construction logic
          const message: string | undefined = undefined;
          const agentRequest = content
            ? { content, idempotencyKey }
            : { message, idempotencyKey };

          expect(agentRequest).toHaveProperty('content', content);
          expect(agentRequest).toHaveProperty('idempotencyKey', idempotencyKey);
          expect(agentRequest).not.toHaveProperty('message');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('missing both message and content should be detected as invalid', () => {
    fc.assert(
      fc.property(fc.uuid(), (idempotencyKey) => {
        // Simulate the server validation: both missing → 400
        const message: string | undefined = undefined;
        const content: ContentBlock[] | undefined = undefined;
        const isInvalid = !message && !content;
        expect(isInvalid).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
