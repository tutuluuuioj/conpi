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
  "claude-3-5-sonnet-20241022": { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  "claude-3-5-haiku": { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  "meta-llama/llama-3-70b": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "meta-llama/llama-3.2-1b-instruct": { inputPerMillion: 0.04, outputPerMillion: 0.16 },
  "meta-llama/llama-3.2-1b": { inputPerMillion: 0.04, outputPerMillion: 0.16 },
  "meta-llama/llama-3.2-3b-instruct": { inputPerMillion: 0.06, outputPerMillion: 0.24 },
};

export interface UsageCalculation {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export function toBigIntYocto(val: any): bigint {
  if (typeof val === "bigint") return val;
  if (!val) return 0n;
  const s = String(val).trim();
  if (s.includes("e") || s.includes("E")) {
    const [mantissa, exponent] = s.toLowerCase().split("e");
    const exp = parseInt(exponent, 10);
    const [intPart, decPart = ""] = mantissa.split(".");
    if (exp >= 0) {
      const zerosNeeded = exp - decPart.length;
      if (zerosNeeded >= 0) {
        return BigInt(intPart + decPart + "0".repeat(zerosNeeded));
      } else {
        return BigInt(intPart + decPart.slice(0, exp));
      }
    } else {
      return 0n;
    }
  }
  return BigInt(s.split(".")[0]);
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number, cachedTokens: number = 0): UsageCalculation {
  const rate = PRICING_TABLE[model];
  if (!rate) {
    throw new Error(`Unsupported model for enclave pricing: ${model}. Model must be present in PRICING_TABLE.`);
  }
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

  public checkAndEmitStages(entry: VaultEntry, termsHashHex: string): Array<{ payload: SignedPayloadDto; signatureHex: string }> {
    const pct = (entry.usedUsd / entry.creditUsd) * 100;
    const results: Array<{ payload: SignedPayloadDto; signatureHex: string }> = [];

    const STAGES = [25, 50, 75, 100];
    for (const targetStage of STAGES) {
      const currentLast = this.lastStageEmitted.get(entry.dealId) || 0;
      if (targetStage > currentLast && pct >= targetStage) {
        this.lastStageEmitted.set(entry.dealId, targetStage);

        // Unit scaling: if creditAmountYocto is present, scale to contract's deal.credit_amount
        // Strictly capped at deal.credit_amount (100%) to prevent overspending
        const usedMicro = BigInt(Math.min(
          Math.round(entry.creditUsd * 1_000_000),
          Math.round(entry.usedUsd * 1_000_000)
        ));
        let meteredYocto: bigint;
        if (entry.creditAmountYocto) {
          const totalCredit = toBigIntYocto(entry.creditAmountYocto);
          const totalMicro = BigInt(Math.max(1, Math.round(entry.creditUsd * 1_000_000)));
          const rawMetered = (usedMicro * totalCredit) / totalMicro;
          meteredYocto = rawMetered > totalCredit ? totalCredit : rawMetered;
        } else {
          meteredYocto = usedMicro * 1_000_000_000_000_000_000n;
        }

        const payload: SignedPayloadDto = {
          domain: "conpi:v1",
          contractId: CONFIG.contractId,
          chainId: CONFIG.networkId,
          dealId: entry.dealId,
          termsHash: Buffer.from(termsHashHex, "hex"),
          kind: PayloadKind.Stage,
          stage: targetStage,
          meteredValueYocto: meteredYocto,
          reason: null,
          nonce: this.getNextNonce(entry.dealId),
          issuedAtNs: BigInt(Date.now()) * 1_000_000n,
        };

        const payloadBytes = serializeSignedPayload(payload);
        const signature = enclaveKeys.sign(payloadBytes);
        results.push({
          payload,
          signatureHex: Buffer.from(signature).toString("hex"),
        });
      }
    }

    return results;
  }

  public checkAndEmitStage(entry: VaultEntry, termsHashHex: string): { payload: SignedPayloadDto; signatureHex: string } | null {
    const stages = this.checkAndEmitStages(entry, termsHashHex);
    return stages.length > 0 ? stages[0] : null;
  }

  public emitDefault(entry: VaultEntry, termsHashHex: string, reason: DefaultReason): { payload: SignedPayloadDto; signatureHex: string } {
    entry.active = false;
    const usedMicro = BigInt(Math.min(
      Math.round(entry.creditUsd * 1_000_000),
      Math.round(entry.usedUsd * 1_000_000)
    ));
    let meteredYocto: bigint;
    if (entry.creditAmountYocto) {
      const totalCredit = toBigIntYocto(entry.creditAmountYocto);
      const totalMicro = BigInt(Math.max(1, Math.round(entry.creditUsd * 1_000_000)));
      const rawMetered = (usedMicro * totalCredit) / totalMicro;
      meteredYocto = rawMetered > totalCredit ? totalCredit : rawMetered;
    } else {
      meteredYocto = usedMicro * 1_000_000_000_000_000_000n;
    }

    const payload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId: entry.dealId,
      termsHash: Buffer.from(termsHashHex, "hex"),
      kind: PayloadKind.Default,
      stage: Math.min(100, Math.floor((entry.usedUsd / entry.creditUsd) * 100)),
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
