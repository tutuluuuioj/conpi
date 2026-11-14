import crypto from "crypto";
import { decryptFromClient, EncryptedEnvelope } from "../crypto/encryption.js";
import { serializeSignedPayload, PayloadKind, SignedPayloadDto } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";
import { lockPricingTable, LockedPricingTable, openRouterPricingFromModels } from "../proxy/pricing.js";
import { meterEngine } from "../proxy/meter.js";
import { negotiationService } from "../negotiation/matcher.js";
import type { TermSheet } from "../negotiation/matcher.js";
import { meteringStateStore, PendingUsage, UsageReceipt } from "../state/metering-store.js";
import { sellerMeterToken } from "../auth/meter-token.js";

export function parseBalance(val: any): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") {
    const s = val.toLocaleString("fullwide", { useGrouping: false });
    if (!s.includes("e") && !s.includes(".")) return BigInt(s);
    return BigInt(Math.floor(val));
  }
  const str = String(val).trim();
  if (str.includes("e") || str.includes("E")) {
    const num = Number(str);
    const s = num.toLocaleString("fullwide", { useGrouping: false });
    if (!s.includes("e") && !s.includes(".")) return BigInt(s);
    return BigInt(Math.floor(num));
  }
  return BigInt(str);
}

export function usdBudgetMatchesOnChain(agreedUsd: number, derivedUsd: number, isNear: boolean): boolean {
  if (!Number.isFinite(agreedUsd) || !Number.isFinite(derivedUsd) || agreedUsd <= 0 || derivedUsd <= 0) return false;
  const absoluteTolerance = isNear ? 0.005 : 0.0001;
  const relativeTolerance = derivedUsd * (isNear ? 0.15 : 0.01);
  return Math.abs(agreedUsd - derivedUsd) <= Math.max(absoluteTolerance, relativeTolerance);
}

export interface KeyCheckResult {
  ok: boolean;
  modelAvailable: boolean;
  balanceCoversCredit: boolean;
  error?: string;
  proxyKey?: string;
  sellerMeterToken?: string;
  activatePayload?: {
    domain: string;
    contractId: string;
    chainId: string;
    dealId: number;
    termsHashHex: string;
    kind: number;
    stage: number;
    meteredValueYocto: string;
    reason: number | null;
    nonce: string;
    issuedAtNs: string;
  };
  activateSignatureHex?: string;
  activationRelayed?: boolean;
  activationAlreadyActive?: boolean;
  activationTxHash?: string;
}

export function shouldKeepVaultEntryActive(onChainStatus: string): boolean {
  return !["Completed", "Defaulted", "Cancelled"].includes(onChainStatus);
}

let cachedNearPriceUsd: { price: number; fetchedAt: number } | null = null;

export async function fetchLiveNearPriceUsd(): Promise<number> {
  const now = Date.now();
  if (cachedNearPriceUsd && now - cachedNearPriceUsd.fetchedAt < 60_000) {
    return cachedNearPriceUsd.price;
  }

  // 1. Try CoinGecko
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data: any = await res.json();
      if (typeof data?.near?.usd === "number" && data.near.usd > 0) {
        cachedNearPriceUsd = { price: data.near.usd, fetchedAt: now };
        return data.near.usd;
      }
    }
  } catch {}

  // 2. Try Binance
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const p = parseFloat(data?.price);
      if (!isNaN(p) && p > 0) {
        cachedNearPriceUsd = { price: p, fetchedAt: now };
        return p;
      }
    }
  } catch {}

  // 3. If recent valid price cache exists, return it; otherwise fail explicitly rather than silently falling back to $3.75
  if (cachedNearPriceUsd && now - cachedNearPriceUsd.fetchedAt < 300_000) {
    return cachedNearPriceUsd.price;
  }
  throw new Error("Live NEAR price oracle unavailable (both CoinGecko and Binance unreachable). Silent fallback price is disabled; deal must fail.");
}

export interface ForeignDealInfo {
  chainId: number;
  vaultAddress: string;
  tokenAddress: string;
  buyerAddress: string;
  sellerAddress: string;
  foreignAmount: bigint;
  evmNonce: number;
}

