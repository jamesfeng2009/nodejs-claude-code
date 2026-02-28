import { describe, it, expect, beforeEach } from 'vitest';
import { TokenTracker, MODEL_PRICING } from '../../src/session/token-tracker.js';

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  // ─── Req 3.3: zero state ──────────────────────────────────────────────────

  describe('zero state — getSummary() on fresh tracker', () => {
    it('returns zero totalInputTokens', () => {
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(0);
    });

    it('returns zero totalOutputTokens', () => {
      const summary = tracker.getSummary();
      expect(summary.totalOutputTokens).toBe(0);
    });

    it('returns zero totalEstimatedCostUsd', () => {
      const summary = tracker.getSummary();
      expect(summary.totalEstimatedCostUsd).toBe(0);
    });

    it('returns empty perModelCost array', () => {
      const summary = tracker.getSummary();
      expect(summary.perModelCost).toHaveLength(0);
    });

    it('returns $0.0000 as formattedCost', () => {
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toBe('$0.0000');
    });
  });

  // ─── Req 3.1, 3.4: single call record and summary ────────────────────────

  describe('single call record and summary', () => {
    it('records input tokens correctly', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(1000);
    });

    it('records output tokens correctly', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.totalOutputTokens).toBe(500);
    });

    it('creates one perModelCost entry', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.perModelCost).toHaveLength(1);
    });

    it('perModelCost entry has correct model name', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.perModelCost[0].model).toBe('claude-sonnet-4-5');
    });

    it('perModelCost entry has correct token counts', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.perModelCost[0].inputTokens).toBe(1000);
      expect(summary.perModelCost[0].outputTokens).toBe(500);
    });

    it('computes cost correctly for a known model', () => {
      // claude-sonnet-4-5: $3.00/M input, $15.00/M output
      // cost = (1000/1_000_000 * 3.00) + (500/1_000_000 * 15.00)
      //      = 0.003 + 0.0075 = 0.0105
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.totalEstimatedCostUsd).toBeCloseTo(0.0105, 10);
    });
  });

  // ─── Req 3.2: multi-call accumulation ────────────────────────────────────

  describe('multi-call accumulation', () => {
    it('accumulates input tokens across calls to the same model', () => {
      tracker.record('claude-haiku-3-5', 100, 50);
      tracker.record('claude-haiku-3-5', 200, 100);
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(300);
    });

    it('accumulates output tokens across calls to the same model', () => {
      tracker.record('claude-haiku-3-5', 100, 50);
      tracker.record('claude-haiku-3-5', 200, 100);
      const summary = tracker.getSummary();
      expect(summary.totalOutputTokens).toBe(150);
    });

    it('keeps one perModelCost entry when same model used multiple times', () => {
      tracker.record('claude-haiku-3-5', 100, 50);
      tracker.record('claude-haiku-3-5', 200, 100);
      const summary = tracker.getSummary();
      expect(summary.perModelCost).toHaveLength(1);
    });

    it('accumulates tokens across different models', () => {
      tracker.record('claude-sonnet-4-5', 1000, 200);
      tracker.record('claude-haiku-3-5', 500, 100);
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(1500);
      expect(summary.totalOutputTokens).toBe(300);
    });

    it('creates separate perModelCost entries for different models', () => {
      tracker.record('claude-sonnet-4-5', 1000, 200);
      tracker.record('claude-haiku-3-5', 500, 100);
      const summary = tracker.getSummary();
      expect(summary.perModelCost).toHaveLength(2);
    });

    it('sums costs across multiple models', () => {
      // sonnet: (1000/1M * 3.00) + (200/1M * 15.00) = 0.003 + 0.003 = 0.006
      // haiku:  (500/1M * 0.80) + (100/1M * 4.00)  = 0.0004 + 0.0004 = 0.0008
      // total = 0.0068
      tracker.record('claude-sonnet-4-5', 1000, 200);
      tracker.record('claude-haiku-3-5', 500, 100);
      const summary = tracker.getSummary();
      expect(summary.totalEstimatedCostUsd).toBeCloseTo(0.0068, 10);
    });
  });

  // ─── Req 4.4: unknown model shows null estimatedCostUsd ──────────────────

  describe('unknown model', () => {
    it('sets estimatedCostUsd to null for unknown model', () => {
      tracker.record('gpt-4-unknown', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.perModelCost[0].estimatedCostUsd).toBeNull();
    });

    it('still records token counts for unknown model', () => {
      tracker.record('gpt-4-unknown', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.perModelCost[0].inputTokens).toBe(1000);
      expect(summary.perModelCost[0].outputTokens).toBe(500);
    });

    it('does not add unknown model cost to totalEstimatedCostUsd', () => {
      tracker.record('gpt-4-unknown', 1_000_000, 1_000_000);
      const summary = tracker.getSummary();
      expect(summary.totalEstimatedCostUsd).toBe(0);
    });

    it('still counts tokens from unknown model in totals', () => {
      tracker.record('gpt-4-unknown', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(1000);
      expect(summary.totalOutputTokens).toBe(500);
    });
  });

  // ─── Req 4.5: cost formatting precision ──────────────────────────────────

  describe('cost formatting — Req 4.5', () => {
    it('formattedCost has $ prefix', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toMatch(/^\$/);
    });

    it('formattedCost has exactly 4 decimal places', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toMatch(/^\$\d+\.\d{4}$/);
    });

    it('formattedCost is $0.0000 when no calls recorded', () => {
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toBe('$0.0000');
    });

    it('formattedCost rounds to 4 decimal places', () => {
      // Use a large token count to get a non-trivial cost
      // claude-opus-4-5: $15/M input, $75/M output
      // 1M input + 1M output = $15 + $75 = $90.0000
      tracker.record('claude-opus-4-5', 1_000_000, 1_000_000);
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toBe('$90.0000');
    });
  });

  // ─── reset() ─────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears all accumulated tokens', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      tracker.reset();
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
    });

    it('clears perModelCost entries', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      tracker.reset();
      const summary = tracker.getSummary();
      expect(summary.perModelCost).toHaveLength(0);
    });

    it('resets formattedCost to $0.0000', () => {
      tracker.record('claude-sonnet-4-5', 1000, 500);
      tracker.reset();
      const summary = tracker.getSummary();
      expect(summary.formattedCost).toBe('$0.0000');
    });
  });

  // ─── MODEL_PRICING table ──────────────────────────────────────────────────

  describe('MODEL_PRICING table', () => {
    it('contains claude-opus-4-5', () => {
      expect(MODEL_PRICING['claude-opus-4-5']).toBeDefined();
    });

    it('contains claude-sonnet-4-5', () => {
      expect(MODEL_PRICING['claude-sonnet-4-5']).toBeDefined();
    });

    it('contains claude-haiku-3-5', () => {
      expect(MODEL_PRICING['claude-haiku-3-5']).toBeDefined();
    });

    it('all entries have positive inputPricePerMillion', () => {
      for (const [, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.inputPricePerMillion).toBeGreaterThan(0);
      }
    });

    it('all entries have positive outputPricePerMillion', () => {
      for (const [, pricing] of Object.entries(MODEL_PRICING)) {
        expect(pricing.outputPricePerMillion).toBeGreaterThan(0);
      }
    });
  });
});
