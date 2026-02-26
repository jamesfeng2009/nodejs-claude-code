import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, readdir, unlink, access } from 'fs/promises';
import { join } from 'path';

export interface MediaStoreOptions {
  /** Working directory, defaults to process.cwd() */
  workDir?: string;
  /** Media storage path, defaults to .ai-assistant/media */
  mediaDir?: string;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/xml': '.xml',
  'application/json': '.json',
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])
);

export class MediaStore {
  private readonly mediaPath: string;

  constructor(options?: MediaStoreOptions) {
    const workDir = options?.workDir ?? process.cwd();
    const mediaDir = options?.mediaDir ?? '.ai-assistant/media';
    this.mediaPath = join(workDir, mediaDir);
  }

  /**
   * Store a media file. Computes SHA-256 hash; if file already exists, skips write.
   * Returns mediaId in format: `media:{sha256hex}`
   */
  async store(base64Data: string, mimeType: string): Promise<string> {
    const hash = createHash('sha256').update(base64Data).digest('hex');
    const ext = MediaStore.mimeToExt(mimeType);
    const filename = `${hash}${ext}`;
    const filePath = join(this.mediaPath, filename);

    await mkdir(this.mediaPath, { recursive: true });

    const exists = await access(filePath).then(() => true).catch(() => false);
    if (!exists) {
      await writeFile(filePath, base64Data, 'utf8');
    }

    return `media:${hash}`;
  }

  /**
   * Resolve a mediaId to base64 data.
   * Throws if the file is not found: "Media file not found for mediaId: {mediaId}"
   */
  async resolve(mediaId: string): Promise<{ data: string; mimeType: string }> {
    const hash = mediaId.startsWith('media:') ? mediaId.slice('media:'.length) : mediaId;

    const files = await readdir(this.mediaPath).catch(() => [] as string[]);
    const match = files.find((f) => f.startsWith(hash));

    if (!match) {
      throw new Error(`Media file not found for mediaId: ${mediaId}`);
    }

    const ext = match.slice(hash.length); // e.g. ".jpg"
    const mimeType = MediaStore.extToMime(ext);
    const filePath = join(this.mediaPath, match);
    const data = await readFile(filePath, 'utf8');

    return { data, mimeType: mimeType ?? 'application/octet-stream' };
  }

  /**
   * Clean orphan media files: scan media dir, delete files not referenced by any session.
   * @param referencedMediaIds Set of all mediaIds referenced by known sessions
   */
  async cleanOrphans(referencedMediaIds: Set<string>): Promise<void> {
    const files = await readdir(this.mediaPath).catch(() => [] as string[]);

    // Build a set of referenced hashes (strip "media:" prefix)
    const referencedHashes = new Set<string>();
    for (const id of referencedMediaIds) {
      const hash = id.startsWith('media:') ? id.slice('media:'.length) : id;
      referencedHashes.add(hash);
    }

    for (const file of files) {
      // filename is "{hash}{ext}", extract hash by stripping the extension
      const dotIndex = file.lastIndexOf('.');
      const hash = dotIndex !== -1 ? file.slice(0, dotIndex) : file;

      if (!referencedHashes.has(hash)) {
        await unlink(join(this.mediaPath, file)).catch(() => {
          // Ignore errors for files that may have been deleted concurrently
        });
      }
    }
  }

  /** Infer file extension from MIME type. Falls back to empty string for unknown types. */
  static mimeToExt(mimeType: string): string {
    return MIME_TO_EXT[mimeType] ?? '';
  }

  /** Infer MIME type from file extension (e.g. ".jpg"). Returns undefined for unknown extensions. */
  static extToMime(ext: string): string | undefined {
    return EXT_TO_MIME[ext];
  }
}
