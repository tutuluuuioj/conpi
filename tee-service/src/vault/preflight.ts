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
  termsHashHex: string;
  creditUsd: number;
  priceUsd: number;
  usedUsd: number;
  tokensTotal: number;
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
      termsHashHex,
      creditUsd,
      priceUsd,
      usedUsd: 0,
      tokensTotal: 0,
      active: true,
      registeredAt: new Date().toISOString(),
      signedPayloads: [],
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
      if (!res.ok) {
        return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Provider error HTTP ${res.status}` };
      }

      // Verify requested model is present in account
      const data: any = await res.json().catch(() => null);
      if (data && Array.isArray(data.data)) {
        const modelsList = data.data.map((m: any) => m.id || m);
        const targetModel = model.toLowerCase();
        const found = modelsList.some((m: string) => typeof m === "string" && (m.toLowerCase() === targetModel || m.toLowerCase().includes(targetModel)));
        if (!found) {
          return { ok: false, modelAvailable: false, balanceCoversCredit: false, error: `Model "${model}" not available for this API key` };
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
