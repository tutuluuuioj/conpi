import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import crypto from "crypto";
import { CONFIG } from "./config.js";

// Internal token is generated strictly in-enclave in memory; no environment variable can override it
export const INTERNAL_SERVER_TOKEN = crypto.randomUUID();
import { enclaveKeys } from "./crypto/keys.js";
import { attestationService } from "./attestation/tdx.js";
import { negotiationService } from "./negotiation/matcher.js";
import { keyVault } from "./vault/preflight.js";
import {
  authenticateDealRequest,
  emitDefaultOnce,
  handleAnthropicMessages,
  handleChatCompletions,
  handleEmbeddings,
  handleModels,
  publicSignedPayload,
  reconcilePendingUsage,
} from "./proxy/server.js";
import { meterEvents } from "./proxy/events.js";
import { DefaultReason } from "./crypto/borsh.js";
import { nearRelayer } from "./chain/relayer.js";
import { settlementEngine } from "./settlement/engine.js";

export const app = Fastify({ logger: false });

let initialized = false;
export async function buildApp() {
  if (initialized) return app;
  initialized = true;

  await enclaveKeys.init();
  await attestationService.init();

  await app.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(websocket);

  // Health check
  app.get("/health", async () => {
    return {
      status: "healthy",
      service: "conpi-tee-service",
      contractId: CONFIG.contractId,
      settlement: settlementEngine.status(),
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
  app.post("/v1/tickets/:id/init", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dealId, buyer, seller, onChainTermsHashHex } = req.body as { dealId: number; buyer: string; seller: string; onChainTermsHashHex?: string };
    try {
      negotiationService.getOrCreateTicket(id, dealId, buyer, seller, onChainTermsHashHex);
      return negotiationService.getTicketView(id);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.get("/v1/tickets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ticket = negotiationService.getTicketView(id);
    if (!ticket) return reply.status(404).send({ error: "Ticket not found" });
    return ticket;
  });

  app.post("/v1/tickets/:id/terms", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { party, terms, encryptedEnvelope } = req.body as {
      party: "buyer" | "seller";
      terms?: any;
      encryptedEnvelope?: any;
    };
    try {
      if (encryptedEnvelope) {
        return negotiationService.submitEncryptedTerms(id, party, encryptedEnvelope);
      }
      if (process.env.NODE_ENV !== "test") {
        return reply.status(400).send({
          error: "Plaintext term sheets are disabled; encryptedEnvelope is required",
        });
      }
      negotiationService.submitTerms(id, party, terms);
      return negotiationService.getTicketView(id);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.post("/v1/tickets/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sender, encryptedEnvelope } = req.body as {
      sender: string;
      encryptedEnvelope?: any;
    };
    try {
      if (!encryptedEnvelope) {
        return reply.status(400).send({
          error: "Plaintext chat is disabled; encryptedEnvelope is required",
        });
      }
      return negotiationService.addEncryptedMessage(id, sender, encryptedEnvelope);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 3. Key Injection & Pre-flight Validation
  app.post("/v1/deals/:id/key", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const { provider, model, models, termsHashHex, encryptedEnvelope, plainApiKey } = req.body as any;

    try {
      const result = await keyVault.validateAndInjectKey(
        dealId,
        provider,
        model,
        models || [model],
        undefined,
        undefined,
        termsHashHex,
        encryptedEnvelope,
        plainApiKey,
        undefined
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
  app.post("/v1/embeddings", handleEmbeddings);
  app.get("/v1/models", handleModels);

  // Authenticated, real-time meter feed. Browser WebSocket clients authenticate
  // in the first message so the cpk_live credential never appears in a URL.
  app.get("/v1/deals/:id/ws", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    let unsubscribe: (() => void) | null = null;
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(1008, "Authentication timeout");
    }, CONFIG.websocketAuthTimeoutMs);

    socket.on("message", (raw: any) => {
      if (authenticated) return;
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch {
        socket.close(1008, "Invalid authentication message");
        return;
      }
      const proxyKey = typeof message?.proxyKey === "string" ? message.proxyKey : "";
      const entry = keyVault.getByProxyKey(proxyKey);
      if (!entry || entry.dealId !== dealId) {
        socket.close(1008, "Invalid proxy key for deal");
        return;
      }
      authenticated = true;
      clearTimeout(authTimer);
      socket.send(JSON.stringify({ type: "authenticated", dealId }));
      socket.send(JSON.stringify(meterEvents.snapshot(entry)));
      unsubscribe = meterEvents.subscribe(dealId, (event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      unsubscribe?.();
    });
  });

  // 5. Live Meter Snapshot & SSE Stream
  app.get("/v1/deals/:id/meter", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const entry = authenticateDealRequest(req, reply, dealId);
    if (!entry) return;
    return {
      dealId,
      usedUsd: entry.usedUsd,
      tokensTotal: entry.tokensTotal,
      active: entry.active,
      provider: entry.provider,
      model: entry.model,
      models: entry.models,
      lockedPricing: entry.lockedPricing,
      pricingSnapshotHash: entry.pricingSnapshotHash,
      creditUsd: entry.creditUsd,
      priceUsd: entry.priceUsd,
      usageReceiptCount: entry.usageReceipts.length,
      lastUsageReceipt: entry.usageReceipts.at(-1) || null,
      processedGenerationCount: entry.processedGenerationIds.length,
      billingBlocked: Boolean(entry.pendingUsage),
      pendingUsage: entry.pendingUsage ? {
        generationId: entry.pendingUsage.generationId,
        createdAt: entry.pendingUsage.createdAt,
        attempts: entry.pendingUsage.attempts,
        lastError: entry.pendingUsage.lastError || null,
      } : null,
      registeredAt: entry.registeredAt,
      lastCheckpointAt: new Date(entry.lastCheckpointAt).toISOString(),
      relayReceipts: entry.relayReceipts,
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/v1/deals/:id/usage-receipts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const entry = authenticateDealRequest(req, reply, dealId);
    if (!entry) return;
    return {
      dealId,
      signerPublicKeyNear: enclaveKeys.getSignerPublicKeyNear(),
      pricingSnapshotHash: entry.pricingSnapshotHash,
      receipts: entry.usageReceipts,
      processedGenerationCount: entry.processedGenerationIds.length,
      billingBlocked: Boolean(entry.pendingUsage),
      pendingUsage: entry.pendingUsage ? {
        generationId: entry.pendingUsage.generationId,
        createdAt: entry.pendingUsage.createdAt,
        attempts: entry.pendingUsage.attempts,
        lastError: entry.pendingUsage.lastError || null,
      } : null,
    };
  });

  // Retry only the unresolved provider charge. This never sends a new model
  // request, so operators can safely recover billing after OpenRouter's
  // generation endpoint becomes available again.
  app.post("/v1/deals/:id/reconcile", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const entry = authenticateDealRequest(req, reply, dealId);
    if (!entry) return;
    if (entry.requestInFlight) {
      return reply.status(409).send({ error: { message: "Another request is already being metered", code: "billing_request_in_flight" } });
    }
    entry.requestInFlight = true;
    try {
      const usage = await reconcilePendingUsage(entry);
      return {
        dealId,
        reconciled: Boolean(usage),
        billingBlocked: Boolean(entry.pendingUsage),
        usedUsd: entry.usedUsd,
        usageReceiptCount: entry.usageReceipts.length,
      };
    } catch (error: any) {
      return reply.status(409).send({
        error: {
          message: error.message,
          code: "cost_reconciliation_pending",
          generationId: entry.pendingUsage?.generationId || null,
        },
      });
    } finally {
      entry.requestInFlight = false;
    }
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
      relayerConfigured: nearRelayer.isConfigured(),
      relayReceipts: entry.relayReceipts,
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
    const internalHeader = req.headers["x-enclave-internal-token"];
    if (!internalHeader || internalHeader !== INTERNAL_SERVER_TOKEN) {
      return reply.status(403).send({
        error: "Forbidden: Manual external default triggers are locked. Only enclave server logic can trigger defaults.",
        code: "external_default_forbidden",
      });
    }

    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const { reason } = (req.body as any) || {};
    const entry = keyVault.getByDealId(dealId);
    if (!entry) {
      return reply.status(404).send({ error: "Deal not found in key vault" });
    }
    let defReason = DefaultReason.InvalidKey;
    if (reason === "BuyerBreach") defReason = DefaultReason.BuyerBreach;
    if (reason === "InsufficientQuota") defReason = DefaultReason.InsufficientQuota;
    if (reason === "ProviderBan") defReason = DefaultReason.ProviderBan;
    if (reason === "SellerSelfDrain") defReason = DefaultReason.SellerSelfDrain;
    const defaultSig = emitDefaultOnce(entry, defReason);
    return {
      ok: true,
      dealId,
      defaultPayload: publicSignedPayload(defaultSig),
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

  settlementEngine.start(() => keyVault.listActive());
  app.addHook("onClose", async () => settlementEngine.stop());

  return app;
}

export async function startServer() {
  await buildApp();
  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  console.log(`=======================================================`);
  console.log(`  CONPI PHALA TDX TEE PROXY SERVICE RUNNING ON ${CONFIG.host}:${CONFIG.port}`);
  console.log(`  Signer Key: ${CONFIG.contractId}`);
  console.log(`=======================================================`);
}

const isTest = process.env.NODE_ENV === "test" || process.argv.some((a) => a.includes("test"));
if (!isTest) {
  startServer().catch((err) => {
    console.error("Failed to start TEE service:", err);
    process.exit(1);
  });
}
