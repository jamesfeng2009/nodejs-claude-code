import type { ToolCall } from './tools.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type SupportedImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export type SupportedFileMimeType =
  | 'application/pdf'
  | 'text/plain'
  | 'text/csv'
  | 'text/html'
  | 'text/xml'
  | 'application/json';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mimeType: SupportedImageMimeType;
  /** base64 encoded image data (one of data/url/mediaId) */
  data?: string;
  /** HTTP/HTTPS URL (one of data/url/mediaId) */
  url?: string;
  /** MediaStore reference ID, format media:{sha256} (one of data/url/mediaId) */
  mediaId?: string;
}

export interface FileBlock {
  type: 'file';
  mimeType: SupportedFileMimeType;
  /** base64 encoded file data (one of data/url/mediaId) */
  data?: string;
  /**
   * HTTP/HTTPS URL (one of data/url/mediaId).
   * Note: Claude API document type does not support url; ContentValidator will reject this field.
   */
  url?: string;
  /** MediaStore reference ID (one of data/url/mediaId) */
  mediaId?: string;
  /** Optional filename, used for compression placeholders and summaries */
  filename?: string;
}

export type ContentBlock = TextBlock | ImageBlock | FileBlock;

export interface Message {
  role: MessageRole;
  /** Plain text content or array of multimodal content blocks */
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp: number;
}
