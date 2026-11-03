import { PayloadKind, DefaultReason, SignedPayloadDto, serializeSignedPayload } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";
import { VaultEntry } from "../vault/preflight.js";

export interface PricingRate {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}

export const PRICING_TABLE: Record<string, PricingRate> = {
  "gpt-4o": { inputPerMillion: 2.50, outputPerMillion: 10.00, cachedInputPerMillion: 1.25 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  "claude-3-5-sonnet": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  "claude-3-5-haiku": { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  "meta-llama/llama-3-70b": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
};

export interface UsageCalculation {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number, cachedTokens: number = 0): UsageCalculation {
  const rate = PRICING_TABLE[model] || { inputPerMillion: 2.0, outputPerMillion: 10.0 };
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);

  const inputCost = (uncachedInput * rate.inputPerMillion) / 1_000_000;
  const cachedCost = (cachedTokens * (rate.cachedInputPerMillion || rate.inputPerMillion * 0.5)) / 1_000_000;
  const outputCost = (outputTokens * rate.outputPerMillion) / 1_000_000;

  const costUsd = inputCost + cachedCost + outputCost;
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd,
  };
}

export class MeterEngine {
  private lastStageEmitted = new Map<number, number>();
  private nonceMap = new Map<number, bigint>();

  public getNextNonce(dealId: number): bigint {
    const current = this.nonceMap.get(dealId) || 1n;
    const next = current + 1n;
    this.nonceMap.set(dealId, next);
    return next;
  }

  public checkAndEmitStage(entry: VaultEntry, termsHashHex: string): { payload: SignedPayloadDto; signatureHex: string } | null {
    const pct = (entry.usedUsd / entry.creditUsd) * 100;
    const lastStage = this.lastStageEmitted.get(entry.dealId) || 0;

    let targetStage = 0;
    if (pct >= 100 && lastStage < 100) targetStage = 100;
    else if (pct >= 75 && lastStage < 75) targetStage = 75;
    else if (pct >= 50 && lastStage < 50) targetStage = 50;
    else if (pct >= 25 && lastStage < 25) targetStage = 25;

    if (targetStage === 0) return null;

    this.lastStageEmitted.set(entry.dealId, targetStage);

    const ONE_NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n;
    const meteredYocto = BigInt(Math.round(entry.usedUsd * 100)) * (ONE_NEAR_YOCTO / 100n);

    const payload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId: entry.dealId,
      termsHash: Buffer.from(termsHashHex, "hex"),
      kind: targetStage === 100 ? PayloadKind.Stage : PayloadKind.Stage,
      stage: targetStage,
      meteredValueYocto: meteredYocto,
      reason: null,
      nonce: this.getNextNonce(entry.dealId),
      issuedAtNs: BigInt(Date.now()) * 1_000_000n,
    };

    const payloadBytes = serializeSignedPayload(payload);
    const signature = enclaveKeys.sign(payloadBytes);

    return {
      payload,
      signatureHex: Buffer.from(signature).toString("hex"),
    };
  }

  public emitDefault(entry: VaultEntry, termsHashHex: string, reason: DefaultReason): { payload: SignedPayloadDto; signatureHex: string } {
    entry.active = false;
    const ONE_NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n;
    const meteredYocto = BigInt(Math.round(entry.usedUsd * 100)) * (ONE_NEAR_YOCTO / 100n);

    const payload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId: entry.dealId,
      termsHash: Buffer.from(termsHashHex, "hex"),
      kind: PayloadKind.Default,
      stage: Math.floor((entry.usedUsd / entry.creditUsd) * 100),
      meteredValueYocto: meteredYocto,
      reason,
      nonce: this.getNextNonce(entry.dealId),
      issuedAtNs: BigInt(Date.now()) * 1_000_000n,
    };

    const payloadBytes = serializeSignedPayload(payload);
    const signature = enclaveKeys.sign(payloadBytes);

    return {
      payload,
      signatureHex: Buffer.from(signature).toString("hex"),
    };
  }
}

export const meterEngine = new MeterEngine();
