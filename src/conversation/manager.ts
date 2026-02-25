import type { Message } from '../types/messages.js';
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
   */
  async compressIfNeeded(): Promise<void> {
    if (this.getTokenCount() < this.config.highWaterMark) {
      return;
    }

    // Separate system messages (always keep) from the rest
    const systemMessages = this.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = this.messages.filter((m) => m.role !== 'system');

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
    while (
      finalSystemTokens + estimateTokens(recentMessages) > this.config.lowWaterMark &&
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
      // Extract entities from all message content
      const entities = this.entityCache.extractEntities(msg.content);
      for (const entity of entities) {
        keyEntities.add(`${entity.type}:${entity.value}`);
      }

      if (msg.role === 'user') {
        // User messages may contain decisions / confirmations
        if (isConfirmationMessage(msg.content)) {
          decisions.push(msg.content.trim());
        }
      } else if (msg.role === 'assistant') {
        // Summarise assistant actions
        const summary = summariseAssistantMessage(msg);
        if (summary) operationHistory.push(summary);
      } else if (msg.role === 'tool') {
        // Capture errors from tool results
        if (isErrorToolResult(msg)) {
          errors.push(msg.content.trim());
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

  /**
   * Determine whether a tool result message should be compressed.
   * Error messages and user-confirmed operations are NOT compressed.
   * File content and large outputs CAN be summarised.
   */
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
    // Build a compact single-line summary to minimize token usage
    const parts: string[] = [];

    if (summary.keyEntities.length > 0) {
      // Limit to first 5 entities, truncate each to 30 chars
      const entities = summary.keyEntities.slice(0, 5).map((e) => e.slice(0, 30));
      parts.push(`entities:${entities.join(',')}`);
    }
    if (summary.decisions.length > 0) {
      const decisions = summary.decisions.slice(0, 3).map((d) => d.slice(0, 30));
      parts.push(`decisions:${decisions.join(',')}`);
    }
    if (summary.errors.length > 0) {
      const errors = summary.errors.slice(0, 3).map((e) => e.slice(0, 40));
      parts.push(`errors:${errors.join(',')}`);
    }
    if (summary.operationHistory.length > 0) {
      const ops = summary.operationHistory.slice(0, 3).map((o) => o.slice(0, 30));
      parts.push(`ops:${ops.join(',')}`);
    }

    const content = `[Conversation Summary] ${parts.join('; ')}`;

    return {
      role: 'system',
      content,
      timestamp: Date.now(),
    };
  }
}

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length;
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += tc.name.length + JSON.stringify(tc.arguments).length;
      }
    }
  }
  // 4 characters ≈ 1 token
  return Math.ceil(chars / 4);
}

// ─── Message classification helpers ──────────────────────────────────────────

function isErrorToolResult(message: Message): boolean {
  const content = message.content.toLowerCase();
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
  const content = message.content.toLowerCase();
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
  if (message.content.length > 0) {
    // Keep first 100 chars as a brief summary
    const brief = message.content.slice(0, 100).replace(/\n/g, ' ');
    return message.content.length > 100 ? `${brief}…` : brief;
  }
  return null;
}

function summariseToolResult(message: Message): string | null {
  const name = message.name ?? 'tool';
  const brief = message.content.slice(0, 80).replace(/\n/g, ' ');
  return `${name}: ${brief}${message.content.length > 80 ? '…' : ''}`;
}
