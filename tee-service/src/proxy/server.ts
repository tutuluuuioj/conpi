import { FastifyRequest, FastifyReply } from "fastify";
import { keyVault } from "../vault/preflight.js";
import { calculateCost, meterEngine } from "./meter.js";
import { DefaultReason } from "../crypto/borsh.js";

export async function handleChatCompletions(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: { message: "Missing or invalid Authorization header", code: "unauthorized" } });
  }

  const proxyKey = authHeader.replace("Bearer ", "").trim();
  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry || !entry.active) {
    return reply.status(403).send({ error: { message: "Invalid or inactive proxy key", code: "key_inactive" } });
  }

  const body = req.body as any;
  const requestedModel = body.model;

  if (entry.models.length > 0 && !entry.models.includes(requestedModel)) {
    return reply.status(400).send({
      error: { message: `Model '${requestedModel}' not in allowed models: ${entry.models.join(", ")}`, code: "model_disallowed" },
    });
  }

  if (entry.usedUsd >= entry.creditUsd) {
    return reply.status(402).send({
      error: { message: `Deal credit cap ($${entry.creditUsd}) reached`, code: "quota_exhausted" },
    });
  }

  // If using mock/test key, serve high-fidelity simulated response with usage
  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    const isStream = Boolean(body.stream);
    const inputTokens = Math.max(12, JSON.stringify(body.messages || []).length / 4);
    const outputTokens = 42;
    const usage = calculateCost(requestedModel, inputTokens, outputTokens);

    entry.usedUsd += usage.costUsd;
    entry.tokensTotal += (inputTokens + outputTokens);

    const stagePayload = meterEngine.checkAndEmitStage(entry, entry.termsHashHex);
    if (stagePayload) {
      entry.signedPayloads.push(stagePayload);
    }

    if (isStream) {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      const deltaChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello from Conpi Phala TEE secure proxy!" }, finish_reason: null }],
      };
      reply.raw.write(`data: ${JSON.stringify(deltaChunk)}\n\n`);

      const finalChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
      };
      reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      return reply.raw.end();
    }

    return reply.send({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello from Conpi Phala TEE secure proxy!" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        conpi_cost_usd: usage.costUsd,
      },
    });
  }

  // Real upstream forward
  let upstreamUrl = "https://api.openai.com/v1/chat/completions";
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${entry.apiKey}`,
  };

  if (entry.provider === "OpenRouter") {
    upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (upstreamRes.status === 401) {
      // Key was revoked mid-deal by seller!
      console.warn(`[Proxy] Detected seller revoked key on deal ${entry.dealId}`);
      entry.active = false;
      const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InvalidKey);
      entry.signedPayloads.push(defaultSig);
      return reply.status(502).send({
        error: { message: "Seller API key was revoked or invalid. Settlement default initiated.", code: "seller_key_revoked" },
        defaultPayload: defaultSig,
      });
    }

    if (upstreamRes.status === 429) {
      const text = await upstreamRes.text();
      if (text.includes("insufficient_quota")) {
        console.warn(`[Proxy] Detected quota depleted on deal ${entry.dealId}`);
        entry.active = false;
        const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InsufficientQuota);
        entry.signedPayloads.push(defaultSig);
        return reply.status(502).send({
          error: { message: "Seller account quota exhausted. Settlement default initiated.", code: "insufficient_quota" },
          defaultPayload: defaultSig,
        });
      }
      return reply.status(429).send({ error: { message: "Upstream rate limit exceeded. Retry later.", code: "rate_limit_exceeded" } });
    }

    const data: any = await upstreamRes.json();
    if (data.usage) {
      const usage = calculateCost(
        requestedModel,
        data.usage.prompt_tokens || 0,
        data.usage.completion_tokens || 0
      );
      entry.usedUsd += usage.costUsd;
      entry.tokensTotal += (data.usage.total_tokens || 0);

      const stagePayload = meterEngine.checkAndEmitStage(entry, entry.termsHashHex);
      if (stagePayload) {
        entry.signedPayloads.push(stagePayload);
      }
    }
    return reply.status(upstreamRes.status).send(data);
  } catch (err: any) {
    return reply.status(500).send({ error: { message: err.message, code: "proxy_error" } });
  }
}

export async function handleModels(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: { message: "Missing Authorization header" } });
  }

  const proxyKey = authHeader.replace("Bearer ", "").trim();
  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry) {
    return reply.status(403).send({ error: { message: "Invalid proxy key" } });
  }

  return reply.send({
    object: "list",
    data: entry.models.map((m) => ({
      id: m,
      object: "model",
      created: 1700000000,
      owned_by: entry.provider.toLowerCase(),
    })),
  });
}
