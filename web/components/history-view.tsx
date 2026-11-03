"use client";

import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { absoluteTime, usd } from "@/lib/format";
import { netFor } from "@/lib/money";
import { useApp } from "@/lib/store";
import { Card, EmptyState, StatusBadge } from "./ui";

export function HistoryView() {
  const app = useApp();
  const deals = [...app.deals].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  if (!deals.length) {
    return <EmptyState icon={<ReceiptText className="h-6 w-6" />} title="No receipts yet." body="Settled deals are listed here." action={null} />;
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Receipts and history</h1>
        <p className="mt-2 text-sm text-muted">Every deal you have touched, with the cash result for your side.</p>
      </div>
      <Card className="hidden p-0 md:block">
        <table className="w-full text-left text-[13px]">
          <thead className="sticky top-16 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            <tr>
              {["Deal", "Role", "Provider", "Credit", "Price", "Outcome", "Net", "Date"].map((head) => (
                <th key={head} className={`px-4 py-3 font-semibold ${head === "Credit" || head === "Price" || head === "Net" ? "text-right" : ""}`}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => {
              const net = netFor(deal);
              return (
                <tr key={deal.id} className="border-t border-line hover:bg-surface-2">
                  <td className="px-4 py-3"><Link className="font-semibold" href={`/history/${deal.id}`}>{deal.id}</Link></td>
                  <td className="px-4 py-3 capitalize">{deal.role}</td>
                  <td className="px-4 py-3">{deal.provider}</td>
                  <td className="px-4 py-3 text-right tabular">{usd(deal.credit)}</td>
                  <td className="px-4 py-3 text-right tabular">{usd(deal.price)}</td>
                  <td className="px-4 py-3"><StatusBadge status={deal.status} /></td>
                  <td className="px-4 py-3 text-right tabular">{net === null ? "Open" : usd(net)}</td>
                  <td className="px-4 py-3 text-muted">{absoluteTime(deal.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <div className="space-y-3 md:hidden">
        {deals.map((deal) => {
          const net = netFor(deal);
          return (
            <Link key={deal.id} href={`/history/${deal.id}`}>
              <Card>
                <div className="flex items-center justify-between"><span className="font-semibold">Deal {deal.id}</span><StatusBadge status={deal.status} /></div>
                <p className="mt-2 text-sm text-muted">{deal.role} · {deal.provider} · {usd(deal.credit)}</p>
                <p className="mt-1 text-sm tabular">{net === null ? "Open" : `Net ${usd(net)}`}</p>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
