import type { Message, ContentBlock } from '../types/messages.js';
import type { KeyEntityCache } from '../context/key-entity-cache.js';

export interface ConversationConfig {
  /** Token count that triggers compression (e.g. 0.8 * maxContextTokens) */
  highWaterMark: number;
  /** Target token count after compression (e.g. 0.5 * maxContextTokens) */
  lowWaterMark: number;
  /** LLM context window size in tokens */
  maxContextTokens: number;
}

export interface StructuredSummary {
  keyEntities: string[];       // file paths, function signatures, class names
  decisions: string[];         // user-confirmed operation decisions
  errors: string[];            // error messages / error codes
  operationHistory: string[];  // brief operation summaries
}

/**
 * Manages conversation history with high/low watermark compression.
 *
 * Compression strategy:
 * 1. When token count >= highWaterMark, trigger compression
 * 2. Generate a structured summary of older messages
 * 3. Use sliding window to keep the most recent complete conversation turns
 * 4. Apply differentiated compression for tool results
 * 5. Compress until token count <= lowWaterMark
 */
export class ConversationManager {
  private messages: Message[] = [];

  constructor(
    private readonly config: ConversationConfig,
    private readonly entityCache: KeyEntityCache,
  ) {}

  addMessage(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Approximate token count: 4 characters ≈ 1 token.
   */
  getTokenCount(): number {
    return estimateTokens(this.messages);
  }

  clear(): void {
    this.messages = [];
  }

  /**
   * Check if compression is needed and compress if so.
   * Compression reduces token count from highWaterMark to lowWaterMark.
   * Applies differentiated compression: compressible tool results are summarised
   * before the sliding-window pass, reducing token pressure (req 4.15).
   */
  async compressIfNeeded(): Promise<void> {
    if (this.getTokenCount() < this.config.highWaterMark) {
      return;
    }

    // Separate system messages (always keep) from the rest
    const systemMessages = this.messages.filter((m) => m.role === 'system');
    let nonSystemMessages = this.messages.filter((m) => m.role !== 'system');

    // ── Differentiated tool-result compression (req 4.15) ────────────────
    // Summarise compressible tool results in-place before the sliding-window pass.
    // Error results and user-confirmed operations are left untouched.
    nonSystemMessages = nonSystemMessages.map((msg) => {
      if (!this.shouldCompressToolResult(msg)) return msg;

      // For ContentBlock arrays: replace ImageBlock/FileBlock with placeholder text
      if (Array.isArray(msg.content)) {
        const compressed = msg.content.map((block) => {
          if (block.type === 'image') {
            return { type: 'text' as const, text: `[图片已压缩: ${block.mimeType}]` };
          } else if (block.type === 'file') {
            return { type: 'text' as const, text: `[文件已压缩: ${block.filename ?? block.mimeType}]` };
          }
          return block;
        });
        // Merge all text blocks into a single string for compactness
        const text = compressed.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        return { ...msg, content: text };
      }

      // Plain string content: summarise long outputs
      const lines = msg.content.split('\n');
      if (lines.length <= 10) return msg; // already short, skip
      const head = lines.slice(0, 6).join('\n');
      const omitted = lines.length - 6;
      return {
        ...msg,
        content: `${head}\n... [${omitted} lines summarised during compression] ...`,
      };
    });

    // Build a compact summary of ALL non-system messages
    const summary = this.generateStructuredSummary(nonSystemMessages);
    const summaryMessage = this.buildSummaryMessage(summary);

    // Find turn boundaries (each turn starts at a user message)
    const turnStarts: number[] = [];
    for (let i = 0; i < nonSystemMessages.length; i++) {
      if (nonSystemMessages[i]!.role === 'user') {
        turnStarts.push(i);
      }
    }

    const systemTokens = estimateTokens([...systemMessages, summaryMessage]);
    void systemTokens; // kept for potential future use

    // If the summary alone exceeds lowWaterMark, truncate it to fit
    let finalSummaryMessage = summaryMessage;
    const summaryTokens = estimateTokens([summaryMessage]);
    if (summaryTokens > this.config.lowWaterMark) {
      // Truncate summary content to fit within lowWaterMark
      const maxSummaryChars = this.config.lowWaterMark * 4 - 4; // leave a small buffer
      const truncatedContent = summaryMessage.content.slice(0, maxSummaryChars);
      finalSummaryMessage = { ...summaryMessage, content: truncatedContent };
    }

    const finalSystemTokens = estimateTokens([...systemMessages, finalSummaryMessage]);

    // Start with the most recent turn and add older turns while staying under lowWaterMark
    // Always keep at least the last turn (most recent user + assistant)
    let keepFrom = turnStarts.length > 0 ? turnStarts[turnStarts.length - 1]! : 0;

    for (let t = turnStarts.length - 2; t >= 0; t--) {
      const candidate = turnStarts[t]!;
      const candidateMessages = nonSystemMessages.slice(candidate);
      const candidateTokens = finalSystemTokens + estimateTokens(candidateMessages);

      if (candidateTokens <= this.config.lowWaterMark) {
        keepFrom = candidate;
      } else {
        break;
      }
    }

    let recentMessages = nonSystemMessages.slice(keepFrom);

    // If even the last turn + summary exceeds lowWaterMark, truncate the recent messages
    // to fit within lowWaterMark. Always keep at least the last user message.
    // Use the same token estimation as getTokenCount() to avoid rounding discrepancies.
    while (
      estimateTokens([...systemMessages, finalSummaryMessage, ...recentMessages]) >= this.config.lowWaterMark &&
      recentMessages.length > 1
    ) {
      // Find the last user message index — never drop it
      const lastUserIdx = recentMessages.reduce(
        (acc, m, i) => (m.role === 'user' ? i : acc),
        -1,
      );

      if (lastUserIdx < 0) {
        // No user message found — can't drop anything meaningful
        break;
      }

      if (lastUserIdx === 0 && recentMessages.length === 1) {
        // Only the last user message remains — can't drop it
        break;
      }

      // Drop the first message in the recent window (if it's not the last user message)
      if (lastUserIdx > 0) {
        recentMessages = recentMessages.slice(1);
      } else {
        // lastUserIdx === 0, but there are more messages after it — drop the last one
        recentMessages = recentMessages.slice(0, recentMessages.length - 1);
      }
    }

    // Rebuild: system + summary + recent turns
    // If still over lowWaterMark (can't trim messages further), truncate the summary to fit
    const assembled = [...systemMessages, finalSummaryMessage, ...recentMessages];
    const assembledTokens = estimateTokens(assembled);
    if (assembledTokens > this.config.lowWaterMark) {
      const recentTokens = estimateTokens([...systemMessages, ...recentMessages]);
      const maxSummaryChars = Math.max(0, (this.config.lowWaterMark - recentTokens) * 4 - 4);
      const truncatedContent = finalSummaryMessage.content.slice(0, maxSummaryChars) || '[Conversation Summary]';
      finalSummaryMessage = { ...finalSummaryMessage, content: truncatedContent };
    }
    this.messages = [...systemMessages, finalSummaryMessage, ...recentMessages];
  }

  /**
   * Generate a structured summary preserving key entities, decisions, errors,
   * and operation history from the given messages.
   */
  generateStructuredSummary(messages: Message[]): StructuredSummary {
    const keyEntities = new Set<string>();
    const decisions: string[] = [];
    const errors: string[] = [];
    const operationHistory: string[] = [];

    for (const msg of messages) {
      // Extract text content for entity recognition
      const textContent = extractTextContent(msg.content);

      // Record multimodal entries in keyEntities
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'image') {
            keyEntities.add(`image:${block.mimeType}`);
          } else if (block.type === 'file') {
            keyEntities.add(`file:${block.filename ?? block.mimeType}`);
          }
        }
      }

