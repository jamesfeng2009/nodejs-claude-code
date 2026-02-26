import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { MediaStore } from '../../../src/media/media-store.js';

// Valid base64 strings for testing
const SAMPLE_BASE64 = 'SGVsbG8gV29ybGQ='; // "Hello World"
const SAMPLE_BASE64_2 = 'Rm9vQmFy'; // "FooBar"

describe('MediaStore', () => {
  let tmpDir: string;
  let store: MediaStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'media-store-test-'));
    store = new MediaStore({ workDir: tmpDir, mediaDir: 'media' });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Requirement 8.6: resolve() throws when mediaId not found ────────────

  describe('Req 8.6 — resolve() throws when mediaId does not exist on disk', () => {
    it('throws with the correct error message for a non-existent mediaId', async () => {
      const mediaId = 'media:nonexistenthash123';
      await expect(store.resolve(mediaId)).rejects.toThrow(
        `Media file not found for mediaId: ${mediaId}`
      );
    });

    it('throws for a mediaId that was never stored', async () => {
      const mediaId = 'media:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      await expect(store.resolve(mediaId)).rejects.toThrow(
        `Media file not found for mediaId: ${mediaId}`
      );
    });

    it('throws even when other files exist in the media directory', async () => {
      // Store one file first
      await store.store(SAMPLE_BASE64, 'image/png');

      // Try to resolve a different, non-existent mediaId
      const missingId = 'media:0000000000000000000000000000000000000000000000000000000000000000';
      await expect(store.resolve(missingId)).rejects.toThrow(
        `Media file not found for mediaId: ${missingId}`
      );
    });
  });

  // ─── Requirement 8.10: MIME to extension mapping completeness ────────────

  describe('Req 8.10 — mimeToExt() maps all 10 supported MIME types correctly', () => {
    it('image/jpeg → .jpg', () => {
      expect(MediaStore.mimeToExt('image/jpeg')).toBe('.jpg');
    });

    it('image/png → .png', () => {
      expect(MediaStore.mimeToExt('image/png')).toBe('.png');
    });

    it('image/gif → .gif', () => {
      expect(MediaStore.mimeToExt('image/gif')).toBe('.gif');
    });

    it('image/webp → .webp', () => {
      expect(MediaStore.mimeToExt('image/webp')).toBe('.webp');
    });

    it('application/pdf → .pdf', () => {
      expect(MediaStore.mimeToExt('application/pdf')).toBe('.pdf');
    });

    it('text/plain → .txt', () => {
      expect(MediaStore.mimeToExt('text/plain')).toBe('.txt');
    });

    it('text/csv → .csv', () => {
      expect(MediaStore.mimeToExt('text/csv')).toBe('.csv');
    });

    it('text/html → .html', () => {
      expect(MediaStore.mimeToExt('text/html')).toBe('.html');
    });

    it('text/xml → .xml', () => {
      expect(MediaStore.mimeToExt('text/xml')).toBe('.xml');
    });

    it('application/json → .json', () => {
      expect(MediaStore.mimeToExt('application/json')).toBe('.json');
    });

    it('returns empty string for unknown MIME type', () => {
      expect(MediaStore.mimeToExt('application/octet-stream')).toBe('');
    });
  });

  // ─── extToMime() reverse mapping ─────────────────────────────────────────

  describe('extToMime() — reverse mapping for all supported extensions', () => {
    const cases: [string, string][] = [
      ['.jpg', 'image/jpeg'],
      ['.png', 'image/png'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
      ['.pdf', 'application/pdf'],
      ['.txt', 'text/plain'],
      ['.csv', 'text/csv'],
      ['.html', 'text/html'],
      ['.xml', 'text/xml'],
      ['.json', 'application/json'],
    ];

    for (const [ext, mime] of cases) {
      it(`${ext} → ${mime}`, () => {
        expect(MediaStore.extToMime(ext)).toBe(mime);
      });
    }

    it('returns undefined for unknown extension', () => {
      expect(MediaStore.extToMime('.xyz')).toBeUndefined();
    });
  });

  // ─── store() creates a file on disk ──────────────────────────────────────

  describe('store() — creates a file on disk with the correct hash-based name', () => {
    it('returns a mediaId in the format media:{sha256hex}', async () => {
      const mediaId = await store.store(SAMPLE_BASE64, 'image/jpeg');
      expect(mediaId).toMatch(/^media:[0-9a-f]{64}$/);
    });

    it('the stored file can be resolved back to the original data', async () => {
      const mediaId = await store.store(SAMPLE_BASE64, 'image/png');
      const resolved = await store.resolve(mediaId);
      expect(resolved.data).toBe(SAMPLE_BASE64);
      expect(resolved.mimeType).toBe('image/png');
    });

    it('stores files with the correct extension based on MIME type', async () => {
      const mediaId = await store.store(SAMPLE_BASE64, 'application/pdf');
      const hash = mediaId.slice('media:'.length);
      const resolved = await store.resolve(mediaId);
      expect(resolved.mimeType).toBe('application/pdf');
      // Verify the hash is part of the mediaId
      expect(hash).toHaveLength(64);
    });
  });

  // ─── store() is idempotent ────────────────────────────────────────────────

  describe('store() — idempotency (same data → same mediaId, no duplicate files)', () => {
    it('returns the same mediaId when storing identical data twice', async () => {
      const id1 = await store.store(SAMPLE_BASE64, 'image/jpeg');
      const id2 = await store.store(SAMPLE_BASE64, 'image/jpeg');
      expect(id1).toBe(id2);
    });

    it('different data produces different mediaIds', async () => {
      const id1 = await store.store(SAMPLE_BASE64, 'image/jpeg');
      const id2 = await store.store(SAMPLE_BASE64_2, 'image/jpeg');
      expect(id1).not.toBe(id2);
    });

    it('resolve still works correctly after storing the same data twice', async () => {
      await store.store(SAMPLE_BASE64, 'image/png');
      const mediaId = await store.store(SAMPLE_BASE64, 'image/png');
      const resolved = await store.resolve(mediaId);
      expect(resolved.data).toBe(SAMPLE_BASE64);
    });
  });
});
