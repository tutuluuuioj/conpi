import { FastifyRequest, FastifyReply } from "fastify";
import { keyVault, VaultEntry } from "../vault/preflight.js";
import { calculateCost, meterEngine, PRICING_TABLE } from "./meter.js";
import { DefaultReason } from "../crypto/borsh.js";

function getProxyKey(req: FastifyRequest): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return xApiKey.trim();
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.replace("Bearer ", "").trim();
  }
  return null;
}

export async function handleChatCompletions(req: FastifyRequest, reply: FastifyReply) {
  const proxyKey = getProxyKey(req);
  if (!proxyKey) {
    return reply.status(401).send({ error: { message: "Missing or invalid Authorization header", code: "unauthorized" } });
  }

  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry || !entry.active) {
    return reply.status(403).send({ error: { message: "Invalid or inactive proxy key", code: "key_inactive" } });
  }

  const body = req.body as any;
  const requestedModel = body.model;

  if (entry.models.length > 0) {
    const allowed = entry.models.map((m) => m.trim().toLowerCase());
    if (!allowed.includes((requestedModel || "").trim().toLowerCase())) {
      return reply.status(400).send({
        error: { message: `Model '${requestedModel}' not in allowed models: ${entry.models.join(", ")} (exact match required)`, code: "model_disallowed" },
      });
    }
  }

  // Verify requested model is supported in enclave pricing table
  if (!PRICING_TABLE[requestedModel]) {
    return reply.status(400).send({
      error: { message: `Model '${requestedModel}' is not supported in the enclave pricing table`, code: "unsupported_model" },
    });
  }

  // Hard credit cap check: reject before executing
  if (entry.usedUsd >= entry.creditUsd) {
    return reply.status(402).send({
      error: { message: `Deal credit cap ($${entry.creditUsd}) reached`, code: "quota_exhausted" },
    });
  }

  // Pre-flight check: ensure remaining credit can cover prompt tokens AND requested max_tokens
  const estPromptTokens = Array.isArray(body.messages)
    ? body.messages.reduce((acc: number, m: any) => acc + (typeof m.content === "string" ? Math.max(1, Math.ceil(m.content.length / 4)) : 4), 0)
    : 15;
  const requestedMaxTokens = typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : 1000;
  const maxPossibleCost = calculateCost(requestedModel, estPromptTokens, requestedMaxTokens).costUsd;

  if (entry.usedUsd + maxPossibleCost > entry.creditUsd) {
    return reply.status(402).send({
      error: {
        message: `Deal remaining credit ($${(entry.creditUsd - entry.usedUsd).toFixed(6)}) insufficient for requested max_tokens (${requestedMaxTokens} tokens = $${maxPossibleCost.toFixed(6)})`,
        code: "quota_exhausted",
      },
    });
  }

  // If using mock/test key, delegate to test-mock module in test mode
  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") {
      return reply.status(403).send({
        error: { message: "Mock API keys are disabled outside test mode (NODE_ENV !== 'test')", code: "mock_forbidden" },
      });
    }
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockChatCompletion } = await (import(mockModulePath) as Promise<any>);
    return handleMockChatCompletion(req, reply, entry, requestedModel);
  }

  // Real upstream forward
  let upstreamUrl = "https://api.openai.com/v1/chat/completions";
  const provLower = entry.provider.toLowerCase();
  const isRedPill = entry.apiKey.startsWith("sk-rp-") || provLower === "redpill" || provLower === "phala";

  if (isRedPill) {
    upstreamUrl = "https://api.redpill.ai/v1/chat/completions";
  } else if (provLower === "openrouter") {
    upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
  }

  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${entry.apiKey}`,
  };

  const isStream = Boolean(body.stream);
  const streamBody = isStream ? { ...body, stream_options: { include_usage: true } } : body;

  try {
    if (isStream) {
      const upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(streamBody),
      });

      if (upstreamRes.status === 401) {
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
          entry.active = false;
          const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InsufficientQuota);
          entry.signedPayloads.push(defaultSig);
          return reply.status(502).send({
            error: { message: "Seller account quota exhausted. Settlement default initiated.", code: "insufficient_quota" },
            defaultPayload: defaultSig,
          });
        }
        return reply.status(429).send({ error: { message: "Upstream rate limit exceeded", code: "rate_limit_exceeded" } });
      }

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text();
        return reply.status(upstreamRes.status).send({ error: { message: errText, code: "upstream_error" } });
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");

      let promptTokens = 0;
      let completionTokens = 0;

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = decoder.decode(value, { stream: true });
          reply.raw.write(chunkStr);
          buffer += chunkStr;

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const parsed = JSON.parse(line.slice(6));
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
                  completionTokens = parsed.usage.completion_tokens ?? completionTokens;
                } else if (parsed.choices && parsed.choices[0]?.delta?.content) {
                  completionTokens += 1;
                }
              } catch {}
            }
          }
        }
      }

      const usage = calculateCost(requestedModel, promptTokens, completionTokens);
      entry.usedUsd += usage.costUsd;
      entry.tokensTotal += (promptTokens + completionTokens);

      const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
      for (const stg of newStages) {
        entry.signedPayloads.push(stg);
      }

      return reply.raw.end();
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (upstreamRes.status === 401) {
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

      const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
      for (const stg of newStages) {
        entry.signedPayloads.push(stg);
      }
    }
    return reply.status(upstreamRes.status).send(data);
  } catch (err: any) {
    return reply.status(500).send({ error: { message: err.message, code: "proxy_error" } });
  }
}

/**
 * Native Anthropic Messages Adapter: POST /v1/messages
 */
export async function handleAnthropicMessages(req: FastifyRequest, reply: FastifyReply) {
  const proxyKey = getProxyKey(req);
  if (!proxyKey) {
    return reply.status(401).send({ error: { type: "authentication_error", message: "Missing x-api-key or Authorization header" } });
  }

  const entry = keyVault.getByProxyKey(proxyKey);
  if (!entry || !entry.active) {
    return reply.status(403).send({ error: { type: "permission_error", message: "Invalid or inactive proxy key" } });
  }

  const body = req.body as any;
  const requestedModel = body.model;

  if (entry.models.length > 0) {
    const allowed = entry.models.map((m) => m.trim().toLowerCase());
    if (!allowed.includes((requestedModel || "").trim().toLowerCase())) {
      return reply.status(400).send({
        error: { type: "invalid_request_error", message: `Model '${requestedModel}' not in allowed models: ${entry.models.join(", ")} (exact match required)` },
      });
    }
  }

  if (!PRICING_TABLE[requestedModel]) {
    return reply.status(400).send({
      error: { type: "invalid_request_error", message: `Model '${requestedModel}' is not supported in the enclave pricing table` },
    });
  }

  // Hard credit cap check
  if (entry.usedUsd >= entry.creditUsd) {
    return reply.status(402).send({
      error: { type: "quota_error", message: `Deal credit cap ($${entry.creditUsd}) reached` },
    });
  }

  const estPromptTokens = Array.isArray(body.messages)
    ? body.messages.reduce((acc: number, m: any) => acc + (typeof m.content === "string" ? Math.max(1, Math.ceil(m.content.length / 4)) : 4), 0)
    : 15;
  const requestedMaxTokens = typeof body.max_tokens === "number" && body.max_tokens > 0
    ? body.max_tokens
    : (typeof body.max_tokens_to_sample === "number" && body.max_tokens_to_sample > 0 ? body.max_tokens_to_sample : 1000);
  const maxPossibleCost = calculateCost(requestedModel, estPromptTokens, requestedMaxTokens).costUsd;

  if (entry.usedUsd + maxPossibleCost > entry.creditUsd) {
    return reply.status(402).send({
      error: {
        type: "quota_error",
        message: `Deal remaining credit ($${(entry.creditUsd - entry.usedUsd).toFixed(6)}) insufficient for requested max_tokens (${requestedMaxTokens} tokens = $${maxPossibleCost.toFixed(6)})`,
      },
    });
  }

  // If mock/test key, delegate to test-mock module in test mode
  if (entry.apiKey.startsWith("mock_") || entry.apiKey.startsWith("test_") || entry.apiKey.startsWith("sk-test")) {
    if (process.env.NODE_ENV !== "test") {
      return reply.status(403).send({
        error: { type: "permission_error", message: "Mock API keys are disabled outside test mode" },
      });
    }
    const mockModulePath = "../../test/test-mock.js";
    const { handleMockAnthropicMessage } = await (import(mockModulePath) as Promise<any>);
    return handleMockAnthropicMessage(req, reply, entry, requestedModel);
  }

  const provLower = entry.provider.toLowerCase();
  const isDirectAnthropic = provLower === "anthropic";

  if (isDirectAnthropic) {
    // Upstream is native Anthropic
    const upstreamRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": entry.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      entry.active = false;
      const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InvalidKey);
      entry.signedPayloads.push(defaultSig);
      return reply.status(502).send({
        error: { type: "seller_key_revoked", message: "Seller API key was revoked or invalid." },
        defaultPayload: defaultSig,
      });
    }

    const data: any = await upstreamRes.json();
    if (data.usage) {
      const usage = calculateCost(requestedModel, data.usage.input_tokens || 0, data.usage.output_tokens || 0);
      entry.usedUsd += usage.costUsd;
      entry.tokensTotal += ((data.usage.input_tokens || 0) + (data.usage.output_tokens || 0));

      const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
      for (const stg of newStages) {
        entry.signedPayloads.push(stg);
      }
    }
    return reply.status(upstreamRes.status).send(data);
  }

  // Upstream is OpenAI or RedPill: translate Anthropic format to OpenAI format
  const openAiMessages: Array<{ role: string; content: string }> = [];
  if (body.system) {
    openAiMessages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  }
  for (const m of body.messages || []) {
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((c: any) => c.text || JSON.stringify(c)).join("\n");
    }
    openAiMessages.push({ role: m.role, content });
  }

  let upstreamUrl = "https://api.openai.com/v1/chat/completions";
  if (entry.apiKey.startsWith("sk-rp-") || provLower === "redpill" || provLower === "phala") {
    upstreamUrl = "https://api.redpill.ai/v1/chat/completions";
  } else if (provLower === "openrouter") {
    upstreamUrl = "https://openrouter.ai/api/v1/chat/completions";
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: openAiMessages,
        max_tokens: body.max_tokens || 1024,
        temperature: body.temperature,
      }),
    });

    if (upstreamRes.status === 401) {
      entry.active = false;
      const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InvalidKey);
      entry.signedPayloads.push(defaultSig);
      return reply.status(502).send({
        error: { type: "seller_key_revoked", message: "Seller API key was revoked or invalid." },
        defaultPayload: defaultSig,
      });
    }

    if (upstreamRes.status === 429) {
      const text = await upstreamRes.text();
      if (text.includes("insufficient_quota")) {
        entry.active = false;
        const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, DefaultReason.InsufficientQuota);
        entry.signedPayloads.push(defaultSig);
        return reply.status(502).send({
          error: { type: "insufficient_quota", message: "Seller account quota exhausted." },
          defaultPayload: defaultSig,
        });
      }
      return reply.status(429).send({ error: { type: "rate_limit_error", message: "Upstream rate limit exceeded." } });
    }

    const data: any = await upstreamRes.json();
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;

    const usage = calculateCost(requestedModel, promptTokens, completionTokens);
    entry.usedUsd += usage.costUsd;
    entry.tokensTotal += (promptTokens + completionTokens);

    const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
    for (const stg of newStages) {
      entry.signedPayloads.push(stg);
    }

    // Return native Anthropic message format
    return reply.status(200).send({
      id: `msg_${data.id || Date.now()}`,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [{ type: "text", text: data.choices?.[0]?.message?.content || "" }],
      stop_reason: data.choices?.[0]?.finish_reason === "stop" ? "end_turn" : "max_tokens",
      stop_sequence: null,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      },
    });
  } catch (err: any) {
    return reply.status(500).send({ error: { type: "api_error", message: err.message } });
  }
}

export async function handleModels(req: FastifyRequest, reply: FastifyReply) {
  const proxyKey = getProxyKey(req);
  if (!proxyKey) {
    return reply.status(401).send({ error: { message: "Missing Authorization or x-api-key header" } });
  }

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
