import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { SubAgent, SubAgentManager } from '../../src/agent/sub-agent-manager.js';
import type { ConversationContext, SubAgentResult } from '../../src/agent/sub-agent-manager.js';
import type { LLMClient, StreamChunk } from '../../src/llm/client.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { Message } from '../../src/types/messages.js';
import type { ToolDefinition } from '../../src/types/tools.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a mock LLMClient that yields a single text chunk then done */
function makeMockLLMClient(response = 'task done'): LLMClient {
  return {
    chat: async function* (_messages: Message[], _tools: ToolDefinition[]) {
      yield { type: 'text', content: response } as StreamChunk;
      yield { type: 'done' } as StreamChunk;
    },
  } as unknown as LLMClient;
}

/** Create a mock LLMClient that throws an error */
function makeErrorLLMClient(errorMsg: string): LLMClient {
  return {
    chat: async function* (_messages: Message[], _tools: ToolDefinition[]) {
      throw new Error(errorMsg);
      // eslint-disable-next-line no-unreachable
      yield { type: 'done' } as StreamChunk;
    },
  } as unknown as LLMClient;
}

/** Create a minimal mock ToolRegistry */
function makeMockToolRegistry(): ToolRegistry {
  return {
    getAll: () => [],
    execute: async () => ({ toolCallId: '', content: '', isError: false }),
  } as unknown as ToolRegistry;
}

/** Build a ConversationContext with some messages */
function makeParentContext(messageCount: number): ConversationContext {
  const messages: Message[] = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: Date.now() + i,
  }));
  return { messages };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const taskArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .map((s) => s.replace(/[\x00-\x1f]/g, 'x').trim())
  .filter((s) => s.length >= 1);

const parentMessageCountArb = fc.integer({ min: 0, max: 10 });

// ─── Property 26: Sub Agent 隔离性与能力一致性 ────────────────────────────────
// Feature: nodejs-claude-code, Property 26: Sub Agent 隔离性与能力一致性
// Sub agents have independent conversation contexts. Mutations to one sub-agent's
// context do not affect another sub-agent's context or the parent context.
// Both sub-agents share the same LLMClient and ToolRegistry instances.
// Validates: Requirements 5.2, 5.3

