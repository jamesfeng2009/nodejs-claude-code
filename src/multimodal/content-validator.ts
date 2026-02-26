import type {
  ContentBlock,
  ImageBlock,
  FileBlock,
  SupportedImageMimeType,
  SupportedFileMimeType,
} from '../types/messages.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<SupportedImageMimeType> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const SUPPORTED_FILE_MIME_TYPES: ReadonlySet<SupportedFileMimeType> = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
]);

// Base64 character set: A-Z, a-z, 0-9, +, /, and = for padding
const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

export class ContentValidator {
  /**
   * Validates a single ContentBlock.
   * - Checks mimeType is in the supported list
   * - Checks that exactly one of data/url/mediaId exists (data takes priority over url)
   * - If data exists, validates it is valid base64
   * - If url exists (ImageBlock only), validates it is HTTP/HTTPS URL
   * - Rejects FileBlock with url field
   */
  validateBlock(block: ContentBlock): ValidationResult {
    if (block.type === 'text') {
      return { valid: true };
    }

    if (block.type === 'image') {
      return this._validateImageBlock(block);
    }

    if (block.type === 'file') {
      return this._validateFileBlock(block);
    }

    return { valid: false, error: `Unsupported block type` };
  }

  /**
   * Validates an array of ContentBlocks, returning the first error (fail-fast).
   */
  validateBlocks(blocks: ContentBlock[]): ValidationResult {
    for (const block of blocks) {
      const result = this.validateBlock(block);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  }

  /**
   * Validates a base64 string (checks character set only, does not decode).
   */
  isValidBase64(data: string): boolean {
    if (data.length === 0) {
      return false;
    }
    // Length must be a multiple of 4 (with padding)
    if (data.length % 4 !== 0) {
      return false;
    }
    return BASE64_REGEX.test(data);
  }

  /**
   * Validates that a URL is HTTP or HTTPS.
   */
  isValidHttpUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private _validateImageBlock(block: ImageBlock): ValidationResult {
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(block.mimeType)) {
      return { valid: false, error: `Unsupported image mimeType: ${block.mimeType}` };
    }

    // data takes priority; if data exists, ignore url
    if (block.data !== undefined) {
      if (!this.isValidBase64(block.data)) {
        return { valid: false, error: `Invalid base64 data in image block` };
      }
      return { valid: true };
    }

    if (block.mediaId !== undefined) {
      return { valid: true };
    }

    if (block.url !== undefined) {
      if (!this.isValidHttpUrl(block.url)) {
        return { valid: false, error: `Invalid URL in image block` };
      }
      return { valid: true };
    }

    return { valid: false, error: `ContentBlock must have either data or url` };
  }

  private _validateFileBlock(block: FileBlock): ValidationResult {
    if (!SUPPORTED_FILE_MIME_TYPES.has(block.mimeType)) {
      return { valid: false, error: `Unsupported file mimeType: ${block.mimeType}` };
    }

    // Reject url field on FileBlock — Claude API document type does not support url
    if (block.url !== undefined) {
      return {
        valid: false,
        error: `FileBlock url is not supported by Claude API, use data or mediaId`,
      };
    }

    if (block.data !== undefined) {
      if (!this.isValidBase64(block.data)) {
        return { valid: false, error: `Invalid base64 data in file block` };
      }
      return { valid: true };
    }

    if (block.mediaId !== undefined) {
      return { valid: true };
    }

    return { valid: false, error: `ContentBlock must have either data or url` };
  }
}
