process.env.NODE_ENV = "test";

import WebSocket from "ws";
import { buildApp } from "../src/index.js";
import { nearRelayer } from "../src/chain/relayer.js";
import { keyVault } from "../src/vault/preflight.js";
import { meterEvents } from "../src/proxy/events.js";
import { calculateCost } from "../src/proxy/pricing.js";
import { proxyRateLimiter } from "../src/proxy/rate-limit.js";
import { classifyProviderError } from "../src/proxy/server.js";
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

  console.log("[P3-9] Quota exhaustion becomes seller self-drain default...");
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { code: "insufficient_quota" } }),
    { status: 429, headers: { "content-type": "application/json" } }
  )) as typeof fetch;
  const quotaFailure = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: auth,
    payload: { model: "gpt-4o", max_tokens: 4, messages: [{ role: "user", content: "quota" }] },
  });
  assert(
    quotaFailure.statusCode === 502 && quotaFailure.body.includes("seller_self_drain"),
    `Quota failure did not create seller self-drain default: ${quotaFailure.statusCode} ${quotaFailure.body}`
  );
  const lastPayload = entry.signedPayloads[entry.signedPayloads.length - 1];
  assert(lastPayload.payload.reason === 5, "Default payload reason must be SellerSelfDrain");
  globalThis.fetch = originalFetch;
  entry.apiKey = savedKey;
  entry.active = true;

  console.log("[P3-10] Authenticated WebSocket meter feed...");
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
  console.log("  ALL PHASE 3 ACCEPTANCE TESTS PASSED (10/10)          ");
  console.log("=======================================================");
}

runPhase3Tests().catch((error) => {
  console.error("Phase 3 acceptance test failed:", error);
  process.exit(1);
});
