"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fingerprint, Lock, MessagesSquare, Send } from "lucide-react";
import { assetAmount, differingFields, ratioOf, sameTerms, usd } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import type { Asset } from "@/lib/types";
import { Button, Card, EmptyState, Field, HashChip, Overline, ProviderLogo, fieldClass } from "./ui";

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
  const ownTerms = deal.role === "buyer" ? deal.buyerTerms : deal.sellerTerms;
  const ownPrice = Number(ownTerms.price) || 0;

  // Calculate dynamic projected lock based on currently edited inputs
  const ownBuyerColPct = Number(ownTerms.buyerCollateralPct) || 0;
  const ownSellerColPct = Number(ownTerms.sellerCollateralPct) || 0;
  const ownColPct = deal.role === "buyer" ? ownBuyerColPct : ownSellerColPct;

  // 100% USDC-Only:
  const ownEffectivePrice = ownPrice;
  const ownProjectedLock = deal.role === "buyer"
    ? ownEffectivePrice * (1 + ownColPct / 100)
    : ownEffectivePrice * (ownColPct / 100);

  const formatLockAmount = (amount: number) => usd(amount);

  // Check if current form terms differ from the locked on-chain deal
  const onChainRefPrice = deal.priceUsd ?? deal.price;
  const termsDifferFromOnChain = Boolean(deal.termsHash) && Math.abs(ownPrice - onChainRefPrice) > 0.0001;

  const matched = Boolean(deal.matched || (deal.buyerSubmitted && deal.sellerSubmitted && fields.length === 0));
  const waiting = deal.buyerSubmitted && deal.sellerSubmitted && !matched && fields.length === 0;
  const mismatch = deal.buyerSubmitted && deal.sellerSubmitted && fields.length > 0;
  const escrow = escrowOf(deal);
  const account = app.account ?? "";
  const formatSettlementAmount = (amount: number) => usd(amount);

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
          <div className="flex items-center gap-2.5">
            <Link
              href={`/deals/${deal.id}`}
              className="text-xs font-semibold text-brand hover:underline flex items-center gap-1"
            >
              ← Deal {deal.id}
            </Link>
            <span className="text-line">|</span>
            <div className="font-semibold">Ticket {deal.id}</div>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted"><Lock className="h-3.5 w-3.5 text-mint" /> Encrypted to the enclave</div>
        </div>
        <div className="flex-1 space-y-3 overflow-auto px-4 py-4">
          {deal.messages.map((message) => {
            const mine = message.sender === account;
            let proposal: any = null;
            if (message.text.startsWith("PROPOSAL:")) {
              try {
                proposal = JSON.parse(message.text.slice(9));
              } catch {}
            }

            return (
              <div key={message.id} className={mine ? "ml-6" : "mr-6"}>
                <div className="mb-1 text-[11px] text-muted">
                  <span className="font-mono font-semibold">{mine ? "You" : message.sender}</span> · {message.time}
                </div>
                {proposal ? (
                  <div className={`rounded-xl border p-3.5 space-y-2.5 text-foreground shadow-sm ${
                    mine ? "border-brand/50 bg-surface-2/70" : "border-mint/50 bg-surface-2"
                  }`}>
                    <div className="flex items-center justify-between border-b border-line/60 pb-2">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-brand">
                        <Fingerprint className="h-4 w-4 text-mint" /> Term Negotiation Proposal
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted">
                        {proposal.token || "USDC"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-surface/80 p-2 border border-line/40">
                        <span className="text-[10px] text-muted block">Proposed Price</span>
                        <div className="flex items-baseline gap-1 mt-0.5">
                          <span className="text-base font-bold tabular text-ink">${proposal.price}</span>
                          <span className="text-[11px] text-brand font-medium">({ratioOf(proposal.price, proposal.credit)})</span>
                        </div>
                      </div>
                      <div className="rounded-lg bg-surface/80 p-2 border border-line/40">
                        <span className="text-[10px] text-muted block">Credit Size</span>
                        <span className="text-base font-bold tabular text-ink mt-0.5 block">${proposal.credit}</span>
                      </div>
                      <div className="rounded-lg bg-surface/80 p-1.5 border border-line/40">
                        <span className="text-[10px] text-muted block">Buyer Collateral</span>
                        <span className="font-semibold tabular text-ink">{proposal.buyerCollateralPct}%</span>
                      </div>
                      <div className="rounded-lg bg-surface/80 p-1.5 border border-line/40">
                        <span className="text-[10px] text-muted block">Seller Collateral</span>
                        <span className="font-semibold tabular text-ink">{proposal.sellerCollateralPct}%</span>
                      </div>
                    </div>

                    {deal.matched || (Number(ownTerms.price) === Number(proposal.price) && fields.length === 0) ? (
                      <div className="rounded-lg bg-mint/10 border border-mint/30 py-1.5 px-3 text-center text-xs font-semibold text-mint flex items-center justify-center gap-1.5">
                        <span>✓ Terms Accepted & Matched in TEE (${proposal.price})</span>
                      </div>
                    ) : !mine ? (
                      <Button
                        size="sm"
                        className="w-full font-semibold shadow-sm"
                        onClick={() => void app.acceptProposal(deal.id, proposal)}
                      >
                        ✓ Accept Proposal (${proposal.price}) & Encrypt to TEE
                      </Button>
                    ) : (
                      <p className="text-[11px] text-muted italic flex items-center gap-1.5 pt-0.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand animate-ping" />
                        You proposed these terms. Awaiting counterparty acceptance.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className={`rounded-lg px-3 py-2 text-sm ${mine ? "bg-brand text-brand-ink" : "border border-line bg-surface-2"}`}>
                    {message.text}
                  </div>
                )}
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
            <div className="flex items-center gap-1.5">
              <ProviderLogo provider={deal.provider} className="h-3.5 w-3.5" />
              <Overline>{deal.provider}</Overline>
            </div>
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
              <select className={fieldClass} value="USDC" disabled>
                <option value="USDC">USDC (Multi-Chain)</option>
              </select>
            </Field>
            <p className="text-xs text-muted">Allowlist: {ownTerms.models.join(", ")}. Deadline {ownTerms.deadline}.</p>
            <p className="text-sm">You lock {formatLockAmount(ownProjectedLock)} if these terms match.</p>
          </div>
          {termsDifferFromOnChain && !matched ? (
            <div className="mt-4 rounded-md border border-brand/30 bg-brand/5 p-3 text-xs text-foreground space-y-2">
              <p className="font-semibold text-brand">💬 Negotiating custom terms (${ownTerms.price})</p>
              <p className="text-muted">
                Deal #{deal.id} was originally minted with ${deal.priceUsd ?? deal.price}. When you and the counterparty accept ${ownTerms.price} in chat, you can create and fund the new on-chain deal on NEAR with 1 click.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => app.updateBuyerTerms(deal.id, {
                    price: deal.priceUsd ?? deal.price,
                    priceUsd: deal.priceUsd ?? deal.price,
                  })}
                >
                  Reset to on-chain Deal #{deal.id} terms
                </Button>
              </div>
            </div>
          ) : null}
          {termsDifferFromOnChain && matched ? (
            <div className="mt-4 rounded-md border border-mint/30 bg-mint/5 p-3 text-xs text-foreground space-y-1.5">
              <p className="font-semibold text-mint flex items-center gap-1.5">
                <span>✓</span> Negotiated terms (${ownTerms.price}) matched in TEE!
              </p>
              <p className="text-muted">
                Both parties have agreed to ${ownTerms.price}. The deal is verified by the Intel TDX enclave and ready to be minted on NEAR.
              </p>
            </div>
          ) : null}
          {waiting ? <p className="mt-4 flex items-center gap-2 text-sm text-blue"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue/30 border-t-blue" /> TEE matching</p> : null}
          {mismatch && !termsDifferFromOnChain ? <p className="mt-4 text-sm text-warning">These fields differ: {fields.join(", ")}. The other side's values stay hidden.</p> : null}
          {matched && deal.termsHash ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-mint"><Fingerprint className="h-4 w-4" /> Terms hash</div>
              <HashChip value={deal.termsHash} onCopy={app.copy} />
              <p className="text-xs text-muted">Both sides submitted the same terms. Nothing else is in the hash.</p>
            </div>
          ) : null}
          <div className="mt-4 flex flex-col gap-2">
            {!matched ? (
              <Button
                variant="primary"
                onClick={() => void app.proposeTerms(deal.id, {
                  price: ownTerms.price,
                  credit: ownTerms.credit,
                  buyerCollateralPct: ownTerms.buyerCollateralPct,
                  sellerCollateralPct: ownTerms.sellerCollateralPct,
                  token: ownTerms.token,
                })}
              >
                Propose Terms in Chat (${ownTerms.price})
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void app.submitNegotiationTerms(deal.id)}>
              {matched ? "Refresh my encrypted terms" : "Submit encrypted terms"}
            </Button>
            {matched && deal.role === "buyer" ? (
              termsDifferFromOnChain ? (
                <Button onClick={async () => {
                  const newId = await app.createNegotiatedDeal(deal.id);
                  if (newId) router.push(`/deals/${newId}`);
                }}>
                  Create Deal at ${ownTerms.price} & Deposit →
                </Button>
              ) : (
                <Button onClick={() => router.push(`/deals/${deal.id}`)}>Accept and deposit</Button>
              )
            ) : null}
            {matched && deal.role === "seller" ? (
              termsDifferFromOnChain ? (
                <div className="rounded-lg border border-mint/30 bg-mint/5 p-3 text-xs text-foreground space-y-1">
                  <p className="font-semibold text-mint flex items-center gap-1.5">
                    <span>✓</span> Terms matched at ${ownTerms.price}!
                  </p>
                  <p className="text-muted">
                    Waiting for buyer ({deal.buyer}) to confirm deal creation on NEAR, then you can deposit your {formatLockAmount(ownProjectedLock)} collateral.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button onClick={() => router.push(`/deals/${deal.id}`)}>Open Deal Dashboard & Deposit →</Button>
                  <p className="text-xs text-muted">Terms matched. Coordinate with the buyer in chat or deposit your collateral.</p>
                </div>
              )
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
