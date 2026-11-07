import { FastifyReply, FastifyRequest } from "fastify";
import { DefaultReason } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";
import { keyVault, VaultEntry } from "../vault/preflight.js";
import { meterEvents } from "./events.js";
import { settlementEngine } from "../settlement/engine.js";
import { meterEngine } from "./meter.js";
import { calculateCost, PricingRate } from "./pricing.js";
import { proxyRateLimiter } from "./rate-limit.js";
import { countChatInputTokens, countEmbeddingInputTokens, countTextTokens, extractText } from "./tokenizer.js";
import { meteringStateStore, PendingUsage, usageReceiptHash } from "../state/metering-store.js";

type ProviderKind = "openai" | "openrouter" | "redpill" | "anthropic";
export type ProviderErrorKind = "transient_rate_limit" | "insufficient_quota" | "invalid_key" | "provider_ban" | "upstream";

interface UsageResult {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  stages: number[];
}

function finitePriceCeiling(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function requestWithProviderUsage(body: any, kind: ProviderKind, lockedRate?: PricingRate): any {
  if (kind !== "openrouter") {
    return body.stream ? { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } } : body;
  }
  const requestedMaxPrice = body.provider?.max_price || {};
  const lockedPrompt = lockedRate?.inputPerMillion;
  const lockedCompletion = lockedRate?.outputPerMillion;
  const requestedPrompt = finitePriceCeiling(requestedMaxPrice.prompt);
  const requestedCompletion = finitePriceCeiling(requestedMaxPrice.completion);
  const maxPrice = lockedRate
    ? {
        prompt: requestedPrompt === undefined ? lockedPrompt : Math.min(requestedPrompt, lockedPrompt!),
        completion: requestedCompletion === undefined ? lockedCompletion : Math.min(requestedCompletion, lockedCompletion!),
      }
    : requestedMaxPrice;
  return {
    ...body,
    usage: { ...(body.usage && typeof body.usage === "object" ? body.usage : {}), include: true },
    provider: {
      ...(body.provider && typeof body.provider === "object" ? body.provider : {}),
      ...(Object.keys(maxPrice).length ? { max_price: maxPrice } : {}),
    },
    ...(body.stream
      ? { stream_options: { ...(body.stream_options || {}), include_usage: true } }
      : {}),
  };
}

export function resolveMeteredCostUsd(provider: string, calculatedCostUsd: number, providerCost: unknown): number {
  const observed = typeof providerCost === "number" ? providerCost : Number.parseFloat(String(providerCost ?? ""));
  if (provider.trim().toLowerCase() === "openrouter") {
    if (Number.isFinite(observed) && observed >= 0) return observed;
    throw new Error("OpenRouter response is missing an authoritative cost; estimated billing is disabled");
  }
  return calculatedCostUsd;
}

export interface OpenRouterCostResolution {
  costUsd: number;
  source: "openrouter_usage" | "openrouter_generation";
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export async function resolveOpenRouterCost(
  apiKey: string,
  providerCost: unknown,
  generationId: unknown,
  options: { fetchImpl?: typeof fetch; retryDelaysMs?: number[] } = {}
): Promise<OpenRouterCostResolution> {
  const normalizedId = typeof generationId === "string" ? generationId.trim() : "";
  if (!normalizedId) {
    throw new Error("OpenRouter omitted the generation ID; metering was stopped without releasing funds");
  }
  const direct = typeof providerCost === "number" ? providerCost : Number.parseFloat(String(providerCost ?? ""));
  if (Number.isFinite(direct) && direct >= 0) return { costUsd: direct, source: "openrouter_usage" };

  const fetchImpl = options.fetchImpl || fetch;
  const retryDelaysMs = options.retryDelaysMs || [250, 500, 1_000, 2_000];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const response = await fetchImpl(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(normalizedId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const data: any = await response.json().catch(() => null);
      const observed = Number(data?.data?.total_cost ?? data?.data?.usage);
      if (Number.isFinite(observed) && observed >= 0) {
        return {
          costUsd: observed,
          source: "openrouter_generation",
          inputTokens: finitePriceCeiling(data?.data?.tokens_prompt ?? data?.data?.native_tokens_prompt),
          outputTokens: finitePriceCeiling(data?.data?.tokens_completion ?? data?.data?.native_tokens_completion),
          cachedTokens: finitePriceCeiling(data?.data?.native_tokens_cached),
        };
      }
      throw new Error("OpenRouter generation record did not contain an authoritative total cost");
    }
    const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === retryDelaysMs.length) {
      throw new Error(`OpenRouter cost reconciliation failed (HTTP ${response.status}); metering was stopped without releasing funds`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  }
  throw new Error("OpenRouter cost reconciliation failed; metering was stopped without releasing funds");
}

export function validatePricedOpenRouterRequest(body: any): string | null {
  if (Array.isArray(body?.models) && (body.models.length !== 1 || body.models[0] !== body.model)) return "model_fallbacks";
  if (body?.route !== undefined) return "alternate_route";
  if (Array.isArray(body?.plugins) && body.plugins.length > 0) return "plugins";
  if (body?.web_search_options !== undefined) return "web_search";
  if (body?.image_config !== undefined || body?.audio !== undefined) return "unpriced_media";
  if (Array.isArray(body?.modalities) && body.modalities.some((item: unknown) => item !== "text")) return "unpriced_modality";
  return null;
}

function getProxyKey(req: FastifyRequest): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) return xApiKey.trim();
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  return null;
}