/**
 * The Solana half of a NEAR escrow deal. The contract is the source of
 * truth: this is only a cached copy used by the enclave when it builds a
 * payout transaction for the Chain-Signatures vault.
 */
export interface SolanaDealInfo {
  vaultAddress: string;
  tokenMint: string;
  mpcPath: string;
  mpcDomainId: number;
  sellerAddress: string;
  collateralAmount: bigint;
  collateralDeposited: boolean;
  payoutSequence: number;
}

export interface VaultEntry {
  dealId: number;
  provider: string;
  apiKey: string;
  model: string;
  models: string[];
  proxyKey: string;
  termsHashHex: string;
  creditUsd: number;
  priceUsd: number;
  usedUsd: number;
  tokensTotal: number;
  lockedPricing: LockedPricingTable;
  pricingSnapshotHash: string;
  usageReceipts: UsageReceipt[];
  processedGenerationIds: string[];
  pendingUsage: PendingUsage | null;
  requestInFlight: boolean;
  rateLimitPerMinute: number;
  creditAmountYocto?: string;
  active: boolean;
  registeredAt: string;
  signedPayloads: Array<{ payload: any; signatureHex: string }>;
  defaultPayload?: { payload: SignedPayloadDto; signatureHex: string };
  lastCheckpointAt: number;
  relayReceipts: RelayReceipt[];
  onChainStatus?: string;
  foreignDeal?: ForeignDealInfo | null;
  solanaDeal?: SolanaDealInfo | null;
}

