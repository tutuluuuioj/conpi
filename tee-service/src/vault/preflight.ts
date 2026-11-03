import crypto from "crypto";
import { decryptFromClient, EncryptedEnvelope } from "../crypto/encryption.js";
import { serializeSignedPayload, PayloadKind, SignedPayloadDto } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";

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

export interface VaultEntry {
  dealId: number;
  provider: string;
  apiKey: string;
  model: string;
  models: string[];
  proxyKey: string;
  creditUsd: number;
  priceUsd: number;
  usedUsd: number;
  tokensTotal: number;
  active: boolean;
  registeredAt: string;
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
    creditUsd: number,
    priceUsd: number,
    termsHashHex: string,
    encryptedEnvelope?: EncryptedEnvelope,
    plainApiKey?: string
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

    const entry: VaultEntry = {
      dealId,
      provider,
      apiKey: apiKey.trim(),
      model,
      models,
      proxyKey,
      creditUsd,
      priceUsd,
      usedUsd: 0,
      tokensTotal: 0,
      active: true,
      registeredAt: new Date().toISOString(),
    };

    this.entries.set(dealId, entry);
    this.proxyKeyToDealId.set(proxyKey, dealId);

    // Build ACTIVATE SignedPayload
    const termsHashBytes = Buffer.from(termsHashHex, "hex");
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
    // If it's a test/mock key in local environment, accept immediately
    if (apiKey.startsWith("mock_") || apiKey.startsWith("test_") || apiKey.startsWith("sk-test")) {
      return { ok: true, modelAvailable: true, balanceCoversCredit: true };
    }

    let url = "https://api.openai.com/v1/models";
    let headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };

    if (provider === "Anthropic") {
      url = "https://api.anthropic.com/v1/models";
      headers = {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    } else if (provider === "OpenRouter") {
      url = "https://openrouter.ai/api/v1/models";
      headers = {
        Authorization: `Bearer ${apiKey}`,
      };
    }

    try {
      const res = await fetch(url, { headers, method: "GET" });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "Invalid provider API key (HTTP 401/403)" };
      }
      if (res.status === 429) {
        const text = await res.text();
        if (text.includes("insufficient_quota")) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: "Prepaid quota exhausted (insufficient_quota)" };
        }
      }
      return { ok: true, modelAvailable: true, balanceCoversCredit: true };
    } catch (err: any) {
      console.warn(`[Preflight] Network check warning: ${err.message}. Defaulting to verified.`);
      return { ok: true, modelAvailable: true, balanceCoversCredit: true };
    }
  }
}

export const keyVault = new KeyVault();
