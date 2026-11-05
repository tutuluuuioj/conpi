import { CONFIG } from "../config.js";
import { nearRelayer } from "../chain/relayer.js";
import { meterEngine } from "../proxy/meter.js";
import { meterEvents } from "../proxy/events.js";
import type { RelayReceipt, VaultEntry } from "../vault/preflight.js";

type RelayKind = RelayReceipt["kind"];
type SignedEnvelope = { payload: any; signatureHex: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String(Object.keys(value as object)[0] || "");
  return String(value || "");
}

/**
 * Serializes every settlement transaction per deal, retries transient RPC
 * failures, and checks chain state before resubmission. This makes relaying
 * safe when an RPC response is lost after a transaction was accepted.
 */
export class SettlementEngine {
  private readonly dealQueues = new Map<number, Promise<unknown>>();
  private readonly pending = new Map<string, Promise<RelayReceipt>>();
  private checkpointTimer: NodeJS.Timeout | null = null;

  public status() {
    return {
      configured: nearRelayer.isConfigured(),
      checkpointIntervalMs: CONFIG.checkpointIntervalMs,
      queuedDeals: this.dealQueues.size,
      pendingPayloads: this.pending.size,
    };
  }

  public start(entries: () => VaultEntry[]): void {
    if (this.checkpointTimer) return;
    this.checkpointTimer = setInterval(() => {
      void this.checkpointActiveDeals(entries()).catch((error) => {
        console.warn("[conpi:checkpoint-loop]", { error: error instanceof Error ? error.message : String(error) });
      });
    }, CONFIG.checkpointIntervalMs);
    this.checkpointTimer.unref?.();
  }

