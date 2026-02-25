import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { OrchestratorAgent } from '../../src/agent/orchestrator.js';
import { ConversationManager } from '../../src/conversation/manager.js';
import { KeyEntityCache } from '../../src/context/key-entity-cache.js';
import type { LLMClient, StreamChunk } from '../../src/llm/client.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { ContextManager } from '../../src/context/context-manager.js';
import type { Message } from '../../src/types/messages.js';
import type { ToolDefinition, ToolCall, ToolResult } from '../../src/types/tools.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock LLMClient that yields a single text chunk then done */
function makeMockLLMClient(chunks: StreamChunk[]): LLMClient {
  return {
    chat: async function* (_messages: Message[], _tools: ToolDefinition[]) {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LLMClient;
}

/** Create a mock ToolRegistry with no tools */
function makeMockToolRegistry(tools: Array<{ name: string; result: ToolResult }> = []): ToolRegistry {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  return {
    getAll: () => [],
    execute: async (toolCall: ToolCall): Promise<ToolResult> => {
      const tool = toolMap.get(toolCall.name);
      if (tool) return { ...tool.result, toolCallId: toolCall.id };
      return { toolCallId: toolCall.id, content: 'tool result', isError: false };
    },
  } as unknown as ToolRegistry;
}

/** Create a mock ContextManager */
function makeMockContextManager(): ContextManager {
  return {
    getRelevantContext: async () => [],
    buildSystemPrompt: () => 'system prompt',
    compressToolOutput: (output: string) => output,
    collectProjectContext: async () => ({
      workDir: '.',
      directoryTree: '',
      configFiles: [],
      gitignorePatterns: [],
    }),
  } as unknown as ContextManager;
}

/** Create a ConversationManager with generous watermarks */
function makeConversationManager(): ConversationManager {
  return new ConversationManager(
    { highWaterMark: 100_000, lowWaterMark: 50_000, maxContextTokens: 200_000 },
    new KeyEntityCache(),
  );
}

/** Collect all chunks from an AsyncGenerator */
async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Non-empty user message that is not a command (doesn't start with /) */
const userMessageArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => s.replace(/[\x00-\x1f]/g, 'x').trim())
  .filter((s) => s.length >= 1 && !s.startsWith('/'));

// ─── Property 1: 用户输入路由正确性 ──────────────────────────────────────────
// Feature: nodejs-claude-code, Property 1: 用户输入路由正确性
// For any non-command user message, processMessage always returns an AsyncGenerator.
// The generator yields at least one chunk for non-empty messages.
// Validates: Requirements 1.2

describe('Property 1: 用户输入路由正确性', () => {
  it('processMessage returns an AsyncGenerator for any non-empty user message', () => {
    fc.assert(
      fc.property(userMessageArb, (userMessage) => {
        const llmClient = makeMockLLMClient([
          { type: 'text', content: 'Hello!' },
          { type: 'done' },
        ]);
        const toolRegistry = makeMockToolRegistry();
        const contextManager = makeMockContextManager();
        const conversationManager = makeConversationManager();

        const orchestrator = new OrchestratorAgent(
          llmClient,
          toolRegistry,
          contextManager,
          conversationManager,
        );

        const result = orchestrator.processMessage(userMessage);

        // Must return an AsyncGenerator (has Symbol.asyncIterator)
        expect(typeof result[Symbol.asyncIterator]).toBe('function');
        // Must also have next() method
        expect(typeof result.next).toBe('function');
      }),
      { numRuns: 100 },
    );
  });

  it('processMessage yields at least one chunk for non-empty messages', async () => {
    await fc.assert(
      fc.asyncProperty(userMessageArb, async (userMessage) => {
        const llmClient = makeMockLLMClient([
          { type: 'text', content: 'response' },
          { type: 'done' },
        ]);
        const toolRegistry = makeMockToolRegistry();
        const contextManager = makeMockContextManager();
        const conversationManager = makeConversationManager();

        const orchestrator = new OrchestratorAgent(
          llmClient,
          toolRegistry,
          contextManager,
          conversationManager,
        );

        const chunks = await collectChunks(orchestrator.processMessage(userMessage));

        // At least one chunk should be yielded
        expect(chunks.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it('user message is added to conversation history before LLM call', async () => {
    await fc.assert(
      fc.asyncProperty(userMessageArb, async (userMessage) => {
        let capturedMessages: Message[] = [];

        const llmClient: LLMClient = {
          chat: async function* (messages: Message[], _tools: ToolDefinition[]) {
            capturedMessages = [...messages];
            yield { type: 'text', content: 'ok' } as StreamChunk;
            yield { type: 'done' } as StreamChunk;
          },
        } as unknown as LLMClient;

        const toolRegistry = makeMockToolRegistry();
        const contextManager = makeMockContextManager();
        const conversationManager = makeConversationManager();

        const orchestrator = new OrchestratorAgent(
          llmClient,
          toolRegistry,
          contextManager,
          conversationManager,
        );

        await collectChunks(orchestrator.processMessage(userMessage));

        // The user message should be in the messages passed to LLM
        const hasUserMessage = capturedMessages.some(
          (m) => m.role === 'user' && m.content === userMessage,
        );
        expect(hasUserMessage).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 11: 工具结果追加到对话历史 ─────────────────────────────────────
// Feature: nodejs-claude-code, Property 11: 工具结果追加到对话历史
// After a tool call is executed in the agentic loop, the tool result is always
// appended to conversation history before the next LLM call.
// Validates: Requirements 3.10

describe('Property 11: 工具结果追加到对话历史', () => {
  it('tool result is appended to conversation history with correct toolCallId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (toolCallId, toolName) => {
          const toolCall: ToolCall = {
            id: toolCallId,
            name: toolName,
            arguments: {},
          };

          // LLM first returns a tool_call, then a text response
          const firstCallChunks: StreamChunk[] = [
            { type: 'tool_call_start', toolCall: { id: toolCallId, name: toolName, arguments: {} } },
            { type: 'tool_call_end', toolCall },
          ];
          const secondCallChunks: StreamChunk[] = [
            { type: 'text', content: 'done' },
            { type: 'done' },
          ];

          let callCount = 0;
          let messagesOnSecondCall: Message[] = [];

          const llmClient: LLMClient = {
            chat: async function* (messages: Message[], _tools: ToolDefinition[]) {
              callCount++;
              if (callCount === 1) {
                for (const chunk of firstCallChunks) yield chunk;
              } else {
                messagesOnSecondCall = [...messages];
                for (const chunk of secondCallChunks) yield chunk;
              }
            },
          } as unknown as LLMClient;

          const toolRegistry = makeMockToolRegistry([
            {
              name: toolName,
              result: { toolCallId, content: 'tool output', isError: false },
            },
          ]);
          const contextManager = makeMockContextManager();
          const conversationManager = makeConversationManager();

          const orchestrator = new OrchestratorAgent(
            llmClient,
            toolRegistry,
            contextManager,
            conversationManager,
          );

          await collectChunks(orchestrator.processMessage('test'));

          // The second LLM call should include the tool result message
          const toolResultMsg = messagesOnSecondCall.find(
            (m) => m.role === 'tool' && m.toolCallId === toolCallId,
          );
          expect(toolResultMsg).toBeDefined();
          expect(toolResultMsg?.content).toBe('tool output');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tool result message has role "tool" and correct toolCallId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (toolCallId) => {
          const toolName = 'test_tool';
          const toolCall: ToolCall = { id: toolCallId, name: toolName, arguments: {} };

          let callCount = 0;

          const llmClient: LLMClient = {
            chat: async function* (_messages: Message[], _tools: ToolDefinition[]) {
              callCount++;
              if (callCount === 1) {
                yield { type: 'tool_call_start', toolCall: { id: toolCallId, name: toolName, arguments: {} } } as StreamChunk;
                yield { type: 'tool_call_end', toolCall } as StreamChunk;
              } else {
                yield { type: 'text', content: 'final' } as StreamChunk;
                yield { type: 'done' } as StreamChunk;
              }
            },
          } as unknown as LLMClient;

          const toolRegistry = makeMockToolRegistry([
            { name: toolName, result: { toolCallId, content: 'result', isError: false } },
          ]);
          const contextManager = makeMockContextManager();
          const conversationManager = makeConversationManager();

          const orchestrator = new OrchestratorAgent(
            llmClient,
            toolRegistry,
            contextManager,
            conversationManager,
          );

          await collectChunks(orchestrator.processMessage('hello'));

          // Check conversation history contains tool result
          const history = conversationManager.getMessages();
          const toolMsg = history.find(
            (m) => m.role === 'tool' && m.toolCallId === toolCallId,
          );

          expect(toolMsg).toBeDefined();
          expect(toolMsg?.role).toBe('tool');
          expect(toolMsg?.toolCallId).toBe(toolCallId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('conversation history grows after each tool call', async () => {
    const toolCallId = 'tc-001';
    const toolName = 'my_tool';
    const toolCall: ToolCall = { id: toolCallId, name: toolName, arguments: {} };

    let callCount = 0;

    const llmClient: LLMClient = {
      chat: async function* (_messages: Message[], _tools: ToolDefinition[]) {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call_start', toolCall: { id: toolCallId, name: toolName, arguments: {} } } as StreamChunk;
          yield { type: 'tool_call_end', toolCall } as StreamChunk;
        } else {
          yield { type: 'text', content: 'done' } as StreamChunk;
          yield { type: 'done' } as StreamChunk;
        }
      },
    } as unknown as LLMClient;

    const toolRegistry = makeMockToolRegistry([
      { name: toolName, result: { toolCallId, content: 'output', isError: false } },
    ]);
    const contextManager = makeMockContextManager();
    const conversationManager = makeConversationManager();

    const orchestrator = new OrchestratorAgent(
      llmClient,
      toolRegistry,
      contextManager,
      conversationManager,
    );

    await collectChunks(orchestrator.processMessage('run tool'));

    const history = conversationManager.getMessages();
    // Should have: user + assistant (with tool call) + tool result + assistant (final)
    expect(history.length).toBeGreaterThanOrEqual(3);

    const roles = history.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('tool');
    expect(roles).toContain('assistant');
  });
});
