import { FastifyReply, FastifyRequest } from "fastify";
import crypto from "crypto";
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
}

export async function resolveOpenRouterCost(
  apiKey: string,
  providerCost: unknown,
  generationId: unknown,
  options: { fetchImpl?: typeof fetch; retryDelaysMs?: number[] } = {}
): Promise<OpenRouterCostResolution> {
  const direct = typeof providerCost === "number" ? providerCost : Number.parseFloat(String(providerCost ?? ""));
  if (Number.isFinite(direct) && direct >= 0) return { costUsd: direct, source: "openrouter_usage" };

  const normalizedId = typeof generationId === "string" ? generationId.trim() : "";
  if (!normalizedId) {
    throw new Error("OpenRouter omitted both usage.cost and the generation ID; metering was stopped without releasing funds");
  }

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
        return { costUsd: observed, source: "openrouter_generation" };
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

async function authoritativeCostForEntry(
  entry: VaultEntry,
  providerCost: unknown,
  generationId: unknown
): Promise<{ providerCost?: number; generationId?: string; source?: OpenRouterCostResolution["source"] }> {
  if (providerKind(entry) !== "openrouter") return {};
  const normalizedId = typeof generationId === "string" && generationId.trim() ? generationId.trim() : undefined;
  const resolved = await resolveOpenRouterCost(entry.apiKey, providerCost, normalizedId);
  return { providerCost: resolved.costUsd, generationId: normalizedId, source: resolved.source };
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
  const calculated = calculateCost(model, inputTokens, outputTokens, cachedTokens, entry.lockedPricing);
  const usage = {
    ...calculated,
    costUsd: resolveMeteredCostUsd(entry.provider, calculated.costUsd, providerCost),
  };
  entry.usedUsd = Math.min(entry.creditUsd, entry.usedUsd + usage.costUsd);
  entry.tokensTotal += usage.inputTokens + usage.outputTokens;
  const previousHash = entry.usageReceipts.at(-1)?.hash || null;
  const receiptBody = {
    sequence: entry.usageReceipts.length + 1,
    generationId: generationId || null,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
    cumulativeUsedUsd: entry.usedUsd,
    source: costSource || "locked_pricing" as const,
    createdAt: new Date().toISOString(),
    previousHash,
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  entry.usageReceipts.push({
    ...receiptBody,
    hash,
    signatureHex: Buffer.from(enclaveKeys.sign(Buffer.from(hash, "hex"))).toString("hex"),
  });
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

async function streamOpenAiResponse(response: Response, reply: FastifyReply, entry: VaultEntry, model: string, fallbackInputTokens: number, transformToAnthropic = false) {
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
  }

  inputTokens ||= fallbackInputTokens;
  outputTokens ||= countTextTokens(entry.provider, model, outputText);
  let authoritative: Awaited<ReturnType<typeof authoritativeCostForEntry>>;
  try {
    authoritative = await authoritativeCostForEntry(entry, providerCost, generationId);
  } catch (error: any) {
    const payload = { error: { message: error.message, code: "cost_reconciliation_failed" } };
    if (transformToAnthropic) reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    else reply.raw.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    return reply.raw.end();
  }
  const usage = recordUsage(
    entry,
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    authoritative.providerCost,
    authoritative.generationId,
    authoritative.source
  );
  const usageSource = authoritative.source || (providerUsageSeen ? "provider" : "tokenizer");
  if (transformToAnthropic) {
    reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
    reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop", conpi_cost_usd: usage.costUsd, conpi_usage_source: usageSource })}\n\n`);
  } else {
    reply.raw.write(`data: ${JSON.stringify({ object: "conpi.meter", usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, conpi_cost_usd: usage.costUsd, conpi_usage_source: usageSource }, stages: usage.stages })}\n\n`);
    reply.raw.write("data: [DONE]\n\n");
  }
  return reply.raw.end();
}

async function streamAnthropicResponse(response: Response, reply: FastifyReply, entry: VaultEntry, model: string, fallbackInputTokens: number, transformToOpenAi = false) {
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
  const maxOutputTokens = Math.max(1, Number(body.max_tokens ?? body.max_completion_tokens ?? 1_000));
  if (!enforceModelAndBudget(entry, model, inputTokens, maxOutputTokens, reply)) return;

  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") return reply.status(403).send({ error: { message: "Mock keys are disabled", code: "mock_forbidden" } });
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockChatCompletion } = await import(mockModulePath) as any;
    return handleMockChatCompletion(req, reply, entry, model);
  }

  try {
    const kind = providerKind(entry);
    if (kind === "anthropic") {
      const response = await fetchWithTransientBackoff("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(openAiMessagesToAnthropic(body)),
      });
      if (!response.ok) return handleProviderFailure(response, entry, reply);
      if (body.stream) return streamAnthropicResponse(response, reply, entry, model, inputTokens, true);
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
      body: JSON.stringify(requestWithProviderUsage(body, kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply);
    if (body.stream) return streamOpenAiResponse(response, reply, entry, model, inputTokens);
    const data: any = await response.json();
    const outputText = extractText(data.choices?.[0]?.message?.content);
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || inputTokens);
    const finalOutput = Number(data.usage?.completion_tokens || countTextTokens(entry.provider, model, outputText));
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const authoritative = await authoritativeCostForEntry(entry, data.usage?.cost, data.id);
    const usage = recordUsage(entry, model, finalInput, finalOutput, cachedTokens, authoritative.providerCost, authoritative.generationId, authoritative.source);
    data.usage = { ...(data.usage || {}), prompt_tokens: finalInput, completion_tokens: finalOutput, total_tokens: finalInput + finalOutput, conpi_cost_usd: usage.costUsd, conpi_usage_source: authoritative.source || (providerUsageSeen ? "provider" : "tokenizer") };
    return reply.status(response.status).send(data);
  } catch (err: any) {
    return reply.status(502).send({ error: { message: err.message, code: "proxy_error" } });
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
  const maxOutputTokens = Math.max(1, Number(body.max_tokens ?? 1_000));
  if (!enforceModelAndBudget(entry, model, inputTokens, maxOutputTokens, reply)) return;

  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") return reply.status(403).send({ error: { type: "permission_error", message: "Mock keys are disabled" } });
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockAnthropicMessage } = await import(mockModulePath) as any;
    return handleMockAnthropicMessage(req, reply, entry, model);
  }

  try {
    const kind = providerKind(entry);
    if (kind === "anthropic") {
      const response = await fetchWithTransientBackoff("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(body),
      });
      if (!response.ok) return handleProviderFailure(response, entry, reply, true);
      if (body.stream) return streamAnthropicResponse(response, reply, entry, model, inputTokens);
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
      method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(requestWithProviderUsage(anthropicMessagesToOpenAi(body), kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply, true);
    if (body.stream) return streamOpenAiResponse(response, reply, entry, model, inputTokens, true);
    const data: any = await response.json();
    const outputText = extractText(data.choices?.[0]?.message?.content);
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || inputTokens);
    const finalOutput = Number(data.usage?.completion_tokens || countTextTokens(entry.provider, model, outputText));
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const authoritative = await authoritativeCostForEntry(entry, data.usage?.cost, data.id);
    const usage = recordUsage(entry, model, finalInput, finalOutput, cachedTokens, authoritative.providerCost, authoritative.generationId, authoritative.source);
    return reply.send({
      id: `msg_${data.id || Date.now()}`, type: "message", role: "assistant", model,
      content: [{ type: "text", text: outputText }],
      stop_reason: data.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null,
      usage: { input_tokens: finalInput, output_tokens: finalOutput, conpi_cost_usd: usage.costUsd, conpi_usage_source: authoritative.source || (providerUsageSeen ? "provider" : "tokenizer") },
    });
  } catch (err: any) {
    return reply.status(502).send({ error: { type: "api_error", message: err.message } });
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
  try {
    const response = await fetchWithTransientBackoff(`${openAiBaseUrl(kind)}/embeddings`, {
      method: "POST", headers: providerHeaders(entry, kind), body: JSON.stringify(requestWithProviderUsage(body, kind, entry.lockedPricing[model])),
    });
    if (!response.ok) return handleProviderFailure(response, entry, reply);
    const data: any = await response.json();
    const providerUsageSeen = data.usage?.prompt_tokens !== undefined || data.usage?.total_tokens !== undefined;
    const finalInput = Number(data.usage?.prompt_tokens || data.usage?.total_tokens || inputTokens);
    const cachedTokens = Number(data.usage?.prompt_tokens_details?.cached_tokens || 0);
    const authoritative = await authoritativeCostForEntry(entry, data.usage?.cost, data.id);
    const usage = recordUsage(entry, model, finalInput, 0, cachedTokens, authoritative.providerCost, authoritative.generationId, authoritative.source);
    data.usage = { ...(data.usage || {}), prompt_tokens: finalInput, total_tokens: finalInput, conpi_cost_usd: usage.costUsd, conpi_usage_source: authoritative.source || (providerUsageSeen ? "provider" : "tokenizer") };
    return reply.status(response.status).send(data);
  } catch (err: any) {
    return reply.status(502).send({ error: { message: err.message, code: "proxy_error" } });
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
