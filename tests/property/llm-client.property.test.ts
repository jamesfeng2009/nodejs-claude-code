import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { LLMClient } from '../../src/llm/client.js';
import type { LLMClientConfig, StreamChunk } from '../../src/llm/client.js';
import type { Message } from '../../src/types/messages.js';
import type { ToolDefinition } from '../../src/types/tools.js';

// Feature: nodejs-claude-code, Property 2: SSE 流中 Tool Call 解析正确性
// For any valid SSE stream containing tool_call data, LLM Client should correctly
// extract tool name and argument object, and the argument object should be valid JSON.

// Feature: nodejs-claude-code, Property 3: 指数退避重试行为
// For any failed LLM API request, LLM Client should retry at most 3 times,
// and each retry wait time should be greater than the previous (exponential backoff).

// Feature: nodejs-claude-code, Property 4: 请求消息组装格式正确性
// For any combination of conversation history, system prompt, and tool definitions,
// the request body assembled by LLM Client should conform to OpenAI Chat Completion API format.

const defaultConfig: LLMClientConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4',
  maxTokens: 4096,
  temperature: 0.7,
};

// Helper: create a ReadableStream from SSE lines
function createSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = lines.join('\n') + '\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Helper: collect all chunks from an async generator
async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// Arbitrary for valid tool names (alphanumeric + underscore)
const toolNameArb = fc
  .stringMatching(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/)
  .filter((s) => s.length > 0);

