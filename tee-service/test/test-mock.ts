import { FastifyRequest, FastifyReply } from "fastify";
import { calculateCost, meterEngine } from "../src/proxy/meter.js";
import { VaultEntry } from "../src/vault/preflight.js";
import { meterEvents } from "../src/proxy/events.js";
import { settlementEngine } from "../src/settlement/engine.js";

export function handleMockChatCompletion(
  req: FastifyRequest,
  reply: FastifyReply,
  entry: VaultEntry,
  requestedModel: string
) {
  const body = req.body as any;
  const isStream = Boolean(body.stream);
  const inputTokens = Array.isArray(body.messages)
    ? body.messages.reduce((acc: number, m: any) => acc + (typeof m.content === "string" ? Math.max(1, m.content.trim().split(/\s+/).filter(Boolean).length) : 4), 0)
    : 15;
  const outputTokens = 12;
  const usage = calculateCost(requestedModel, inputTokens, outputTokens, 0, entry.lockedPricing);

  entry.usedUsd = Math.min(entry.creditUsd, entry.usedUsd + usage.costUsd);
  entry.tokensTotal += (inputTokens + outputTokens);

  const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
  for (const stg of newStages) {
    entry.signedPayloads.push(stg);
  }
  if (newStages.length) void settlementEngine.relayStages(entry, newStages);
  meterEvents.publish(entry, newStages.length ? "stage" : "usage", newStages.map((stage) => stage.payload.stage));

  const testContent = `[Mock Test Engine]: ${Array.isArray(body.messages) ? (body.messages[body.messages.length - 1]?.content || "ok") : "ok"}`;

  if (isStream) {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");

    const deltaChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta: { role: "assistant", content: testContent }, finish_reason: null }],
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
      message: { role: "assistant", content: testContent },
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

export function handleMockAnthropicMessage(
  req: FastifyRequest,
  reply: FastifyReply,
  entry: VaultEntry,
  requestedModel: string
) {
  const body = req.body as any;
  const inputTokens = Array.isArray(body.messages)
    ? body.messages.reduce((acc: number, m: any) => acc + (typeof m.content === "string" ? Math.max(1, m.content.trim().split(/\s+/).filter(Boolean).length) : 4), 0)
    : 15;
  const outputTokens = 12;
  const usage = calculateCost(requestedModel, inputTokens, outputTokens, 0, entry.lockedPricing);
  entry.usedUsd = Math.min(entry.creditUsd, entry.usedUsd + usage.costUsd);
  entry.tokensTotal += (inputTokens + outputTokens);

  const newStages = meterEngine.checkAndEmitStages(entry, entry.termsHashHex);
  for (const stg of newStages) {
    entry.signedPayloads.push(stg);
  }
  if (newStages.length) void settlementEngine.relayStages(entry, newStages);
  meterEvents.publish(entry, newStages.length ? "stage" : "usage", newStages.map((stage) => stage.payload.stage));

  const testContent = `[Mock Test Engine]: ${Array.isArray(body.messages) ? (body.messages[body.messages.length - 1]?.content || "ok") : "ok"}`;
  return reply.send({
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: [{ type: "text", text: testContent }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  });
}
