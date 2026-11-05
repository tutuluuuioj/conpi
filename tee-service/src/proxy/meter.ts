import { PayloadKind, DefaultReason, SignedPayloadDto, serializeSignedPayload } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";
import type { VaultEntry } from "../vault/preflight.js";
export { calculateCost, PRICING_TABLE } from "./pricing.js";

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

export class MeterEngine {
  private lastStageEmitted = new Map<number, number>();
  private nonceMap = new Map<number, bigint>();

  public getNextNonce(dealId: number): bigint {
    const current = this.nonceMap.get(dealId) || 1n;
    const next = current + 1n;
    this.nonceMap.set(dealId, next);
    return next;
  }

  public reset(dealId?: number): void {
    if (dealId === undefined) {
      this.lastStageEmitted.clear();
      this.nonceMap.clear();
      return;
    }
    this.lastStageEmitted.delete(dealId);
    this.nonceMap.delete(dealId);
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