function providerKind(entry: VaultEntry): ProviderKind {
  const provider = entry.provider.trim().toLowerCase();
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter") return "openrouter";
  if (provider === "redpill" || provider === "phala" || entry.apiKey.startsWith("sk-rp-")) return "redpill";
  return "openai";
}

function stagePendingUsage(entry: VaultEntry, pending: Omit<PendingUsage, "createdAt" | "attempts">): void {
  const generationId = pending.generationId?.trim() || null;
  if (generationId && entry.processedGenerationIds.includes(generationId)) {
    throw new Error(`OpenRouter generation '${generationId}' was already recorded; duplicate billing was rejected`);
  }
  if (entry.pendingUsage && entry.pendingUsage.generationId !== generationId) {
    throw new Error(`Deal #${entry.dealId} is blocked by unresolved generation '${entry.pendingUsage.generationId || "unknown"}'`);
  }
  entry.pendingUsage = {
    ...pending,
    generationId,
    createdAt: entry.pendingUsage?.createdAt || new Date().toISOString(),
    attempts: entry.pendingUsage?.attempts || 0,
    lastError: entry.pendingUsage?.lastError,
  };
  meteringStateStore.save(entry);
}

export async function reconcilePendingUsage(entry: VaultEntry): Promise<UsageResult | null> {
  const pending = entry.pendingUsage;
  if (!pending) return null;
  if (providerKind(entry) !== "openrouter") {
    throw new Error(`Deal #${entry.dealId} has unresolved provider usage and is blocked`);
  }
  try {
    const resolved = await resolveOpenRouterCost(entry.apiKey, pending.providerCost, pending.generationId);
    return recordUsage(
      entry,
      pending.model,
      resolved.inputTokens ?? pending.inputTokens,
      resolved.outputTokens ?? pending.outputTokens,
      resolved.cachedTokens ?? pending.cachedTokens,
      resolved.costUsd,
      pending.generationId || undefined,
      resolved.source
    );
  } catch (error: any) {
    entry.pendingUsage = {
      ...pending,
      attempts: pending.attempts + 1,
      lastError: error.message,
    };
    meteringStateStore.save(entry);
    throw error;
  }
}

async function finalizeProviderUsage(
  entry: VaultEntry,
  pending: Omit<PendingUsage, "createdAt" | "attempts">
): Promise<{ usage: UsageResult; generationId?: string; source: string }> {
  if (providerKind(entry) !== "openrouter") {
    return {
      usage: recordUsage(entry, pending.model, pending.inputTokens, pending.outputTokens, pending.cachedTokens),
      generationId: pending.generationId || undefined,
      source: "locked_pricing",
    };
  }
  stagePendingUsage(entry, pending);
  const usage = await reconcilePendingUsage(entry);
  const receipt = entry.usageReceipts.at(-1);
  return {
    usage: usage!,
    generationId: receipt?.generationId || undefined,
    source: receipt?.source || "openrouter_usage",
  };
}

