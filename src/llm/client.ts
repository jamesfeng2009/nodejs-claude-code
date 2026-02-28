import type { Message, ContentBlock, ImageBlock, FileBlock } from '../types/messages.js';
import type { ToolDefinition, ToolCall } from '../types/tools.js';
import type { MediaStore } from '../media/media-store.js';
import type { TokenTracker } from '../session/token-tracker.js';

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_args' | 'tool_call_end' | 'done';
  content?: string;
  toolCall?: Partial<ToolCall>;
}

// Claude API multimodal content block types
interface ClaudeImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

interface ClaudeDocumentBlock {
  type: 'document';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

type ClaudeContentBlock = ClaudeImageBlock | ClaudeDocumentBlock | ClaudeTextBlock;

// OpenAI-compatible request/response types
interface OpenAIMessage {
  role: string;
  content: string | ClaudeContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface OpenAIDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    delta: OpenAIDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LLMClient {
  private config: LLMClientConfig;
  private mediaStore?: MediaStore;
  private tokenTracker?: TokenTracker;

  constructor(config: LLMClientConfig, mediaStore?: MediaStore, tokenTracker?: TokenTracker) {
    this.config = config;
    this.mediaStore = mediaStore;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Send a chat request and return an AsyncGenerator of StreamChunks.
   * Uses SSE protocol for streaming responses.
   * Includes exponential backoff retry (max 3 retries).
   */
  async *chat(messages: Message[], tools: ToolDefinition[]): AsyncGenerator<StreamChunk> {
    const openAIMessages = await this.convertMessages(messages);
    const openAITools = this.convertTools(tools);

    const requestBody = this.buildRequestBody(openAIMessages, openAITools);

    const response = await this.retryWithBackoff(
      () => this.sendRequest(requestBody),
      3
    );

    yield* this.parseSSEStream(response.body!);
  }

  /**
   * Build the OpenAI-compatible request body.
   * Validates: Requirements 2.6
   */
  buildRequestBody(
    messages: OpenAIMessage[],
    tools: OpenAITool[]
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (tools.length > 0) {
      body['tools'] = tools;
    }

    return body;
  }

  /**
   * Convert internal Message format to OpenAI/Claude format.
   * Supports both plain string content and ContentBlock arrays.
   */
  async convertMessages(messages: Message[]): Promise<OpenAIMessage[]> {
    const result: OpenAIMessage[] = [];

    for (const msg of messages) {
      const openAIMsg: OpenAIMessage = {
        role: msg.role,
        content: typeof msg.content === 'string'
          ? msg.content
          : await this.convertContentBlocks(msg.content),
      };

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        openAIMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
        // For assistant messages with tool calls, content can be null
        if (msg.role === 'assistant' && !msg.content) {
          openAIMsg.content = null;
        }
      }

      if (msg.toolCallId) {
        openAIMsg.tool_call_id = msg.toolCallId;
      }

      if (msg.name) {
        openAIMsg.name = msg.name;
      }

      result.push(openAIMsg);
    }

    return result;
  }

  /**
   * Convert an array of ContentBlocks to Claude API format.
   */
  private async convertContentBlocks(blocks: ContentBlock[]): Promise<ClaudeContentBlock[]> {
    const result: ClaudeContentBlock[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        result.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        result.push(await this.convertImageBlock(block));
      } else if (block.type === 'file') {
        result.push(await this.convertFileBlock(block));
      }
    }

    return result;
  }

