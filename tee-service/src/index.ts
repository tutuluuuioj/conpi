import Fastify from "fastify";
import cors from "@fastify/cors";
import { CONFIG } from "./config.js";
import { attestationService } from "./attestation/tdx.js";
import { negotiationService } from "./negotiation/matcher.js";
import { keyVault } from "./vault/preflight.js";
import { handleChatCompletions, handleModels } from "./proxy/server.js";
import { nearRelayer } from "./chain/relayer.js";

const app = Fastify({ logger: true });

async function bootstrap() {
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
  app.get("/v1/attestation", async () => {
    return attestationService.getAttestation();
  });

  app.get("/v1/quote", async (req, reply) => {
    const rawQuote = await attestationService.getRawQuote();
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
    const { provider, model, models, creditUsd, priceUsd, termsHashHex, encryptedEnvelope, plainApiKey } = req.body as any;

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
        plainApiKey
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
