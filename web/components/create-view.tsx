"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODELS } from "@/lib/data";
import { ratioOf, usd } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import type { Asset, Provider } from "@/lib/types";
import { Button, Card, Field, Overline, fieldClass } from "./ui";

const STEPS = ["Credit", "Price", "Review"];

export function CreateView() {
  const app = useApp();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider>("OpenAI");
  const [models, setModels] = useState<string[]>(["gpt-4o"]);
  const [credit, setCredit] = useState(0.1);
  const [price, setPrice] = useState(0.08);
  const [collateral, setCollateral] = useState(20);
  const [token, setToken] = useState<Asset>(app.defaultToken);
  const [error, setError] = useState("");

  const ratio = credit ? price / credit : 0;
  const escrow = escrowOf({ price, buyerCollateralPct: 10, sellerCollateralPct: collateral, releasedUsd: 0 });

  const toggle = (model: string) => {
    setModels((current) => current.includes(model) ? current.filter((item) => item !== model) : [...current, model]);
  };

  const next = () => {
    if (step === 0 && (!models.length || credit < 0.1 || credit > 1000)) {
      setError("Choose at least one model and a credit amount from $0.10 to $1,000.");
      return;
    }
    if (step === 1 && (ratio < 0.5 || ratio > 1 || collateral < 10 || collateral > 50)) {
      setError("Price ratio must sit between 0.50× and 1.00×. Collateral is 10% to 50%.");
      return;
    }
    setError("");
    setStep((value) => Math.min(2, value + 1));
  };

  const sign = () => {
    if (!app.account) return;
    const listing = {
      id: `lst-${crypto.randomUUID().slice(0, 6)}`,
      type: "sell" as const,
      provider,
      model: models[0],
      models,
      credit,
      price,
      collateralPct: collateral,
      buyerCollateralPct: 10,
      seller: app.account,
      reputation: 0,
      tee: true,
      token,
      rateLimit: "60 req/min",
      expectedTest: `One short call on ${models[0]}`,
      createdAt: new Date().toISOString(),
    };
    app.ask({
      title: "Sign listing",
      body: `Publish ${usd(credit)} of ${provider} credit at ${usd(price)} (${ratioOf(price, credit)}). You will deposit ${usd(escrow.sellerCollateral)} ${token} only after a buyer funds the deal. The provider key is not part of this signature.`,
      confirm: "Sign",
      run: async () => {
        const result = await app.createListing(listing);
        if (result.ok) router.push("/");
        return result;
      },
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Overline>Create listing</Overline>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">List unused API credit</h1>
        <p className="mt-2 text-sm text-muted">Three steps. The provider key is asked only after a deposit, and only by the enclave.</p>
      </div>
      <ol className="flex gap-4 text-sm">
        {STEPS.map((label, index) => (
          <li key={label} className={index === step ? "font-semibold text-ink" : index < step ? "text-mint" : "text-muted"}>{index + 1}. {label}</li>
        ))}
      </ol>
      <Card>
        {step === 0 ? (
          <div className="space-y-4">
            <Field label="Provider">
              <select className={fieldClass} value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
                <option>OpenAI</option>
                <option>Anthropic</option>
                <option>OpenRouter</option>
              </select>
            </Field>
            <div>
              <div className="mb-2 text-[13px] font-medium">Models</div>
              <div className="flex flex-wrap gap-2">
                {MODELS.map((model) => (
                  <button key={model} type="button" className={`rounded-sm border px-2 py-1 text-xs font-semibold ${models.includes(model) ? "border-brand bg-brand/10 text-brand" : "border-line text-muted"}`} onClick={() => toggle(model)}>{model}</button>
                ))}
              </div>
            </div>
            <Field label="Credit amount" hint="USD value of prepaid credit (min $0.10).">
              <input
                className={`${fieldClass} tabular text-right`}
                type="number"
                inputMode="decimal"
                step="any"
                min={0.1}
                max={1000}
                value={credit}
                onChange={(event) => {
                  const val = Number(event.target.value);
                  setCredit(val);
                  if (price > val || price < val * 0.5) {
                    setPrice(Math.round(val * 0.8 * 100) / 100);
                  }
                }}
              />
            </Field>
          </div>
        ) : null}
        {step === 1 ? (
          <div className="space-y-4">
            <Field label="Price" hint={`Ratio ${ratioOf(price, credit)}.`}>
              <input
                className={`${fieldClass} tabular text-right`}
                type="number"
                inputMode="decimal"
                step="any"
                min={0.05}
                value={price}
                onChange={(event) => setPrice(Number(event.target.value))}
              />
            </Field>
            <Field label="Seller collateral %" hint="Locked until the deal settles. Returned in full if the credit is delivered.">
              <input className={`${fieldClass} tabular text-right`} type="number" min={10} max={50} value={collateral} onChange={(event) => setCollateral(Number(event.target.value))} />
            </Field>
            <Field label="Accepted token">
              <select className={fieldClass} value={token} onChange={(event) => setToken(event.target.value as Asset)}>
                <option>USDC</option>
                <option>USDT</option>
                <option>NEAR</option>
              </select>
            </Field>
            <ul className="rounded-md border border-line bg-surface-2 p-3 text-sm">
              <li className="flex justify-between"><span>Buyer pays</span><span className="tabular">{usd(escrow.buyerDeposit)}</span></li>
              <li className="mt-1 flex justify-between"><span>You lock</span><span className="tabular">{usd(escrow.sellerDeposit)}</span></li>
              <li className="mt-1 flex justify-between font-semibold"><span>Total escrow</span><span className="tabular">{usd(escrow.total)}</span></li>
            </ul>
          </div>
        ) : null}
        {step === 2 ? (
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Credit</dt><dd className="text-right">{provider} · {models.join(", ")} · {usd(credit)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Price</dt><dd className="tabular">{usd(price)} · {ratioOf(price, credit)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Collateral</dt><dd className="tabular">{collateral}% · {usd(escrow.sellerDeposit)} {token}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Seller</dt><dd className="font-mono">{app.account}</dd></div>
          </dl>
        ) : null}
        {error ? <p className="mt-3 text-xs font-medium text-danger">{error}</p> : null}
        <div className="mt-5 flex justify-between">
          <Button variant="ghost" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>Back</Button>
          {step < 2 ? <Button onClick={next}>Continue</Button> : <Button onClick={sign} disabled={!app.account}>Sign listing</Button>}
        </div>
      </Card>
    </div>
  );
}
