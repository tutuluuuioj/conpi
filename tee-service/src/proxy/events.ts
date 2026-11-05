import { EventEmitter } from "node:events";
import type { VaultEntry } from "../vault/preflight.js";

export type MeterEventReason = "snapshot" | "usage" | "stage" | "checkpoint" | "default";

export interface MeterEvent {
  type: "meter.update";
  reason: MeterEventReason;
  dealId: number;
  usedUsd: number;
  creditUsd: number;
  priceUsd: number;
  tokensTotal: number;
  percent: number;
  active: boolean;
  stages: number[];
  timestamp: string;
}

class MeterEventHub {
  private readonly emitter = new EventEmitter();

  public snapshot(entry: VaultEntry, reason: MeterEventReason = "snapshot", stages: number[] = []): MeterEvent {
    return {
      type: "meter.update",
      reason,
      dealId: entry.dealId,
      usedUsd: entry.usedUsd,
      creditUsd: entry.creditUsd,
      priceUsd: entry.priceUsd,
      tokensTotal: entry.tokensTotal,
      percent: entry.creditUsd > 0 ? Math.min(100, (entry.usedUsd / entry.creditUsd) * 100) : 0,
      active: entry.active,
      stages,
      timestamp: new Date().toISOString(),
    };
  }

  public publish(entry: VaultEntry, reason: MeterEventReason, stages: number[] = []): MeterEvent {
    const event = this.snapshot(entry, reason, stages);
    this.emitter.emit(String(entry.dealId), event);
    return event;
  }

  public subscribe(dealId: number, listener: (event: MeterEvent) => void): () => void {
    const eventName = String(dealId);
    this.emitter.on(eventName, listener);
    return () => this.emitter.off(eventName, listener);
  }
}

export const meterEvents = new MeterEventHub();