async function acquireBillingLock(entry: VaultEntry, reply: FastifyReply): Promise<boolean> {
  if (providerKind(entry) !== "openrouter") return true;
  if (entry.defaultPayload) {
    reply.status(502).send({
      error: { message: "Provider credentials or quota failed; deterministic default settlement payload created", code: "seller_self_drain" },
      defaultPayload: publicSignedPayload(entry.defaultPayload),
    });
    return false;
  }
  const start = Date.now();
  while (entry.requestInFlight) {
    if (Date.now() - start > 1_000) {
      reply.status(409).send({ error: { message: "Another request is already being metered for this deal", code: "billing_request_in_flight" } });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (entry.defaultPayload) {
      reply.status(502).send({
        error: { message: "Provider credentials or quota failed; deterministic default settlement payload created", code: "seller_self_drain" },
        defaultPayload: publicSignedPayload(entry.defaultPayload),
      });
      return false;
    }
  }
  entry.requestInFlight = true;
  try {
    await reconcilePendingUsage(entry);
    return true;
  } catch (error: any) {
    entry.requestInFlight = false;
    reply.status(409).send({
      error: {
        message: error.message,
        code: "cost_reconciliation_pending",
        generationId: entry.pendingUsage?.generationId || null,
      },
    });
    return false;
  }
}

function openAiBaseUrl(kind: ProviderKind): string {
  if (kind === "openrouter") return "https://openrouter.ai/api/v1";
  if (kind === "redpill") return "https://api.redpill.ai/v1";
  return "https://api.openai.com/v1";
}

function providerHeaders(entry: VaultEntry, kind = providerKind(entry)): Record<string, string> {
  if (kind === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": entry.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${entry.apiKey}`,
  };
  if (kind === "openrouter") {
    headers["HTTP-Referer"] = "https://conpi.network";
    headers["X-Title"] = "Conpi TEE Proxy";
  }
  return headers;
}

export function isProviderBan(status: number, errTextOrData: unknown): boolean {
  if (status < 400) return false;
  const lower = (typeof errTextOrData === "string" ? errTextOrData : JSON.stringify(errTextOrData || "")).toLowerCase();
  return [
    "account_deactivated", "organization_disabled", "provider_ban", "provider_banned",
    "account_banned", "user_banned", "account_suspended", "banned", "suspended",
    "access_terminated", "policy_violation", "key has been disabled", "account disabled",
    "billing_suspended", "abuse_ban", "terms_violation",
  ].some((marker) => lower.includes(marker));
}

export function classifyProviderError(status: number, body: unknown): ProviderErrorKind {
  const lower = (typeof body === "string" ? body : JSON.stringify(body || "")).toLowerCase();
  if (status === 401) return "invalid_key";
  if (isProviderBan(status, body)) return "provider_ban";
  const quotaFailure = [
    "insufficient_quota",
    "billing_hard_limit_reached",
    "credit balance is too low",
    "quota_exhausted",
    "insufficient credits",
    "insufficient credit",
    "key limit exceeded",
  ].some((marker) => lower.includes(marker));
  if ((status === 402 || status === 403 || status === 429) && quotaFailure) return "insufficient_quota";
  if (lower.includes("invalid_api_key") || lower.includes("invalid x-api-key")) return "invalid_key";
  if (status === 429) return "transient_rate_limit";
  return "upstream";
}

export function extractProviderErrorCode(body: unknown): string {
  let data: any = body;
  if (typeof body === "string") {
    try { data = JSON.parse(body); } catch { data = null; }
  }
  const raw = data?.error?.code ?? data?.error?.type ?? data?.code ?? data?.type;
  if (raw === null || raw === undefined || raw === "") return "unknown";
  return String(raw).replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || "unknown";
}

function authenticate(req: FastifyRequest, reply: FastifyReply): VaultEntry | null {
  const proxyKey = getProxyKey(req);
  if (!proxyKey) {
    reply.status(401).send({ error: { message: "Missing proxy API key", code: "unauthorized" } });
    return null;
  }
  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry || !entry.active) {
    reply.status(403).send({ error: { message: "Invalid or inactive proxy key", code: "key_inactive" } });
    return null;
  }
  return entry;
}

export function authenticateDealRequest(req: FastifyRequest, reply: FastifyReply, dealId: number): VaultEntry | null {
  const proxyKey = getProxyKey(req);
  if (!proxyKey) {
    reply.status(401).send({ error: { message: "Missing proxy API key", code: "unauthorized" } });
    return null;
  }
  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry || entry.dealId !== dealId) {
    reply.status(403).send({ error: { message: "Proxy key is not authorized for this deal", code: "deal_forbidden" } });
    return null;
  }
  return entry;
}

function enforceRateLimit(entry: VaultEntry, reply: FastifyReply): boolean {
  const result = proxyRateLimiter.take(entry.proxyKey, entry.rateLimitPerMinute);
  reply.header("X-RateLimit-Limit", String(result.limit));
  reply.header("X-RateLimit-Remaining", String(result.remaining));
  if (result.allowed) return true;
  reply.header("Retry-After", String(result.retryAfterSeconds));
  reply.status(429).send({
    error: { message: "Conpi proxy rate limit exceeded", code: "proxy_rate_limit_exceeded", retry_after_seconds: result.retryAfterSeconds },
  });
  return false;
}

export function computeAffordableOutputTokens(
  entry: VaultEntry,
  model: string,
  inputTokens: number,
  cachedTokens = 0
): number {
  const rate = entry.lockedPricing[model];
  if (!rate || rate.outputPerMillion <= 0) return 1_000_000;
  const remainingBudgetUsd = Math.max(0, entry.creditUsd - entry.usedUsd);
  const inputRate = rate.inputPerMillion;
  const cachedRate = rate.cachedInputPerMillion ?? inputRate;
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const inputCost = (uncachedInput * inputRate + cachedTokens * cachedRate) / 1_000_000;
  const remainingForOutputUsd = Math.max(0, remainingBudgetUsd - inputCost);
  const outputPricePerToken = rate.outputPerMillion / 1_000_000;
  return Math.floor(remainingForOutputUsd / outputPricePerToken);
}

function enforceModelAndBudget(entry: VaultEntry, model: string, inputTokens: number, maximumOutputTokens: number, reply: FastifyReply): boolean {
  const normalizedModel = model.trim().toLowerCase();
  if (!entry.models.some((item) => item.trim().toLowerCase() === normalizedModel)) {
    reply.status(400).send({ error: { message: `Model '${model}' is not in the deal allowlist`, code: "model_disallowed" } });
    return false;
  }
  if (!entry.lockedPricing[model]) {
    reply.status(400).send({ error: { message: `Model '${model}' has no locked price for this deal`, code: "price_not_locked" } });
    return false;
  }
  if (entry.usedUsd >= entry.creditUsd) {
    reply.status(402).send({ error: { message: "Deal credit cap reached", code: "quota_exhausted" } });
    return false;
  }
  const maximumCost = calculateCost(model, inputTokens, maximumOutputTokens, 0, entry.lockedPricing).costUsd;
  const remaining = Math.max(0, entry.creditUsd - entry.usedUsd);
  if (maximumCost > remaining + Number.EPSILON) {
    reply.status(402).send({
      error: {
        message: `Remaining locked credit ($${remaining.toFixed(6)}) cannot cover the request maximum ($${maximumCost.toFixed(6)})`,
        code: "budget_cap_exceeded",
      },
    });
    return false;
  }
  return true;
}