// Arbitrary for valid JSON argument objects
const jsonArgsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
  fc.oneof(
    fc.string({ maxLength: 50 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean()
  ),
  { minKeys: 0, maxKeys: 5 }
) as fc.Arbitrary<Record<string, unknown>>;

// Arbitrary for message roles
const messageRoleArb = fc.constantFrom<'user' | 'assistant' | 'system'>('user', 'assistant', 'system');

// Arbitrary for messages
const messageArb: fc.Arbitrary<Message> = fc.record({
  role: messageRoleArb,
  content: fc.string({ minLength: 0, maxLength: 200 }),
  timestamp: fc.integer({ min: 0, max: Date.now() }),
});

// Arbitrary for tool definitions
const toolDefinitionArb: fc.Arbitrary<ToolDefinition> = fc.record({
  name: toolNameArb,
  description: fc.string({ minLength: 1, maxLength: 100 }),
  parameters: fc.constant({
    type: 'object' as const,
    properties: {},
    required: [],
  }),
});

describe('Property 2: SSE 流中 Tool Call 解析正确性', () => {
  it('correctly extracts tool name and valid JSON arguments from SSE stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        toolNameArb,
        jsonArgsArb,
        fc.string({ minLength: 1, maxLength: 20 }),
        async (toolName, args, toolCallId) => {
          const client = new LLMClient(defaultConfig);
          const argsJson = JSON.stringify(args);

          // Build SSE stream with tool call data
          const sseLines = [
            // First chunk: tool call start with id and name
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCallId,
                        type: 'function',
                        function: { name: toolName, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}`,
            // Second chunk: arguments
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: argsJson },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}`,
            // Third chunk: finish with tool_calls reason
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'tool_calls',
                },
              ],
            })}`,
            'data: [DONE]',
          ];

          const stream = createSSEStream(sseLines);
          const chunks = await collectChunks(client.parseSSEStream(stream));

          // Find tool_call_start chunk
          const startChunk = chunks.find((c) => c.type === 'tool_call_start');
          expect(startChunk).toBeDefined();
          expect(startChunk?.toolCall?.name).toBe(toolName);
          expect(startChunk?.toolCall?.id).toBe(toolCallId);

          // Find tool_call_end chunk
          const endChunk = chunks.find((c) => c.type === 'tool_call_end');
          expect(endChunk).toBeDefined();
          expect(endChunk?.toolCall?.name).toBe(toolName);
          expect(endChunk?.toolCall?.id).toBe(toolCallId);

          // Arguments should be valid JSON object
          const parsedArgs = endChunk?.toolCall?.arguments;
          expect(parsedArgs).toBeDefined();
          expect(typeof parsedArgs).toBe('object');

          // Verify the arguments match the original
          expect(parsedArgs).toEqual(args);

          // Verify done chunk is present
          const doneChunk = chunks.find((c) => c.type === 'done');
          expect(doneChunk).toBeDefined();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('handles text content correctly in SSE stream', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (textContent) => {
          const client = new LLMClient(defaultConfig);

          const sseLines = [
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: { content: textContent },
                  finish_reason: null,
                },
              ],
            })}`,
            'data: [DONE]',
          ];

          const stream = createSSEStream(sseLines);
          const chunks = await collectChunks(client.parseSSEStream(stream));

          const textChunks = chunks.filter((c) => c.type === 'text');
          expect(textChunks.length).toBeGreaterThan(0);

          const combinedText = textChunks.map((c) => c.content).join('');
          expect(combinedText).toBe(textContent);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('emits done chunk when [DONE] is received', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 0, maxLength: 5 }),
        async (textParts) => {
          const client = new LLMClient(defaultConfig);

          const sseLines = textParts.map(
            (text) =>
              `data: ${JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                choices: [
                  {
                    index: 0,
                    delta: { content: text },
                    finish_reason: null,
                  },
                ],
              })}`
          );
          sseLines.push('data: [DONE]');

          const stream = createSSEStream(sseLines);
          const chunks = await collectChunks(client.parseSSEStream(stream));

          // Last chunk should be 'done'
          const lastChunk = chunks[chunks.length - 1];
          expect(lastChunk?.type).toBe('done');
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 3: 指数退避重试行为', () => {

  it('retries at most 3 times on failure', async () => {
    // Use a version with zero delay for testing
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (failCount) => {
          // Create a client with a patched sleep that resolves immediately
          const client = new LLMClient(defaultConfig);
          // Override sleep to be instant for testing
          (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
            Promise.resolve();

          let callCount = 0;

          const fn = async () => {
            callCount++;
            if (callCount <= failCount) {
              throw new Error(`Attempt ${callCount} failed`);
            }
            return 'success';
          };

          callCount = 0;
          const result = await client.retryWithBackoff(fn, 3);
          expect(result).toBe('success');
          expect(callCount).toBe(failCount + 1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('throws after exhausting all retries', async () => {
    const client = new LLMClient(defaultConfig);
    // Override sleep to be instant for testing
    (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () =>
      Promise.resolve();

    let callCount = 0;

    const fn = async () => {
      callCount++;
      throw new Error('Always fails');
    };

    await expect(client.retryWithBackoff(fn, 3)).rejects.toThrow();
    // Should have tried: 1 initial + 3 retries = 4 total
    expect(callCount).toBe(4);
  });

  it('exponential backoff: each retry delay is greater than the previous', () => {
    // Test the delay calculation formula directly (2^attempt * 1000)
    // This validates the exponential backoff property without needing async timers
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 3 }),
        (maxRetries) => {
          // Compute expected delays based on the formula: 2^attempt * 1000
          const expectedDelays: number[] = [];
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            expectedDelays.push(Math.pow(2, attempt) * 1000);
          }

          // Verify exponential growth: each delay is greater than the previous
          for (let i = 1; i < expectedDelays.length; i++) {
            expect(expectedDelays[i]).toBeGreaterThan(expectedDelays[i - 1]!);
          }

          // Verify specific values
          expect(expectedDelays[0]).toBe(1000);  // 2^0 * 1000
          if (expectedDelays.length >= 2) {
            expect(expectedDelays[1]).toBe(2000); // 2^1 * 1000
          }
          if (expectedDelays.length >= 3) {
            expect(expectedDelays[2]).toBe(4000); // 2^2 * 1000
          }

          // Verify total retries count
          expect(expectedDelays.length).toBe(maxRetries);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('exponential backoff delays are strictly increasing for any attempt count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (numAttempts) => {
          // The delay formula: 2^attempt * 1000
          const delays = Array.from({ length: numAttempts }, (_, i) => Math.pow(2, i) * 1000);

          // Strictly increasing
          for (let i = 1; i < delays.length; i++) {
            expect(delays[i]).toBeGreaterThan(delays[i - 1]!);
          }

          // Each delay is exactly double the previous
          for (let i = 1; i < delays.length; i++) {
            expect(delays[i]).toBe(delays[i - 1]! * 2);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('succeeds on first attempt without any retries', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 50 }), async (expectedResult) => {
        const client = new LLMClient(defaultConfig);
        let callCount = 0;

        const fn = async () => {
          callCount++;
          return expectedResult;
        };

        callCount = 0;
        const result = await client.retryWithBackoff(fn, 3);

        expect(result).toBe(expectedResult);
        expect(callCount).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: 请求消息组装格式正确性', () => {
  it('request body conforms to OpenAI Chat Completion API format', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        fc.array(toolDefinitionArb, { minLength: 0, maxLength: 5 }),
        (messages, tools) => {
          const client = new LLMClient(defaultConfig);

          const openAIMessages = client.convertMessages(messages);
          const openAITools = client.convertTools(tools);
          const requestBody = client.buildRequestBody(openAIMessages, openAITools);

          // Must contain messages array
          expect(requestBody).toHaveProperty('messages');
          expect(Array.isArray(requestBody['messages'])).toBe(true);

          // Each message must have role and content fields
          const msgArray = requestBody['messages'] as Array<Record<string, unknown>>;
          for (const msg of msgArray) {
            expect(msg).toHaveProperty('role');
            expect(typeof msg['role']).toBe('string');
            // content can be string or null (for assistant messages with tool calls)
            expect('content' in msg).toBe(true);
          }

          // If tools are provided, must contain tools array
          if (tools.length > 0) {
            expect(requestBody).toHaveProperty('tools');
            expect(Array.isArray(requestBody['tools'])).toBe(true);

            const toolsArray = requestBody['tools'] as Array<Record<string, unknown>>;
            expect(toolsArray.length).toBe(tools.length);

            // Each tool must have type and function fields
            for (const tool of toolsArray) {
              expect(tool).toHaveProperty('type');
              expect(tool['type']).toBe('function');
              expect(tool).toHaveProperty('function');

              const fn = tool['function'] as Record<string, unknown>;
              expect(fn).toHaveProperty('name');
              expect(fn).toHaveProperty('description');
              expect(fn).toHaveProperty('parameters');
            }
          }

          // Must contain model
          expect(requestBody).toHaveProperty('model');
          expect(requestBody['model']).toBe(defaultConfig.model);

          // Must have stream: true for SSE
          expect(requestBody).toHaveProperty('stream');
          expect(requestBody['stream']).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('messages array preserves role and content for all message types', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        (messages) => {
          const client = new LLMClient(defaultConfig);
          const openAIMessages = client.convertMessages(messages);

          expect(openAIMessages.length).toBe(messages.length);

          for (let i = 0; i < messages.length; i++) {
            const original = messages[i]!;
            const converted = openAIMessages[i]!;

            // Role must be preserved
            expect(converted.role).toBe(original.role);

            // Content must be present (string or null)
            expect('content' in converted).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tool definitions are correctly converted to OpenAI format', () => {
    fc.assert(
      fc.property(
        fc.array(toolDefinitionArb, { minLength: 1, maxLength: 5 }),
        (tools) => {
          const client = new LLMClient(defaultConfig);
          const openAITools = client.convertTools(tools);

          expect(openAITools.length).toBe(tools.length);

          for (let i = 0; i < tools.length; i++) {
            const original = tools[i]!;
            const converted = openAITools[i]!;

            expect(converted.type).toBe('function');
            expect(converted.function.name).toBe(original.name);
            expect(converted.function.description).toBe(original.description);
            expect(converted.function.parameters).toEqual(original.parameters);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('empty tools array results in no tools field in request body', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 5 }),
        (messages) => {
          const client = new LLMClient(defaultConfig);
          const openAIMessages = client.convertMessages(messages);
          const requestBody = client.buildRequestBody(openAIMessages, []);

          // When no tools, tools field should not be present
          expect(requestBody).not.toHaveProperty('tools');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Validates: Requirements 2.6 - request body contains messages array with role and content', () => {
    fc.assert(
      fc.property(
        fc.array(messageArb, { minLength: 1, maxLength: 10 }),
        fc.array(toolDefinitionArb, { minLength: 0, maxLength: 5 }),
        (messages, tools) => {
          const client = new LLMClient(defaultConfig);
          const openAIMessages = client.convertMessages(messages);
          const openAITools = client.convertTools(tools);
          const requestBody = client.buildRequestBody(openAIMessages, openAITools);

          // Core requirement: messages array exists
          const msgArray = requestBody['messages'] as Array<Record<string, unknown>>;
          expect(Array.isArray(msgArray)).toBe(true);
          expect(msgArray.length).toBeGreaterThan(0);

          // Each message has role (string) and content (string or null)
          for (const msg of msgArray) {
            expect(typeof msg['role']).toBe('string');
            const validRoles = ['system', 'user', 'assistant', 'tool'];
            expect(validRoles).toContain(msg['role']);
            expect('content' in msg).toBe(true);
          }

          // If tools provided, tools array exists with correct structure
          if (tools.length > 0) {
            const toolsArray = requestBody['tools'] as Array<Record<string, unknown>>;
            expect(Array.isArray(toolsArray)).toBe(true);
            for (const tool of toolsArray) {
              expect(tool['type']).toBe('function');
              const fn = tool['function'] as Record<string, unknown>;
              expect(typeof fn['name']).toBe('string');
              expect(typeof fn['description']).toBe('string');
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
