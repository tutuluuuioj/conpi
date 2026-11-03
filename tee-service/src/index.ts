import Fastify from "fastify";
import cors from "@fastify/cors";
import { CONFIG } from "./config.js";
import { enclaveKeys } from "./crypto/keys.js";
import { attestationService } from "./attestation/tdx.js";
import { negotiationService } from "./negotiation/matcher.js";
import { keyVault } from "./vault/preflight.js";
import { handleChatCompletions, handleModels, handleAnthropicMessages } from "./proxy/server.js";
import { meterEngine } from "./proxy/meter.js";
import { DefaultReason } from "./crypto/borsh.js";
import { nearRelayer } from "./chain/relayer.js";

const app = Fastify({ logger: true });

async function bootstrap() {
  await enclaveKeys.init();
  await attestationService.init();

  await app.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // Health check
  app.get("/health", async () => {
    return {
      status: "healthy",
      service: "conpi-tee-service",
      contractId: CONFIG.contractId,
      timestamp: new Date().toISOString(),
    };
  });

  // 1. Attestation & In-Enclave Public Keys
  app.get("/v1/attestation", async (req) => {
    const nonce = (req.query as any)?.nonce || (req.headers["x-nonce"] as string) || undefined;
    return attestationService.getAttestation(nonce);
  });

  app.get("/v1/quote", async (req, reply) => {
    const nonce = (req.query as any)?.nonce || (req.headers["x-nonce"] as string) || undefined;
    const rawQuote = await attestationService.getRawQuote(nonce);
    if (!rawQuote) {
      return reply.status(404).send({ error: "No hardware quote available in this environment" });
    }
    reply.header("Content-Type", "application/octet-stream");
    return reply.send(rawQuote);
  });

  // 2. Private Negotiation Ticket & Terms Matching
  app.post("/v1/tickets/:id/init", async (req) => {
    const { id } = req.params as { id: string };
    const { dealId, buyer, seller } = req.body as { dealId: number; buyer: string; seller: string };
    return negotiationService.getOrCreateTicket(id, dealId, buyer, seller);
  });

  app.get("/v1/tickets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ticket = negotiationService.getTicket(id);
    if (!ticket) return reply.status(404).send({ error: "Ticket not found" });
    return ticket;
  });

  app.post("/v1/tickets/:id/terms", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { party, terms } = req.body as { party: "buyer" | "seller"; terms: any };
    try {
      return negotiationService.submitTerms(id, party, terms);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 3. Key Injection & Pre-flight Validation
  app.post("/v1/deals/:id/key", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const { provider, model, models, creditUsd, priceUsd, termsHashHex, encryptedEnvelope, plainApiKey, creditAmountYocto } = req.body as any;

    try {
      const result = await keyVault.validateAndInjectKey(
        dealId,
        provider,
        model,
        models || [model],
        creditUsd,
        priceUsd,
        termsHashHex,
        encryptedEnvelope,
        plainApiKey,
        creditAmountYocto
      );
      if (!result.ok) {
        return reply.status(400).send(result);
      }
      return result;
    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: err.message });
    }
  });

  // 4. OpenAI / Anthropic Reverse Proxy
  app.post("/v1/chat/completions", handleChatCompletions);
  app.post("/v1/messages", handleAnthropicMessages);
  app.get("/v1/models", handleModels);

  // 5. Live Meter Snapshot & SSE Stream
  app.get("/v1/deals/:id/meter", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const entry = keyVault.getByDealId(dealId);
    if (!entry) {
      return {
        dealId,
        usedUsd: 0,
        tokensTotal: 0,
        active: false,
        creditUsd: 0,
        priceUsd: 0,
        timestamp: new Date().toISOString(),
      };
    }
    return {
      dealId,
      usedUsd: entry.usedUsd,
      tokensTotal: entry.tokensTotal,
      active: entry.active,
      creditUsd: entry.creditUsd,
      priceUsd: entry.priceUsd,
      registeredAt: entry.registeredAt,
      timestamp: new Date().toISOString(),
    };
  });

  // 6. Signed Payloads & Attestation Retrieval
  app.get("/v1/deals/:id/payloads", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const entry = keyVault.getByDealId(dealId);
    if (!entry) {
      return reply.status(404).send({ error: "Deal not found in key vault" });
    }
    return {
      dealId,
      termsHashHex: entry.termsHashHex,
      count: entry.signedPayloads.length,
      signedPayloads: entry.signedPayloads.map((item) => ({
        payload: {
          domain: item.payload.domain,
          contractId: item.payload.contractId,
          chainId: item.payload.chainId,
          dealId: Number(item.payload.dealId),
          termsHashHex: Buffer.from(item.payload.termsHash).toString("hex"),
          kind: item.payload.kind,
          stage: item.payload.stage,
          meteredValueYocto: item.payload.meteredValueYocto.toString(),
          reason: item.payload.reason !== null && item.payload.reason !== undefined ? item.payload.reason : null,
          nonce: item.payload.nonce.toString(),
          issuedAtNs: item.payload.issuedAtNs.toString(),
        },
        signatureHex: item.signatureHex,
      })),
    };
  });

  app.post("/v1/deals/:id/default", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const { reason } = (req.body as any) || {};
    const entry = keyVault.getByDealId(dealId);
    if (!entry) {
      return reply.status(404).send({ error: "Deal not found in key vault" });
    }
    entry.active = false;
    let defReason = DefaultReason.InvalidKey;
    if (reason === "BuyerBreach") defReason = DefaultReason.BuyerBreach;
    if (reason === "InsufficientQuota") defReason = DefaultReason.InsufficientQuota;
    if (reason === "ProviderBan") defReason = DefaultReason.ProviderBan;
    const defaultSig = meterEngine.emitDefault(entry, entry.termsHashHex, defReason);
    entry.signedPayloads.push(defaultSig);
    return {
      ok: true,
      dealId,
      defaultPayload: {
        payload: {
          domain: defaultSig.payload.domain,
          contractId: defaultSig.payload.contractId,
          chainId: defaultSig.payload.chainId,
          dealId: Number(defaultSig.payload.dealId),
          termsHashHex: Buffer.from(defaultSig.payload.termsHash).toString("hex"),
          kind: defaultSig.payload.kind,
          stage: defaultSig.payload.stage,
          meteredValueYocto: defaultSig.payload.meteredValueYocto.toString(),
          reason: defaultSig.payload.reason !== null && defaultSig.payload.reason !== undefined ? defaultSig.payload.reason : null,
          nonce: defaultSig.payload.nonce.toString(),
          issuedAtNs: defaultSig.payload.issuedAtNs.toString(),
        },
        signatureHex: defaultSig.signatureHex,
      },
    };
  });

  app.get("/v1/deals/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const sendUpdate = () => {
      const entry = keyVault.getByDealId(dealId);
      const payload = {
        dealId,
        usedUsd: entry ? entry.usedUsd : 0,
        tokensTotal: entry ? entry.tokensTotal : 0,
        active: entry ? entry.active : false,
        timestamp: new Date().toISOString(),
      };
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendUpdate();
    const interval = setInterval(sendUpdate, 2000);

    req.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  // 6. Chain View Helper
  app.get("/v1/chain/deal/:id", async (req) => {
    const { id } = req.params as { id: string };
    return nearRelayer.getDeal(parseInt(id, 10));
  });

  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  console.log(`=======================================================`);
  console.log(`  CONPI PHALA TDX TEE PROXY SERVICE RUNNING ON ${CONFIG.host}:${CONFIG.port}`);
  console.log(`  Signer Key: ${CONFIG.contractId}`);
  console.log(`=======================================================`);
}

bootstrap().catch((err) => {
  console.error("Failed to start TEE service:", err);
  process.exit(1);
});
