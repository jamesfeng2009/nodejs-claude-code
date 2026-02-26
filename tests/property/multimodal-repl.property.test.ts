// Feature: multimodal-support
// Properties: 13, 14

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { REPL } from '../../src/cli/repl.js';

// ─── Supported extension lists ────────────────────────────────────────────────

const SUPPORTED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const SUPPORTED_FILE_EXTS = ['.pdf', '.txt', '.csv'];
const ALL_SUPPORTED_EXTS = [...SUPPORTED_IMAGE_EXTS, ...SUPPORTED_FILE_EXTS];

const EXPECTED_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

// ─── Property 13: REPL extension → MIME type mapping ─────────────────────────
// Feature: multimodal-support, Property 13: REPL 扩展名到 MIME 类型映射
// For any extension in the supported list, REPL.EXT_TO_MIME returns the correct MIME type.
// Validates: Requirements 6.2

describe('Property 13: REPL 扩展名到 MIME 类型映射', () => {
  it('EXT_TO_MIME maps all supported image extensions to correct MIME types', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_IMAGE_EXTS), (ext) => {
        const mime = REPL.EXT_TO_MIME[ext];
        expect(mime).toBeDefined();
        expect(mime).toBe(EXPECTED_MIME[ext]);
        expect(mime).toMatch(/^image\//);
      }),
      { numRuns: 100 },
    );
  });

  it('EXT_TO_MIME maps all supported file extensions to correct MIME types', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_FILE_EXTS), (ext) => {
        const mime = REPL.EXT_TO_MIME[ext];
        expect(mime).toBeDefined();
        expect(mime).toBe(EXPECTED_MIME[ext]);
        expect(mime).not.toMatch(/^image\//);
      }),
      { numRuns: 100 },
    );
  });

  it('EXT_TO_MIME is consistent: same extension always returns same MIME type', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_SUPPORTED_EXTS), (ext) => {
        const mime1 = REPL.EXT_TO_MIME[ext];
        const mime2 = REPL.EXT_TO_MIME[ext];
        expect(mime1).toBe(mime2);
      }),
      { numRuns: 100 },
    );
  });

  it('image extensions map to image/* MIME types', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_IMAGE_EXTS), (ext) => {
        const mime = REPL.EXT_TO_MIME[ext];
        expect(mime).toMatch(/^image\//);
      }),
      { numRuns: 100 },
    );
  });

  it('non-image extensions do not map to image/* MIME types', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_FILE_EXTS), (ext) => {
        const mime = REPL.EXT_TO_MIME[ext];
        expect(mime).not.toMatch(/^image\//);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 14: REPL rejects unsupported extensions ────────────────────────
// Feature: multimodal-support, Property 14: REPL 拒绝不支持的扩展名
// For any extension NOT in the supported list, EXT_TO_MIME returns undefined,
// which causes REPL to print an error and not submit the request.
// Validates: Requirements 6.4

describe('Property 14: REPL 拒绝不支持的扩展名', () => {
  const SUPPORTED_EXT_SET = new Set(ALL_SUPPORTED_EXTS);

  it('EXT_TO_MIME returns undefined for unsupported extensions', () => {
    // Generate extensions that are NOT in the supported list
    const unsupportedExtArb = fc
      .string({ minLength: 1, maxLength: 10 })
      .map((s) => `.${s.replace(/[^a-z0-9]/gi, 'x').toLowerCase()}`)
      .filter((ext) => !SUPPORTED_EXT_SET.has(ext));

    fc.assert(
      fc.property(unsupportedExtArb, (ext) => {
        const mime = REPL.EXT_TO_MIME[ext];
        expect(mime).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('common unsupported extensions are not in EXT_TO_MIME', () => {
    const commonUnsupported = ['.bmp', '.tiff', '.svg', '.mp4', '.zip', '.docx', '.xlsx', '.exe', '.sh', '.ts'];
    for (const ext of commonUnsupported) {
      expect(REPL.EXT_TO_MIME[ext]).toBeUndefined();
    }
  });

  it('EXT_TO_MIME has exactly the expected number of entries', () => {
    // 9 entries: .jpg, .jpeg, .png, .gif, .webp, .pdf, .txt, .csv + .html, .xml, .json are NOT in REPL map
    // Per design doc: REPL only maps .jpg/.jpeg/.png/.gif/.webp/.pdf/.txt/.csv
    const keys = Object.keys(REPL.EXT_TO_MIME);
    expect(keys.length).toBe(8); // .jpg, .jpeg, .png, .gif, .webp, .pdf, .txt, .csv
  });

  it('all entries in EXT_TO_MIME start with a dot', () => {
    fc.assert(
      fc.property(fc.constantFrom(...Object.keys(REPL.EXT_TO_MIME)), (ext) => {
        expect(ext).toMatch(/^\./);
      }),
      { numRuns: 100 },
    );
  });
});
