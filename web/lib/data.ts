import { BASE_URL, CONFIG, TERMS_HASH, TX } from "./chain";
import type { Claim, Deal, Listing, Notice, Proposal, Provider, Terms } from "./types";

export const PROVIDER_MODELS: Record<Provider, readonly string[]> = {
  OpenAI: ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small", "text-embedding-3-large"],
  Anthropic: ["claude-sonnet-4-6", "claude-3-5-sonnet", "claude-3-5-haiku"],
  OpenRouter: [
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "meta-llama/llama-3.2-1b-instruct",
    "meta-llama/llama-3-70b",
  ],
};

export const MODELS = Array.from(new Set(Object.values(PROVIDER_MODELS).flat()));

export function modelsForProvider(provider: Provider): readonly string[] {
  return PROVIDER_MODELS[provider];
}

const prices = {
  openai: [
    { model: "gpt-4o", input: "$2.50 / 1M", output: "$10.00 / 1M" },
    { model: "gpt-4o-mini", input: "$0.15 / 1M", output: "$0.60 / 1M" },
  ],
  anthropic: [
    { model: "claude-sonnet-4-6", input: "$3.00 / 1M", output: "$15.00 / 1M" },
  ],
  router: [
    { model: "gpt-4o", input: "$2.50 / 1M", output: "$10.00 / 1M" },
    { model: "meta-llama/llama-3-70b", input: "$0.59 / 1M", output: "$0.79 / 1M" },
  ],
};

function terms(partial: Terms): Terms {
  return partial;
}

export const LISTINGS: Listing[] = [
  {
    id: "lst-01",
    type: "sell",
    provider: "OpenAI",
    model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini"],
    credit: 80,
    price: 60,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "seller.near",
    reputation: 12,
    tee: true,
    token: "USDC",
    rateLimit: "60 req/min",
    expectedTest: "One chat completion on gpt-4o-mini, max 32 tokens",
    createdAt: "2026-11-02T18:40:00.000Z",
  },
  {
    id: "lst-02",
    type: "sell",
    provider: "Anthropic",
    model: "claude-3-5-sonnet",
    models: ["claude-3-5-sonnet", "claude-3-5-haiku"],
    credit: 200,
    price: 150,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "sonnet-pool.near",
    reputation: 31,
    tee: true,
    token: "USDC",
    rateLimit: "80 req/min",
    expectedTest: "One message on claude-3-5-haiku, max 32 tokens",
    createdAt: "2026-11-02T16:10:00.000Z",
  },
  {
    id: "lst-03",
    type: "sell",
    provider: "OpenRouter",
    model: "mixed",
    models: ["gpt-4o", "meta-llama/llama-3-70b"],
    credit: 50,
    price: 42,
    collateralPct: 25,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "route-desk.near",
    reputation: 7,
    tee: true,
    token: "NEAR",
    rateLimit: "120 req/min",
    expectedTest: "One completion on llama-3-70b, max 32 tokens",
    createdAt: "2026-11-02T12:05:00.000Z",
  },
  {
    id: "lst-04",
    type: "sell",
    provider: "OpenAI",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini"],
    credit: 120,
    price: 78,
    collateralPct: 15,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "seller.near",
    reputation: 12,
    tee: true,
    token: "USDC",
    rateLimit: "200 req/min",
    expectedTest: "One chat completion, max 16 tokens",
    createdAt: "2026-11-01T21:18:00.000Z",
  },
  {
    id: "lst-05",
    type: "sell",
    provider: "Anthropic",
    model: "claude-3-5-haiku",
    models: ["claude-3-5-haiku"],
    credit: 40,
    price: 30,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "claude-fan.near",
    reputation: 4,
    tee: true,
    token: "USDT",
    rateLimit: "50 req/min",
    expectedTest: "One message, max 16 tokens",
    createdAt: "2026-11-01T15:44:00.000Z",
  },
  {
    id: "lst-06",
    type: "buy",
    provider: "OpenAI",
    model: "gpt-4o",
    models: ["gpt-4o", "text-embedding-3-large"],
    credit: 500,
    price: 380,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "ai-startup.near",
    reputation: 2,
    tee: true,
    token: "USDC",
    rateLimit: "200 req/min",
    expectedTest: "Buyer will accept a gpt-4o test call after deposit",
    createdAt: "2026-11-02T09:12:00.000Z",
  },
  {
    id: "lst-07",
    type: "sell",
    provider: "OpenRouter",
    model: "meta-llama/llama-3-70b",
    models: ["meta-llama/llama-3-70b"],
    credit: 90,
    price: 60,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "llama-desk.near",
    reputation: 18,
    tee: true,
    token: "USDC",
    rateLimit: "150 req/min",
    expectedTest: "One completion, max 32 tokens",
    createdAt: "2026-10-31T19:02:00.000Z",
  },
  {
    id: "lst-08",
    type: "buy",
    provider: "Anthropic",
    model: "claude-3-5-sonnet",
    models: ["claude-3-5-sonnet"],
    credit: 150,
    price: 120,
    collateralPct: 20,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "studio.near",
    reputation: 9,
    tee: true,
    token: "USDC",
    rateLimit: "40 req/min",
    expectedTest: "Buyer publishes the allowlist before deposit",
    createdAt: "2026-10-31T11:26:00.000Z",
  },
  {
    id: "lst-09",
    type: "sell",
    provider: "OpenAI",
    model: "gpt-4o",
    models: ["gpt-4o"],
    credit: 300,
    price: 240,
    collateralPct: 30,
    buyerCollateralPct: CONFIG.buyerCollateralPct,
    seller: "treasury.near",
    reputation: 44,
    tee: true,
    token: "USDC",
    rateLimit: "90 req/min",
    expectedTest: "One chat completion, max 32 tokens",
    createdAt: "2026-10-30T08:15:00.000Z",
  },
];

export const DEALS: Deal[] = [];

export const CLAIMS: Claim[] = [];

export const NOTICES: Notice[] = [];

export const PROPOSALS: Proposal[] = [];

export const KEY_CHECKS = [
  "Key received",
  "Test call sent",
  "Model available",
  "Balance covers the credit",
];

export function listingTerms(listing: Listing): Terms {
  return {
    credit: listing.credit,
    price: listing.price,
    buyerCollateralPct: listing.buyerCollateralPct,
    sellerCollateralPct: listing.collateralPct,
    token: listing.token,
    models: listing.models,
    deadline: "2026-12-02",
  };
}
