"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { BASE_URL } from "@/lib/chain";
import { clockTime, maskKey, ratioOf, usd } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import { teeApi } from "@/lib/tee-api";
import type { DealStep } from "@/lib/types";
import {
  Button,
  Card,
  Countdown,
  EmptyState,
  EscrowTable,
  HashChip,
  Meter,
  OutcomeBanner,
  Overline,
  SecretKey,
  StageTicks,
  StatusBadge,
  Stepper,
  fieldClass,
  txHref,
} from "./ui";

export function DealView({ id }: { id: string }) {
  const app = useApp();
  const deal = app.deals.find((item) => item.id === id);
  const [view, setView] = useState<DealStep>(deal?.step ?? "negotiate");
  const [key, setKey] = useState("");
  const [snippet, setSnippet] = useState<"curl" | "python" | "node">("curl");
  const [report, setReport] = useState("");

  useEffect(() => {
    if (deal) setView(deal.step);
  }, [deal?.step, deal]);

  useEffect(() => {
    if (!deal?.pulseStage) return;
    const timer = window.setTimeout(() => app.clearPulse(deal.id), 800);
    return () => window.clearTimeout(timer);
  }, [deal?.pulseStage, deal?.id, app]);

  useEffect(() => {
    if (!deal || deal.status !== "Active" || !deal.proxyKey) return;
    return teeApi.openMeterStream(
      Number(deal.id),
      deal.proxyKey,
      (event) => app.applyMeterEvent(deal.id, event),
      (status) => app.setHeartbeat(deal.id, status === "connected" ? "live" : "stale")
    );
  }, [deal?.id, deal?.status, deal?.proxyKey, app.applyMeterEvent, app.setHeartbeat]);

  if (!deal) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="Deal not found." body="Check the id, or switch back to testnet." action={<Button href="/deals">All deals</Button>} />;
  }

  const escrow = escrowOf(deal);
  const depositAmount = deal.role === "buyer" ? escrow.buyerDeposit : escrow.sellerDeposit;
  const myDeposited = deal.role === "buyer" ? deal.buyerDeposited : deal.sellerDeposited;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length < 8) return;
    const submittedKey = key.trim();
    setKey("");
    app.submitSellerKey(deal.id, submittedKey);
  };

  const deposit = () => {
    app.ask({
      title: `Deposit ${usd(depositAmount)} ${deal.token}`,
      body: deal.token === "NEAR"
        ? `This locks ${usd(depositAmount)} NEAR until settlement. Gas is paid in NEAR.`
        : `This locks ${usd(depositAmount)} ${deal.token} with an NEP-141 ft_transfer_call. If the contract is not registered for the token, the wallet will also ask for a storage deposit.`,
      confirm: "Deposit",
      run: () => app.deposit(deal.id),
    });
  };

  const cancel = () => {
    app.ask({
      title: "Cancel this deal",
      body: "Cancellation is only available before the proxy key goes live. Any deposit you made is refunded.",
      confirm: "Cancel deal",
      danger: true,
      run: () => app.cancelDeal(deal.id),
    });
  };

  const fileReport = (event: FormEvent) => {
    event.preventDefault();
    if (!report.trim()) return;
    app.sendMessage(deal.id, `Report: ${report.trim()}`);
    setReport("");
  };

  const shownKey = deal.proxyKey ? maskKey(deal.proxyKey) : "cpk_••••••••";
  const snippets = {
    curl: `curl ${deal.baseUrl || BASE_URL}/chat/completions \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${deal.model}","messages":[{"role":"user","content":"Hello"}]}'`,
    python: `from openai import OpenAI\nclient = OpenAI(base_url="${deal.baseUrl || BASE_URL}", api_key="${shownKey}")\nclient.chat.completions.create(model="${deal.model}", messages=[{"role":"user","content":"Hello"}])`,
    node: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "${deal.baseUrl || BASE_URL}", apiKey: "${shownKey}" });\nawait client.chat.completions.create({ model: "${deal.model}", messages: [{ role: "user", content: "Hello" }] });`,
  };

  const primary = view === "deposit" && !myDeposited
    ? <Button className="w-full" onClick={deposit}>Deposit {usd(depositAmount)} {deal.token}</Button>
    : view === "key" && deal.keyStatus !== "verified"
      ? <Button className="w-full" type="submit" form="seller-key">Activate Deal via TEE</Button>
      : view === "negotiate"
        ? <Button className="w-full" href={`/deals/${deal.id}/ticket`}>Open ticket</Button>
        : null;

  return (
    <div className="space-y-6 pb-24 lg:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deal {deal.id}</h1>
          <p className="mt-1 text-sm text-muted">{deal.provider} {usd(deal.credit)} → {usd(deal.price)} · {ratioOf(deal.price, deal.credit)} · {deal.token}</p>
        </div>
        <StatusBadge status={deal.status} />
      </div>
      <Card>
        <Stepper deal={deal} onPick={setView} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          {view === "negotiate" ? (
            <Card>
              <h2 className="text-lg font-semibold">Negotiate</h2>
              <p className="mt-2 text-sm text-muted">Terms are edited on the private ticket. Both sides submit, then the enclave compares them.</p>
              <Button className="mt-4" href={`/deals/${deal.id}/ticket`}>Open ticket</Button>
            </Card>
          ) : null}
          {view === "terms" ? (
            <Card>
              <h2 className="text-lg font-semibold">Terms hash</h2>
              {deal.termsHash ? (
                <div className="mt-4 space-y-3">
                  <HashChip value={deal.termsHash} onCopy={app.copy} />
                  <p className="text-sm">Buyer accepted. Seller accepted.</p>
                  {deal.steps.terms?.tx ? <a className="text-sm font-semibold text-brand" href={txHref(deal.steps.terms.tx)} target="_blank" rel="noreferrer">accept_deal transaction</a> : null}
                </div>
              ) : <p className="mt-3 text-sm text-muted">The hash appears after both sides submit matching terms.</p>}
            </Card>
          ) : null}
          {view === "deposit" ? (
            <Card>
              <h2 className="text-lg font-semibold">Deposit</h2>
              <p className="mt-2 text-sm text-muted">Token is fixed by the terms. Buyer deposits price plus collateral. Seller deposits collateral.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-line p-3">
                  <Overline>Buyer · {usd(escrow.buyerDeposit)}</Overline>
                  <p className="mt-2 text-sm font-semibold">{deal.buyerDeposited ? "Deposited" : "Waiting"}</p>
                </div>
                <div className="rounded-md border border-line p-3">
                  <Overline>Seller · {usd(escrow.sellerDeposit)}</Overline>
                  <p className="mt-2 text-sm font-semibold">{deal.sellerDeposited ? "Deposited" : "Waiting"}</p>
                </div>
              </div>
              <p className="mt-4 text-sm">Deposit timeout <Countdown until={deal.depositDeadline} /></p>
              {!myDeposited && deal.step !== "settled" ? (
                <Button className="mt-4" onClick={deposit}>
                  {deal.role === "buyer" && !deal.counterpartyAccepted ? `Accept & Deposit ${usd(depositAmount)} ${deal.token}` : `Deposit ${usd(depositAmount)} ${deal.token}`}
                </Button>
              ) : null}
            </Card>
          ) : null}
          {view === "key" ? (
            <Card>
              <h2 className="text-lg font-semibold">Key check</h2>
              {deal.keyStatus !== "verified" ? (
                <form id="seller-key" className="mt-4 space-y-3" onSubmit={submitKey}>
                  <label className="block text-[13px] font-medium text-ink">Provider key
                    <input className={`${fieldClass} mt-1.5 font-mono`} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Sent only to the enclave (e.g. OpenAI / OpenRouter key)" />
                  </label>
                  <p className="text-xs text-muted">This value is sent directly to the hardware enclave to verify quota and activate the proxy key. Not stored in browser or written on-chain.</p>
                  <Button type="submit">Activate Deal via TEE</Button>
                </form>
              ) : <p className="mt-2 text-sm text-muted">The provider key was verified by the TEE and the deal is activated on NEAR.</p>}
              <ul className="mt-4 space-y-2 text-sm">
                {(deal.keyChecks.length ? deal.keyChecks : [{ label: "Waiting for TEE verification", ok: false }]).map((check) => (
                  <li key={check.label} className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${check.ok ? "bg-mint" : "bg-line"}`} />
                    {check.label}
                    {!check.ok && deal.keyStatus === "checking" ? <span className="text-xs text-muted">Checking</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {view === "live" ? (
            <div className="space-y-4">
              <Card>
                <h2 className="text-lg font-semibold">Proxy</h2>
                <div className="mt-4 space-y-3">
                  <div>
                    <Overline>Base URL</Overline>
                    <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[13px]">
                      <span className="truncate">{deal.baseUrl}</span>
                      <button type="button" className="text-xs font-semibold text-brand" onClick={() => app.copy(deal.baseUrl)}>Copy</button>
                    </div>
                  </div>
                  <div>
                    <Overline>API key</Overline>
                    <div className="mt-1">{deal.proxyKey ? <SecretKey value={deal.proxyKey} revoked={deal.proxyRevoked} onCopy={app.copy} /> : <p className="text-sm text-muted">The proxy key appears after the key check.</p>}</div>
                  </div>
                </div>
                <div className="mt-4 flex gap-2 text-sm">
                  {(["curl", "python", "node"] as const).map((tab) => (
                    <button key={tab} type="button" className={`rounded px-2 py-1 font-semibold ${snippet === tab ? "bg-surface-2 text-ink" : "text-muted"}`} onClick={() => setSnippet(tab)}>{tab}</button>
                  ))}
                </div>
                <pre className="mt-2 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-xs leading-5">{snippets[snippet]}</pre>
              </Card>
              <Card>
                <div className="flex items-end justify-between gap-3">
                  <h2 className="text-lg font-semibold">Usage</h2>
                  <span className="text-xs text-muted">Updated {clockTime(deal.lastUpdate)}</span>
                </div>
                <p className="mt-2 text-sm tabular">{usd(deal.usedUsd)} of {usd(deal.credit)} · {(deal.tokens / 1_000_000).toFixed(1)}M tokens</p>
                <div className="mt-3"><Meter used={deal.usedUsd} credit={deal.credit} stage={deal.stage} pulse={deal.pulseStage} /></div>
                <StageTicks price={deal.price} stage={deal.stage} pulse={deal.pulseStage} />
                <p className="mt-3 text-xs text-muted">Next release at {deal.stage >= 100 ? "settlement" : `${deal.stage + 25}% (${usd(deal.price / 4)})`}.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => app.syncMeterState(deal.id)}>Sync meter</Button>
                  <Button onClick={() => app.releaseStagePayout(deal.id)}>Release stage payout</Button>
                </div>
              </Card>
              <Card>
                <h2 className="text-lg font-semibold">Locked prices</h2>
                <table className="mt-3 w-full text-left text-[13px]">
                  <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    <tr><th className="pb-2">Model</th><th className="pb-2 text-right">Input</th><th className="pb-2 text-right">Output</th></tr>
                  </thead>
                  <tbody>
                    {deal.prices.map((row) => (
                      <tr key={row.model} className="border-t border-line"><td className="py-2">{row.model}</td><td className="py-2 text-right tabular">{row.input}</td><td className="py-2 text-right tabular">{row.output}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ) : null}
          {view === "settled" ? (
            <div className="space-y-4">
              <OutcomeBanner deal={deal} />
              <Card>
                <h2 className="text-lg font-semibold">Final split</h2>
                {deal.split ? <EscrowTable deal={deal} /> : <p className="mt-2 text-sm text-muted">Settlement figures appear when the deal closes.</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button href={`/history/${deal.id}`}>Receipt</Button>
                  {app.claims.some((claim) => claim.dealId === deal.id && !claim.claimed) ? <Button variant="secondary" href="/claims" icon={undefined}>Claim</Button> : null}
                </div>
              </Card>
            </div>
          ) : null}
          <Card>
            <h2 className="text-lg font-semibold">Activity</h2>
            <ul className="mt-3 divide-y divide-line">
              {deal.activity.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                  <div>
                    <div className="font-medium">{event.title}</div>
                    <div className="text-muted">{event.detail}</div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    <div>{event.time}</div>
                    {event.tx ? <a className="font-mono text-brand" href={txHref(event.tx)} target="_blank" rel="noreferrer">{event.tx.slice(0, 6)}…{event.tx.slice(-4)}</a> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <aside className="space-y-4 lg:col-span-4">
          <Card>
            <Overline>Escrow</Overline>
            <div className="mt-3"><EscrowTable deal={deal} /></div>
          </Card>
          <Card>
            <Overline>Terms hash</Overline>
            <div className="mt-3">{deal.termsHash ? <HashChip value={deal.termsHash} onCopy={app.copy} /> : <p className="text-sm text-muted">Not matched yet.</p>}</div>
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <Link href="/trust" className="font-semibold text-brand">Contract and enclave</Link>
              <Link href="/governance" className="font-semibold text-brand">DAO</Link>
            </div>
            <form onSubmit={fileReport} className="mt-4 space-y-2">
              <textarea className={`${fieldClass} h-20 py-2`} value={report} placeholder="Report a problem" onChange={(event) => setReport(event.target.value)} />
              <Button type="submit" variant="secondary" className="w-full">Report problem</Button>
            </form>
            {deal.step !== "live" && deal.step !== "settled" ? <Button variant="ghost" className="mt-2 w-full" onClick={cancel}>Cancel</Button> : null}
          </Card>
        </aside>
      </div>
      {primary ? <div className="no-print fixed inset-x-0 bottom-16 z-30 border-t border-line bg-surface/95 p-3 backdrop-blur lg:hidden">{primary}</div> : null}
    </div>
  );
}