      // Extract entities from text content
      const entities = this.entityCache.extractEntities(textContent);
      for (const entity of entities) {
        keyEntities.add(`${entity.type}:${entity.value}`);
      }

      if (msg.role === 'user') {
        if (isConfirmationMessage(textContent)) {
          decisions.push(textContent.trim());
        }
      } else if (msg.role === 'assistant') {
        const summary = summariseAssistantMessage(msg);
        if (summary) operationHistory.push(summary);
      } else if (msg.role === 'tool') {
        if (isErrorToolResult(msg)) {
          errors.push(textContent.trim());
        } else {
          const summary = summariseToolResult(msg);
          if (summary) operationHistory.push(summary);
        }
      }
    }

    return {
      keyEntities: Array.from(keyEntities),
      decisions,
      errors,
      operationHistory,
    };
  }

  shouldCompressToolResult(message: Message): boolean {
    if (message.role !== 'tool') return false;

    // Never compress error results
    if (isErrorToolResult(message)) return false;

    // Never compress user-confirmed operation results
    if (isUserConfirmedOperation(message)) return false;

    // File content and other large outputs can be compressed
    return true;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildSummaryMessage(summary: StructuredSummary): Message {
    // Build a structured multi-section summary so key information is readable
    // and not lost in a single-line concatenation.
    const parts: string[] = ['[Conversation Summary]'];

    if (summary.keyEntities.length > 0) {
      parts.push(`Key entities: ${summary.keyEntities.slice(0, 10).join(', ')}`);
    }
    if (summary.decisions.length > 0) {
      parts.push(`Decisions: ${summary.decisions.slice(0, 5).map((d) => d.slice(0, 80)).join(' | ')}`);
    }
    if (summary.errors.length > 0) {
      parts.push(`Errors: ${summary.errors.slice(0, 5).map((e) => e.slice(0, 100)).join(' | ')}`);
    }
    if (summary.operationHistory.length > 0) {
      parts.push(`Operations: ${summary.operationHistory.slice(0, 8).map((o) => o.slice(0, 60)).join(' | ')}`);
    }

    return {
      role: 'system',
      content: parts.join('\n'),
      timestamp: Date.now(),
    };
  }
}

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateContentTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') {
    return content.length;
  }
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') {
      chars += block.text.length;
    } else if (block.type === 'image' || block.type === 'file') {
      if (block.data) {
        chars += block.data.length; // will be divided by 4 at the end
      } else if (block.url) {
        chars += 80; // 20 tokens * 4 chars/token
      }
      // mediaId: treat as negligible (just the id string)
    }
  }
  return chars;
}

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += estimateContentTokens(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += tc.name.length + JSON.stringify(tc.arguments).length;
      }
    }
  }
  // 4 characters ≈ 1 token
  return Math.ceil(chars / 4);
}

