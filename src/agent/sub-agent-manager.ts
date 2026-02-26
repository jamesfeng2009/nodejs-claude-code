import type { LLMClient } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Message } from '../types/messages.js';
import type { ToolCall } from '../types/tools.js';

export interface ConversationContext {
  messages: Message[];
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  artifacts: string[];
  error?: string;
}

export class SubAgent {
  /** Independent conversation context — does NOT share with parent */
  private readonly ownContext: ConversationContext;

  constructor(
    private readonly task: string,
    private readonly llmClient: LLMClient,
    private readonly toolRegistry: ToolRegistry,
    parentContext: ConversationContext,
  ) {
    // Create a fresh, independent context.
    // Inherit parent system messages (constraints/decisions) so the sub-agent
    // is aware of key project context, but does NOT inherit conversation history (P1-8 fix).
    const parentSystemMessages = parentContext.messages.filter((m) => m.role === 'system');
    this.ownContext = { messages: [...parentSystemMessages] };
  }

  /**
   * Run a simplified agentic loop for the sub-task.
   * 1. Start with a system message + task message
   * 2. Call LLMClient.chat() with the sub-agent's own messages
   * 3. Accumulate text response as summary
   * 4. If tool calls are returned, execute them and append results
   * 5. Loop until pure text response (no tool calls)
   * 6. Return SubAgentResult
   */
  async execute(): Promise<SubAgentResult> {
    try {
      // Seed the independent context with sub-agent system message + task.
      // Parent system messages are already in ownContext from the constructor.
      const systemMsg: Message = {
        role: 'system',
        content: 'You are a sub-agent. Complete the assigned task using the available tools.',
        timestamp: Date.now(),
      };
      const taskMsg: Message = {
        role: 'user',
        content: this.task,
        timestamp: Date.now(),
      };
      // Only prepend sub-agent system message if no parent system messages were inherited
      if (this.ownContext.messages.length === 0) {
        this.ownContext.messages.push(systemMsg);
      }
      this.ownContext.messages.push(taskMsg);

      const tools = this.toolRegistry.getAll().map((t) => t.definition);
      let summaryParts: string[] = [];

      // Agentic loop — exit when LLM returns a pure text response
      for (let iteration = 0; iteration < 20; iteration++) {
        const pendingToolCalls: ToolCall[] = [];
        let textAccumulator = '';

        for await (const chunk of this.llmClient.chat(this.ownContext.messages, tools)) {
          if (chunk.type === 'text' && chunk.content) {
            textAccumulator += chunk.content;
          } else if (chunk.type === 'tool_call_end' && chunk.toolCall) {
            const tc = chunk.toolCall;
            if (tc.id && tc.name) {
              pendingToolCalls.push({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments ?? {},
              });
            }
          } else if (chunk.type === 'done') {
            break;
          }
        }

        if (pendingToolCalls.length === 0) {
          // Pure text response — we're done
          if (textAccumulator) {
            summaryParts.push(textAccumulator);
          }

          // Append assistant message to own context
          this.ownContext.messages.push({
            role: 'assistant',
            content: textAccumulator,
            timestamp: Date.now(),
          });

          break;
        }

        // Append assistant message with tool calls
        this.ownContext.messages.push({
          role: 'assistant',
          content: textAccumulator,
          toolCalls: pendingToolCalls,
          timestamp: Date.now(),
        });

        // Execute each tool call and append results
        for (const toolCall of pendingToolCalls) {
          const result = await this.toolRegistry.execute(toolCall);
          this.ownContext.messages.push({
            role: 'tool',
            content: result.content,
            toolCallId: toolCall.id,
            name: toolCall.name,
            timestamp: Date.now(),
          });
        }
      }

      return {
        success: true,
        summary: summaryParts.join('\n').trim() || `Completed task: ${this.task}`,
        artifacts: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: '',
        artifacts: [],
        error: message,
      };
    }
  }

  /** Expose the sub-agent's own context (for isolation testing) */
  getContext(): ConversationContext {
    return this.ownContext;
  }

  /** Expose the LLMClient reference (for capability consistency testing) */
  getLLMClient(): LLMClient {
    return this.llmClient;
  }

  /** Expose the ToolRegistry reference (for capability consistency testing) */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}

export class SubAgentManager {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /**
   * Create a SubAgent with an independent conversation context.
   * The sub-agent shares the same LLMClient and ToolRegistry as the parent,
   * but has its own isolated ConversationContext.
   */
  createSubAgent(task: string, parentContext: ConversationContext): SubAgent {
    return new SubAgent(task, this.llmClient, this.toolRegistry, parentContext);
  }

  /** Execute a sub-agent and return its result. */
  async executeSubAgent(subAgent: SubAgent): Promise<SubAgentResult> {
    return subAgent.execute();
  }
}
