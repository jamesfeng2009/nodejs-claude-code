import { readFile } from 'fs/promises';
import type { LLMClient, StreamChunk } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextManager } from '../context/context-manager.js';
import type { ConversationManager } from '../conversation/manager.js';
import type { SubAgentManager } from './sub-agent-manager.js';
import type { ContentBlock, Message } from '../types/messages.js';
import type { ToolCall } from '../types/tools.js';
import { loadMemoryFiles, formatMemorySection } from '../context/memory-loader.js';
import { TokenTracker } from '../session/token-tracker.js';
import { isFileContentReference, type FileContentReference } from '../types/context.js';
import { PermissionChecker } from '../context/permission-checker.js';

/**
 * Expand FileContentReference placeholders in tool messages to actual file content.
 * Creates a shallow copy of messages — does NOT mutate the originals.
 * Requirements: 6.2, 6.3, 6.4
 */
async function expandFileReferences(messages: Message[]): Promise<Message[]> {
  const expanded: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.content);
      } catch {
        expanded.push(msg);
        continue;
      }

      if (isFileContentReference(parsed)) {
        const ref = parsed as FileContentReference;
        let fileContent: string;
        try {
          fileContent = await readFile(ref.filePath, 'utf-8');
        } catch (err: unknown) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') {
            fileContent = `文件已不存在: ${ref.filePath}`;
          } else {
            fileContent = `无法读取文件: ${ref.filePath}: ${nodeErr.message ?? String(err)}`;
          }
        }
        expanded.push({ ...msg, content: fileContent });
        continue;
      }
    }
    expanded.push(msg);
  }
  return expanded;
}

export class OrchestratorAgent {
  /** Cached project context — collected once per session, not per message */
  private projectContextPromise: ReturnType<ContextManager['collectProjectContext']> | null = null;

  /** Token usage tracker — exposed for REPL /cost command (Requirements 3.2, 3.3) */
  readonly tokenTracker: TokenTracker;

  /** Permission checker — loaded once per session start (Requirements 10.1, 10.5) */
  private readonly permissionChecker: PermissionChecker | null;

  constructor(
    private readonly llmClient: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    private readonly contextManager: ContextManager,
    private readonly conversationManager: ConversationManager,
    private readonly subAgentManager?: SubAgentManager,
    tokenTracker?: TokenTracker,
    workDir?: string,
  ) {
    this.tokenTracker = tokenTracker ?? new TokenTracker();
    this.permissionChecker = workDir ? new PermissionChecker(workDir) : null;
  }

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
    // Load permission config at session start (Requirements 10.1, 10.5)
    if (this.permissionChecker) {
      await this.permissionChecker.load();
    }

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
    // Reload CLAUDE.md memory files on each processMessage invocation (Requirement 2.4).
    const memoryFiles = await loadMemoryFiles(process.cwd());
    const memorySection = formatMemorySection(memoryFiles);
    const systemPrompt = this.contextManager.buildSystemPrompt(projectContext, relevantChunks)
      + (memorySection ? '\n\n' + memorySection : '');

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
      const expandedMessages = await expandFileReferences(currentMessages);
      const stream = this.llmClient.chat(expandedMessages, toolDefinitions);

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
        // Permission check before tool execution (Requirements 10.1, 10.5, 11.1–11.6)
        if (this.permissionChecker) {
          const permResult = this.permissionChecker.check(
            toolCall.name,
            toolCall.arguments as Record<string, unknown>,
          );
          if (!permResult.allowed) {
            const deniedMsg: Message = {
              role: 'tool',
              content: `Permission denied: ${permResult.reason}`,
              toolCallId: toolCall.id,
              name: toolCall.name,
              timestamp: Date.now(),
            };
            this.conversationManager.addMessage(deniedMsg);
            currentMessages.push(deniedMsg);
            continue;
          }
        }

        const toolResult = await this.toolRegistry.execute(toolCall);

        let storedContent: string;
        if (toolCall.name === 'file_read') {
          // Store a FileContentReference placeholder instead of raw file content.
          // The actual content will be re-read from disk via expandFileReferences
          // before each LLM call. Requirements: 6.1, 6.4
          const ref: FileContentReference = {
            __type: 'file_content_reference',
            filePath: toolCall.arguments['path'] as string,
            readAtMtime: Date.now(),
          };
          storedContent = JSON.stringify(ref);
        } else {
          // Compress large tool outputs before storing in conversation history (P0-3 fix).
          storedContent = this.contextManager.compressToolOutput(
            toolResult.content,
            toolCall.name,
          );
        }

        const toolResultMsg: Message = {
          role: 'tool',
          content: storedContent,
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
