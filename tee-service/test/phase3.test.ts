process.env.NODE_ENV = "test";

import WebSocket from "ws";
import { buildApp } from "../src/index.js";
import { nearRelayer } from "../src/chain/relayer.js";
import { keyVault } from "../src/vault/preflight.js";
import { meterEvents } from "../src/proxy/events.js";
import { calculateCost } from "../src/proxy/pricing.js";
import { proxyRateLimiter } from "../src/proxy/rate-limit.js";
import { classifyProviderError, extractProviderErrorCode, requestWithProviderUsage, resolveMeteredCostUsd } from "../src/proxy/server.js";
import { countChatInputTokens, countEmbeddingInputTokens } from "../src/proxy/tokenizer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runPhase3Tests() {
  console.log("=== RUNNING CONPI PHASE 3 ACCEPTANCE TESTS ===");

  (nearRelayer as any).getDeal = async () => ({
    id: 3001,
    token: "usdc.testnet",
    credit_amount: "100000000",
    price: "80000000",
    terms_hash: Array.from(Buffer.from("11".repeat(32), "hex")),
  });

  const keyResult = await keyVault.validateAndInjectKey(
    3001,
    "OpenAI",
    "gpt-4o",
    ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"],
    undefined,
    undefined,
    "11".repeat(32),
    undefined,
    "mock_phase3_provider_key"
  );
  assert(keyResult.ok && keyResult.proxyKey, `Failed to prepare Phase 3 test deal: ${keyResult.error}`);
  const proxyKey = keyResult.proxyKey;
  const entry = keyVault.getByProxyKey(proxyKey)!;
  const app = await buildApp();
  const auth = { authorization: `Bearer ${proxyKey}` };

  console.log("[P3-1] Per-deal locked pricing...");
  assert(Object.isFrozen(entry.lockedPricing), "Locked pricing table must be immutable");
  assert(Object.isFrozen(entry.lockedPricing["gpt-4o"]), "Locked model rate must be immutable");
  const priced = calculateCost("gpt-4o", 1_000, 500, 0, entry.lockedPricing);
  assert(Math.abs(priced.costUsd - 0.0075) < 1e-12, "Locked price calculation is incorrect");
  assert(
    Math.abs(resolveMeteredCostUsd("OpenRouter", 0.05, 0.0251) - 0.0251) < 1e-12,
    "OpenRouter authoritative usage.cost was not used"
  );
  assert(
    Math.abs(resolveMeteredCostUsd("OpenAI", 0.05, 0.0251) - 0.05) < 1e-12,
    "A non-OpenRouter provider was allowed to override locked-price accounting"
  );
  const openRouterBody = requestWithProviderUsage({ model: "z-ai/glm-5.3-flash", stream: true }, "openrouter");
  assert(openRouterBody.usage?.include === true, "OpenRouter requests must require authoritative cost metadata");
  assert(openRouterBody.stream_options?.include_usage === true, "OpenRouter streams must include their final usage chunk");

  console.log("[P3-2] Production tokenizer fallbacks...");
  const chatTokens = countChatInputTokens("OpenAI", "gpt-4o", [{ role: "user", content: "Tokenize this exact request." }]);
  const embeddingTokens = countEmbeddingInputTokens("OpenAI", "text-embedding-3-small", ["alpha", "beta"]);
  assert(chatTokens > 5, "Chat tokenizer returned an implausible token count");
  assert(embeddingTokens >= 2, "Embedding tokenizer returned an implausible token count");

  console.log("[P3-3] Proxy authentication, allowlist, and model discovery...");
  const unauthModels = await app.inject({ method: "GET", url: "/v1/models" });
  assert(unauthModels.statusCode === 401, "Models endpoint must reject missing proxy credentials");
  const models = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
  assert(models.statusCode === 200, `Models endpoint failed: ${models.body}`);
  assert(JSON.parse(models.body).data.every((row: any) => row.conpi_locked_pricing), "Models must expose locked pricing rows");
  const disallowed = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4-turbo", max_tokens: 1, messages: [{ role: "user", content: "hello" }] },
  });
  assert(disallowed.statusCode === 400 && disallowed.body.includes("model_disallowed"), "Exact model allowlist was not enforced");
  const unauthMeter = await app.inject({ method: "GET", url: "/v1/deals/3001/meter" });
  assert(unauthMeter.statusCode === 401, "Meter endpoint must reject missing proxy credentials");
  const wrongDealMeter = await app.inject({ method: "GET", url: "/v1/deals/9999/meter", headers: auth });
  assert(wrongDealMeter.statusCode === 403, "Meter endpoint must reject a proxy key from another deal");
  const authorizedMeter = await app.inject({ method: "GET", url: "/v1/deals/3001/meter", headers: auth });
  assert(authorizedMeter.statusCode === 200, `Authenticated meter endpoint failed: ${authorizedMeter.body}`);

  console.log("[P3-4] Hard budget cap before provider execution...");
  const savedUsed = entry.usedUsd;
  entry.usedUsd = entry.creditUsd - 0.000001;
  const overBudget = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 1_000, messages: [{ role: "user", content: "hello" }] },
  });
  assert(overBudget.statusCode === 402 && overBudget.body.includes("budget_cap_exceeded"), "Hard budget cap was not enforced");
  entry.usedUsd = savedUsed;

  console.log("[P3-5] Chat and embeddings metering through cpk_live auth...");
  const beforeChat = entry.usedUsd;
  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hello phase three" }] },
  });
  assert(chat.statusCode === 200, `Mock chat proxy failed: ${chat.body}`);
  assert(entry.usedUsd > beforeChat, "Chat usage did not advance the meter");
  const embedding = await app.inject({
    method: "POST",
    url: "/v1/embeddings",
    headers: auth,
    payload: { model: "text-embedding-3-small", input: ["conpi", "phase three"] },
  });
  assert(embedding.statusCode === 200, `Embeddings proxy failed: ${embedding.body}`);
  assert(JSON.parse(embedding.body).usage.conpi_cost_usd > 0, "Embedding usage did not use locked pricing");

  console.log("[P3-6] Enclave rate limiting...");
  proxyRateLimiter.reset(proxyKey);
  entry.rateLimitPerMinute = 2;
  assert((await app.inject({ method: "GET", url: "/v1/models", headers: auth })).statusCode === 200, "Rate limit request 1 failed");
  assert((await app.inject({ method: "GET", url: "/v1/models", headers: auth })).statusCode === 200, "Rate limit request 2 failed");
  const limited = await app.inject({ method: "GET", url: "/v1/models", headers: auth });
  assert(limited.statusCode === 429 && limited.headers["retry-after"], "Proxy rate limit did not return 429 + Retry-After");
  entry.rateLimitPerMinute = 60;
  proxyRateLimiter.reset(proxyKey);

  console.log("[P3-7] Precise provider error classification...");
  assert(classifyProviderError(429, '{"error":{"code":"rate_limit_exceeded"}}') === "transient_rate_limit", "Transient 429 misclassified");
  assert(classifyProviderError(429, '{"error":{"code":"insufficient_quota"}}') === "insufficient_quota", "Quota 429 misclassified");
  assert(classifyProviderError(401, '{"error":{"code":"invalid_api_key"}}') === "invalid_key", "401 misclassified");
  assert(classifyProviderError(401, '{"error":{"message":"Insufficient credits","code":401}}') === "invalid_key", "A true 401 must remain InvalidKey");
  const openRouterCredits402 = '{"error":{"message":"Insufficient credits. Add more credits and try again.","code":402}}';
  const openRouterKeyLimit403 = '{"error":{"message":"Key limit exceeded","code":403}}';
  assert(classifyProviderError(402, openRouterCredits402) === "insufficient_quota", "OpenRouter 402 insufficient credits misclassified");
  assert(classifyProviderError(403, openRouterKeyLimit403) === "insufficient_quota", "OpenRouter 403 key limit misclassified");
  assert(extractProviderErrorCode(openRouterCredits402) === "402", "OpenRouter upstream error code was not extracted safely");
  assert(classifyProviderError(403, '{"error":{"message":"Forbidden"}}') === "upstream", "Bare 403 must not create a default");
  assert(classifyProviderError(403, "account_suspended") === "provider_ban", "Provider ban misclassified");

  console.log("[P3-8] Transient provider backoff and retry...");
  const originalFetch = globalThis.fetch;
  const savedKey = entry.apiKey;
  entry.apiKey = "sk-real-shape-for-fetch-stub";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({
      id: "stub-chat",
      choices: [{ message: { role: "assistant", content: "retry succeeded" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const retried = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 4, messages: [{ role: "user", content: "retry" }] },
  });
  assert(retried.statusCode === 200 && fetchCalls === 2, `Transient retry failed: calls=${fetchCalls}, body=${retried.body}`);
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: "stub-chat-without-provider-usage",
    choices: [{ message: { role: "assistant", content: "tokenizer fallback worked" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const fallbackResponse = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 8, messages: [{ role: "user", content: "meter without provider usage" }] },
  });
  const fallbackBody = JSON.parse(fallbackResponse.body);
  const fallbackExpected = calculateCost(
    "gpt-4o",
    fallbackBody.usage?.prompt_tokens,
    fallbackBody.usage?.completion_tokens,
    0,
    entry.lockedPricing
  );
  assert(fallbackResponse.statusCode === 200, `Tokenizer fallback request failed: ${fallbackResponse.body}`);
  assert(fallbackBody.usage?.prompt_tokens > 0 && fallbackBody.usage?.completion_tokens > 0, "Tokenizer fallback did not synthesize usage");
  assert(fallbackBody.usage?.conpi_usage_source === "tokenizer", "Tokenizer fallback was not identified in the metered response");
  assert(Math.abs(fallbackBody.usage.conpi_cost_usd - fallbackExpected.costUsd) < 1e-12, "Tokenizer fallback was not charged against the locked table");

  console.log("[P3-9] OpenRouter quota errors create exactly one seller self-drain default...");
  const defaultCountBefore = entry.signedPayloads.filter((item) => item.payload.kind === 4).length;
  entry.defaultPayload = undefined;
  entry.active = true;
  globalThis.fetch = (async () => new Response(
    '{"error":{"message":"Forbidden"}}',
    { status: 403, headers: { "content-type": "application/json" } }
  )) as typeof fetch;
  const bareForbidden = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 4, messages: [{ role: "user", content: "bare forbidden" }] },
  });
  assert(bareForbidden.statusCode === 403, `Bare provider 403 must pass through without default: ${bareForbidden.body}`);
  assert(entry.signedPayloads.filter((item) => item.payload.kind === 4).length === defaultCountBefore, "Bare provider 403 created a default");
  assert(entry.active, "Bare provider 403 froze the deal");
  const warningRows: any[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => warningRows.push(args);
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      '{"error":{"message":"Insufficient credits. Add more credits and try again.","code":402}}',
      { status: 402, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  const concurrentFailures = await Promise.all(Array.from({ length: 5 }, () => app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 4, messages: [{ role: "user", content: "quota race" }] },
  })));
  console.warn = originalWarn;
  assert(concurrentFailures.every((response) => response.statusCode === 502 && response.body.includes("seller_self_drain")), "Concurrent quota failures were not seller self-drain responses");
  const defaultPayloads = entry.signedPayloads.filter((item) => item.payload.kind === 4);
  assert(defaultPayloads.length === defaultCountBefore + 1, `Expected exactly one new default, found ${defaultPayloads.length - defaultCountBefore}`);
  const responseDefaults = concurrentFailures.map((response) => JSON.parse(response.body).defaultPayload);
  assert(new Set(responseDefaults.map((item) => item.signatureHex)).size === 1, "In-flight requests did not receive the same default signature");
  assert(new Set(responseDefaults.map((item) => item.payload.nonce)).size === 1, "In-flight requests did not receive the same default nonce");
  assert(defaultPayloads[defaultPayloads.length - 1].payload.reason === 5, "Default payload reason must be SellerSelfDrain");
  assert(warningRows.length === 5, "Each upstream failure must emit one sanitized diagnostic log");
  assert(warningRows.every((row) => row[1]?.status === 402 && row[1]?.code === "402"), "Upstream diagnostics must contain status and error code");
  assert(!JSON.stringify(warningRows).includes("sk-real-shape-for-fetch-stub"), "Upstream diagnostics leaked provider credentials");
  globalThis.fetch = originalFetch;
  entry.apiKey = savedKey;
  entry.active = true;
  entry.defaultPayload = undefined;

  console.log("[P3-10] Native Anthropic protocol and OpenAI-to-Anthropic adapter...");
  const anthropicResult = await keyVault.validateAndInjectKey(
    3002,
    "anthropic",
    "claude-sonnet-4-6",
    ["claude-sonnet-4-6"],
    undefined,
    undefined,
    "11".repeat(32),
    undefined,
    "mock_anthropic_adapter_key"
  );
  assert(anthropicResult.ok && anthropicResult.proxyKey, `Failed to prepare Anthropic adapter: ${anthropicResult.error}`);
  const anthropicEntry = keyVault.getByProxyKey(anthropicResult.proxyKey)!;
  anthropicEntry.apiKey = "sk-ant-provider-shape-for-fetch-stub";
  const anthropicCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    anthropicCalls.push({
      url: String(url),
      headers: (init?.headers || {}) as Record<string, string>,
      body: JSON.parse(String(init?.body || "{}")),
    });
    return new Response(JSON.stringify({
      id: `msg_adapter_${anthropicCalls.length}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Anthropic adapter verified" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 9, output_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const anthropicAuth = { authorization: `Bearer ${anthropicResult.proxyKey}` };
  const nativeAnthropic = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: anthropicAuth,
    payload: { model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "native request" }] },
  });
  assert(nativeAnthropic.statusCode === 200 && JSON.parse(nativeAnthropic.body).type === "message", `Native Anthropic request failed: ${nativeAnthropic.body}`);
  const adaptedAnthropic = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: anthropicAuth,
    payload: {
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "adapt this" }],
    },
  });
  const adaptedBody = JSON.parse(adaptedAnthropic.body);
  assert(adaptedAnthropic.statusCode === 200 && adaptedBody.object === "chat.completion", `OpenAI-to-Anthropic adapter failed: ${adaptedAnthropic.body}`);
  assert(anthropicCalls.length === 2 && anthropicCalls.every((call) => call.url === "https://api.anthropic.com/v1/messages"), "Anthropic calls used the wrong upstream endpoint");
  assert(anthropicCalls.every((call) => call.headers["anthropic-version"] === "2023-06-01"), "Anthropic version header missing");
  assert(anthropicCalls[1].body.system === "Be concise" && anthropicCalls[1].body.messages.length === 1, "OpenAI messages were not adapted to Anthropic format");
  globalThis.fetch = originalFetch;

  console.log("[P3-11] Authenticated WebSocket meter feed...");
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string", "Test server did not expose a TCP address");
  const websocketMessages: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/deals/3001/ws`);
    const timer = setTimeout(() => reject(new Error("WebSocket meter feed timed out")), 5_000);
    socket.on("open", () => socket.send(JSON.stringify({ proxyKey })));
    socket.on("message", (raw) => {
      websocketMessages.push(JSON.parse(raw.toString()));
      if (websocketMessages.some((message) => message.type === "meter.update" && message.reason === "usage")) {
        clearTimeout(timer);
        socket.close();
        resolve();
      } else if (websocketMessages.some((message) => message.type === "authenticated")) {
        meterEvents.publish(entry, "usage");
      }
    });
    socket.on("error", reject);
  });
  assert(websocketMessages.some((message) => message.type === "authenticated"), "WebSocket authentication acknowledgement missing");
  assert(websocketMessages.some((message) => message.type === "meter.update"), "WebSocket meter update missing");
  await app.close();

  console.log("=======================================================");
  console.log("  ALL PHASE 3 ACCEPTANCE TESTS PASSED (11/11)          ");
  console.log("=======================================================");
}

runPhase3Tests().catch((error) => {
  console.error("Phase 3 acceptance test failed:", error);
  process.exit(1);
});
