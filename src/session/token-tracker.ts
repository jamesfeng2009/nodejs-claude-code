/** Model pricing table (USD per million tokens) */
export const MODEL_PRICING: Record<string, { inputPricePerMillion: number; outputPricePerMillion: number }> = {
  'claude-opus-4-5':   { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00 },
  'claude-sonnet-4-5': { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00 },
  'claude-haiku-3-5':  { inputPricePerMillion: 0.80,  outputPricePerMillion: 4.00  },
  'claude-3-opus':     { inputPricePerMillion: 15.00, outputPricePerMillion: 75.00 },
  'claude-3-sonnet':   { inputPricePerMillion: 3.00,  outputPricePerMillion: 15.00 },
  'claude-3-haiku':    { inputPricePerMillion: 0.25,  outputPricePerMillion: 1.25  },
};

export interface TokenUsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

export interface SessionCostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-model cost breakdown */
  perModelCost: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** null when model is not in MODEL_PRICING */
    estimatedCostUsd: number | null;
  }>;
  /** Sum of costs for all models with known pricing */
  totalEstimatedCostUsd: number;
  /** Formatted total cost, e.g. "$0.0042" */
  formattedCost: string;
}

/** Accumulated token counts per model */
interface ModelAccumulator {
  inputTokens: number;
  outputTokens: number;
}

export class TokenTracker {
  private perModel: Map<string, ModelAccumulator> = new Map();

  /**
   * Record token usage from a single LLM call.
   * Accumulates into per-model session totals.
   */
  record(model: string, inputTokens: number, outputTokens: number): void {
    const existing = this.perModel.get(model) ?? { inputTokens: 0, outputTokens: 0 };
    this.perModel.set(model, {
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
    });
  }

  /**
   * Returns a summary of all token usage and estimated costs for the current session.
   */
  getSummary(): SessionCostSummary {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedCostUsd = 0;

    const perModelCost = Array.from(this.perModel.entries()).map(([model, acc]) => {
      totalInputTokens += acc.inputTokens;
      totalOutputTokens += acc.outputTokens;

      const pricing = MODEL_PRICING[model];
      let estimatedCostUsd: number | null = null;

      if (pricing) {
        estimatedCostUsd =
          (acc.inputTokens / 1_000_000) * pricing.inputPricePerMillion +
          (acc.outputTokens / 1_000_000) * pricing.outputPricePerMillion;
        totalEstimatedCostUsd += estimatedCostUsd;
      }

      return {
        model,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        estimatedCostUsd,
      };
    });

    return {
      totalInputTokens,
      totalOutputTokens,
      perModelCost,
      totalEstimatedCostUsd,
      formattedCost: `$${totalEstimatedCostUsd.toFixed(4)}`,
    };
  }

  /**
   * Reset all accumulated counts. Call at the start of a new session.
   */
  reset(): void {
    this.perModel.clear();
  }
}
