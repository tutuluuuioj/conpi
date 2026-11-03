"use client";

import { HandCoins } from "lucide-react";
import { txHref } from "./ui";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState } from "./ui";

export function ClaimsView() {
  const app = useApp();
  const open = app.claims.filter((claim) => !claim.claimed);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Claims</h1>
          <p className="mt-2 text-sm text-muted">Payouts the contract could not transfer. They stay here until you pull them.</p>
        </div>
        {open.length ? (
          <Button onClick={() => app.ask({
            title: "Claim all payouts",
            body: `This sends ${open.map((claim) => `${claim.amount.toFixed(2)} ${claim.token}`).join(" and ")} to ${app.account}.`,
            confirm: "Claim all",
            run: () => app.claimAll(),
          })}>Claim all</Button>
        ) : null}
      </div>
      {!open.length && app.claims.length ? <p className="text-sm text-muted">Nothing left to claim.</p> : null}
      <div className="space-y-3">
        {app.claims.map((claim) => (
          <Card key={claim.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold tabular">{claim.amount.toFixed(2)} {claim.token}</div>
                <p className="text-sm text-muted">Deal {claim.dealId} · {claim.reason}</p>
                {claim.tx ? <a className="text-xs font-semibold text-mint" href={txHref(claim.tx)} target="_blank" rel="noreferrer">Claimed · view transaction</a> : null}
              </div>
              {claim.claimed ? <span className="text-sm font-semibold text-mint">Paid</span> : (
                <Button onClick={() => app.ask({
                  title: `Claim ${claim.amount.toFixed(2)} ${claim.token}`,
                  body: `Deal ${claim.dealId}. ${claim.reason}. The funds stay in the contract if this transaction fails.`,
                  confirm: "Claim",
                  run: () => app.claimOne(claim.id),
                })}>Claim</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
      {!app.claims.length ? <EmptyState icon={<HandCoins className="h-6 w-6" />} title="Nothing to claim." body="Failed transfers land here." /> : null}
    </div>
  );
}