  private async convertImageBlock(block: ImageBlock): Promise<ClaudeImageBlock> {
    if (block.data) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      };
    }
    if (block.url) {
      return {
        type: 'image',
        source: { type: 'url', url: block.url },
      };
    }
    if (block.mediaId) {
      const resolved = await this.resolveMediaId(block.mediaId);
      return {
        type: 'image',
        source: { type: 'base64', media_type: resolved.mimeType, data: resolved.data },
      };
    }
    throw new Error('ContentBlock must have either data, url, or mediaId');
  }

  private async convertFileBlock(block: FileBlock): Promise<ClaudeDocumentBlock> {
    if (block.data) {
      return {
        type: 'document',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      };
    }
    if (block.url) {
      return {
        type: 'document',
        source: { type: 'url', url: block.url },
      };
    }
    if (block.mediaId) {
      const resolved = await this.resolveMediaId(block.mediaId);
      return {
        type: 'document',
        source: { type: 'base64', media_type: resolved.mimeType, data: resolved.data },
      };
    }
    throw new Error('ContentBlock must have either data, url, or mediaId');
  }

  private async resolveMediaId(mediaId: string): Promise<{ data: string; mimeType: string }> {
    if (!this.mediaStore) {
      throw new Error(`Media file not found for mediaId: ${mediaId}`);
    }
    return this.mediaStore.resolve(mediaId);
  }

  /**
   * Convert internal ToolDefinition format to OpenAI format.
   */
  convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Send the HTTP request to the LLM API.
   */
  private async sendRequest(body: Record<string, unknown>): Promise<Response> {
    const url = `${this.config.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `LLM API request failed: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    return response;
  }

  /**
   * Parse SSE stream data and yield StreamChunks.
   * Extracts text, tool_call_start, tool_call_args, tool_call_end, done events.
   * Validates: Requirements 2.2, 2.3
   */
  async *parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool call state for assembling tool calls
    const toolCallBuffers = new Map<
      number,
      { id: string; name: string; argsBuffer: string }
    >();

    // Track whether usage was recorded for this stream
    let usageRecorded = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed === '' || trimmed.startsWith(':')) {
            // Empty line or comment - skip
            continue;
          }

          if (!trimmed.startsWith('data: ')) {
            continue;
          }

          const data = trimmed.slice(6); // Remove "data: " prefix

          if (data === '[DONE]') {
            if (!usageRecorded && this.tokenTracker) {
              console.warn('[TokenTracker] No usage field found in SSE stream; token counts not recorded.');
            }
            yield { type: 'done' };
            return;
          }

          let parsed: OpenAIStreamChunk;
          try {
            parsed = JSON.parse(data) as OpenAIStreamChunk;
          } catch {
            // Skip malformed JSON
            continue;
          }

          // Detect usage field (some providers attach it to the final chunk)
          if (parsed.usage && this.tokenTracker) {
            this.tokenTracker.record(
              this.config.model,
              parsed.usage.prompt_tokens,
              parsed.usage.completion_tokens,
            );
            usageRecorded = true;
          }

          for (const choice of parsed.choices) {
            const delta = choice.delta;

            // Handle text content
            if (delta.content != null && delta.content !== '') {
              yield { type: 'text', content: delta.content };
            }

            // Handle tool calls
            if (delta.tool_calls) {
              for (const toolCallDelta of delta.tool_calls) {
                const idx = toolCallDelta.index;

                if (toolCallDelta.id) {
                  // New tool call starting
                  toolCallBuffers.set(idx, {
                    id: toolCallDelta.id,
                    name: toolCallDelta.function?.name ?? '',
                    argsBuffer: toolCallDelta.function?.arguments ?? '',
                  });

                  yield {
                    type: 'tool_call_start',
                    toolCall: {
                      id: toolCallDelta.id,
                      name: toolCallDelta.function?.name ?? '',
                      arguments: {},
                    },
                  };
                } else {
                  // Continuing tool call - accumulate args
                  const existing = toolCallBuffers.get(idx);
                  if (existing) {
                    if (toolCallDelta.function?.name) {
                      // Some providers send name in continuation deltas — ignore to avoid duplication
                      // (OpenAI-compatible streams only send name in the first delta)
                    }
                    if (toolCallDelta.function?.arguments) {
                      existing.argsBuffer += toolCallDelta.function.arguments;
                      yield {
                        type: 'tool_call_args',
                        toolCall: {
                          id: existing.id,
                          name: existing.name,
                        },
                        content: toolCallDelta.function.arguments,
                      };
                    }
                  }
                }
              }
            }

            // Handle finish reason
            if (choice.finish_reason === 'tool_calls') {
              // Emit tool_call_end for all accumulated tool calls
              for (const [, toolCallData] of toolCallBuffers) {
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(toolCallData.argsBuffer) as Record<string, unknown>;
                } catch {
                  parsedArgs = {};
                }

                yield {
                  type: 'tool_call_end',
                  toolCall: {
                    id: toolCallData.id,
                    name: toolCallData.name,
                    arguments: parsedArgs,
                  },
                };
              }
              toolCallBuffers.clear();
            }
          }
        }
      }

      // Stream ended without [DONE] — warn if usage was never recorded
      if (!usageRecorded && this.tokenTracker) {
        console.warn('[TokenTracker] No usage field found in SSE stream; token counts not recorded.');
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Retry a function with exponential backoff.
   * Max retries: 3, with delays of 1s, 2s, 4s.
   * Validates: Requirements 2.4, 2.5
   */
  async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          await this.sleep(delayMs);
        }
      }
    }

    throw new Error(
      `LLM API request failed after ${maxRetries} retries: ${lastError?.message ?? 'Unknown error'}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
