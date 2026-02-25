import type { LLMClient, StreamChunk } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextManager } from '../context/context-manager.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { SubAgentManager } from './sub-agent-manager.js';
import type { Message } from '../types/messages.js';
import type { ToolCall } from '../types/tools.js';

export class OrchestratorAgent {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly contextManager: ContextManager,
    private readonly conversationManager: ConversationManager,
    private readonly subAgentManager?: SubAgentManager,
  ) {}

  /**
   * Public entry point: process a user message and stream response chunks.
   * Validates: Requirements 1.2, 5.1
   */
  async *processMessage(userMessage: string): AsyncGenerator<StreamChunk> {
    // Add user message to conversation history
    this.conversationManager.addMessage({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    const messages = this.conversationManager.getMessages();
    yield* this.runAgenticLoop(messages);
  }

  /**
   * Core agentic loop:
   * 1. Assemble messages (context + conversation history + tool definitions)
   * 2. Call LLM, stream responses
   * 3. If response contains tool_call, execute the tool and append tool_result to history
   * 4. Repeat until LLM returns pure text response (no tool_call)
   * After each iteration, check token watermark and trigger compression if needed.
   * Validates: Requirements 3.10, 5.1
   */
  async *runAgenticLoop(messages: Message[]): AsyncGenerator<StreamChunk> {
    const tools = this.toolRegistry.getAll();
    const toolDefinitions = tools.map((t) => t.definition);

    while (true) {
      const stream = this.llmClient.chat(messages, toolDefinitions);
      let hasToolCall = false;
      let currentToolCall: Partial<ToolCall> | null = null;
      const assistantContent: string[] = [];

      for await (const chunk of stream) {
        yield chunk;

        if (chunk.type === 'text' && chunk.content) {
          assistantContent.push(chunk.content);
        }

        if (chunk.type === 'tool_call_start' && chunk.toolCall) {
          currentToolCall = { ...chunk.toolCall };
        }

        if (chunk.type === 'tool_call_args' && currentToolCall && chunk.content) {
          // Args are accumulated in tool_call_end
        }

        if (chunk.type === 'tool_call_end' && chunk.toolCall) {
          hasToolCall = true;
          const toolCall = chunk.toolCall as ToolCall;

          // Append assistant message with tool call to history
          const assistantMsg: Message = {
            role: 'assistant',
            content: assistantContent.join(''),
            toolCalls: [toolCall],
            timestamp: Date.now(),
          };
          this.conversationManager.addMessage(assistantMsg);
          messages.push(assistantMsg);

          // Execute the tool
          const toolResult = await this.toolRegistry.execute(toolCall);

          // Append tool result to conversation history
          // Validates: Requirements 3.10
          const toolResultMsg: Message = {
            role: 'tool',
            content: toolResult.content,
            toolCallId: toolResult.toolCallId,
            name: toolCall.name,
            timestamp: Date.now(),
          };
          this.conversationManager.addMessage(toolResultMsg);
          messages.push(toolResultMsg);

          // Reset for next tool call
          currentToolCall = null;
          assistantContent.length = 0;
        }
      }

      if (!hasToolCall) {
        // Pure text response — append assistant message and exit loop
        if (assistantContent.length > 0) {
          this.conversationManager.addMessage({
            role: 'assistant',
            content: assistantContent.join(''),
            timestamp: Date.now(),
          });
        }
        break;
      }

      // Check token watermark and compress if needed
      await this.conversationManager.compressIfNeeded();
    }
  }
}
