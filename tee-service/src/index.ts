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
import { DefaultReason, PayloadKind, serializeSignedPayload, type SignedPayloadDto } from "./crypto/borsh.js";
import { nearRelayer } from "./chain/relayer.js";
import { settlementEngine } from "./settlement/engine.js";
import { foreignVaultManager } from "./chain/foreign-vault.js";
import { foreignRelayer } from "./chain/foreign-relayer.js";
import { baseClient, BASE_SEPOLIA_USDC, BASE_SEPOLIA_CHAIN_ID } from "./chain/base-client.js";
import { SolanaClient } from "./chain/solana-client.js";
import bs58 from "bs58";
import {
  verifySellerKeyAuthorization,
  consumeSellerKeyAuthorizationNonce,
  type SellerKeyAuthorization,
} from "./auth/seller-key.js";

export const app = Fastify({ logger: false });
const keyInjectionLocks = new Set<number>();

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
    const { provider, model, models, termsHashHex, encryptedEnvelope, plainApiKey, sellerAuthorization } = req.body as any;

    let injectionLocked = false;
    try {
      if (!Number.isSafeInteger(dealId) || dealId <= 0) {
        return reply.status(400).send({ ok: false, error: "Invalid deal id" });
      }
      const onChainDeal = await nearRelayer.getDeal(dealId);
      if (!onChainDeal?.seller) {
        return reply.status(404).send({ ok: false, error: `Deal #${dealId} was not found on-chain` });
      }
      await verifySellerKeyAuthorization({
        dealId,
        seller: String(onChainDeal.seller),
        provider,
        model,
        models: models || [model],
        termsHashHex,
        encryptedEnvelope,
        plainApiKey,
        authorization: sellerAuthorization as SellerKeyAuthorization,
      }, { consumeNonce: false });
      const requestedDealStatus = String(onChainDeal.status || "").toLowerCase();
      if (requestedDealStatus !== "funded" && requestedDealStatus !== "active") {
        return reply.status(409).send({
          ok: false,
          error: `Deal #${dealId} is ${onChainDeal.status || "not funded"}; provider keys can only be submitted for funded deals`,
        });
      }
      const dealTeeSigner = String(onChainDeal.tee_pubkey || "").trim();
      const currentTeeSigner = enclaveKeys.getSignerPublicKeyNear();
      if (dealTeeSigner && dealTeeSigner !== currentTeeSigner) {
        return reply.status(409).send({
          ok: false,
          code: "tee_signer_mismatch",
          error: `Deal #${dealId} is bound to retired TEE signer ${dealTeeSigner}; recreate the deal for current signer ${currentTeeSigner}`,
        });
      }
      if (keyInjectionLocks.has(dealId)) {
        return reply.status(409).send({ ok: false, error: `Key injection is already in progress for deal #${dealId}` });
      }
      keyInjectionLocks.add(dealId);
      injectionLocked = true;

      const existing = keyVault.getByDealId(dealId);
      const chainStatus = String(onChainDeal.status || "").toLowerCase();
      const localStatus = String(existing?.onChainStatus || "").toLowerCase();
      const authoritativeStatus = chainStatus === "active" || localStatus === "active" ? "active" : chainStatus || localStatus;
      if (existing && authoritativeStatus === "active") {
        return reply.status(409).send({
          ok: false,
          error: `Deal #${dealId} is already active; its provider key cannot be replaced`,
        });
      }
      consumeSellerKeyAuthorizationNonce(sellerAuthorization as SellerKeyAuthorization);
      if (existing) {
        const activation = existing.signedPayloads.find((item) => item.payload.kind === PayloadKind.Activate);
        if (!activation) {
          return reply.status(409).send({ ok: false, error: `Deal #${dealId} already has a provider key` });
        }
        const publicActivation = publicSignedPayload(activation);
        let activationTxHash: string | undefined;
        let activationRelayed = false;
        if (nearRelayer.isConfigured()) {
          try {
            const submitted = await nearRelayer.submitActivate(dealId, publicActivation.payload, publicActivation.signatureHex);
            activationTxHash = submitted.transactionHash;
            activationRelayed = true;
            existing.onChainStatus = "Active";
          } catch (error: any) {
            const refreshed = await nearRelayer.getDeal(dealId).catch(() => null);
            if (String(refreshed?.status || "").toLowerCase() === "active") {
              activationRelayed = true;
              existing.onChainStatus = "Active";
            } else {
              return reply.status(502).send({
                ok: false,
                error: `TEE activation relay failed: ${error?.message || String(error)}`,
                proxyKey: existing.proxyKey,
                activatePayload: publicActivation.payload,
                activateSignatureHex: publicActivation.signatureHex,
                keyAlreadyInjected: true,
              });
            }
          }
        }
        return {
          ok: true,
          modelAvailable: true,
          balanceCoversCredit: true,
          proxyKey: existing.proxyKey,
          activatePayload: publicActivation.payload,
          activateSignatureHex: publicActivation.signatureHex,
          activationRelayed,
          activationAlreadyActive: authoritativeStatus === "active",
          activationTxHash,
          keyAlreadyInjected: true,
        };
      }

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

      const entry = keyVault.getByDealId(dealId);
      const onChainStatus = String(entry?.onChainStatus || "").toLowerCase();
      if (onChainStatus === "active") {
        return {
          ...result,
          activationRelayed: true,
          activationAlreadyActive: true,
        };
      }

      if (
        nearRelayer.isConfigured()
        && result.activatePayload
        && result.activateSignatureHex
      ) {
        try {
          const activation = await nearRelayer.submitActivate(
            dealId,
            result.activatePayload,
            result.activateSignatureHex
          );
          if (entry) entry.onChainStatus = "Active";
          return {
            ...result,
            activationRelayed: true,
            activationTxHash: activation.transactionHash,
          };
        } catch (error: any) {
          // A submitted transaction may have reached finality even if the RPC
          // response was lost. Re-read chain state before reporting failure so
          // retrying activation cannot create a confusing false negative.
          const refreshed = await nearRelayer.getDeal(dealId).catch(() => null);
          if (String(refreshed?.status || "").toLowerCase() === "active") {
            if (entry) entry.onChainStatus = "Active";
            return {
              ...result,
              activationRelayed: true,
              activationAlreadyActive: true,
            };
          }
          return reply.status(502).send({
            ...result,
            ok: false,
            error: `TEE activation relay failed: ${error?.message || String(error)}`,
          });
        }
      }

      return result;
    } catch (err: any) {
      const message = err?.message || String(err);
      const authFailure = /seller|signature|authorization|wallet|nonce|public key/i.test(message);
      return reply.status(authFailure ? 401 : 500).send({ ok: false, error: message });
    } finally {
      if (injectionLocked) keyInjectionLocks.delete(dealId);
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

  app.get("/v1/solana/vault", async () => {
    return nearRelayer.callView("get_solana_vault_config", {});
  });

  // These are public, already-on-chain deal terms.  The frontend needs the
  // locked vault rather than the mutable default when asking a seller to make
  // their collateral transfer.
  app.get("/v1/deals/:id/solana", async (req, reply) => {
    const dealId = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(dealId) || dealId <= 0) {
      return reply.status(400).send({ error: "Invalid deal id" });
    }
    const locked = await nearRelayer.getSolanaDeal(dealId);
    if (!locked) return reply.status(404).send({ error: "No Solana terms for this deal" });
    return locked;
  });

  // Solana seller acceptance. The relayer only transports the signed message:
  // the escrow verifies it against the seller's 32-byte Solana public key.
  app.post("/v1/deals/:id/accept-solana", async (req, reply) => {
    const dealId = Number((req.params as { id: string }).id);
    const body = req.body as {
      expectedHashHex: string;
      sellerAddress: string;
      publicKeyBase58?: string;
      nonce: number;
      expiresAtNs: string | number;
      signatureBase64: string;
    };
    if (!Number.isSafeInteger(dealId) || dealId <= 0 || !body?.expectedHashHex || !body?.sellerAddress || !body?.signatureBase64) {
      return reply.status(400).send({ error: "Missing or invalid Solana acceptance parameters" });
    }
    if (!nearRelayer.isConfigured()) {
      return reply.status(503).send({ error: "TEE relayer credentials are not configured" });
    }
    try {
      const [deal, existing] = await Promise.all([
        nearRelayer.getDeal(dealId),
        nearRelayer.getSolanaDeal(dealId).catch(() => null),
      ]);
      if (!deal) return reply.status(404).send({ error: "Deal does not exist" });
      if (existing) return reply.status(409).send({ error: "This deal already has a Solana seller acceptance" });
      const publicKey = bs58.decode(body.publicKeyBase58 || body.sellerAddress);
      if (publicKey.length !== 32) return reply.status(400).send({ error: "Solana public key must be 32 bytes" });
      if (Buffer.from(publicKey).toString("hex") !== String(deal.seller || "").toLowerCase()) {
        return reply.status(403).send({ error: "The connected Solana wallet is not this deal's seller" });
      }
      if (String(body.sellerAddress).toLowerCase() !== Buffer.from(publicKey).toString("hex")) {
        return reply.status(400).send({ error: "Solana payout address must match the signing wallet" });
      }
      const expectedHash = body.expectedHashHex.replace(/^0x/, "").toLowerCase();
      const onChainHash = Array.isArray(deal.terms_hash) ? Buffer.from(deal.terms_hash).toString("hex") : "";
      if (expectedHash.length !== 64 || expectedHash !== onChainHash) {
        return reply.status(409).send({ error: "Acceptance terms hash does not match the on-chain deal" });
      }
      const signature = Buffer.from(body.signatureBase64, "base64");
      if (signature.length !== 64) return reply.status(400).send({ error: "Solana acceptance signature must be 64 bytes" });
      const result = await nearRelayer.submitAcceptDealSolana({
        dealId,
        expectedHashHex: expectedHash,
        sellerAddress: body.sellerAddress,
        publicKey,
        nonce: Number(body.nonce),
        expiresAtNs: body.expiresAtNs,
        signature,
      });
      return { ok: true, transactionHash: result.transactionHash };
    } catch (error: any) {
      return reply.status(400).send({ error: error?.message || "Solana seller acceptance failed" });
    }
  });

  // The enclave independently checks the Solana transaction before it can
  // mark the seller's collateral as deposited on the NEAR escrow.
  app.post("/v1/deals/:id/solana-collateral", async (req, reply) => {
    const dealId = Number((req.params as { id: string }).id);
    const body = req.body as { txSignature: string; termsHashHex: string };
    if (!Number.isSafeInteger(dealId) || dealId <= 0 || !body?.txSignature || !body?.termsHashHex) {
      return reply.status(400).send({ error: "Missing Solana collateral parameters" });
    }
    if (!nearRelayer.isConfigured()) {
      return reply.status(503).send({ error: "TEE relayer credentials are not configured" });
    }
    try {
      const [deal, solanaDeal] = await Promise.all([
        nearRelayer.getDeal(dealId),
        nearRelayer.getSolanaDeal(dealId),
      ]);
      if (!deal || !solanaDeal) return reply.status(409).send({ error: "Solana seller acceptance must be recorded before collateral" });
      if (solanaDeal.collateral_deposited) return reply.status(409).send({ error: "Solana collateral has already been recorded" });
      const onChainHash = Array.isArray(deal.terms_hash) ? Buffer.from(deal.terms_hash).toString("hex") : "";
      if (body.termsHashHex.replace(/^0x/, "").toLowerCase() !== onChainHash) {
        return reply.status(409).send({ error: "Collateral terms hash does not match the on-chain deal" });
      }
      // The seller accepted these vault terms on-chain. Never use a mutable
      // process default here: a DAO rotation is for future deals only.
      const lockedSolanaClient = new SolanaClient(
        CONFIG.solanaRpcUrl,
        String(solanaDeal.token_mint),
        String(solanaDeal.vault_address),
      );
      await lockedSolanaClient.verifyCollateralDeposit({
        signature: body.txSignature,
        sellerAddress: String(solanaDeal.seller_address),
        amountAtomic: BigInt(solanaDeal.collateral_amount || 0),
      });
      const payload: SignedPayloadDto = {
        domain: "conpi:v1",
        contractId: CONFIG.contractId,
        chainId: CONFIG.networkId,
        dealId,
        termsHash: Buffer.from(onChainHash, "hex"),
        kind: PayloadKind.ForeignDeposit,
        stage: 0,
        meteredValueYocto: 0n,
        reason: null,
        nonce: BigInt(deal.last_nonce || 0) + 1n,
        issuedAtNs: BigInt(Date.now()) * 1_000_000n,
        foreignTxSighash: crypto.createHash("sha256").update(body.txSignature).digest(),
      };
      const signatureHex = Buffer.from(enclaveKeys.sign(serializeSignedPayload(payload))).toString("hex");
      const relayed = await nearRelayer.submitRecordSolanaCollateral(dealId, body.txSignature, payload, signatureHex);
      return {
        ok: true,
        transactionHash: relayed.transactionHash,
        payload: publicSignedPayload({ payload, signatureHex } as any),
      };
    } catch (error: any) {
      return reply.status(400).send({ error: error?.message || "Solana collateral verification failed" });
    }
  });

  // 7. Multi-Chain Foreign Payments (Base Sepolia / Chain Signatures)
  app.get("/v1/foreign/vault/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const dealId = parseInt(id, 10);
    const vault = foreignVaultManager.deriveVaultAddress(CONFIG.contractId, dealId);
    const gasCheck = await foreignRelayer.checkVaultGas(vault.address);
    return {
      dealId,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      vaultAddress: vault.address,
      uncompressedPubKey: vault.uncompressedPubKey,
      tokenAddress: BASE_SEPOLIA_USDC,
      gasBalanceEth: gasCheck.balanceEth.toString(),
      hasGas: gasCheck.hasGas,
    };
  });

  app.post("/v1/foreign/verify-deposit", async (req, reply) => {
    const body = req.body as {
      dealId: number;
      txHash: `0x${string}`;
      termsHashHex: string;
      expectedAmountAtomic?: string;
      minConfirmations?: number;
      autoRelay?: boolean;
    };

    if (!body?.dealId || !body?.txHash || !body?.termsHashHex) {
      return reply.status(400).send({ error: "Missing required parameters (dealId, txHash, termsHashHex)" });
    }

    const [deal, foreignDeal] = await Promise.all([
      nearRelayer.getDeal(body.dealId),
      nearRelayer.getForeignDeal(body.dealId),
    ]);
    if (!deal) {
      return reply.status(404).send({ error: "Deal does not exist on the escrow contract" });
    }
    if (!foreignDeal) {
      return reply.status(409).send({ error: "Foreign deal parameters must be registered by the seller before deposit verification" });
    }

    const lockedAmountAtomic = String(foreignDeal.foreign_amount || "0");
    if (BigInt(lockedAmountAtomic) <= 0n) {
      return reply.status(409).send({ error: "On-chain foreign deposit amount is not locked" });
    }

    const vault = foreignVaultManager.deriveVaultAddress(CONFIG.contractId, body.dealId);
    if (String(foreignDeal.vault_address || "").toLowerCase() !== vault.address.toLowerCase()) {
      return reply.status(409).send({ error: "Registered vault does not match the deterministic deal vault" });
    }
    if (Number(foreignDeal.chain_id) !== BASE_SEPOLIA_CHAIN_ID) {
      return reply.status(409).send({ error: "Registered foreign chain is not Base Sepolia" });
    }
    if (String(foreignDeal.token_address || "").toLowerCase() !== BASE_SEPOLIA_USDC.toLowerCase()) {
      return reply.status(409).send({ error: "Registered foreign token is not Base Sepolia USDC" });
    }

    const verification = await baseClient.verifyDeposit({
      txHash: body.txHash,
      expectedVault: vault.address,
      expectedAmountAtomic: lockedAmountAtomic,
      minConfirmations: body.minConfirmations ? BigInt(body.minConfirmations) : 1n,
    });

    if (!verification.ok) {
      return reply.status(400).send({
        ok: false,
        error: verification.error,
        vaultAddress: vault.address,
      });
    }

    // Construct enclave ForeignDeposit payload
    const termsHashBytes = Array.isArray(deal.terms_hash)
      ? Buffer.from(deal.terms_hash)
      : Buffer.from(body.termsHashHex.replace(/^0x/, ""), "hex");
    const requestedTermsHash = body.termsHashHex.replace(/^0x/, "").toLowerCase();
    if (termsHashBytes.toString("hex") !== requestedTermsHash) {
      return reply.status(409).send({ error: "Deposit verification terms hash does not match the on-chain deal" });
    }
    const payload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId: body.dealId,
      termsHash: new Uint8Array(termsHashBytes),
      kind: PayloadKind.ForeignDeposit,
      stage: 0,
      meteredValueYocto: 0n,
      reason: null,
      nonce: Number(deal.last_nonce || 0) + 1,
      issuedAtNs: BigInt(Date.now()) * 1_000_000n,
    };

    const serialized = serializeSignedPayload(payload);
    const signature = enclaveKeys.sign(serialized);
    const signatureHex = Buffer.from(signature).toString("hex");

    let relayResult = null;
    if (body.autoRelay && nearRelayer.isConfigured()) {
      try {
        if (
          !verification.sender ||
          String(foreignDeal.buyer_address || "").toLowerCase() !== verification.sender.toLowerCase()
        ) {
          throw new Error("Verified deposit sender does not match the locked foreign buyer address");
        }
        relayResult = await nearRelayer.submitForeignDeposit(
          body.dealId,
          body.txHash,
          payload,
          signatureHex
        );
      } catch (err: any) {
        relayResult = { error: err?.message || String(err) };
      }
    }

    return {
      ok: true,
      dealId: body.dealId,
      txHash: body.txHash,
      verification,
      payload: publicSignedPayload({ payload, signatureHex } as any),
      relayResult,
    };
  });

  app.post("/v1/foreign/broadcast-payout", async (req, reply) => {
    const body = req.body as {
      dealId: number;
      stage: number;
      chainId: number;
      recipient: `0x${string}`;
      amountAtomic: string;
      sighashHex: `0x${string}`;
      rHex: string;
      sHex: string;
      recoveryId: number;
      nonce?: number;
    };

    if (!body?.dealId || !body?.recipient || !body?.amountAtomic || !body?.rHex || !body?.sHex) {
      return reply.status(400).send({ error: "Missing required payout parameters" });
    }

    const result = await foreignRelayer.broadcastSignedPayout({
      dealId: body.dealId,
      stage: body.stage,
      chainId: body.chainId || BASE_SEPOLIA_CHAIN_ID,
      recipient: body.recipient,
      amountAtomic: BigInt(body.amountAtomic),
      sighashHex: body.sighashHex,
      rHex: body.rHex,
      sHex: body.sHex,
      recoveryId: body.recoveryId,
      nonce: body.nonce,
    });

    if (!result.success) {
      return reply.status(400).send(result);
    }

    return result;
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
  const relayerKey = process.env.OPERATOR_EVM_PRIVATE_KEY || process.env.BASE_SEPOLIA_RELAYER_KEY;
  if (!relayerKey) {
    console.warn(`  [Diagnostic] OPERATOR_EVM_PRIVATE_KEY not set. Base Sepolia gas sponsorship requires manual funding.`);
  } else {
    console.log(`  [Diagnostic] Base Sepolia gas sponsorship operator active.`);
  }
  console.log(`=======================================================`);
}

const isTest = process.env.NODE_ENV === "test" || process.argv.some((a) => a.includes("test"));
if (!isTest) {
  startServer().catch((err) => {
    console.error("Failed to start TEE service:", err);
    process.exit(1);
  });
}
