import crypto from "crypto";
import { decryptFromClient, EncryptedEnvelope } from "../crypto/encryption.js";
import { serializeSignedPayload, PayloadKind, SignedPayloadDto } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";

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

export interface KeyCheckResult {
  ok: boolean;
  modelAvailable: boolean;
  balanceCoversCredit: boolean;
  error?: string;
  proxyKey?: string;
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

  // 3. Fallback to last known price or benchmark default ($3.75)
  if (cachedNearPriceUsd) return cachedNearPriceUsd.price;
  return 3.75;
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
  creditAmountYocto?: string;
  active: boolean;
  registeredAt: string;
  signedPayloads: Array<{ payload: any; signatureHex: string }>;
}

class KeyVault {
  // Pure volatile in-memory map; never written to disk
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
    let apiKey: string;
    if (plainApiKey) {
      apiKey = plainApiKey;
    } else if (encryptedEnvelope) {
      apiKey = decryptFromClient(encryptedEnvelope);
    } else {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "No API key provided" };
    }

    if (!apiKey || apiKey.trim().length < 8) {
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "API key too short" };
    }

    // Pre-flight check against provider API
    const preflight = await this.executePreflight(provider, apiKey, model);
    if (!preflight.ok) {
      return {
        ok: false,
        modelAvailable: preflight.modelAvailable,
        balanceCoversCredit: preflight.balanceCoversCredit,
        error: preflight.error,
      };
    }

    // Generate buyer bearer proxy key
    const proxyKey = `cpk_live_${crypto.randomBytes(16).toString("hex")}`;

    let resolvedCreditYocto: string = "";
    let resolvedCreditUsd: number = 0;
    let resolvedPriceUsd: number = 0;
    let resolvedTermsHashHex: string = termsHashHex || "";

    // Strictly resolve creditUsd, priceUsd and creditAmountYocto from on-chain deal state
    try {
      const { nearRelayer } = await import("../chain/relayer.js");
      const deal = await nearRelayer.getDeal(dealId);
      if (deal) {
        const creditBigInt = parseBalance(deal.credit_amount);
        if (creditBigInt === 0n) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `On-chain deal #${dealId} has zero credit_amount` };
        }
        resolvedCreditYocto = creditBigInt.toString();
        const priceBigInt = parseBalance(deal.price);
        const isNear = (deal.token === null || deal.token === "NEAR");
        if (isNear) {
          const nearPrice = await fetchLiveNearPriceUsd();
          resolvedCreditUsd = (Number(creditBigInt) / 1e24) * nearPrice;
          resolvedPriceUsd = (Number(priceBigInt) / 1e24) * nearPrice;
        } else {
          resolvedCreditUsd = Number(creditBigInt) / 1e6;
          resolvedPriceUsd = Number(priceBigInt) / 1e6;
        }
        if (Array.isArray(deal.terms_hash)) {
          resolvedTermsHashHex = Buffer.from(deal.terms_hash).toString("hex");
        }
      } else if (process.env.NODE_ENV === "test") {
        // Fallback for isolated offline unit testing when deal is not found
        resolvedCreditYocto = creditAmountYocto || "2000000000000000000000000";
        resolvedCreditUsd = (typeof creditUsd === "number" && creditUsd > 0) ? creditUsd : 2;
        resolvedPriceUsd = (typeof priceUsd === "number" && priceUsd > 0) ? priceUsd : 2;
      } else {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Deal #${dealId} does not exist on-chain` };
      }
    } catch (err: any) {
      if (process.env.NODE_ENV === "test") {
        resolvedCreditYocto = creditAmountYocto || "2000000000000000000000000";
        resolvedCreditUsd = (typeof creditUsd === "number" && creditUsd > 0) ? creditUsd : 2;
        resolvedPriceUsd = (typeof priceUsd === "number" && priceUsd > 0) ? priceUsd : 2;
      } else {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Failed to query on-chain deal #${dealId}: ${err.message}` };
      }
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
      usedUsd: 0,
      tokensTotal: 0,
      creditAmountYocto: resolvedCreditYocto,
      active: true,
      registeredAt: new Date().toISOString(),
      signedPayloads: [],
    };

    this.entries.set(dealId, entry);
    this.proxyKeyToDealId.set(proxyKey, dealId);

    // Build ACTIVATE SignedPayload
    const termsHashBytes = Buffer.from(resolvedTermsHashHex, "hex");
    const nowNs = BigInt(Date.now()) * 1_000_000n;

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
      nonce: 1n,
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
    model: string
  ): Promise<{ ok: boolean; modelAvailable: boolean; balanceCoversCredit: boolean; error?: string }> {
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
      if (data && Array.isArray(data.data)) {
        const modelsList: string[] = data.data.map((m: any) => (typeof m === "string" ? m : m.id || ""));
        const targetModel = model.trim().toLowerCase();
        const found = modelsList.some((m: string) => typeof m === "string" && m.trim().toLowerCase() === targetModel);
        if (!found) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Model "${model}" not available for this API key (exact match required)` };
        }
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

      return { ok: true, modelAvailable: true, balanceCoversCredit: true };
    } catch (err: any) {
      console.error(`[Preflight] Network check failed:`, err.message);
      return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Preflight network error: ${err.message}` };
    }
  }
}

export const keyVault = new KeyVault();
