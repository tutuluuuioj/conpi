"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint, Lock, MessagesSquare, Send } from "lucide-react";
import { assetAmount, differingFields, ratioOf, sameTerms, usd } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import type { Asset } from "@/lib/types";
import { Button, Card, EmptyState, Field, HashChip, Overline, fieldClass } from "./ui";

export function TicketView({ id }: { id: string }) {
  const app = useApp();
  const router = useRouter();
  const deal = app.deals.find((item) => item.id === id);
  const [text, setText] = useState("");
  useEffect(() => {
    void app.syncNegotiationTicket(id);
    const interval = window.setInterval(() => void app.syncNegotiationTicket(id), 2_000);
    return () => window.clearInterval(interval);
  }, [id, app.syncNegotiationTicket]);
  if (!deal) {
    return <EmptyState icon={<MessagesSquare className="h-6 w-6" />} title="Ticket not found." body="Open a listing from the market." action={<Button href="/">Browse the market</Button>} />;
  }
  const fields = deal.termDiffFields ?? differingFields(deal.buyerTerms, deal.sellerTerms);
  const matched = Boolean(deal.termsHash);
  const waiting = deal.buyerSubmitted && deal.sellerSubmitted && !deal.termsHash && fields.length === 0;
  const mismatch = deal.buyerSubmitted && deal.sellerSubmitted && fields.length > 0;
  const escrow = escrowOf(deal);
  const account = app.account ?? "";
  const ownTerms = deal.role === "buyer" ? deal.buyerTerms : deal.sellerTerms;
  const formatSettlementAmount = (amount: number) => deal.token === "NEAR" ? assetAmount(amount, "NEAR") : usd(amount);

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    void app.sendMessage(deal.id, text.trim());
    setText("");
  };

  const changed = (key: keyof typeof deal.buyerTerms) => deal.buyerSubmitted && !sameTerms(deal.buyerTerms, deal.sellerTerms) && fields.some((field) => field.toLowerCase().includes(String(key).slice(0, 4)));

  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <Card className="flex h-[520px] flex-col p-0 lg:col-span-7">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="font-semibold">Ticket {deal.id}</div>
          <div className="flex items-center gap-1 text-xs text-muted"><Lock className="h-3.5 w-3.5 text-mint" /> Encrypted to the enclave</div>
        </div>
        <div className="flex-1 space-y-3 overflow-auto px-4 py-4">
          {deal.messages.map((message) => {
            const mine = message.sender === account;
            return (
              <div key={message.id} className={mine ? "ml-8" : "mr-8"}>
                <div className="mb-1 text-[11px] text-muted"><span className="font-mono">{message.sender}</span> · {message.time}</div>
                <div className={`rounded-lg px-3 py-2 text-sm ${mine ? "bg-brand text-brand-ink" : "border border-line bg-surface-2"}`}>{message.text}</div>
              </div>
            );
          })}
        </div>
        <form onSubmit={send} className="flex gap-2 border-t border-line p-3">
          <input className={fieldClass} value={text} placeholder="Propose a change" onChange={(event) => setText(event.target.value)} />
          <Button type="submit" aria-label="Send" icon={<Send className="h-4 w-4" />}>{""}</Button>
        </form>
      </Card>
      <div className="space-y-4 lg:col-span-5">
        <Card>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Proposed terms</h2>
            <Overline>{deal.provider}</Overline>
          </div>
          <div className="mt-4 space-y-3">
            <Field label="Credit" error={changed("credit") ? "This field differs." : undefined}>
              <input className={`${fieldClass} tabular text-right`} type="number" value={ownTerms.credit} onChange={(event) => app.updateBuyerTerms(deal.id, { credit: Number(event.target.value) })} />
            </Field>
            <Field label="Price" hint={ratioOf(ownTerms.price, ownTerms.credit)} error={changed("price") ? "This field differs." : undefined}>
              <input className={`${fieldClass} tabular text-right`} type="number" value={ownTerms.price} onChange={(event) => app.updateBuyerTerms(deal.id, { price: Number(event.target.value) })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Buyer collateral %">
                <input className={`${fieldClass} tabular text-right`} type="number" value={ownTerms.buyerCollateralPct} onChange={(event) => app.updateBuyerTerms(deal.id, { buyerCollateralPct: Number(event.target.value) })} />
              </Field>
              <Field label="Seller collateral %">
                <input className={`${fieldClass} tabular text-right`} type="number" value={ownTerms.sellerCollateralPct} onChange={(event) => app.updateBuyerTerms(deal.id, { sellerCollateralPct: Number(event.target.value) })} />
              </Field>
            </div>
            <Field label="Token">
              <select className={fieldClass} value={ownTerms.token} onChange={(event) => app.updateBuyerTerms(deal.id, { token: event.target.value as Asset })}>
                <option>USDC</option>
                <option>USDT</option>
                <option>NEAR</option>
              </select>
            </Field>
            <p className="text-xs text-muted">Allowlist: {ownTerms.models.join(", ")}. Deadline {ownTerms.deadline}.</p>
            <p className="text-sm">You lock {formatSettlementAmount(deal.role === "buyer" ? escrow.buyerDeposit : escrow.sellerDeposit)} if these terms match.</p>
          </div>
          {waiting ? <p className="mt-4 flex items-center gap-2 text-sm text-blue"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue/30 border-t-blue" /> TEE matching</p> : null}
          {mismatch ? <p className="mt-4 text-sm text-warning">These fields differ: {fields.join(", ")}. The other side's values stay hidden.</p> : null}
          {matched && deal.termsHash ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-mint"><Fingerprint className="h-4 w-4" /> Terms hash</div>
              <HashChip value={deal.termsHash} onCopy={app.copy} />
              <p className="text-xs text-muted">Both sides submitted the same terms. Nothing else is in the hash.</p>
            </div>
          ) : null}
          <div className="mt-4 flex flex-col gap-2">
            <Button variant={matched ? "secondary" : undefined} onClick={() => void app.submitNegotiationTerms(deal.id)}>
              {matched ? "Refresh my encrypted terms" : "Submit encrypted terms"}
            </Button>
            {matched && deal.role === "buyer" ? (
              <Button onClick={() => router.push(`/deals/${deal.id}`)}>Accept and deposit</Button>
            ) : null}
            {matched && deal.role === "seller" ? <p className="text-sm text-muted">Waiting for the buyer to deposit.</p> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
