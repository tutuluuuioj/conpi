export interface PricingRate {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cachedInputPerMillion?: number;
}

export type LockedPricingTable = Readonly<Record<string, PricingRate>>;

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${label} price from provider catalogue`);
  return parsed;
}

/**
 * OpenRouter's model catalogue publishes prices in USD per token. Convert the
 * selected rows to the per-million representation used by the enclave meter.
 * The returned rows are snapshots: callers freeze them for the lifetime of a
 * deal, so later catalogue changes cannot rewrite an active deal's accounting.
 */
export function openRouterPricingFromModels(
  models: string[],
  catalogueRows: any[]
): LockedPricingTable {
  const rowsById = new Map(
    catalogueRows
      .filter((row) => row && typeof row.id === "string")
      .map((row) => [row.id.trim().toLowerCase(), row])
  );
  const locked: Record<string, PricingRate> = {};

  for (const model of [...new Set(models.map((item) => item.trim()).filter(Boolean))]) {
    const row = rowsById.get(model.toLowerCase());
    if (!row) throw new Error(`Model "${model}" is not available from OpenRouter`);
    const pricing = row.pricing || {};
    const inputPerMillion = finiteNonNegative(pricing.prompt, `${model} prompt`) * 1_000_000;
    const outputPerMillion = finiteNonNegative(pricing.completion, `${model} completion`) * 1_000_000;
    const cacheRead = pricing.input_cache_read ?? pricing.cache_read ?? pricing.cached_prompt;
    const cachedInputPerMillion = cacheRead === undefined || cacheRead === null || cacheRead === ""
      ? inputPerMillion
      : finiteNonNegative(cacheRead, `${model} cache read`) * 1_000_000;
    locked[model] = Object.freeze({ inputPerMillion, outputPerMillion, cachedInputPerMillion });
  }

  if (Object.keys(locked).length === 0) throw new Error("At least one allowed model is required");
  return Object.freeze(locked);
}

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
  "claude-sonnet-4-6": Object.freeze({ inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 }),
  "anthropic/claude-sonnet-4.6": Object.freeze({ inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 }),
  "openai/gpt-4o": Object.freeze({ inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 }),
  "openai/gpt-4o-mini": Object.freeze({ inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 }),
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

export function lockPricingTable(models: string[], providerSnapshot?: LockedPricingTable): LockedPricingTable {
  const uniqueModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (uniqueModels.length === 0) throw new Error("At least one allowed model is required");

  const locked: Record<string, PricingRate> = {};
  for (const model of uniqueModels) {
    const rate = providerSnapshot?.[model] ?? PRICING_TABLE[model];
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