  public stop(): void {
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  public async checkpointActiveDeals(entries: VaultEntry[]): Promise<void> {
    if (!nearRelayer.isConfigured()) return;
    const now = Date.now();
    const eligible = entries.filter((entry) => entry.active && now - entry.lastCheckpointAt >= CONFIG.checkpointIntervalMs);
    await Promise.all(eligible.map((entry) => this.createAndRelayCheckpoint(entry)));
  }

  public async createAndRelayCheckpoint(entry: VaultEntry): Promise<RelayReceipt | null> {
    if (!entry.active) return null;
    const deal = await nearRelayer.getDeal(entry.dealId);
    if (!deal || statusName(deal.status) !== "Active") return null;

    meterEngine.seedNonce(entry.dealId, BigInt(deal.last_nonce || 0));
    meterEngine.seedStage(entry.dealId, Number(deal.stage_reached || 0));
    const signed = meterEngine.emitCheckpoint(entry, entry.termsHashHex);
    entry.signedPayloads.push(signed);
    entry.lastCheckpointAt = Date.now();
    meterEvents.publish(entry, "checkpoint");
    return this.relayCheckpoint(entry, signed);
  }

  public async relayStages(entry: VaultEntry, payloads: SignedEnvelope[]): Promise<RelayReceipt[]> {
    const receipts: RelayReceipt[] = [];
    for (const payload of payloads) receipts.push(await this.relayStage(entry, payload));
    return receipts;
  }

  public relayStage(entry: VaultEntry, signed: SignedEnvelope): Promise<RelayReceipt> {
    return this.enqueue(entry, "stage", signed, () => nearRelayer.submitReleaseStage(
      entry.dealId,
      Number(signed.payload.stage),
      signed.payload,
      signed.signatureHex
    ));
  }

  public relayCheckpoint(entry: VaultEntry, signed: SignedEnvelope): Promise<RelayReceipt> {
    return this.enqueue(entry, "checkpoint", signed, () => nearRelayer.submitCheckpoint(
      entry.dealId,
      signed.payload,
      signed.signatureHex
    ));
  }

  public relayDefault(entry: VaultEntry, signed: SignedEnvelope): Promise<RelayReceipt> {
    return this.enqueue(entry, "default", signed, () => nearRelayer.submitSettleDefault(
      entry.dealId,
      signed.payload,
      signed.signatureHex
    ));
  }

  public async drain(dealId: number): Promise<void> {
    await this.dealQueues.get(dealId);
  }

  public resetForTests(): void {
    this.stop();
    this.dealQueues.clear();
    this.pending.clear();
  }

  private enqueue(
    entry: VaultEntry,
    kind: RelayKind,
    signed: SignedEnvelope,
    submit: () => Promise<{ transactionHash: string; status: any }>
  ): Promise<RelayReceipt> {
    const nonce = String(signed.payload.nonce);
    const key = `${entry.dealId}:${nonce}`;
    const existing = entry.relayReceipts.find((item) => item.kind === kind && item.nonce === nonce);
    if (existing?.state === "applied") return Promise.resolve(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;

    if (!nearRelayer.isConfigured()) {
      return Promise.resolve(this.updateReceipt(entry, kind, nonce, {
        state: "awaiting_credentials",
        attempts: existing?.attempts || 0,
        error: "Relayer credentials are not configured; signed payload remains available for wallet submission",
      }));
    }

    const previous = this.dealQueues.get(entry.dealId) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.submitWithRetry(entry, kind, signed, submit));
    this.dealQueues.set(entry.dealId, task);
    this.pending.set(key, task);
    void task.finally(() => {
      this.pending.delete(key);
      if (this.dealQueues.get(entry.dealId) === task) this.dealQueues.delete(entry.dealId);
    });
    return task;
  }

  private async submitWithRetry(
    entry: VaultEntry,
    kind: RelayKind,
    signed: SignedEnvelope,
    submit: () => Promise<{ transactionHash: string; status: any }>
  ): Promise<RelayReceipt> {
    const nonce = String(signed.payload.nonce);
    this.updateReceipt(entry, kind, nonce, { state: "queued", attempts: 0 });

    for (let attempt = 1; attempt <= CONFIG.relayerMaxAttempts; attempt += 1) {
      if (await this.isAlreadyApplied(entry.dealId, kind, signed.payload)) {
        return this.updateReceipt(entry, kind, nonce, { state: "applied", attempts: attempt - 1, error: undefined });
      }
      try {
        const result = await submit();
        return this.updateReceipt(entry, kind, nonce, {
          state: "applied",
          attempts: attempt,
          transactionHash: result.transactionHash,
          error: undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (await this.isAlreadyApplied(entry.dealId, kind, signed.payload)) {
          return this.updateReceipt(entry, kind, nonce, { state: "applied", attempts: attempt, error: undefined });
        }
        if (attempt === CONFIG.relayerMaxAttempts) {
          console.warn("[conpi:relay-failed]", { dealId: entry.dealId, kind, nonce, attempts: attempt, error: message });
          return this.updateReceipt(entry, kind, nonce, { state: "failed", attempts: attempt, error: message });
        }
        this.updateReceipt(entry, kind, nonce, { state: "submitted", attempts: attempt, error: message });
        await delay(Math.min(10_000, CONFIG.relayerRetryBaseMs * 2 ** (attempt - 1)));
      }
    }

    return this.updateReceipt(entry, kind, nonce, { state: "failed", attempts: CONFIG.relayerMaxAttempts, error: "Retry loop exhausted" });
  }

  private async isAlreadyApplied(dealId: number, kind: RelayKind, payload: any): Promise<boolean> {
    try {
      const deal = await nearRelayer.getDeal(dealId);
      if (!deal) return false;
      const state = statusName(deal.status);
      if (kind === "default") return state === "Defaulted";
      if (kind === "stage") {
        return Number(deal.stage_reached || 0) >= Number(payload.stage) || (Number(payload.stage) === 100 && state === "Completed");
      }
      return Number(deal.last_nonce || 0) >= Number(payload.nonce);
    } catch {
      return false;
    }
  }

  private updateReceipt(
    entry: VaultEntry,
    kind: RelayKind,
    nonce: string,
    patch: Pick<RelayReceipt, "state" | "attempts"> & Partial<RelayReceipt>
  ): RelayReceipt {
    let receipt = entry.relayReceipts.find((item) => item.kind === kind && item.nonce === nonce);
    if (!receipt) {
      receipt = { kind, nonce, state: patch.state, attempts: patch.attempts, updatedAt: new Date().toISOString() };
      entry.relayReceipts.push(receipt);
    }
    Object.assign(receipt, patch, { updatedAt: new Date().toISOString() });
    if (patch.error === undefined) delete receipt.error;
    return receipt;
  }
}

export const settlementEngine = new SettlementEngine();
