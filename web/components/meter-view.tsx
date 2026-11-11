"use client";

import { useState } from "react";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { usd } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Meter, Overline } from "./ui";

export function MeterView() {
  const app = useApp();
  const account = app.account?.trim().toLowerCase() || "";

  // Show active deals belonging to the current user (or all if not signed in)
  const userDeals = account
    ? app.deals.filter((deal) => deal.buyer.trim().toLowerCase() === account || deal.seller.trim().toLowerCase() === account)
    : app.deals;
  const live = userDeals
    .filter((deal) => deal.status === "Active")
    .sort((a, b) => Number(b.id) - Number(a.id));

  const [selected, setSelected] = useState<string>("");
  const activeSelectedId = selected && live.some((d) => d.id === selected) ? selected : (live[0]?.id ?? "");
  const deal = live.find((item) => item.id === activeSelectedId) ?? live[0];
  const usedToday = live.reduce((sum, item) => sum + (Number(item.usedUsd) || 0), 0);
  const totalTokens = live.reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);

  const hasTokens = Boolean(deal && deal.tokens > 0);
  const hours = Array.from({ length: 12 }, (_, index) => {
    if (!hasTokens || !deal) return 0;
    return Math.round((deal.tokens / 12) * (0.8 + ((index * 13) % 5) * 0.1));
  });
  const max = Math.max(1, ...hours);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Meter</h1>
        <p className="mt-2 text-sm text-muted">Usage across your live deals, priced from the locked table.</p>
      </div>
      {live.length === 0 ? (
        <EmptyState
          icon={<Gauge className="h-6 w-6" />}
          title="No live deals."
          body={account ? "You currently have no active running deals on-chain." : "Connect your wallet or browse the marketplace to start a deal."}
          action={<Button href="/">Browse the market</Button>}
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><Overline>Used today</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{usd(usedToday)}</p></Card>
            <Card><Overline>Live deals</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{live.length}</p></Card>
            <Card><Overline>Tokens today</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{(totalTokens / 1_000_000).toFixed(2)}M</p></Card>
          </div>
          <Card>
            <Overline>Tokens by hour</Overline>
            <div className="mt-4 flex items-end gap-1.5" aria-hidden>
              {hours.map((value, index) => (
                <div key={index} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div className="flex h-24 w-full items-end">
                    <div
                      className="w-full rounded-sm bg-mint transition-all"
                      style={{ height: hasTokens ? `${Math.max(6, (value / max) * 100)}%` : "4px" }}
                    />
                  </div>
                  <span className="text-[10px] text-muted">{index + 8}</span>
                </div>
              ))}
            </div>
          </Card>
          <div className="space-y-3">
            {live.map((item) => {
              const creditVal = item.creditUsd || item.credit;
              const isSelected = item.id === deal?.id;
              return (
                <button key={item.id} type="button" onClick={() => setSelected(item.id)} className="block w-full text-left">
                  <Card interactive className={isSelected ? "border-brand/40 ring-1 ring-brand/30" : ""}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold">Deal {item.id} · {item.provider} <span className="text-xs font-normal text-muted">({item.model})</span></div>
                        <div className="text-xs text-muted">{usd(item.usedUsd)} used · stage {item.stage}% · checkpoint {item.lastCheckpoint}</div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold">
                        <span className={`h-2 w-2 rounded-full ${item.heartbeat === "live" ? "bg-mint pulse-dot" : "bg-warning"}`} />
                        {item.heartbeat === "live" ? "Live" : "Idle"}
                      </span>
                    </div>
                    <div className="mt-3"><Meter used={item.usedUsd} credit={creditVal} stage={item.stage} compact /></div>
                  </Card>
                </button>
              );
            })}
          </div>
          <Card>
            <h2 className="text-lg font-semibold">Per model</h2>
            <table className="mt-3 w-full text-left text-[13px]">
              <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted"><tr><th className="pb-2">Model</th><th className="pb-2 text-right">Input</th><th className="pb-2 text-right">Output</th></tr></thead>
              <tbody>
                {(deal?.prices ?? []).map((row) => (
                  <tr key={row.model} className="border-t border-line"><td className="py-2">{row.model}</td><td className="py-2 text-right tabular">{row.input}</td><td className="py-2 text-right tabular">{row.output}</td></tr>
                ))}
              </tbody>
            </table>
            {deal ? <Link href={`/deals/${deal.id}`} className="mt-3 inline-block text-sm font-semibold text-brand">Open deal {deal.id}</Link> : null}
          </Card>
        </>
      )}

      <Card>
        <Overline>TEE Payout & Default Controls</Overline>
        <p className="mt-2 text-sm text-muted">
          Execute real on-chain stage releases or trigger default settlement using payloads signed by the Phala Intel TDX enclave.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={!deal || deal.status !== "Active"}
            onClick={() => deal && app.releaseStagePayout(deal.id)}
          >
            Release Stage Payout (TEE Signed)
          </Button>
          <Button
            variant="danger"
            disabled={!deal || (deal.status !== "Active" && deal.status !== "Funded")}
            onClick={() => deal && app.triggerDefaultSettlement(deal.id, "SellerSelfDrain")}
          >
            Trigger Default Settlement (TEE Signed)
          </Button>
          <Button
            variant="secondary"
            disabled={!deal}
            onClick={() => deal && app.syncMeterState(deal.id)}
          >
            Sync TEE Meter State
          </Button>
        </div>
      </Card>
    </div>
  );
}