function recordUsage(
  entry: VaultEntry,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  providerCost?: unknown,
  generationId?: string,
  costSource?: OpenRouterCostResolution["source"]
): UsageResult {
  entry.usageReceipts ||= [];
  entry.processedGenerationIds ||= [];
  if (generationId && entry.processedGenerationIds.includes(generationId)) {
    throw new Error(`OpenRouter generation '${generationId}' was already recorded; duplicate billing was rejected`);
  }
  const calculated = calculateCost(model, inputTokens, outputTokens, cachedTokens, entry.lockedPricing);
  const usage = {
    ...calculated,
    costUsd: resolveMeteredCostUsd(entry.provider, calculated.costUsd, providerCost),
  };
  const nextUsedUsd = Math.min(entry.creditUsd, entry.usedUsd + usage.costUsd);
  const nextTokensTotal = entry.tokensTotal + usage.inputTokens + usage.outputTokens;
  const previousHash = entry.usageReceipts.at(-1)?.hash || null;
  const receiptBody = {
    sequence: entry.usageReceipts.length + 1,
    generationId: generationId || null,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
    cumulativeUsedUsd: nextUsedUsd,
    source: costSource || "locked_pricing" as const,
    createdAt: new Date().toISOString(),
    previousHash,
  };
  const hash = usageReceiptHash(receiptBody);
  const receipt = {
    ...receiptBody,
    hash,
    signatureHex: Buffer.from(enclaveKeys.sign(Buffer.from(hash, "hex"))).toString("hex"),
  };
  const nextReceipts = [...entry.usageReceipts, receipt];
  const nextProcessedGenerationIds = generationId
    ? [...entry.processedGenerationIds, generationId]
    : [...entry.processedGenerationIds];

  // The durable ledger is the commit point. Do not mutate the in-memory meter or
  // emit a payout until the complete next state has been encrypted and fsynced.
  meteringStateStore.save({
    ...entry,
    usedUsd: nextUsedUsd,
    tokensTotal: nextTokensTotal,
    usageReceipts: nextReceipts,
    processedGenerationIds: nextProcessedGenerationIds,
    pendingUsage: null,
  });
  entry.usedUsd = nextUsedUsd;
  entry.tokensTotal = nextTokensTotal;
  entry.usageReceipts = nextReceipts;
  entry.processedGenerationIds = nextProcessedGenerationIds;
  entry.pendingUsage = null;
  const signedStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
  for (const stage of signedStages) entry.signedPayloads.push(stage);
  if (signedStages.length > 0) {
    void settlementEngine.relayStages(entry, signedStages).catch((error) => {
      console.warn("[conpi:stage-relay]", { dealId: entry.dealId, error: error instanceof Error ? error.message : String(error) });
    });
  }
  if (entry.usedUsd >= entry.creditUsd) entry.active = false;
  const stages = signedStages.map((stage) => stage.payload.stage);
  meterEvents.publish(entry, stages.length ? "stage" : "usage", stages);
  return { ...usage, stages };
}

export function emitDefaultOnce(entry: VaultEntry, reason: DefaultReason) {
  if (entry.defaultPayload) return entry.defaultPayload;
  const signed = meterEngine.emitDefault(entry, entry.termsHashHex, reason);
  entry.defaultPayload = signed;
  entry.signedPayloads.push(signed);
  meterEvents.publish(entry, "default");
  void settlementEngine.relayDefault(entry, signed).catch((error) => {
    console.warn("[conpi:default-relay]", { dealId: entry.dealId, error: error instanceof Error ? error.message : String(error) });
  });
  return signed;
}

export function publicSignedPayload(item: { payload: any; signatureHex: string }) {
  return {
    payload: {
      domain: item.payload.domain,
      contractId: item.payload.contractId,
      chainId: item.payload.chainId,
      dealId: Number(item.payload.dealId),
      termsHashHex: Buffer.from(item.payload.termsHash).toString("hex"),
      kind: item.payload.kind,
      stage: item.payload.stage,
      meteredValueYocto: item.payload.meteredValueYocto.toString(),
      reason: item.payload.reason ?? null,
      nonce: item.payload.nonce.toString(),
      issuedAtNs: item.payload.issuedAtNs.toString(),
    },
    signatureHex: item.signatureHex,
  };
}