export function hashLockedPricing(pricing: LockedPricingTable): string {
  const canonical = Object.keys(pricing)
    .sort()
    .map((model) => ({ model, ...pricing[model] }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface RelayReceipt {
  kind: "stage" | "checkpoint" | "default";
  nonce: string;
  state: "queued" | "awaiting_credentials" | "submitted" | "applied" | "failed";
  attempts: number;
  transactionHash?: string;
  error?: string;
  updatedAt: string;
}

class KeyVault {
  // Provider and proxy secrets remain volatile. Only encrypted metering state is
  // sealed to the CVM volume for crash recovery and duplicate-charge defense.
  private entries = new Map<number, VaultEntry>();
  private proxyKeyToDealId = new Map<string, number>();

  public getByDealId(dealId: number): VaultEntry | undefined {
    return this.entries.get(dealId);
  }

  public getByProxyKey(proxyKey: string): VaultEntry | undefined {
    const dealId = this.proxyKeyToDealId.get(proxyKey);
    if (dealId === undefined) return undefined;
    return this.entries.get(dealId);
  }

  public listActive(): VaultEntry[] {
    return [...this.entries.values()].filter((entry) => entry.active);
  }

  public async validateAndInjectKey(
    dealId: number,
    provider: string,
    model: string,
    models: string[],
    creditUsd?: number,
    priceUsd?: number,
    termsHashHex?: string,
    encryptedEnvelope?: EncryptedEnvelope,
    plainApiKey?: string,
    creditAmountYocto?: string
  ): Promise<KeyCheckResult> {
    let lockedPricing: LockedPricingTable;
    let normalizedModels: string[];
    try {
      model = model?.trim();
      normalizedModels = [...new Set([model, ...models].map((item) => item?.trim()).filter(Boolean))];
      if (!normalizedModels.includes(model.trim())) {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "Primary model must be included in the allowlist" };
      }
      models = normalizedModels;
    } catch (err: any) {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: err.message };
    }

    let apiKey: string;
    if (plainApiKey) {
      if (process.env.NODE_ENV !== "test") {
        return {
          ok: false,
          modelAvailable: false,
          balanceCoversCredit: false,
          error: "Plaintext API keys are rejected outside test mode; encryptedEnvelope is required",
        };
      }
      apiKey = plainApiKey;
    } else if (encryptedEnvelope) {
      apiKey = decryptFromClient(encryptedEnvelope);
    } else {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "No API key provided" };
    }

    if (!apiKey || apiKey.trim().length < 8) {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "API key too short" };
    }

    let agreedTerms: TermSheet | undefined;
    try {
      agreedTerms = negotiationService.assertMatchedDealTerms(dealId, provider, models, termsHashHex || "");
    } catch (err: any) {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: err.message };
    }

    // Pre-flight check against provider API
    const preflight = await this.executePreflight(provider, apiKey, model, models);
    if (!preflight.ok) {
      return {
        ok: false,
        modelAvailable: preflight.modelAvailable,
        balanceCoversCredit: preflight.balanceCoversCredit,
        error: preflight.error,
      };
    }
    try {
      lockedPricing = lockPricingTable(models, preflight.providerPricing);
    } catch (err: any) {
      return { ok: false, modelAvailable: true, balanceCoversCredit: true, error: err.message };
    }

    // Generate buyer bearer proxy key
    const proxyKey = `cpk_live_${crypto.randomBytes(16).toString("hex")}`;

    let resolvedCreditYocto: string = "";
    let resolvedCreditUsd: number = 0;
    let resolvedPriceUsd: number = 0;
    let resolvedTermsHashHex: string = termsHashHex || "";
    let resolvedLastNonce = 0;
    let resolvedStage = 0;
    let resolvedStatus = "Funded";
    let derivedCreditUsd = 0;
    let derivedPriceUsd = 0;
    let onChainTokenIsNear = false;

    let resolvedForeignDeal: ForeignDealInfo | null = null;
    let resolvedSolanaDeal: SolanaDealInfo | null = null;

    // Strictly resolve creditUsd, priceUsd and creditAmountYocto from on-chain deal state
    try {
      const { nearRelayer } = await import("../chain/relayer.js");
      const deal = await nearRelayer.getDeal(dealId);
      const [foreign, solana] = await Promise.all([
        nearRelayer.getForeignDeal(dealId).catch(() => null),
        nearRelayer.getSolanaDeal(dealId).catch(() => null),
      ]);
      if (foreign && foreign.vault_address) {
        resolvedForeignDeal = {
          chainId: Number(foreign.chain_id || 84532),
          vaultAddress: foreign.vault_address,
          tokenAddress: foreign.token_address,
          buyerAddress: foreign.buyer_address,
          sellerAddress: foreign.seller_address,
          foreignAmount: BigInt(foreign.foreign_amount),
          evmNonce: Number(foreign.evm_nonce || 0),
        };
      }
      if (solana && solana.vault_address) {
        resolvedSolanaDeal = {
          vaultAddress: String(solana.vault_address),
          tokenMint: String(solana.token_mint),
          mpcPath: String(solana.mpc_path),
          mpcDomainId: Number(solana.mpc_domain_id),
          sellerAddress: String(solana.seller_address),
          collateralAmount: BigInt(solana.collateral_amount || 0),
          collateralDeposited: Boolean(solana.collateral_deposited),
          payoutSequence: Number(solana.payout_sequence || 0),
        };
      }
      if (deal) {
        const creditBigInt = parseBalance(deal.credit_amount);
        if (creditBigInt === 0n) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `On-chain deal #${dealId} has zero credit_amount` };
        }
        resolvedCreditYocto = creditBigInt.toString();
        const priceBigInt = parseBalance(deal.price);
        const isNear = (deal.token === null || deal.token === "NEAR");
        onChainTokenIsNear = isNear && !resolvedForeignDeal;
        if (resolvedForeignDeal) {
          // Foreign Maker Vault deals escrow USDC outside NEAR. Their canonical
          // USD budget is the registered six-decimal foreign amount, not the
          // placeholder native values on the coordination contract.
          derivedCreditUsd = Number(resolvedForeignDeal.foreignAmount) / 1e6;
          derivedPriceUsd = derivedCreditUsd;
        } else if (isNear) {
          const nearPrice = await fetchLiveNearPriceUsd();
          derivedCreditUsd = (Number(creditBigInt) / 1e24) * nearPrice;
          derivedPriceUsd = (Number(priceBigInt) / 1e24) * nearPrice;
        } else {
          derivedCreditUsd = Number(creditBigInt) / 1e6;
          derivedPriceUsd = Number(priceBigInt) / 1e6;
        }
        resolvedCreditUsd = derivedCreditUsd;
        resolvedPriceUsd = derivedPriceUsd;
        if (Array.isArray(deal.terms_hash)) {
          resolvedTermsHashHex = Buffer.from(deal.terms_hash).toString("hex");
        }
        resolvedLastNonce = Number(deal.last_nonce || 0);
        resolvedStage = Number(deal.stage_reached || 0);
        resolvedStatus = String(deal.status || "Funded");
      } else if (process.env.NODE_ENV === "test") {
        // Fallback for isolated offline unit testing when deal is not found
        resolvedCreditYocto = creditAmountYocto || "2000000000000000000000000";
        resolvedCreditUsd = (typeof creditUsd === "number" && creditUsd > 0) ? creditUsd : 2;
        resolvedPriceUsd = (typeof priceUsd === "number" && priceUsd > 0) ? priceUsd : 2;
        derivedCreditUsd = resolvedCreditUsd;
        derivedPriceUsd = resolvedPriceUsd;
      } else {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Deal #${dealId} does not exist on-chain` };
      }
    } catch (err: any) {
      if (process.env.NODE_ENV === "test") {
        resolvedCreditYocto = creditAmountYocto || "2000000000000000000000000";
        resolvedCreditUsd = (typeof creditUsd === "number" && creditUsd > 0) ? creditUsd : 2;
        resolvedPriceUsd = (typeof priceUsd === "number" && priceUsd > 0) ? priceUsd : 2;
        derivedCreditUsd = resolvedCreditUsd;
        derivedPriceUsd = resolvedPriceUsd;
      } else {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Failed to query on-chain deal #${dealId}: ${err.message}` };
      }
    }

    try {
      agreedTerms = negotiationService.assertMatchedDealTerms(dealId, provider, models, resolvedTermsHashHex) || agreedTerms;
    } catch (err: any) {
      return { ok: false, modelAvailable: true, balanceCoversCredit: true, error: err.message };
    }
    if (agreedTerms) {
      if (!usdBudgetMatchesOnChain(agreedTerms.creditAmountUsd, derivedCreditUsd, onChainTokenIsNear)) {
        return {
          ok: false,
          modelAvailable: true,
          balanceCoversCredit: false,
          error: `Agreed USD credit $${agreedTerms.creditAmountUsd.toFixed(6)} does not match the on-chain ${onChainTokenIsNear ? "NEAR" : "token"} value ($${derivedCreditUsd.toFixed(6)})`,
        };
      }
      if (!usdBudgetMatchesOnChain(agreedTerms.priceUsd, derivedPriceUsd, onChainTokenIsNear)) {
        return {
          ok: false,
          modelAvailable: true,
          balanceCoversCredit: false,
          error: `Agreed USD price $${agreedTerms.priceUsd.toFixed(6)} does not match the on-chain ${onChainTokenIsNear ? "NEAR" : "token"} value ($${derivedPriceUsd.toFixed(6)})`,
        };
      }
      resolvedCreditUsd = agreedTerms.creditAmountUsd;
      resolvedPriceUsd = agreedTerms.priceUsd;
    }

    let pricingSnapshotHash = hashLockedPricing(lockedPricing);
    let persistedState: ReturnType<typeof meteringStateStore.load> = null;
    try {
      persistedState = meteringStateStore.load(dealId, resolvedTermsHashHex);
      if (persistedState) {
        const persistedModels = Object.keys(persistedState.lockedPricing).map((item) => item.toLowerCase()).sort();
        const requestedModels = models.map((item) => item.toLowerCase()).sort();
        if (JSON.stringify(persistedModels) !== JSON.stringify(requestedModels)) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: `Persisted model allowlist mismatch for deal #${dealId}` };
        }
        lockedPricing = persistedState.lockedPricing;
        pricingSnapshotHash = persistedState.pricingSnapshotHash;
      }
    } catch (err: any) {
      return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: err.message };
    }

    const entry: VaultEntry = {
      dealId,
      provider,
      apiKey: apiKey.trim(),
      model,
      models,
      proxyKey,
      termsHashHex: resolvedTermsHashHex,
      creditUsd: resolvedCreditUsd,
      priceUsd: resolvedPriceUsd,
      usedUsd: persistedState?.usedUsd || 0,
      tokensTotal: persistedState?.tokensTotal || 0,
      lockedPricing,
      pricingSnapshotHash,
      usageReceipts: persistedState?.usageReceipts || [],
      processedGenerationIds: persistedState?.processedGenerationIds || [],
      pendingUsage: persistedState?.pendingUsage || null,
      requestInFlight: false,
      rateLimitPerMinute: CONFIG.rateLimitPerMinute,
      creditAmountYocto: resolvedCreditYocto,
      // "active" controls deal recovery and proxy authentication, not the
      // budget cap.  A fully consumed on-chain Active deal must remain in the
      // recovery loop until its final stage is actually settled.  New model
      // calls are independently rejected by the budget admission check.
      active: shouldKeepVaultEntryActive(resolvedStatus),
      registeredAt: new Date().toISOString(),
      signedPayloads: [],
      lastCheckpointAt: Date.now(),
      relayReceipts: [],
      onChainStatus: resolvedStatus,
      foreignDeal: resolvedForeignDeal,
      solanaDeal: resolvedSolanaDeal,
    };

    this.entries.set(dealId, entry);
    this.proxyKeyToDealId.set(proxyKey, dealId);
    meteringStateStore.save(entry);

    // Continue the on-chain per-deal nonce sequence. A fresh funded deal starts at
    // zero, while a recovered enclave instance resumes after the latest accepted
    // payload instead of creating replayed signatures.
    meterEngine.seedNonce(dealId, BigInt(resolvedLastNonce));
    meterEngine.seedStage(dealId, resolvedStage);
    if (resolvedForeignDeal) {
      meterEngine.seedEvmNonce(dealId, resolvedForeignDeal.evmNonce);
    }

    // Build ACTIVATE SignedPayload
    const termsHashBytes = Buffer.from(resolvedTermsHashHex, "hex");
    const nowNs = BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n;

    const activatePayload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId,
      termsHash: termsHashBytes,
      kind: PayloadKind.Activate,
      stage: 0,
      meteredValueYocto: 0n,
      reason: null,
      nonce: meterEngine.getNextNonce(dealId),
      issuedAtNs: nowNs,
    };

    const payloadBytes = serializeSignedPayload(activatePayload);
    const signature = enclaveKeys.sign(payloadBytes);
    const activateSignatureHex = Buffer.from(signature).toString("hex");

    entry.signedPayloads.push({
      payload: activatePayload,
      signatureHex: activateSignatureHex,
    });

    return {
      ok: true,
      modelAvailable: true,
      balanceCoversCredit: true,
      proxyKey,
      sellerMeterToken: sellerMeterToken(dealId, resolvedTermsHashHex),
      activatePayload: {
        domain: activatePayload.domain,
        contractId: activatePayload.contractId,
        chainId: activatePayload.chainId,
        dealId: Number(activatePayload.dealId),
        termsHashHex: Buffer.from(activatePayload.termsHash).toString("hex"),
        kind: activatePayload.kind,
        stage: activatePayload.stage,
        meteredValueYocto: activatePayload.meteredValueYocto.toString(),
        reason: activatePayload.reason !== null && activatePayload.reason !== undefined ? activatePayload.reason : null,
        nonce: activatePayload.nonce.toString(),
        issuedAtNs: activatePayload.issuedAtNs.toString(),
      },
      activateSignatureHex,
    };
  }

  private async executePreflight(
    provider: string,
    apiKey: string,
    model: string,
    models: string[]
  ): Promise<{ ok: boolean; modelAvailable: boolean; balanceCoversCredit: boolean; error?: string; providerPricing?: LockedPricingTable }> {
    // Mock and test shortcuts are strictly disabled outside test mode
    if (apiKey.startsWith("mock_") || apiKey.startsWith("test_") || apiKey.startsWith("sk-test")) {
      if (process.env.NODE_ENV !== "test") {
        return {
          ok: false,
          modelAvailable: false,
          balanceCoversCredit: false,
          error: "Mock and test API keys are rejected outside test mode (NODE_ENV !== 'test')",
        };
      }
      return { ok: true, modelAvailable: true, balanceCoversCredit: true };
    }

    let baseUrl = "https://api.openai.com/v1";
    let headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };

    const provLower = provider.toLowerCase();
    const isRedPill = apiKey.startsWith("sk-rp-") || provLower === "redpill" || provLower === "phala";
    const isAnthropic = provLower === "anthropic";
    const isOpenRouter = provLower === "openrouter";

    if (isRedPill) {
      baseUrl = "https://api.redpill.ai/v1";
      headers = { Authorization: `Bearer ${apiKey}` };
    } else if (isAnthropic) {
      baseUrl = "https://api.anthropic.com/v1";
      headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    } else if (isOpenRouter) {
      baseUrl = "https://openrouter.ai/api/v1";
      headers = { Authorization: `Bearer ${apiKey}` };
    }

    try {
      // 1. Check models and ensure exact model match (no substring matching)
      const modelsUrl = `${baseUrl}/models`;
      const res = await fetch(modelsUrl, { headers, method: "GET" });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "Invalid provider API key (HTTP 401/403)" };
      }
      if (res.status === 429) {
        const text = await res.text();
        if (text.includes("insufficient_quota")) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "Prepaid quota exhausted (insufficient_quota)" };
        }
      }
      if (!res.ok) {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Provider error HTTP ${res.status}` };
      }

      // Verify requested model is present in account via strict exact match
      const data: any = await res.json().catch(() => null);
      let providerPricing: LockedPricingTable | undefined;
      if (data && Array.isArray(data.data)) {
        const modelsList: string[] = data.data.map((m: any) => (typeof m === "string" ? m : m.id || ""));
        const available = new Set(modelsList.map((item) => item.trim().toLowerCase()).filter(Boolean));
        const missing = models.filter((item) => !available.has(item.trim().toLowerCase()));
        if (missing.length) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Model "${missing[0]}" not available for this API key (exact match required)` };
        }
        if (isOpenRouter) providerPricing = openRouterPricingFromModels(models, data.data);
      }

      // OpenRouter exposes a free key-inspection endpoint. Use it instead of a
      // billable one-token completion probe so validation never appears as
      // unmetered usage in the seller's OpenRouter dashboard.
      if (isOpenRouter) {
        const keyRes = await fetch(`${baseUrl}/key`, { headers, method: "GET" });
        if (keyRes.status === 401 || keyRes.status === 403) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Invalid OpenRouter API key" };
        }
        if (!keyRes.ok) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: `OpenRouter key check failed (HTTP ${keyRes.status})` };
        }
        const keyData: any = await keyRes.json().catch(() => null);
        const remaining = Number(keyData?.data?.limit_remaining);
        if (Number.isFinite(remaining) && remaining <= 0) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "OpenRouter API key limit is exhausted" };
        }
        return { ok: true, modelAvailable: true, balanceCoversCredit: true, providerPricing };
      }

      // 2. Real balance & quota preflight check via minimal completion probe
      if (isAnthropic) {
        const probeRes = await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.trim(),
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
        });
        if (probeRes.status === 402 || probeRes.status === 429) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Anthropic account quota or balance insufficient" };
        }
        if (probeRes.status === 401 || probeRes.status === 403) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Anthropic authentication failed during balance preflight" };
        }
      } else {
        const probeRes = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.trim(),
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          }),
        });
        if (probeRes.status === 402) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Provider account balance insufficient (HTTP 402)" };
        }
        if (probeRes.status === 429) {
          const probeText = await probeRes.text();
          if (probeText.includes("insufficient_quota")) {
            return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Provider quota depleted (insufficient_quota)" };
          }
        }
        if (probeRes.status === 401 || probeRes.status === 403) {
          return { ok: false, modelAvailable: true, balanceCoversCredit: false, error: "Authentication failed during balance preflight" };
        }
      }

      return { ok: true, modelAvailable: true, balanceCoversCredit: true, providerPricing };
    } catch (err: any) {
      console.error(`[Preflight] Network check failed:`, err.message);
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Preflight network error: ${err.message}` };
    }
  }
}

export const keyVault = new KeyVault();