// ─── Text extraction helper ───────────────────────────────────────────────────

/**
 * Extract plain text from a message content (string or ContentBlock[]).
 * For ContentBlock arrays, concatenates text from all TextBlocks.
 */
function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is import('../types/messages.js').TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ─── Message classification helpers ──────────────────────────────────────────

function isErrorToolResult(message: Message): boolean {
  const content = extractTextContent(message.content).toLowerCase();
  return (
    content.includes('error') ||
    content.includes('failed') ||
    content.includes('exception') ||
    content.includes('permission denied') ||
    content.includes('not found') ||
    content.startsWith('err_') ||
    /\berr_[a-z_]+/i.test(content)
  );
}

function isUserConfirmedOperation(message: Message): boolean {
  const content = extractTextContent(message.content).toLowerCase();
  return (
    content.includes('confirmed') ||
    content.includes('approved') ||
    content.includes('executed') ||
    content.includes('shell command') ||
    content.includes('user confirmed')
  );
}

function isConfirmationMessage(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower === 'yes' ||
    lower === 'y' ||
    lower === 'confirm' ||
    lower === 'ok' ||
    lower === 'proceed' ||
    lower.includes('confirmed') ||
    lower.includes('approved') ||
    lower.includes('go ahead')
  );
}

function summariseAssistantMessage(message: Message): string | null {
  if (message.toolCalls && message.toolCalls.length > 0) {
    const names = message.toolCalls.map((tc) => tc.name).join(', ');
    return `Called tools: ${names}`;
  }
  const text = extractTextContent(message.content);
  if (text.length > 0) {
    const brief = text.slice(0, 100).replace(/\n/g, ' ');
    return text.length > 100 ? `${brief}…` : brief;
  }
  return null;
}

function summariseToolResult(message: Message): string | null {
  const name = message.name ?? 'tool';
  const text = extractTextContent(message.content);
  const brief = text.slice(0, 80).replace(/\n/g, ' ');
  return `${name}: ${brief}${text.length > 80 ? '…' : ''}`;
}
