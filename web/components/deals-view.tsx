"use client";

import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { ratioOf, usd } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Meter, StatusBadge } from "./ui";

export function DealsView() {
  const app = useApp();
  const deals = app.deals.filter((deal) => !app.account || deal.buyer === app.account || deal.seller === app.account);
  if (!deals.length) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="You have no deals yet." body="Browse the market and open a ticket." action={<Button href="/">Browse the market</Button>} />;
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deals</h1>
        <p className="mt-2 text-sm text-muted">Escrow from negotiation through settlement.</p>
      </div>
      <div className="space-y-3">
        {deals.map((deal) => (
          <Link key={deal.id} href={`/deals/${deal.id}`}>
            <Card interactive className="flex flex-col gap-4 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Deal {deal.id}</span>
                  <StatusBadge status={deal.status} />
                  <span className="text-xs uppercase tracking-[0.08em] text-muted">{deal.role}</span>
                </div>
                <p className="mt-1 text-sm text-muted">{deal.provider} · {deal.model} · {usd(deal.credit)} → {usd(deal.price)} · {ratioOf(deal.price, deal.credit)}</p>
              </div>
              <div className="w-full md:w-56">
                <Meter used={deal.usedUsd} credit={deal.credit} stage={deal.stage} compact />
                <div className="mt-1 text-right text-xs tabular text-muted">{usd(deal.usedUsd)} of {usd(deal.credit)}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
