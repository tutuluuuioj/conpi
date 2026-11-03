"use client";

import { useState } from "react";
import Link from "next/link";
import { Gauge } from "lucide-react";
import { usd } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Meter, Overline } from "./ui";

export function MeterView() {
  const app = useApp();
  const live = app.deals.filter((deal) => deal.status === "Active");
  const [selected, setSelected] = useState(live[0]?.id ?? "1042");
  const deal = app.deals.find((item) => item.id === selected) ?? live[0];
  const usedToday = live.reduce((sum, item) => sum + item.usedUsd, 0);
  const hours = Array.from({ length: 12 }, (_, index) => 8 + ((index * 17 + (deal?.tokens ?? 3)) % 36));
  const max = Math.max(...hours);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Meter</h1>
        <p className="mt-2 text-sm text-muted">Usage across live deals, priced from the locked table.</p>
      </div>
      {live.length === 0 ? (
        <EmptyState icon={<Gauge className="h-6 w-6" />} title="No live deals." body="Your usage shows up here once a deal is active." action={<Button href="/">Browse the market</Button>} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><Overline>Used today</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{usd(usedToday)}</p></Card>
            <Card><Overline>Live deals</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{live.length}</p></Card>
            <Card><Overline>Tokens today</Overline><p className="mt-2 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{(live.reduce((sum, item) => sum + item.tokens, 0) / 1_000_000).toFixed(1)}M</p></Card>
          </div>
          <Card>
            <Overline>Tokens by hour</Overline>
            <div className="mt-4 flex items-end gap-1.5" aria-hidden>
              {hours.map((value, index) => (
                <div key={index} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <div className="flex h-24 w-full items-end">
                    <div className="w-full rounded-sm bg-mint" style={{ height: `${Math.max(6, (value / max) * 100)}%` }} />
                  </div>
                  <span className="text-[10px] text-muted">{index + 8}</span>
                </div>
              ))}
            </div>
          </Card>
          <div className="space-y-3">
            {live.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelected(item.id)} className="block w-full text-left">
                <Card interactive className={item.id === deal?.id ? "border-brand/40" : ""}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">Deal {item.id} · {item.provider}</div>
                      <div className="text-xs text-muted">{usd(item.usedUsd)} used · stage {item.stage}% · checkpoint {item.lastCheckpoint}</div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold">
                      <span className={`h-2 w-2 rounded-full ${item.heartbeat === "live" ? "bg-mint pulse-dot" : "bg-warning"}`} />
                      {item.heartbeat === "live" ? "Live" : "No heartbeat"}
                    </span>
                  </div>
                  <div className="mt-3"><Meter used={item.usedUsd} credit={item.credit} stage={item.stage} compact /></div>
                </Card>
              </button>
            ))}
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
        <Overline>Testnet tools</Overline>
        <p className="mt-2 text-sm text-muted">These actions stay on testnet builds. They update the local deal the way the enclave would.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!deal || deal.status !== "Active"} onClick={() => deal && app.simulateUsage(deal.id)}>Simulate requests</Button>
          <Button variant="danger" disabled={!deal || deal.status !== "Active"} onClick={() => deal && app.simulateRevoke(deal.id)}>Simulate seller revoke</Button>
          <Button variant="secondary" disabled={!deal} onClick={() => deal && app.simulateCounterparty(deal.id)}>Simulate counterparty</Button>
          <Button variant="secondary" disabled={!deal} onClick={() => deal && app.setHeartbeat(deal.id, deal.heartbeat === "live" ? "stale" : "live")}>{deal?.heartbeat === "stale" ? "Restore heartbeat" : "Drop heartbeat"}</Button>
        </div>
      </Card>
    </div>
  );
}
