import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";
import type { LockedPricingTable } from "../proxy/pricing.js";

export type UsageCostSource =
  | "openrouter_usage"
  | "openrouter_generation"
  | "locked_pricing"
  | "locked_pricing_tokenizer"
  | "locked_pricing_reserved";

export interface UsageReceipt {
  sequence: number;
  generationId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  requestFeeUsd?: number;
  costUsd: number;
  cumulativeUsedUsd: number;
  source: UsageCostSource;
  createdAt: string;
  previousHash: string | null;
  hash: string;
  signatureHex: string;
}

export interface PendingUsage {
  generationId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  providerCost: number | null;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface PersistedMeteringState {
  version: 1;
  dealId: number;
  termsHashHex: string;
  pricingSnapshotHash: string;
  usedUsd: number;
  tokensTotal: number;
  lockedPricing: LockedPricingTable;
  usageReceipts: UsageReceipt[];
  processedGenerationIds: string[];
  pendingUsage: PendingUsage | null;
  updatedAt: string;
}

export interface MeteringStateSource {
  dealId: number;
  termsHashHex: string;
  pricingSnapshotHash: string;
  usedUsd: number;
  tokensTotal: number;
  lockedPricing: LockedPricingTable;
  usageReceipts: UsageReceipt[];
  processedGenerationIds: string[];
  pendingUsage: PendingUsage | null;
}

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid persisted ${label}`);
  return parsed;
}

function lockedPricingHash(pricing: LockedPricingTable): string {
  const canonical = Object.keys(pricing).sort().map((model) => ({ model, ...pricing[model] }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function usageReceiptHash(receipt: Omit<UsageReceipt, "hash" | "signatureHex">): string {
  return crypto.createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

class MeteringStateStore {
  private statePath(dealId: number): string {
    return path.join(CONFIG.meteringStateDir, `deal-${dealId}.state`);
  }

  private aad(dealId: number): Buffer {
    return Buffer.from(`conpi:metering-state:v1:${dealId}`, "utf8");
  }

  private ensureDirectory(): void {
    fs.mkdirSync(CONFIG.meteringStateDir, { recursive: true, mode: 0o700 });
  }

  public save(entry: MeteringStateSource): void {
    this.ensureDirectory();
    const state: PersistedMeteringState = {
      version: 1,
      dealId: entry.dealId,
      termsHashHex: entry.termsHashHex,
      pricingSnapshotHash: entry.pricingSnapshotHash,
      usedUsd: entry.usedUsd,
      tokensTotal: entry.tokensTotal,
      lockedPricing: entry.lockedPricing,
      usageReceipts: entry.usageReceipts,
      processedGenerationIds: [...new Set(entry.processedGenerationIds)],
      pendingUsage: entry.pendingUsage,
      updatedAt: new Date().toISOString(),
    };
    const key = enclaveKeys.getStateStorageKeyBytes();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(this.aad(entry.dealId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const destination = this.statePath(entry.dealId);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, envelope, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
    const dirFd = fs.openSync(CONFIG.meteringStateDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }

  public load(dealId: number, termsHashHex: string): PersistedMeteringState | null {
    const filename = this.statePath(dealId);
    if (!fs.existsSync(filename)) return null;
    let state: PersistedMeteringState;
    try {
      const envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (envelope?.version !== 1) throw new Error("unsupported state version");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        enclaveKeys.getStateStorageKeyBytes(),
        Buffer.from(envelope.iv, "base64")
      );
      decipher.setAAD(this.aad(dealId));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      state = JSON.parse(plaintext.toString("utf8"));
    } catch (error: any) {
      throw new Error(`Encrypted metering state for deal #${dealId} failed authentication: ${error.message}`);
    }
    if (state.version !== 1 || state.dealId !== dealId) throw new Error(`Persisted metering state identity mismatch for deal #${dealId}`);
    if (state.termsHashHex !== termsHashHex) throw new Error(`Persisted metering terms mismatch for deal #${dealId}`);
    if (state.pricingSnapshotHash !== lockedPricingHash(state.lockedPricing)) throw new Error(`Persisted pricing snapshot is invalid for deal #${dealId}`);
    finiteNonNegative(state.usedUsd, "used USD");
    finiteNonNegative(state.tokensTotal, "token total");
    if (!Array.isArray(state.usageReceipts) || !Array.isArray(state.processedGenerationIds)) {
      throw new Error(`Persisted metering ledger is malformed for deal #${dealId}`);
    }
    let previousHash: string | null = null;
    const seen = new Set<string>();
    let receiptTokensTotal = 0;
    for (let index = 0; index < state.usageReceipts.length; index += 1) {
      const receipt = state.usageReceipts[index];
      if (receipt.sequence !== index + 1 || receipt.previousHash !== previousHash) {
        throw new Error(`Persisted usage receipt chain is broken for deal #${dealId}`);
      }
      const { hash, signatureHex, ...body } = receipt;
      if (usageReceiptHash(body) !== hash || !enclaveKeys.verify(Buffer.from(hash, "hex"), Buffer.from(signatureHex, "hex"))) {
        throw new Error(`Persisted usage receipt signature is invalid for deal #${dealId}`);
      }
      finiteNonNegative(receipt.inputTokens, "receipt input tokens");
      finiteNonNegative(receipt.outputTokens, "receipt output tokens");
      finiteNonNegative(receipt.cachedTokens, "receipt cached tokens");
      if (receipt.cacheWriteTokens !== undefined) finiteNonNegative(receipt.cacheWriteTokens, "receipt cache write tokens");
      if (receipt.reasoningTokens !== undefined) finiteNonNegative(receipt.reasoningTokens, "receipt reasoning tokens");
      if (receipt.requestFeeUsd !== undefined) finiteNonNegative(receipt.requestFeeUsd, "receipt request fee");
      finiteNonNegative(receipt.costUsd, "receipt cost");
      finiteNonNegative(receipt.cumulativeUsedUsd, "receipt cumulative usage");
      receiptTokensTotal += receipt.inputTokens + receipt.outputTokens;
      if (receipt.generationId) {
        if (seen.has(receipt.generationId)) throw new Error(`Duplicate persisted generation ${receipt.generationId}`);
        seen.add(receipt.generationId);
      }
      previousHash = hash;
    }
    const persistedIds = new Set(state.processedGenerationIds);
    if (
      persistedIds.size !== state.processedGenerationIds.length ||
      persistedIds.size !== seen.size ||
      [...seen].some((id) => !persistedIds.has(id))
    ) {
      throw new Error(`Persisted generation index is inconsistent for deal #${dealId}`);
    }
    const lastCumulative = state.usageReceipts.at(-1)?.cumulativeUsedUsd || 0;
    if (Math.abs(lastCumulative - state.usedUsd) > 1e-12 || receiptTokensTotal !== state.tokensTotal) {
      throw new Error(`Persisted usage totals are inconsistent for deal #${dealId}`);
    }
    if (state.pendingUsage) {
      finiteNonNegative(state.pendingUsage.inputTokens, "pending input tokens");
      finiteNonNegative(state.pendingUsage.outputTokens, "pending output tokens");
      finiteNonNegative(state.pendingUsage.cachedTokens, "pending cached tokens");
      if (state.pendingUsage.cacheWriteTokens !== undefined) finiteNonNegative(state.pendingUsage.cacheWriteTokens, "pending cache write tokens");
      if (state.pendingUsage.reasoningTokens !== undefined) finiteNonNegative(state.pendingUsage.reasoningTokens, "pending reasoning tokens");
      finiteNonNegative(state.pendingUsage.attempts, "pending reconciliation attempts");
      if (state.pendingUsage.providerCost !== null) finiteNonNegative(state.pendingUsage.providerCost, "pending provider cost");
    }
    if (state.pendingUsage?.generationId && persistedIds.has(state.pendingUsage.generationId)) {
      throw new Error(`Persisted pending generation was already recorded for deal #${dealId}`);
    }
    return state;
  }
}

export const meteringStateStore = new MeteringStateStore();