describe('Property 26: Sub Agent 隔离性与能力一致性', () => {
  it('sub-agent context is independent from parent context', () => {
    fc.assert(
      fc.property(taskArb, parentMessageCountArb, (task, parentMsgCount) => {
        const llmClient = makeMockLLMClient();
        const toolRegistry = makeMockToolRegistry();
        const manager = new SubAgentManager(llmClient, toolRegistry);

        const parentContext = makeParentContext(parentMsgCount);
        const originalParentLength = parentContext.messages.length;

        const subAgent = manager.createSubAgent(task, parentContext);
        const subContext = subAgent.getContext();

        // Sub-agent context starts empty (independent)
        expect(subContext.messages.length).toBe(0);

        // Mutating sub-agent context does not affect parent
        subContext.messages.push({
          role: 'user',
          content: 'injected',
          timestamp: Date.now(),
        });

        expect(parentContext.messages.length).toBe(originalParentLength);
      }),
      { numRuns: 100 },
    );
  });

  it('two sub-agents have independent contexts that do not interfere', () => {
    fc.assert(
      fc.property(taskArb, taskArb, (task1, task2) => {
        const llmClient = makeMockLLMClient();
        const toolRegistry = makeMockToolRegistry();
        const manager = new SubAgentManager(llmClient, toolRegistry);

        const parentContext = makeParentContext(3);

        const subAgent1 = manager.createSubAgent(task1, parentContext);
        const subAgent2 = manager.createSubAgent(task2, parentContext);

        const ctx1 = subAgent1.getContext();
        const ctx2 = subAgent2.getContext();

        // Both start empty
        expect(ctx1.messages.length).toBe(0);
        expect(ctx2.messages.length).toBe(0);

        // Mutating ctx1 does not affect ctx2
        ctx1.messages.push({
          role: 'user',
          content: 'only in agent 1',
          timestamp: Date.now(),
        });

        expect(ctx2.messages.length).toBe(0);
        expect(ctx1.messages.length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it('sub-agents share the same LLMClient and ToolRegistry instances as the manager', () => {
    fc.assert(
      fc.property(taskArb, taskArb, (task1, task2) => {
        const llmClient = makeMockLLMClient();
        const toolRegistry = makeMockToolRegistry();
        const manager = new SubAgentManager(llmClient, toolRegistry);

        const parentContext = makeParentContext(2);

        const subAgent1 = manager.createSubAgent(task1, parentContext);
        const subAgent2 = manager.createSubAgent(task2, parentContext);

        // Both sub-agents share the exact same LLMClient instance
        expect(subAgent1.getLLMClient()).toBe(llmClient);
        expect(subAgent2.getLLMClient()).toBe(llmClient);
        expect(subAgent1.getLLMClient()).toBe(subAgent2.getLLMClient());

        // Both sub-agents share the exact same ToolRegistry instance
        expect(subAgent1.getToolRegistry()).toBe(toolRegistry);
        expect(subAgent2.getToolRegistry()).toBe(toolRegistry);
        expect(subAgent1.getToolRegistry()).toBe(subAgent2.getToolRegistry());
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 27: Sub Agent 结果返回完整性 ────────────────────────────────────
// Feature: nodejs-claude-code, Property 27: Sub Agent 结果返回完整性
// SubAgentResult always has all required fields: success (boolean), summary (string),
// artifacts (array). On success, error is undefined. On failure, error is a non-empty string.
// Validates: Requirements 5.4

describe('Property 27: Sub Agent 结果返回完整性', () => {
  it('successful execution returns result with all required fields', async () => {
    await fc.assert(
      fc.asyncProperty(taskArb, async (task) => {
        const llmClient = makeMockLLMClient('task completed successfully');
        const toolRegistry = makeMockToolRegistry();
        const manager = new SubAgentManager(llmClient, toolRegistry);

        const parentContext = makeParentContext(0);
        const subAgent = manager.createSubAgent(task, parentContext);
        const result: SubAgentResult = await manager.executeSubAgent(subAgent);

        // All required fields must be present
        expect(typeof result.success).toBe('boolean');
        expect(typeof result.summary).toBe('string');
        expect(Array.isArray(result.artifacts)).toBe(true);

        // On success: error must be undefined
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('failed execution returns result with error as non-empty string', async () => {
    await fc.assert(
      fc.asyncProperty(
        taskArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        async (task, errorMsg) => {
          const llmClient = makeErrorLLMClient(errorMsg);
          const toolRegistry = makeMockToolRegistry();
          const manager = new SubAgentManager(llmClient, toolRegistry);

          const parentContext = makeParentContext(0);
          const subAgent = manager.createSubAgent(task, parentContext);
          const result: SubAgentResult = await manager.executeSubAgent(subAgent);

          // All required fields must be present
          expect(typeof result.success).toBe('boolean');
          expect(typeof result.summary).toBe('string');
          expect(Array.isArray(result.artifacts)).toBe(true);

          // On failure: success=false, error is a non-empty string
          expect(result.success).toBe(false);
          expect(typeof result.error).toBe('string');
          expect((result.error as string).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('SubAgent constructed directly also returns complete result', async () => {
    await fc.assert(
      fc.asyncProperty(taskArb, async (task) => {
        const llmClient = makeMockLLMClient('direct result');
        const toolRegistry = makeMockToolRegistry();
        const parentContext = makeParentContext(1);

        const subAgent = new SubAgent(task, llmClient, toolRegistry, parentContext);
        const result: SubAgentResult = await subAgent.execute();

        expect(typeof result.success).toBe('boolean');
        expect(typeof result.summary).toBe('string');
        expect(Array.isArray(result.artifacts)).toBe(true);

        if (result.success) {
          expect(result.error).toBeUndefined();
        } else {
          expect(typeof result.error).toBe('string');
          expect((result.error as string).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
