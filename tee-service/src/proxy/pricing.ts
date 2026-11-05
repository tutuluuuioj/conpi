export interface PricingRate {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cachedInputPerMillion?: number;
}

export type LockedPricingTable = Readonly<Record<string, PricingRate>>;

/**
 * The enclave-owned price catalogue. A copy of the selected rows is frozen
 * when a provider key is accepted so later catalogue changes cannot alter an
 * active deal's accounting.
 */
export const PRICING_TABLE: LockedPricingTable = Object.freeze({
  "gpt-4o": Object.freeze({ inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 }),
  "gpt-4o-mini": Object.freeze({ inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 }),
  "text-embedding-3-small": Object.freeze({ inputPerMillion: 0.02, outputPerMillion: 0 }),
  "text-embedding-3-large": Object.freeze({ inputPerMillion: 0.13, outputPerMillion: 0 }),
  "claude-3-5-sonnet": Object.freeze({ inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 }),
  "claude-3-5-sonnet-20241022": Object.freeze({ inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 }),
  "claude-3-5-haiku": Object.freeze({ inputPerMillion: 0.8, outputPerMillion: 4, cachedInputPerMillion: 0.08 }),
  "claude-3-5-haiku-20241022": Object.freeze({ inputPerMillion: 0.8, outputPerMillion: 4, cachedInputPerMillion: 0.08 }),
  "meta-llama/llama-3-70b": Object.freeze({ inputPerMillion: 0.59, outputPerMillion: 0.79 }),
  "meta-llama/llama-3.2-1b-instruct": Object.freeze({ inputPerMillion: 0.04, outputPerMillion: 0.16 }),
  "meta-llama/llama-3.2-1b": Object.freeze({ inputPerMillion: 0.04, outputPerMillion: 0.16 }),
  "meta-llama/llama-3.2-3b-instruct": Object.freeze({ inputPerMillion: 0.06, outputPerMillion: 0.24 }),
});

export interface UsageCalculation {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function lockPricingTable(models: string[]): LockedPricingTable {
  const uniqueModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (uniqueModels.length === 0) throw new Error("At least one allowed model is required");

  const locked: Record<string, PricingRate> = {};
  for (const model of uniqueModels) {
    const rate = PRICING_TABLE[model];
    if (!rate) throw new Error(`Unsupported model for enclave pricing: ${model}`);
    locked[model] = Object.freeze({ ...rate });
  }
  return Object.freeze(locked);
}

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  pricing: LockedPricingTable = PRICING_TABLE
): UsageCalculation {
  const rate = pricing[model];
  if (!rate) {
    throw new Error(`Model '${model}' is not present in this deal's locked price table`);
  }

  const safeInput = Math.max(0, Math.floor(inputTokens));
  const safeOutput = Math.max(0, Math.floor(outputTokens));
  const safeCached = Math.min(safeInput, Math.max(0, Math.floor(cachedTokens)));
  const uncachedInput = safeInput - safeCached;
  const inputCost = (uncachedInput * rate.inputPerMillion) / 1_000_000;
  const cachedCost = (safeCached * (rate.cachedInputPerMillion ?? rate.inputPerMillion)) / 1_000_000;
  const outputCost = (safeOutput * rate.outputPerMillion) / 1_000_000;

  return {
    inputTokens: safeInput,
    outputTokens: safeOutput,
    cachedTokens: safeCached,
    costUsd: inputCost + cachedCost + outputCost,
  };
}