async function fetchWithTransientBackoff(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    const body = await response.clone().text();
    if (classifyProviderError(response.status, body) !== "transient_rate_limit" || attempt >= CONFIG.transientRateLimitRetries) return response;
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(2_000, retryAfter * 1_000)
      : Math.min(2_000, CONFIG.transientRateLimitBackoffMs * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function handleProviderFailure(response: Response, entry: VaultEntry, reply: FastifyReply, anthropicFormat = false) {
  const text = await response.text();
  const kind = classifyProviderError(response.status, text);
  const upstreamCode = extractProviderErrorCode(text);
  console.warn("[conpi:upstream-error]", {
    dealId: entry.dealId,
    provider: providerKind(entry),
    status: response.status,
    code: upstreamCode,
    classification: kind,
  });
  if (kind === "transient_rate_limit") {
    reply.header("Retry-After", response.headers.get("retry-after") || "1");
    return reply.status(429).send({
      error: anthropicFormat
        ? { type: "rate_limit_error", message: "Provider rate limit exceeded after enclave backoff" }
        : { message: "Provider rate limit exceeded after enclave backoff", code: "rate_limit_exceeded" },
    });
  }
  if (kind === "invalid_key" || kind === "provider_ban" || kind === "insufficient_quota") {
    const reason = kind === "provider_ban" ? DefaultReason.ProviderBan
      : kind === "invalid_key" ? DefaultReason.InvalidKey : DefaultReason.SellerSelfDrain;
    const defaultPayload = emitDefaultOnce(entry, reason);
    const code = kind === "insufficient_quota" ? "seller_self_drain" : kind;
    return reply.status(502).send({
      error: anthropicFormat
        ? { type: code, message: "Provider credentials or quota failed; deterministic default settlement payload created" }
        : { message: "Provider credentials or quota failed; deterministic default settlement payload created", code },
      defaultPayload: publicSignedPayload(defaultPayload),
    });
  }
  return reply.status(response.status).send({
    error: anthropicFormat
      ? { type: "upstream_error", message: text || `Provider returned HTTP ${response.status}` }
      : { message: text || `Provider returned HTTP ${response.status}`, code: "upstream_error" },
  });
}

function openAiMessagesToAnthropic(body: any) {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === "system") systemParts.push(extractText(message.content));
    else if (message?.role === "user" || message?.role === "assistant") messages.push({ role: message.role, content: message.content });
  }
  return {
    model: body.model,
    system: systemParts.length ? systemParts.join("\n") : undefined,
    messages,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1_000,
    temperature: body.temperature,
    top_p: body.top_p,
    stop_sequences: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
    stream: Boolean(body.stream),
  };
}

function anthropicMessagesToOpenAi(body: any) {
  const messages: Array<{ role: string; content: string }> = [];
  if (body.system) messages.push({ role: "system", content: extractText(body.system) });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    messages.push({ role: message.role, content: extractText(message.content) });
  }
  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 1_000,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: Boolean(body.stream),
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
  };
}

