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
  const [keyHidden, setKeyHidden] = useState<boolean>(false);
  const [proxyKeyInput, setProxyKeyInput] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined" && deal?.id) {
      const isHidden = localStorage.getItem(`conpi:hide_proxy_key_${deal.id}`) === "true";
      setKeyHidden(isHidden);
    }
  }, [deal?.id]);

  const handleCopyAndHide = (keyToCopy: string) => {
    app.copy(keyToCopy);
    setKeyHidden(true);
    if (typeof window !== "undefined" && deal?.id) {
      localStorage.setItem(`conpi:hide_proxy_key_${deal.id}`, "true");
    }
  };

  const handleRevealKey = () => {
    setKeyHidden(false);
    if (typeof window !== "undefined" && deal?.id) {
      localStorage.removeItem(`conpi:hide_proxy_key_${deal.id}`);
    }
  };

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

  useEffect(() => {
    if (!deal || deal.status !== "Active" || !deal.proxyKey) return;
    app.syncMeterState(deal.id);
    const interval = setInterval(() => {
      app.syncMeterState(deal.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [deal?.id, deal?.status, deal?.proxyKey]);

  if (!deal) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="Deal not found." body="Check the id, or switch back to testnet." action={<Button href="/deals">All deals</Button>} />;
  }

  const escrow = escrowOf(deal);
  const depositAmount = deal.role === "buyer" ? escrow.buyerDeposit : escrow.sellerDeposit;
  const myDeposited = deal.role === "buyer" ? deal.buyerDeposited : deal.sellerDeposited;

  const isNear = deal.token === "NEAR";
  const creditUsd = deal.creditUsd ?? (isNear ? deal.credit * 4.02 : deal.credit);
  const priceUsd = deal.priceUsd ?? (isNear ? deal.price * 4.02 : deal.price);
  const fmtDeposit = isNear ? `${depositAmount.toFixed(4)} NEAR` : usd(depositAmount);
  const pctUsed = creditUsd > 0 ? ((deal.usedUsd / creditUsd) * 100).toFixed(2) : "0.00";
  const tokensText = deal.tokens >= 1_000_000
    ? `${(deal.tokens / 1_000_000).toFixed(2)}M`
    : deal.tokens >= 1_000
      ? `${(deal.tokens / 1_000).toFixed(1)}k`
      : `${deal.tokens}`;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length < 8) return;
    const submittedKey = key.trim();
    setKey("");
    app.submitSellerKey(deal.id, submittedKey);
  };

  const importProxyKey = async (event: FormEvent) => {
    event.preventDefault();
    if (await app.importProxyKey(deal.id, proxyKeyInput)) setProxyKeyInput("");
  };

  const deposit = () => {
    app.ask({
      title: `Deposit ${fmtDeposit}`,
      body: isNear
        ? `This locks ${fmtDeposit} until settlement. Gas is paid in NEAR.`
        : `This locks ${fmtDeposit} with an NEP-141 ft_transfer_call. If the contract is not registered for the token, the wallet will also ask for a storage deposit.`,
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

  const shownKey = deal.proxyKey ? (keyHidden ? "<YOUR_COPIED_KEY>" : deal.proxyKey) : "cpk_••••••••";
  const snippets = {
    curl: `curl ${deal.baseUrl || BASE_URL}/chat/completions \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${deal.model}","messages":[{"role":"user","content":"Hello"}]}'`,
    python: `from openai import OpenAI\nclient = OpenAI(base_url="${deal.baseUrl || BASE_URL}", api_key="${shownKey}")\nclient.chat.completions.create(model="${deal.model}", messages=[{"role":"user","content":"Hello"}])`,
    node: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "${deal.baseUrl || BASE_URL}", apiKey: "${shownKey}" });\nawait client.chat.completions.create({ model: "${deal.model}", messages: [{ role: "user", content: "Hello" }] });`,
  };

  const primary = view === "deposit" && !myDeposited
    ? <Button className="w-full" onClick={deposit}>Deposit {fmtDeposit}</Button>
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
          <p className="mt-1 text-sm text-muted">
            {deal.provider} · {deal.credit} {deal.token} {isNear ? `($${creditUsd.toFixed(4)})` : ""} credit for {deal.price} {deal.token} {isNear ? `($${priceUsd.toFixed(4)})` : ""} · {ratioOf(deal.price, deal.credit)}
          </p>
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
                  <Overline>Buyer · {isNear ? `${escrow.buyerDeposit.toFixed(4)} NEAR` : usd(escrow.buyerDeposit)}</Overline>
                  <p className="mt-2 text-sm font-semibold">{deal.buyerDeposited ? "Deposited" : "Waiting"}</p>
                </div>
                <div className="rounded-md border border-line p-3">
                  <Overline>Seller · {isNear ? `${escrow.sellerDeposit.toFixed(4)} NEAR` : usd(escrow.sellerDeposit)}</Overline>
                  <p className="mt-2 text-sm font-semibold">{deal.sellerDeposited ? "Deposited" : "Waiting"}</p>
                </div>
              </div>
              <p className="mt-4 text-sm">Deposit timeout <Countdown until={deal.depositDeadline} /></p>
              {!myDeposited && deal.step !== "settled" ? (
                <Button className="mt-4" onClick={deposit}>
                  Deposit {fmtDeposit}
                </Button>
              ) : null}
              {!deal.counterpartyAccepted && deal.termsHash ? (
                <div className="mt-4 pt-2 border-t border-line/60">
                  <p className="text-xs text-muted mb-2">Counterparty confirmation needed on-chain:</p>
                  <Button variant="secondary" onClick={() => app.acceptDeal(deal.id)}>
                    Accept Deal Terms on NEAR
                  </Button>
                </div>
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
              {deal.keyStatus === "verified" ? (
                <div className="mt-4">
                  <Button onClick={() => setView("live")}>Go to Live Proxy & Usage</Button>
                </div>
              ) : null}
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
                    <div className="flex items-center justify-between">
                      <Overline>API key</Overline>
                      {deal.proxyKey && keyHidden ? (
                        <button
                          type="button"
                          className="text-xs font-semibold text-brand hover:underline"
                          onClick={handleRevealKey}
                        >
                          Reveal key
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-1">
                      {deal.proxyKey ? (
                        keyHidden ? (
                          <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-mint" />
                              <span className="font-mono text-muted truncate">cpk_live_••••••••••••••••••••••••••••••••</span>
                            </div>
                            <span className="shrink-0 rounded bg-surface px-2 py-0.5 text-[11px] font-medium text-mint">
                              Copied & Hidden from UI
                            </span>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <SecretKey
                                  value={deal.proxyKey}
                                  revoked={deal.proxyRevoked}
                                  onCopy={handleCopyAndHide}
                                />
                              </div>
                              <Button
                                type="button"
                                className="shrink-0 text-xs py-2 px-3 whitespace-nowrap"
                                onClick={() => handleCopyAndHide(deal.proxyKey)}
                              >
                                Copy & Hide Key
                              </Button>
                            </div>
                            <p className="text-[11px] text-muted">
                              Clicking copy will copy the key to your clipboard and remove it from the screen for safety.
                            </p>
                          </div>
                        )
                      ) : (
                        <form className="space-y-2" onSubmit={importProxyKey}>
                          <p className="text-sm text-muted">Paste this deal&apos;s TEE-issued buyer key to authenticate the private live meter.</p>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              className={`${fieldClass} flex-1 font-mono`}
                              type="password"
                              autoComplete="off"
                              placeholder="cpk_live_…"
                              value={proxyKeyInput}
                              onChange={(event) => setProxyKeyInput(event.target.value)}
                            />
                            <Button type="submit">Connect meter</Button>
                          </div>
                        </form>
                      )}
                    </div>
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
                <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm tabular">
                    <span className="font-semibold text-ink">${deal.usedUsd.toFixed(4)}</span>
                    {" "}of{" "}
                    <span className="font-semibold text-ink">${creditUsd.toFixed(4)} USD</span>
                    {isNear ? (
                      <span className="ml-1 text-xs text-muted">({deal.credit} NEAR on-chain)</span>
                    ) : null}
                    {" "}· {tokensText} tokens
                  </p>
                  <span className="text-xs font-semibold tabular text-brand">
                    {pctUsed}% consumed
                  </span>
                </div>
                <div className="mt-3">
                  <Meter used={deal.usedUsd} credit={creditUsd} stage={deal.stage} pulse={deal.pulseStage} />
                </div>
                <StageTicks price={deal.price} priceUsd={priceUsd} token={deal.token} stage={deal.stage} pulse={deal.pulseStage} />
                <p className="mt-3 text-xs text-muted">
                  Next release at {deal.stage >= 100 ? "settlement" : `${deal.stage < 25 ? 25 : deal.stage < 50 ? 50 : deal.stage < 75 ? 75 : 100}% (${(deal.price / 4).toFixed(4)} ${deal.token}${isNear ? ` · $${(priceUsd / 4).toFixed(4)}` : ""})`}.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => app.syncMeterState(deal.id)}>Sync meter</Button>
                  <Button onClick={() => app.releaseStagePayout(deal.id)}>Release stage payout</Button>
                  {deal.status === "Active" ? (
                    <Button variant="ghost" className="text-danger" onClick={() => app.triggerDefaultSettlement(deal.id, "InvalidKey")}>
                      Settle Default & Refund
                    </Button>
                  ) : null}
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
