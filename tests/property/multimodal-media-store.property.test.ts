// Feature: multimodal-support
// Properties: 17, 18, 19, 20

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { rm, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { MediaStore } from '../../src/media/media-store.js';
import { SessionStore } from '../../src/session/session-store.js';
import type {
  SupportedImageMimeType,
  SupportedFileMimeType,
  ContentBlock,
  ImageBlock,
  FileBlock,
} from '../../src/types/messages.js';
import type { Message } from '../../src/types/messages.js';

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

const ALL_SUPPORTED_MIME_TYPES = [...SUPPORTED_IMAGE_MIME_TYPES, ...SUPPORTED_FILE_MIME_TYPES];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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

/** Arbitrary supported MIME type (image or file) */
const supportedMimeArb = fc.constantFrom(...ALL_SUPPORTED_MIME_TYPES);

/** Arbitrary supported image MIME type */
const supportedImageMimeArb = fc.constantFrom(...SUPPORTED_IMAGE_MIME_TYPES);

/** Arbitrary supported file MIME type */
const supportedFileMimeArb = fc.constantFrom(...SUPPORTED_FILE_MIME_TYPES);

// ─── Temp directory helpers ───────────────────────────────────────────────────

function makeTempDir(): string {
  return join(tmpdir(), `test-media-store-${Date.now()}-${randomUUID()}`);
}

// ─── Property 17: MediaStore store round-trip ─────────────────────────────────
// Feature: multimodal-support, Property 17: MediaStore 存储往返
// For any base64 data and MIME type, calling store() then resolve() returns
// data identical to the original.
// Validates: Requirements 8.1, 8.9

describe('Property 17: MediaStore 存储往返', () => {
  let tempDir: string;
  let store: MediaStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new MediaStore({ workDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('store() then resolve() returns the original base64 data', async () => {
    await fc.assert(
      fc.asyncProperty(validBase64Arb, supportedMimeArb, async (base64Data, mimeType) => {
        const mediaId = await store.store(base64Data, mimeType);

        // mediaId must be in format "media:{hash}"
        expect(mediaId).toMatch(/^media:[a-f0-9]{64}$/);

        const resolved = await store.resolve(mediaId);

        // Round-trip: resolved data must equal original
        expect(resolved.data).toBe(base64Data);
        expect(resolved.mimeType).toBe(mimeType);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 18: MediaStore hash dedup (idempotency) ────────────────────────
// Feature: multimodal-support, Property 18: MediaStore 哈希去重（幂等性）
// For any base64 data, calling store() twice returns the same mediaId,
// and only one file exists on disk.
// Validates: Requirements 8.2

describe('Property 18: MediaStore 哈希去重（幂等性）', () => {
  let tempDir: string;
  let store: MediaStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new MediaStore({ workDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('store() twice with same data returns same mediaId and only one file on disk', async () => {
    await fc.assert(
      fc.asyncProperty(validBase64Arb, supportedMimeArb, async (base64Data, mimeType) => {
        const mediaId1 = await store.store(base64Data, mimeType);
        const mediaId2 = await store.store(base64Data, mimeType);

        // Both calls must return the same mediaId
        expect(mediaId1).toBe(mediaId2);

        // Only one file should exist on disk for this hash
        const hash = mediaId1.slice('media:'.length);
        const mediaPath = join(tempDir, '.ai-assistant', 'media');
        const files = await readdir(mediaPath);
        const matchingFiles = files.filter((f) => f.startsWith(hash));
        expect(matchingFiles).toHaveLength(1);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 19: Orphan file cleanup ────────────────────────────────────────
// Feature: multimodal-support, Property 19: 孤立文件清理
// For any set of media files where some are referenced and some are not,
// after cleanOrphans(), all referenced files remain and all unreferenced files are deleted.
// Validates: Requirements 8.7, 8.8

describe('Property 19: 孤立文件清理', () => {
  let tempDir: string;
  let store: MediaStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = new MediaStore({ workDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('cleanOrphans() removes unreferenced files and keeps referenced ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1-5 "referenced" data items
        fc.array(fc.tuple(validBase64Arb, supportedMimeArb), { minLength: 1, maxLength: 5 }),
        // Generate 1-5 "orphan" data items (distinct from referenced)
        fc.array(fc.tuple(validBase64Arb, supportedMimeArb), { minLength: 1, maxLength: 5 }),
        async (referencedItems, orphanItems) => {
          // Store all referenced items
          const referencedIds = new Set<string>();
          for (const [data, mime] of referencedItems) {
            const id = await store.store(data, mime);
            referencedIds.add(id);
          }

          // Store all orphan items (collect their IDs but don't reference them)
          const orphanIds: string[] = [];
          for (const [data, mime] of orphanItems) {
            const id = await store.store(data, mime);
            // Only add to orphans if it's not already referenced
            if (!referencedIds.has(id)) {
              orphanIds.push(id);
            }
          }

          // Run cleanup with only the referenced IDs
          await store.cleanOrphans(referencedIds);

          const mediaPath = join(tempDir, '.ai-assistant', 'media');
          const remainingFiles = await readdir(mediaPath).catch(() => [] as string[]);
          const remainingHashes = new Set(remainingFiles.map((f) => f.slice(0, f.lastIndexOf('.'))));

          // All referenced files must still exist
          for (const id of referencedIds) {
            const hash = id.slice('media:'.length);
            expect(remainingHashes.has(hash)).toBe(true);
          }

          // All orphan files must be deleted
          for (const id of orphanIds) {
            const hash = id.slice('media:'.length);
            expect(remainingHashes.has(hash)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 20: SessionStore only persists mediaId references ───────────────
// Feature: multimodal-support, Property 20: SessionStore 仅持久化 mediaId 引用
// For any ContentBlock with a mediaId field, after SessionStore.save(),
// reading the JSON file on disk should not contain expanded base64 data,
// only the mediaId string.
// Validates: Requirements 8.5

describe('Property 20: SessionStore 仅持久化 mediaId 引用', () => {
  let tempDir: string;
  let sessionStore: SessionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    sessionStore = new SessionStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saved session JSON contains mediaId but not expanded base64 data for ImageBlock', async () => {
    await fc.assert(
      fc.asyncProperty(
        supportedImageMimeArb,
        validBase64Arb,
        // Use hex-like strings to match real mediaId format (media:{sha256hex})
        fc.hexaString({ minLength: 16, maxLength: 64 }).map((s) => `media:${s}`),
        async (mimeType, base64Data, mediaId) => {
          const block: ImageBlock = {
            type: 'image',
            mimeType,
            mediaId,
          };

          const session = sessionStore.create();
          const message: Message = {
            role: 'user',
            content: [block],
            timestamp: Date.now(),
          };
          session.conversationHistory.push(message);

          await sessionStore.save(session);

          // Read the raw JSON from disk
          const sessionsDir = join(tempDir, '.ai-assistant', 'sessions');
          const filePath = join(sessionsDir, `${session.sessionId}.json`);
          const rawJson = await readFile(filePath, 'utf-8');

          // The JSON must contain the mediaId
          expect(rawJson).toContain(mediaId);

          // Verify the block is stored as-is with mediaId, not with expanded data
          const parsed = JSON.parse(rawJson);
          const savedBlock = parsed.conversationHistory[0].content[0] as ImageBlock;
          expect(savedBlock.mediaId).toBe(mediaId);
          expect(savedBlock.data).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('saved session JSON contains mediaId but not expanded base64 data for FileBlock', async () => {
    await fc.assert(
      fc.asyncProperty(
        supportedFileMimeArb,
        validBase64Arb,
        // Use hex-like strings to match real mediaId format (media:{sha256hex})
        fc.hexaString({ minLength: 16, maxLength: 64 }).map((s) => `media:${s}`),
        async (mimeType, base64Data, mediaId) => {
          const block: FileBlock = {
            type: 'file',
            mimeType,
            mediaId,
          };

          const session = sessionStore.create();
          const message: Message = {
            role: 'user',
            content: [block],
            timestamp: Date.now(),
          };
          session.conversationHistory.push(message);

          await sessionStore.save(session);

          // Read the raw JSON from disk
          const sessionsDir = join(tempDir, '.ai-assistant', 'sessions');
          const filePath = join(sessionsDir, `${session.sessionId}.json`);
          const rawJson = await readFile(filePath, 'utf-8');

          // The JSON must contain the mediaId
          expect(rawJson).toContain(mediaId);

          // Verify the block is stored with mediaId, not with expanded data
          const parsed = JSON.parse(rawJson);
          const savedBlock = parsed.conversationHistory[0].content[0] as FileBlock;
          expect(savedBlock.mediaId).toBe(mediaId);
          expect(savedBlock.data).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
