"use client";

import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { ratioOf, usd } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Meter, StatusBadge } from "./ui";

export function DealsView() {
  const app = useApp();
  const account = app.account?.trim().toLowerCase() || "";
  const deals = app.deals.filter((deal) => !account || deal.buyer.trim().toLowerCase() === account || deal.seller.trim().toLowerCase() === account);
  if (app.isLoadingOnChain && !app.deals.length) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="Loading your on-chain deals…" body="Reading the NEAR Testnet escrow state." />;
  }
  if (!deals.length) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="You have no deals yet." body="Browse the market and open a ticket." action={<div className="flex gap-2"><Button variant="secondary" onClick={() => void app.refreshOnChain()}>Retry</Button><Button href="/">Browse the market</Button></div>} />;
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deals</h1>
        <p className="mt-2 text-sm text-muted">Escrow from negotiation through settlement.</p>
      </div>
      <div className="space-y-3">
        {deals.map((deal) => {
          const isNear = deal.token === "NEAR";
          const creditUsd = deal.creditUsd ?? (isNear ? deal.credit * 4.02 : deal.credit);
          const priceUsd = deal.priceUsd ?? (isNear ? deal.price * 4.02 : deal.price);
          return (
          <Link key={deal.id} href={`/deals/${deal.id}`}>
            <Card interactive className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Deal {deal.id}</span>
                  <StatusBadge status={deal.status} />
                  <span className="text-xs uppercase tracking-[0.08em] text-muted">{deal.role}</span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {deal.provider} · {deal.model} · {isNear ? `${deal.credit.toFixed(4)} NEAR (${usd(creditUsd)})` : usd(deal.credit)} → {isNear ? `${deal.price.toFixed(4)} NEAR (${usd(priceUsd)})` : usd(deal.price)} · {ratioOf(deal.price, deal.credit)}
                </p>
              </div>
              <div className="w-full md:w-56">
                <Meter used={deal.usedUsd} credit={creditUsd} stage={deal.stage} compact />
                <div className="mt-1 text-right text-xs tabular text-muted">{usd(deal.usedUsd)} of {usd(creditUsd)} metered</div>
              </div>
            </Card>
          </Link>
          );
        })}
      </div>
    </div>
  );
}
