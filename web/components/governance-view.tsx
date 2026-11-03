"use client";

import { useState } from "react";
import { CONFIG, DAO_ID } from "@/lib/chain";
import { useApp } from "@/lib/store";
import { Badge, Button, Card, Countdown, Overline } from "./ui";

export function GovernanceView() {
  const app = useApp();
  const [open, setOpen] = useState<string | null>("prop-4");
  const member = app.account === "buyer.near";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Governance</h1>
        <p className="mt-2 text-sm text-muted">Owner {DAO_ID}. Threshold 2 of 3. Every admin action waits 5 minutes.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><Overline>Paused</Overline><p className="mt-2 text-lg font-semibold">{app.paused ? "Yes" : "No"}</p></Card>
        <Card><Overline>Min slash bps</Overline><p className="mt-2 text-lg font-semibold tabular">{CONFIG.minSlashBps / 100}%</p></Card>
        <Card><Overline>Timelock delay</Overline><p className="mt-2 text-lg font-semibold tabular">{CONFIG.timelockMinutes} minutes</p></Card>
      </div>
      <Card>
        <h2 className="text-lg font-semibold">Config</h2>
        <dl className="mt-3 grid gap-x-10 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Min slash rate</dt><dd className="tabular">{CONFIG.minSlashBps / 100}%</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Slash on revoke</dt><dd className="tabular">{CONFIG.slashRevokeBps / 100}%</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Provider-ban slash</dt><dd className="tabular">{CONFIG.slashProviderBanBps / 100}%</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Buyer-breach slash</dt><dd className="tabular">{CONFIG.slashBuyerBreachBps / 100}%</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">TEE liveness</dt><dd className="tabular">{CONFIG.teeLivenessSec / 3600} hour</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Auto-release notice</dt><dd className="tabular">{CONFIG.noticeHours} hours</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Deposit window</dt><dd className="tabular">{CONFIG.minDeposit} to {CONFIG.maxDeposit}</dd></div>
          <div className="flex justify-between gap-4 border-b border-line py-2"><dt className="text-muted">Storage deposit</dt><dd className="tabular">{CONFIG.storageDeposit}</dd></div>
        </dl>
      </Card>
      <div className="space-y-3">
        {app.proposals.map((proposal) => (
          <Card key={proposal.id}>
            <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(open === proposal.id ? null : proposal.id)}>
              <div>
                <div className="font-semibold">{proposal.action}</div>
                <p className="mt-1 text-sm text-muted">{proposal.proposer} · {proposal.confirmations} of {proposal.threshold}</p>
              </div>
              <Badge tone={proposal.status === "Ready" ? "mint" : proposal.status === "Executed" ? "info" : proposal.status === "Cancelled" ? "neutral" : "warning"}>{proposal.status}</Badge>
            </button>
            <p className="mt-3 text-sm text-muted">Executable <Countdown until={proposal.executableAt} /></p>
            {open === proposal.id ? (
              <div className="mt-4 border-t border-line pt-4">
                <table className="w-full text-left text-[13px]">
                  <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted"><tr><th className="pb-2">Field</th><th className="pb-2">From</th><th className="pb-2">To</th></tr></thead>
                  <tbody>
                    {proposal.diff.map((row) => (
                      <tr key={row.field} className="border-t border-line"><td className="py-2 font-mono">{row.field}</td><td className="py-2">{row.from}</td><td className="py-2">{row.to}</td></tr>
                    ))}
                  </tbody>
                </table>
                {member && proposal.status !== "Executed" ? (
                  <div className="mt-4 flex gap-2">
                    <Button variant="secondary" disabled={proposal.confirmedByMe} onClick={() => app.confirmProposal(proposal.id)}>Confirm</Button>
                    <Button disabled={proposal.status !== "Ready"} onClick={() => app.ask({
                      title: "Execute proposal",
                      body: `${proposal.action}. This runs the diff above on the contract.`,
                      confirm: "Execute",
                      run: () => app.executeProposal(proposal.id),
                    })}>Execute</Button>
                  </div>
                ) : <p className="mt-3 text-xs text-muted">Read only unless your wallet is a signer.</p>}
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}
