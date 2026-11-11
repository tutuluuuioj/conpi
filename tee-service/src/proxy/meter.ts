import { PayloadKind, DefaultReason, SignedPayloadDto, serializeSignedPayload } from "../crypto/borsh.js";
import { enclaveKeys } from "../crypto/keys.js";
import { CONFIG } from "../config.js";
import type { VaultEntry } from "../vault/preflight.js";
import { foreignVaultManager } from "../chain/foreign-vault.js";
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
  private evmNonceMap = new Map<number, number>();

  public seedNonce(dealId: number, lastAcceptedNonce: bigint | number): void {
    const seed = BigInt(lastAcceptedNonce);
    const current = this.nonceMap.get(dealId) || 0n;
    if (seed > current) this.nonceMap.set(dealId, seed);
  }

  public seedEvmNonce(dealId: number, lastAcceptedEvmNonce: number): void {
    const seed = Number(lastAcceptedEvmNonce);
    const current = this.evmNonceMap.get(dealId) || 0;
    if (seed > current) this.evmNonceMap.set(dealId, seed);
  }

  public seedStage(dealId: number, lastReleasedStage: number): void {
    const stage = Math.max(0, Math.min(100, Math.floor(lastReleasedStage)));
    const current = this.lastStageEmitted.get(dealId) || 0;
    if (stage > current) this.lastStageEmitted.set(dealId, stage);
  }

  public getNextNonce(dealId: number): bigint {
    const current = this.nonceMap.get(dealId) || 0n;
    const next = current + 1n;
    this.nonceMap.set(dealId, next);
    return next;
  }

  public getNextEvmNonce(dealId: number): number {
    const current = this.evmNonceMap.get(dealId) || 0;
    this.evmNonceMap.set(dealId, current + 1);
    return current;
  }

  private meteredValue(entry: VaultEntry): bigint {
    const usedMicro = BigInt(Math.min(
      Math.round(entry.creditUsd * 1_000_000),
      Math.round(entry.usedUsd * 1_000_000)
    ));
    if (entry.creditAmountYocto) {
      const totalCredit = toBigIntYocto(entry.creditAmountYocto);
      const totalMicro = BigInt(Math.max(1, Math.round(entry.creditUsd * 1_000_000)));
      const rawMetered = (usedMicro * totalCredit) / totalMicro;
      return rawMetered > totalCredit ? totalCredit : rawMetered;
    }
    return usedMicro * 1_000_000_000_000_000_000n;
  }

  public reset(dealId?: number): void {
    if (dealId === undefined) {
      this.lastStageEmitted.clear();
      this.nonceMap.clear();
      this.evmNonceMap.clear();
      return;
    }
    this.lastStageEmitted.delete(dealId);
    this.nonceMap.delete(dealId);
    this.evmNonceMap.delete(dealId);
  }

  public checkAndEmitStages(entry: VaultEntry, termsHashHex: string): Array<{ payload: SignedPayloadDto; signatureHex: string }> {
    const pct = (entry.usedUsd / entry.creditUsd) * 100;
    const results: Array<{ payload: SignedPayloadDto; signatureHex: string }> = [];

    const STAGES = [25, 50, 75, 100];
    for (const targetStage of STAGES) {
      const currentLast = this.lastStageEmitted.get(entry.dealId) || 0;
      // 5 basis points (0.05%) completion tolerance: >= 99.95% metered usage triggers 100% stage release
      const stageThreshold = targetStage === 100 ? 99.95 : targetStage;
      if (targetStage > currentLast && pct >= stageThreshold) {
        this.lastStageEmitted.set(entry.dealId, targetStage);

        // Unit scaling: if creditAmountYocto is present, scale to contract's deal.credit_amount
        // Strictly capped at deal.credit_amount (100%) to prevent overspending
        // For 100% stage release, ensure meteredYocto matches 100% of deal credit amount
        const meteredYocto = targetStage === 100 && entry.creditAmountYocto
          ? toBigIntYocto(entry.creditAmountYocto)
          : this.meteredValue(entry);

        let foreignTxSighash: Uint8Array | null = null;
        let foreignTx: { nonce: number; recipient: string; amount: bigint | string; sighashHex: string } | undefined;

        if (entry.foreignDeal) {
          const currentReached = currentLast;
          const expectedForeignPayout =
            ((BigInt(targetStage) * entry.foreignDeal.foreignAmount) / 100n) -
            ((BigInt(currentReached) * entry.foreignDeal.foreignAmount) / 100n);
          const evmNonce = this.getNextEvmNonce(entry.dealId);
          const prepared = foreignVaultManager.buildErc20TransferTx({
            recipient: entry.foreignDeal.sellerAddress as any,
            amountAtomic: expectedForeignPayout,
            nonce: evmNonce,
            tokenAddress: entry.foreignDeal.tokenAddress as any,
          });
          foreignTxSighash = Buffer.from(prepared.sighash.replace(/^0x/, ""), "hex");
          foreignTx = {
            nonce: evmNonce,
            recipient: entry.foreignDeal.sellerAddress,
            amount: expectedForeignPayout,
            sighashHex: prepared.sighash,
          };
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
          issuedAtNs: BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n,
          foreignTxSighash,
        };

        if (foreignTx) {
          (payload as any).foreignTx = foreignTx;
        }

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

  public emitCheckpoint(entry: VaultEntry, termsHashHex: string): { payload: SignedPayloadDto; signatureHex: string } {
    const payload: SignedPayloadDto = {
      domain: "conpi:v1",
      contractId: CONFIG.contractId,
      chainId: CONFIG.networkId,
      dealId: entry.dealId,
      termsHash: Buffer.from(termsHashHex, "hex"),
      kind: PayloadKind.Checkpoint,
      stage: Math.min(100, Math.floor((entry.usedUsd / Math.max(entry.creditUsd, Number.EPSILON)) * 100)),
      meteredValueYocto: this.meteredValue(entry),
      reason: null,
      nonce: this.getNextNonce(entry.dealId),
      issuedAtNs: BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n,
    };
    const signature = enclaveKeys.sign(serializeSignedPayload(payload));
    return { payload, signatureHex: Buffer.from(signature).toString("hex") };
  }

  public emitDefault(entry: VaultEntry, termsHashHex: string, reason: DefaultReason): { payload: SignedPayloadDto; signatureHex: string } {
    if (entry.defaultPayload) return entry.defaultPayload;
    entry.active = false;
    const meteredYocto = this.meteredValue(entry);

    let foreignTxSighash: Uint8Array | null = null;
    let foreignTx: { nonce: number; recipient: string; amount: bigint | string; sighashHex: string } | undefined;

    if (entry.foreignDeal) {
      const totalCredit = entry.creditAmountYocto ? toBigIntYocto(entry.creditAmountYocto) : 0n;
      let fractionBps = 0n;
      if (totalCredit > 0n) {
        fractionBps = (meteredYocto * 10000n) / totalCredit;
        if (fractionBps > 10000n) fractionBps = 10000n;
      }
      const foreignSellerEarned = (fractionBps * entry.foreignDeal.foreignAmount) / 10000n;
      const stageReached = BigInt(this.lastStageEmitted.get(entry.dealId) || 0);
      const foreignAlreadyReleased = (stageReached * entry.foreignDeal.foreignAmount) / 100n;
      const effectiveTaken = foreignSellerEarned > foreignAlreadyReleased ? foreignSellerEarned : foreignAlreadyReleased;
      const buyerForeignRefund = entry.foreignDeal.foreignAmount > effectiveTaken ? entry.foreignDeal.foreignAmount - effectiveTaken : 0n;

      const evmNonce = this.getNextEvmNonce(entry.dealId);
      const prepared = foreignVaultManager.buildErc20TransferTx({
        recipient: entry.foreignDeal.buyerAddress as any,
        amountAtomic: buyerForeignRefund,
        nonce: evmNonce,
        tokenAddress: entry.foreignDeal.tokenAddress as any,
      });
      foreignTxSighash = Buffer.from(prepared.sighash.replace(/^0x/, ""), "hex");
      foreignTx = {
        nonce: evmNonce,
        recipient: entry.foreignDeal.buyerAddress,
        amount: buyerForeignRefund,
        sighashHex: prepared.sighash,
      };
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
      issuedAtNs: BigInt(Math.floor(Date.now() / 1000)) * 1_000_000_000n,
      foreignTxSighash,
    };

    if (foreignTx) {
      (payload as any).foreignTx = foreignTx;
    }

    const payloadBytes = serializeSignedPayload(payload);
    const signature = enclaveKeys.sign(payloadBytes);

    const signed = {
      payload,
      signatureHex: Buffer.from(signature).toString("hex"),
    };
    entry.defaultPayload = signed;
    return signed;
  }
}

export const meterEngine = new MeterEngine();
