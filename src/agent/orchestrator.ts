import type { LLMClient, StreamChunk } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextManager } from '../context/context-manager.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { SubAgentManager } from './sub-agent-manager.js';
import type { ContentBlock, Message } from '../types/messages.js';
import type { ToolCall } from '../types/tools.js';

export class OrchestratorAgent {
  /** Cached project context — collected once per session, not per message */
  private projectContextPromise: ReturnType<ContextManager['collectProjectContext']> | null = null;

  constructor(
    private readonly llmClient: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly contextManager: ContextManager,
    private readonly conversationManager: ConversationManager,
    private readonly subAgentManager?: SubAgentManager,
  ) {}

  /**
   * Clear the conversation history.
   * Exposed publicly so the REPL /clear command can call it without
   * resorting to unsafe type-casting (P1-6 fix).
   */
  clearConversation(): void {
    this.conversationManager.clear();
    // Also reset the cached project context so it is re-collected next turn.
    this.projectContextPromise = null;
  }

  /**
   * Returns the current conversation history (for session persistence).
   */
  getConversationHistory() {
    return this.conversationManager.getMessages();
  }

  /**
   * Public entry point: process a user message and stream response chunks.
   * Validates: Requirements 1.2, 5.1
   */
  async *processMessage(userMessage: string | ContentBlock[]): AsyncGenerator<StreamChunk> {
    // Add user message to conversation history
    this.conversationManager.addMessage({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    });

    // ── Context injection (Requirements 4.1, 4.2, 4.10) ──────────────────
    // Collect project context once and cache it for the session lifetime.
    if (!this.projectContextPromise) {
      this.projectContextPromise = this.contextManager.collectProjectContext(process.cwd());
    }
    const projectContext = await this.projectContextPromise;

    // Retrieve semantically relevant chunks for this specific message.
    // When userMessage is a ContentBlock[], extract text for context retrieval.
    const textForContext = Array.isArray(userMessage)
      ? userMessage
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join(' ')
      : userMessage;
    const relevantChunks = await this.contextManager.getRelevantContext(textForContext);

    // Build system prompt with project structure + relevant code context.
    const systemPrompt = this.contextManager.buildSystemPrompt(projectContext, relevantChunks);

    // Prepend system message if not already present, or replace the existing one.
    const messages = this.conversationManager.getMessages();
    const withSystem = this.injectSystemMessage(messages, systemPrompt);

    yield* this.runAgenticLoop(withSystem);
  }

  /**
   * Ensure the first message in the list is a system message with the given prompt.
   * Replaces an existing system message or prepends a new one.
   */
  private injectSystemMessage(messages: Message[], systemPrompt: string): Message[] {
    const systemMsg: Message = {
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now(),
    };

    if (messages.length > 0 && messages[0]!.role === 'system') {
      return [systemMsg, ...messages.slice(1)];
    }
    return [systemMsg, ...messages];
  }

  /**
   * Core agentic loop:
   * 1. Assemble messages (context + conversation history + tool definitions)
   * 2. Call LLM, stream responses
   * 3. If response contains tool_calls, execute all of them and append results
   * 4. Repeat until LLM returns a pure text response (no tool_call)
   * After each iteration, check token watermark and trigger compression if needed.
   * When compression runs, re-sync the local messages array from conversationManager
   * so the next LLM call uses the compressed history (P1-12 fix).
   * Validates: Requirements 3.10, 5.1
   */
  async *runAgenticLoop(messages: Message[]): AsyncGenerator<StreamChunk> {
    const tools = this.toolRegistry.getAll();
    const toolDefinitions = tools.map((t) => t.definition);

    // Use a mutable reference so we can re-sync after compression.
    let currentMessages = messages;

    while (true) {
      const stream = this.llmClient.chat(currentMessages, toolDefinitions);

      // Collect the full assistant turn before executing tools.
      // A single LLM response may contain multiple tool calls; we must
      // accumulate all of them before executing any, so the assistant message
      // added to history is complete (contains all tool calls for that turn).
      const pendingToolCalls: ToolCall[] = [];
      const assistantTextParts: string[] = [];

      for await (const chunk of stream) {
        yield chunk;

        if (chunk.type === 'text' && chunk.content) {
          assistantTextParts.push(chunk.content);
        }

        if (chunk.type === 'tool_call_end' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall as ToolCall);
        }
      }

      if (pendingToolCalls.length === 0) {
        // Pure text response — append assistant message and exit loop
        if (assistantTextParts.length > 0) {
          this.conversationManager.addMessage({
            role: 'assistant',
            content: assistantTextParts.join(''),
            timestamp: Date.now(),
          });
        }
        break;
      }

      // Append a single assistant message that contains ALL tool calls for this turn.
      // This matches the OpenAI multi-tool-call format where one assistant message
      // can carry multiple tool_calls entries.
      const assistantMsg: Message = {
        role: 'assistant',
        content: assistantTextParts.join(''),
        toolCalls: pendingToolCalls,
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(assistantMsg);
      currentMessages.push(assistantMsg);

      // Execute all tool calls and append their results to history.
      // Requirements 3.10: each result is a role="tool" message with the matching toolCallId.
      for (const toolCall of pendingToolCalls) {
        const toolResult = await this.toolRegistry.execute(toolCall);
        // Compress large tool outputs before storing in conversation history (P0-3 fix).
        const compressedContent = this.contextManager.compressToolOutput(
          toolResult.content,
          toolCall.name,
        );
        const toolResultMsg: Message = {
          role: 'tool',
          content: compressedContent,
          toolCallId: toolResult.toolCallId,
          name: toolCall.name,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(toolResultMsg);
        currentMessages.push(toolResultMsg);
      }

      // Check token watermark and compress if needed before next LLM call.
      // After compression, re-sync currentMessages from conversationManager so
      // the next LLM call uses the compressed history (P1-12 fix).
      await this.conversationManager.compressIfNeeded();
      const compressed = this.conversationManager.getMessages();
      // Re-inject system prompt at the top of the compressed history.
      const systemMsg = currentMessages.find((m) => m.role === 'system');
      if (systemMsg) {
        currentMessages = this.injectSystemMessage(compressed, systemMsg.content as string);
      } else {
        currentMessages = compressed;
      }
    }
  }
}