async function streamOpenAiResponse(response: Response, reply: FastifyReply, entry: VaultEntry, model: string, fallbackInputTokens: number, transformToAnthropic = false, maxOutputLimit = Infinity) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  let buffer = "";
  let outputText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let providerCost: unknown;
  let providerUsageSeen = false;
  let generationId: string | undefined;
  let pendingStaged = false;

  if (transformToAnthropic) {
    reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: fallbackInputTokens, output_tokens: 0 } } })}\n\n`);
    reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider streaming response has no body");
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let data: any;
      try { data = JSON.parse(raw); } catch { continue; }
      if (!generationId && typeof data.id === "string") generationId = data.id;
      if (providerKind(entry) === "openrouter" && generationId && !pendingStaged) {
        // Persist the provider generation before forwarding its first chunk.
        // If reconciliation fails or the process restarts, later calls remain
        // blocked until this exact generation is recovered and committed.
        stagePendingUsage(entry, {
          generationId,
          model,
          inputTokens: fallbackInputTokens,
          outputTokens: 0,
          cachedTokens: 0,
          providerCost: null,
        });
        pendingStaged = true;
      }
      const text = data.choices?.[0]?.delta?.content;
      if (typeof text === "string") {
        outputText += text;
        if (transformToAnthropic) {
          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
        }
      }
      if (!transformToAnthropic) reply.raw.write(`data: ${raw}\n\n`);
      if (data.usage) {
        providerUsageSeen = true;
        inputTokens = Number(data.usage.prompt_tokens || inputTokens);
        outputTokens = Number(data.usage.completion_tokens || outputTokens);
        cachedTokens = Number(data.usage.prompt_tokens_details?.cached_tokens || cachedTokens);
        if (data.usage.cost !== undefined) providerCost = data.usage.cost;
      }
    }
    if (Number.isFinite(maxOutputLimit)) {
      const currentEstimated = outputTokens || countTextTokens(entry.provider, model, outputText);
      if (currentEstimated >= maxOutputLimit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }

  inputTokens ||= fallbackInputTokens;
  outputTokens ||= countTextTokens(entry.provider, model, outputText);
  try {
    const committed = await finalizeProviderUsage(entry, {
      generationId: generationId || null,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      providerCost: Number.isFinite(Number(providerCost)) ? Number(providerCost) : null,
    });
    const usage = committed.usage;
    const usageSource = committed.source || (providerUsageSeen ? "provider" : "tokenizer");
    if (transformToAnthropic) {
      reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
      reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop", conpi_cost_usd: usage.costUsd, conpi_usage_source: usageSource })}\n\n`);
    } else {
      reply.raw.write(`data: ${JSON.stringify({ object: "conpi.meter", usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, conpi_cost_usd: usage.costUsd, conpi_usage_source: usageSource }, stages: usage.stages })}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
    }
  } catch (error: any) {
    const payload = { error: { message: error.message, code: "cost_reconciliation_failed" } };
    if (transformToAnthropic) reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    else reply.raw.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    return reply.raw.end();
  }
  return reply.raw.end();
}

async function streamAnthropicResponse(response: Response, reply: FastifyReply, entry: VaultEntry, model: string, fallbackInputTokens: number, transformToOpenAi = false, maxOutputLimit = Infinity) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  let buffer = "";
  let outputText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let providerUsageSeen = false;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider streaming response has no body");
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!transformToOpenAi) reply.raw.write(chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      let data: any;
      try { data = JSON.parse(raw); } catch { continue; }
      if (data.message?.usage || data.usage) providerUsageSeen = true;
      inputTokens = Number(data.message?.usage?.input_tokens || data.usage?.input_tokens || inputTokens);
      outputTokens = Number(data.usage?.output_tokens || outputTokens);
      const text = data.delta?.text;
      if (typeof text === "string") {
        outputText += text;
        if (transformToOpenAi) {
          reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        }
      }
    }
    if (Number.isFinite(maxOutputLimit)) {
      const currentEstimated = outputTokens || countTextTokens(entry.provider, model, outputText);
      if (currentEstimated >= maxOutputLimit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  inputTokens ||= fallbackInputTokens;
  outputTokens ||= countTextTokens(entry.provider, model, outputText);
  const usage = recordUsage(entry, model, inputTokens, outputTokens);
  if (transformToOpenAi) {
    reply.raw.write(`data: ${JSON.stringify({ id: `chatcmpl-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, conpi_cost_usd: usage.costUsd, conpi_usage_source: providerUsageSeen ? "provider" : "tokenizer" } })}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
  }
  return reply.raw.end();
}

export async function handleChatCompletions(req: FastifyRequest, reply: FastifyReply) {
  const entry = authenticate(req, reply);
  if (!entry || !enforceRateLimit(entry, reply)) return;
  const body = (req.body || {}) as any;
  const model = String(body.model || "");
  if (!model) return reply.status(400).send({ error: { message: "model is required", code: "invalid_request" } });
  if (providerKind(entry) === "openrouter") {
    const unpricedFeature = validatePricedOpenRouterRequest(body);
    if (unpricedFeature) {
      return reply.status(400).send({
        error: { message: `OpenRouter request feature '${unpricedFeature}' is not covered by the deal's locked pricing`, code: "unpriced_feature" },
      });
    }
  }
  const inputTokens = countChatInputTokens(entry.provider, model, body.messages);
  const affordableOutputTokens = computeAffordableOutputTokens(entry, model, inputTokens);
  if (affordableOutputTokens <= 0) {
    return reply.status(402).send({
      error: {
        message: `Remaining locked credit ($${Math.max(0, entry.creditUsd - entry.usedUsd).toFixed(6)}) cannot cover prompt and output tokens`,
        code: "budget_cap_exceeded",
      },
    });
  }
  const requestedMaxTokens = body.max_tokens ?? body.max_completion_tokens;
  const effectiveMaxTokens = requestedMaxTokens != null
    ? Math.min(Math.max(1, Number(requestedMaxTokens)), Math.max(1, affordableOutputTokens))
    : Math.max(1, affordableOutputTokens);
  if (!enforceModelAndBudget(entry, model, inputTokens, effectiveMaxTokens, reply)) return;

  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") return reply.status(403).send({ error: { message: "Mock keys are disabled", code: "mock_forbidden" } });
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockChatCompletion } = await import(mockModulePath) as any;
    return handleMockChatCompletion(req, reply, entry, model);
  }

  if (!(await acquireBillingLock(entry, reply))) return;
  if (!enforceModelAndBudget(entry, model, inputTokens, effectiveMaxTokens, reply)) {
    entry.requestInFlight = false;
    return;
  }

  const forwardBody = {
    ...body,
    max_tokens: effectiveMaxTokens,
    ...(body.max_completion_tokens != null ? { max_completion_tokens: effectiveMaxTokens } : {}),
  };

  try {
    const kind = providerKind(entry);
    if (kind === "anthropic") {
      const response = await fetchWithTransientBackoff("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(openAiMessagesToAnthropic(forwardBody)),
      });
      if (!response.ok) return handleProviderFailure(response, entry, reply);
      if (body.stream) return await streamAnthropicResponse(response, reply, entry, model, inputTokens, true, effectiveMaxTokens);
      const data: any = await response.json();
      const outputText = extractText(data.content);
      const providerUsageSeen = data.usage?.input_tokens !== undefined && data.usage?.output_tokens !== undefined;
      const finalInput = Number(data.usage?.input_tokens || inputTokens);
      const finalOutput = Number(data.usage?.output_tokens || countTextTokens(entry.provider, model, outputText));
      const usage = recordUsage(entry, model, finalInput, finalOutput);
      return reply.send({
        id: `chatcmpl-${data.id || Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: "assistant", content: outputText }, finish_reason: data.stop_reason === "max_tokens" ? "length" : "stop" }],
        usage: { prompt_tokens: finalInput, completion_tokens: finalOutput, total_tokens: finalInput + finalOutput, conpi_cost_usd: usage.costUsd, conpi_usage_source: providerUsageSeen ? "provider" : "tokenizer" },
      });
    }

    const response = await fetchWithTransientBackoff(`${openAiBaseUrl(kind)}/chat/completions`, {
      method: "POST", headers: providerHeaders(entry, kind),
      body: JSON.stringify(requestWithProviderUsage(forwardBody, kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply);
    if (body.stream) return await streamOpenAiResponse(response, reply, entry, model, inputTokens, false, effectiveMaxTokens);
    const data: any = await response.json();
    const outputText = extractText(data.choices?.[0]?.message?.content);
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || inputTokens);
    const finalOutput = Number(data.usage?.completion_tokens || countTextTokens(entry.provider, model, outputText));
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const committed = await finalizeProviderUsage(entry, {
      generationId: typeof data.id === "string" ? data.id : null,
      model,
      inputTokens: finalInput,
      outputTokens: finalOutput,
      cachedTokens,
      providerCost: Number.isFinite(Number(data.usage?.cost)) ? Number(data.usage.cost) : null,
      lastError: undefined,
    });
    const conpiUsageSource = providerKind(entry) === "openrouter"
      ? (committed.source || "openrouter_usage")
      : (providerUsageSeen ? "provider" : "tokenizer");
    data.usage = { ...(data.usage || {}), prompt_tokens: finalInput, completion_tokens: finalOutput, total_tokens: finalInput + finalOutput, conpi_cost_usd: committed.usage.costUsd, conpi_usage_source: conpiUsageSource };
    return reply.status(response.status).send(data);
  } catch (err: any) {
    return reply.status(502).send({ error: { message: err.message, code: "proxy_error" } });
  } finally {
    entry.requestInFlight = false;
  }
}

export async function handleAnthropicMessages(req: FastifyRequest, reply: FastifyReply) {
  const entry = authenticate(req, reply);
  if (!entry || !enforceRateLimit(entry, reply)) return;
  const body = (req.body || {}) as any;
  const model = String(body.model || "");
  if (!model) return reply.status(400).send({ error: { type: "invalid_request_error", message: "model is required" } });
  if (providerKind(entry) === "openrouter") {
    const unpricedFeature = validatePricedOpenRouterRequest(body);
    if (unpricedFeature) {
      return reply.status(400).send({
        error: { type: "invalid_request_error", message: `OpenRouter request feature '${unpricedFeature}' is not covered by the deal's locked pricing`, code: "unpriced_feature" },
      });
    }
  }
  const inputTokens = countChatInputTokens(entry.provider, model, body.messages, body.system);
  const affordableOutputTokens = computeAffordableOutputTokens(entry, model, inputTokens);
  if (affordableOutputTokens <= 0) {
    return reply.status(402).send({
      error: {
        type: "budget_cap_exceeded",
        message: `Remaining locked credit ($${Math.max(0, entry.creditUsd - entry.usedUsd).toFixed(6)}) cannot cover prompt and output tokens`,
      },
    });
  }
  const requestedMaxTokens = body.max_tokens;
  const effectiveMaxTokens = requestedMaxTokens != null
    ? Math.min(Math.max(1, Number(requestedMaxTokens)), Math.max(1, affordableOutputTokens))
    : Math.max(1, affordableOutputTokens);
  if (!enforceModelAndBudget(entry, model, inputTokens, effectiveMaxTokens, reply)) return;

  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") return reply.status(403).send({ error: { type: "permission_error", message: "Mock keys are disabled" } });
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockAnthropicMessage } = await import(mockModulePath) as any;
    return handleMockAnthropicMessage(req, reply, entry, model);
  }

  if (!(await acquireBillingLock(entry, reply))) return;
  if (!enforceModelAndBudget(entry, model, inputTokens, effectiveMaxTokens, reply)) {
    entry.requestInFlight = false;
    return;
  }

  const forwardBody = {
    ...body,
    max_tokens: effectiveMaxTokens,
  };

  try {
    const kind = providerKind(entry);
    if (kind === "anthropic") {
      const response = await fetchWithTransientBackoff("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(forwardBody),
      });
      if (!response.ok) return handleProviderFailure(response, entry, reply, true);
      if (body.stream) return await streamAnthropicResponse(response, reply, entry, model, inputTokens, false, effectiveMaxTokens);
      const data: any = await response.json();
      const outputText = extractText(data.content);
      const providerUsageSeen = data.usage?.input_tokens !== undefined && data.usage?.output_tokens !== undefined;
      const finalInput = Number(data.usage?.input_tokens || inputTokens);
      const finalOutput = Number(data.usage?.output_tokens || countTextTokens(entry.provider, model, outputText));
      const usage = recordUsage(entry, model, finalInput, finalOutput);
      data.usage = { ...(data.usage || {}), input_tokens: finalInput, output_tokens: finalOutput, conpi_cost_usd: usage.costUsd, conpi_usage_source: providerUsageSeen ? "provider" : "tokenizer" };
      return reply.send(data);
    }

    const response = await fetchWithTransientBackoff(`${openAiBaseUrl(kind)}/chat/completions`, {
      method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(requestWithProviderUsage(anthropicMessagesToOpenAi(forwardBody), kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply, true);
    if (body.stream) return await streamOpenAiResponse(response, reply, entry, model, inputTokens, true, effectiveMaxTokens);
    const data: any = await response.json();
    const outputText = extractText(data.choices?.[0]?.message?.content);
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || inputTokens);
    const finalOutput = Number(data.usage?.completion_tokens || countTextTokens(entry.provider, model, outputText));
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const committed = await finalizeProviderUsage(entry, {
      generationId: typeof data.id === "string" ? data.id : null,
      model,
      inputTokens: finalInput,
      outputTokens: finalOutput,
      cachedTokens,
      providerCost: Number.isFinite(Number(data.usage?.cost)) ? Number(data.usage.cost) : null,
    });
    return reply.send({
      id: `msg_${data.id || Date.now()}`, type: "message", role: "assistant", model,
      content: [{ type: "text", text: outputText }],
      stop_reason: data.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null,
      usage: { input_tokens: finalInput, output_tokens: finalOutput, conpi_cost_usd: committed.usage.costUsd, conpi_usage_source: committed.source || (providerUsageSeen ? "provider" : "tokenizer") },
    });
  } catch (err: any) {
    return reply.status(502).send({ error: { type: "api_error", message: err.message } });
  } finally {
    entry.requestInFlight = false;
  }
}

