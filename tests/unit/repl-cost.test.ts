import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { REPL } from '../../src/cli/repl.js';
import { TokenTracker } from '../../src/session/token-tracker.js';
import type { OrchestratorAgent } from '../../src/agent/orchestrator.js';
import type { StreamingRenderer } from '../../src/cli/streaming-renderer.js';

function makeOrchestrator(): OrchestratorAgent {
  return {
    processMessage: vi.fn().mockReturnValue((async function* () {})()),
    clearConversation: vi.fn(),
    getConversationHistory: vi.fn().mockReturnValue([]),
  } as unknown as OrchestratorAgent;
}

function makeRenderer(): StreamingRenderer {
  return {
    renderToken: vi.fn(),
    renderToolCall: vi.fn(),
    renderError: vi.fn(),
    adaptToWidth: vi.fn(),
  } as unknown as StreamingRenderer;
}

// ─── /cost command — Req 5.1, 5.2, 5.3, 5.4 ─────────────────────────────────

describe('REPL /cost command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  // ─── Req 5.3: zero values before any LLM calls ───────────────────────────

  describe('before any LLM calls', () => {
    it('shows zero input tokens when tokenTracker has no records', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0'));
    });

    it('shows zero output tokens when tokenTracker has no records', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const outputLine = calls.find((line) => /output/i.test(line));
      expect(outputLine).toBeDefined();
      expect(outputLine).toContain('0');
    });

    it('shows $0.0000 cost when tokenTracker has no records', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const costLine = calls.find((line) => /cost/i.test(line));
      expect(costLine).toBeDefined();
      expect(costLine).toContain('$0.0000');
    });

    it('shows $0.0000 when no tokenTracker is provided', async () => {
      // REPL without tokenTracker — should fall back to zero values
      const repl = new REPL(makeOrchestrator(), makeRenderer());
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const costLine = calls.find((line) => /cost/i.test(line));
      expect(costLine).toBeDefined();
      expect(costLine).toContain('$0.0000');
    });
  });

  // ─── Req 5.1, 5.2: after recording tokens ────────────────────────────────

  describe('after recording tokens', () => {
    it('shows correct input token count', async () => {
      const tracker = new TokenTracker();
      tracker.record('claude-sonnet-4-5', 1500, 300);
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const inputLine = calls.find((line) => /input/i.test(line));
      expect(inputLine).toBeDefined();
      expect(inputLine).toContain('1500');
    });

    it('shows correct output token count', async () => {
      const tracker = new TokenTracker();
      tracker.record('claude-sonnet-4-5', 1500, 300);
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const outputLine = calls.find((line) => /output/i.test(line));
      expect(outputLine).toBeDefined();
      expect(outputLine).toContain('300');
    });

    it('shows non-zero formatted cost after recording tokens', async () => {
      const tracker = new TokenTracker();
      tracker.record('claude-sonnet-4-5', 1_000_000, 0);
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const costLine = calls.find((line) => /cost/i.test(line));
      expect(costLine).toBeDefined();
      // claude-sonnet-4-5 input: $3.00/M → 1M tokens = $3.0000
      expect(costLine).toContain('$3.0000');
    });

    it('accumulates tokens across multiple records', async () => {
      const tracker = new TokenTracker();
      tracker.record('claude-haiku-3-5', 1000, 200);
      tracker.record('claude-haiku-3-5', 2000, 400);
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      const inputLine = calls.find((line) => /input/i.test(line));
      expect(inputLine).toBeDefined();
      expect(inputLine).toContain('3000');
    });
  });

  // ─── Req 5.2: output format — separate labeled lines ─────────────────────

  describe('output format', () => {
    it('prints input tokens on a labeled line', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.some((line) => /input.*token/i.test(line))).toBe(true);
    });

    it('prints output tokens on a labeled line', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.some((line) => /output.*token/i.test(line))).toBe(true);
    });

    it('prints estimated cost on a labeled line', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      const calls = consoleSpy.mock.calls.map((c) => c[0] as string);
      expect(calls.some((line) => /cost/i.test(line))).toBe(true);
    });

    it('prints at least 3 lines of output', async () => {
      const tracker = new TokenTracker();
      const repl = new REPL(makeOrchestrator(), makeRenderer(), tracker);
      await repl.handleInput('/cost');
      expect(consoleSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Req 5.4: /cost does not send to LLM ─────────────────────────────────

  describe('does not send to LLM', () => {
    it('does not call orchestrator.processMessage for /cost', async () => {
      const orchestrator = makeOrchestrator();
      const tracker = new TokenTracker();
      const repl = new REPL(orchestrator, makeRenderer(), tracker);
      await repl.handleInput('/cost');
      expect(orchestrator.processMessage).not.toHaveBeenCalled();
    });
  });
});
