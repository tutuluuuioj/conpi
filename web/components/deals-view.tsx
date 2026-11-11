"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, MessagesSquare } from "lucide-react";
import { ratioOf, usd } from "@/lib/format";
import { toNearAccountId } from "@/lib/near-account";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Meter, ProviderLogo, StatusBadge } from "./ui";

export function DealsView() {
  const app = useApp();
  const account = app.account?.trim().toLowerCase() || "";
  const [filterMode, setFilterMode] = useState<"mine" | "all">("mine");

  const deals = useMemo(() => {
    let list = app.deals;
    if (account && filterMode === "mine") {
      const nearAccount = toNearAccountId(account);
      list = app.deals.filter(
        (deal) =>
          deal.buyer.trim().toLowerCase() === account ||
          deal.seller.trim().toLowerCase() === account ||
          (nearAccount && (deal.buyer.trim().toLowerCase() === nearAccount || deal.seller.trim().toLowerCase() === nearAccount))
      );
    }
    return [...list].sort((a, b) => Number(b.id) - Number(a.id));
  }, [app.deals, account, filterMode]);

  if (app.isLoadingOnChain && !app.deals.length) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="Loading your on-chain deals…" body="Reading the NEAR Testnet escrow state." />;
  }
  if (!deals.length) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deals</h1>
            <p className="mt-2 text-sm text-muted">Escrow from negotiation through settlement.</p>
          </div>
          {account ? (
            <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setFilterMode("mine")}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${filterMode === "mine" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
              >
                My Deals
              </button>
              <button
                type="button"
                onClick={() => setFilterMode("all")}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${filterMode === "all" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
              >
                All On-Chain ({app.deals.length})
              </button>
            </div>
          ) : null}
        </div>
        <EmptyState
          icon={<ArrowLeftRight className="h-6 w-6" />}
          title={account ? "You have no deals in this view." : "Connect wallet to see your deals."}
          body="Browse the market and open a ticket or switch to All On-Chain."
          action={<div className="flex gap-2"><Button variant="secondary" onClick={() => void app.refreshOnChain()}>Retry</Button><Button href="/">Browse the market</Button></div>}
        />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deals</h1>
          <p className="mt-2 text-sm text-muted">Escrow from negotiation through settlement.</p>
        </div>
        {account ? (
          <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFilterMode("mine")}
              className={`rounded-md px-3 py-1 font-medium transition-colors ${filterMode === "mine" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              My Deals ({app.deals.filter((d) => d.buyer.toLowerCase() === account || d.seller.toLowerCase() === account).length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode("all")}
              className={`rounded-md px-3 py-1 font-medium transition-colors ${filterMode === "all" ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}
            >
              All On-Chain ({app.deals.length})
            </button>
          </div>
        ) : null}
      </div>
      <div className="space-y-3">
        {deals.map((deal) => {
          const creditUsd = deal.creditUsd ?? deal.credit;
          const priceUsd = deal.priceUsd ?? deal.price;
          return (
          <Link key={deal.id} href={`/deals/${deal.id}`}>
            <Card interactive className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Deal {deal.id}</span>
                  <StatusBadge status={deal.status} />
                  <span className="text-xs uppercase tracking-[0.08em] text-muted">{deal.role}</span>
                  <Link
                    href={`/deals/${deal.id}/ticket`}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-muted hover:text-brand hover:border-brand/40 transition-colors"
                  >
                    <MessagesSquare className="h-3 w-3 text-mint" />
                    <span>Chat</span>
                  </Link>
                </div>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                  <ProviderLogo provider={deal.provider} className="h-3.5 w-3.5 shrink-0" />
                  <span>{deal.provider}</span> · <span className="text-foreground font-medium">{deal.model}</span> · {usd(creditUsd)} → {usd(priceUsd)} · {ratioOf(deal.price, deal.credit)}
                </p>
              </div>
              <div className="w-full md:w-56">
                <Meter used={deal.usedUsd} credit={creditUsd} stage={deal.stage} compact />
                <div className="mt-1 text-right text-xs tabular text-muted">{usd(deal.usedUsd)} of {usd(creditUsd)} metered ({deal.stage}%)</div>
              </div>
            </Card>
          </Link>
          );
        })}
      </div>
    </div>
  );
}