export async function handleEmbeddings(req: FastifyRequest, reply: FastifyReply) {
  const entry = authenticate(req, reply);
  if (!entry || !enforceRateLimit(entry, reply)) return;
  const body = (req.body || {}) as any;
  const model = String(body.model || "");
  if (!model) return reply.status(400).send({ error: { message: "model is required", code: "invalid_request" } });
  if (providerKind(entry) === "openrouter") {
    const unpricedFeature = validatePricedOpenRouterRequest(body);
    if (unpricedFeature) {
      return reply.status(400).send({
        error: { message: `OpenRouter request feature '${unpricedFeature}' is not covered by the deal's locked pricing`, code: "unpriced_feature" },
      });
    }
  }
  const inputTokens = countEmbeddingInputTokens(entry.provider, model, body.input);
  if (!enforceModelAndBudget(entry, model, inputTokens, 0, reply)) return;
  const kind = providerKind(entry);
  if (kind === "anthropic") return reply.status(400).send({ error: { message: "Anthropic does not provide embeddings", code: "unsupported_provider_feature" } });
  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") return reply.status(403).send({ error: { message: "Mock keys are disabled", code: "mock_forbidden" } });
    const usage = recordUsage(entry, model, inputTokens, 0);
    return reply.send({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.125, -0.25, 0.5] }],
      model,
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens, conpi_cost_usd: usage.costUsd },
    });
  }
  if (!(await acquireBillingLock(entry, reply))) return;
  if (!enforceModelAndBudget(entry, model, inputTokens, 0, reply)) {
    entry.requestInFlight = false;
    return;
  }
  try {
    const response = await fetchWithTransientBackoff(`${openAiBaseUrl(kind)}/embeddings`, {
      method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(requestWithProviderUsage(body, kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply);
    const data: any = await response.json();
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined || data.usage?.total_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || data.usage?.total_tokens || inputTokens);
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const committed = await finalizeProviderUsage(entry, {
      generationId: typeof data.id === "string" ? data.id : null,
      model,
      inputTokens: finalInput,
      outputTokens: 0,
      cachedTokens,
      providerCost: Number.isFinite(Number(data.usage?.cost)) ? Number(data.usage.cost) : null,
    });
    data.usage = { ...(data.usage || {}), prompt_tokens: finalInput, total_tokens: finalInput, conpi_cost_usd: committed.usage.costUsd, conpi_usage_source: committed.source || (providerUsageSeen ? "provider" : "tokenizer") };
    return reply.status(response.status).send(data);
  } catch (err: any) {
    return reply.status(502).send({ error: { message: err.message, code: "proxy_error" } });
  } finally {
    entry.requestInFlight = false;
  }
}

export async function handleModels(req: FastifyRequest, reply: FastifyReply) {
  const entry = authenticate(req, reply);
  if (!entry || !enforceRateLimit(entry, reply)) return;
  return reply.send({
    object: "list",
    conpi_pricing_snapshot_hash: entry.pricingSnapshotHash,
    data: entry.models.map((model) => ({
      id: model, object: "model", created: Math.floor(new Date(entry.registeredAt).getTime() / 1_000),
      owned_by: entry.provider.toLowerCase(), conpi_locked_pricing: entry.lockedPricing[model],
    })),
  });
}
