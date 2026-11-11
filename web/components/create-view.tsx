"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { modelsForProvider } from "@/lib/data";
import { ratioOf, usd } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import type { Asset, Provider } from "@/lib/types";
import { Button, Card, Field, Overline, fieldClass } from "./ui";

const STEPS = ["Credit", "Price", "Review"];
const MIN_CREDIT_USD = 0.05;
const MIN_PRICE_USD = MIN_CREDIT_USD * 0.5;

export function CreateView() {
  const app = useApp();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider>("OpenAI");
  const [models, setModels] = useState<string[]>(["gpt-4o"]);
  const [customModel, setCustomModel] = useState("");
  const [credit, setCredit] = useState(MIN_CREDIT_USD);
  const [price, setPrice] = useState(0.04);
  const [collateral, setCollateral] = useState(20);
  const [token, setToken] = useState<Asset>("USDC");
  const [buyerAccount, setBuyerAccount] = useState("");
  const [error, setError] = useState("");
  const availableModels = modelsForProvider(provider);

  const ratio = credit ? price / credit : 0;
  const escrow = escrowOf({ price, buyerCollateralPct: 10, sellerCollateralPct: collateral, releasedUsd: 0 });

  const sellerAccount = app.account || app.nearAccount || app.evmAccount || app.solanaAccount;

  const toggle = (model: string) => {
    setModels((current) => current.includes(model) ? current.filter((item) => item !== model) : [...current, model]);
  };

  const addCustomModel = () => {
    let model = customModel.trim();
    if (!model) return;
    if (provider === "OpenRouter" && !model.includes("/")) {
      if (model === "claude-sonnet-4-6" || model === "claude-sonnet-4.6") {
        model = "anthropic/claude-sonnet-4.6";
      } else if (model.startsWith("claude-") || model.startsWith("haiku-") || model.startsWith("opus-")) {
        model = `anthropic/${model}`;
      } else if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-")) {
        model = `openai/${model}`;
      } else if (model.startsWith("llama-")) {
        model = `meta-llama/${model}`;
      } else if (model.startsWith("deepseek-")) {
        model = `deepseek/${model}`;
      } else if (model.startsWith("glm-")) {
        model = `z-ai/${model}`;
      }
    }
    setModels((current) => current.includes(model) ? current : [...current, model]);
    setCustomModel("");
  };

  const changeProvider = (nextProvider: Provider) => {
    const nextModels = modelsForProvider(nextProvider);
    setProvider(nextProvider);
    setModels([nextModels[0]]);
    setCustomModel("");
    setError("");
  };

  const next = () => {
    if (step === 0 && (!models.length || credit < MIN_CREDIT_USD || credit > 1000)) {
      setError("Choose at least one model and a credit amount from $0.05 to $1,000.");
      return;
    }
    if (step === 1) {
      if (buyerAccount.trim() && sellerAccount && buyerAccount.trim().toLowerCase() === sellerAccount.toLowerCase()) {
        setError(`Buyer wallet must be different from your connected seller wallet (${sellerAccount}).`);
        return;
      }
      if (ratio < 0.5 || ratio > 1 || collateral < 10 || collateral > 50) {
        setError("Price ratio must sit between 0.50× and 1.00×. Collateral is 10% to 50%.");
        return;
      }
    }
    setError("");
    setStep((value) => Math.min(2, value + 1));
  };

  const sign = () => {
    if (!sellerAccount) {
      app.openConnectModal();
      return;
    }
    const buyerTrimmed = buyerAccount.trim();
    if (buyerTrimmed && buyerTrimmed.toLowerCase() === sellerAccount.toLowerCase()) {
      setError(`Buyer wallet must be different from your connected seller wallet (${sellerAccount}).`);
      setStep(1);
      return;
    }
    const listing = {
      id: `lst-${crypto.randomUUID().slice(0, 6)}`,
      type: "sell" as const,
      provider,
      model: models[0],
      models,
      credit,
      creditUsd: credit,
      price,
      priceUsd: price,
      collateralPct: collateral,
      buyerCollateralPct: 10,
      seller: sellerAccount,
      buyer: buyerTrimmed || undefined,
      reputation: 0,
      tee: true,
      token,
      rateLimit: "60 req/min",
      expectedTest: `One short call on ${models[0]}`,
      createdAt: new Date().toISOString(),
    };
    app.ask({
      title: buyerTrimmed ? "Create Deal on NEAR" : "Publish Public Listing",
      body: buyerTrimmed
        ? `Create direct on-chain deal: ${usd(credit)} of ${provider} credit at ${usd(price)} USDC (${ratioOf(price, credit)}) with buyer ${buyerTrimmed}. Your wallet will open for approval.`
        : `Publish ${usd(credit)} of ${provider} credit at ${usd(price)} USDC on the public Marketplace. You will deposit ${usd(escrow.sellerDeposit)} USDC collateral only after a buyer funds the deal.`,
      confirm: buyerTrimmed ? "Approve in Wallet" : "Publish to Market",
      run: async () => {
        const result: any = await app.createListing(listing);
        if (result.ok) {
          if (result.dealId) router.push(`/deals/${result.dealId}`);
          else if (result.listingId) router.push(`/listings/${result.listingId}`);
          else router.push("/");
        }
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
              <select className={fieldClass} value={provider} onChange={(event) => changeProvider(event.target.value as Provider)}>
                <option>OpenAI</option>
                <option>Anthropic</option>
                <option>OpenRouter</option>
              </select>
            </Field>
            <div>
              <div className="mb-2 text-[13px] font-medium">Models</div>
              <div className="flex flex-wrap gap-2">
                {availableModels.map((model) => (
                  <button key={model} type="button" className={`rounded-sm border px-2 py-1 text-xs font-semibold ${models.includes(model) ? "border-brand bg-brand/10 text-brand" : "border-line text-muted"}`} onClick={() => toggle(model)}>{model}</button>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <input
                  className={`${fieldClass} font-mono`}
                  value={customModel}
                  list={`models-${provider.toLowerCase()}`}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCustomModel();
                    }
                  }}
                  placeholder={provider === "OpenRouter" ? "Exact ID, e.g. google/gemini-2.5-pro" : "Exact provider model ID"}
                />
                <button type="button" className="rounded-sm border border-line px-3 text-sm font-semibold text-ink" onClick={addCustomModel}>Add</button>
                <datalist id={`models-${provider.toLowerCase()}`}>
                  {availableModels.map((model) => <option key={model} value={model} />)}
                </datalist>
              </div>
              <p className="mt-2 text-xs text-muted">
                {provider === "OpenRouter"
                  ? "Any exact OpenRouter model ID can be added. Its live catalogue price is verified and frozen when the deal activates."
                  : `Add an exact ${provider} model ID. The enclave verifies both account access and supported locked pricing before activation.`}
              </p>
            </div>
            <Field
              label="Credit amount"
              hint="USD value of prepaid credit (min $0.05)."
            >
              <input
                className={`${fieldClass} tabular text-right`}
                type="number"
                inputMode="decimal"
                step="any"
                min={MIN_CREDIT_USD}
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
            <Field
              label="Price"
              hint={`Ratio ${ratioOf(price, credit)} (100% USDC).`}
            >
              <input
                className={`${fieldClass} tabular text-right`}
                type="number"
                inputMode="decimal"
                step="any"
                min={MIN_PRICE_USD}
                value={price}
                onChange={(event) => setPrice(Number(event.target.value))}
              />
            </Field>
            <Field label="Seller collateral %" hint="Locked until the deal settles. Returned in full if the credit is delivered.">
              <input className={`${fieldClass} tabular text-right`} type="number" min={10} max={50} value={collateral} onChange={(event) => setCollateral(Number(event.target.value))} />
            </Field>
            <Field label="Accepted token" hint="CONPI runs exclusively on USDC across Base, Solana, and NEAR.">
              <select className={fieldClass} value="USDC" disabled>
                <option value="USDC">USDC (Multi-Chain Maker Vault)</option>
              </select>
            </Field>
            <ul className="rounded-md border border-line bg-surface-2 p-3 text-sm">
              <li className="flex justify-between">
                <span>Buyer pays</span>
                <span className="tabular font-medium text-brand">
                  ${price.toFixed(2)} USDC
                </span>
              </li>
              <li className="mt-1 flex justify-between">
                <span>You lock (Collateral)</span>
                <span className="tabular font-medium text-ink">
                  ${escrow.sellerDeposit.toFixed(2)} USDC
                </span>
              </li>
              <li className="mt-1 flex justify-between font-semibold border-t border-line/60 pt-1">
                <span>Total escrow</span>
                <span className="tabular font-bold text-emerald-400">
                  ${(price + escrow.sellerDeposit).toFixed(2)} USDC
                </span>
              </li>
              <li className="mt-2 border-t border-line/60 pt-2 text-[11px] text-mint flex items-center justify-between">
                <span>● Conpi Maker Vault</span>
                <span className="font-mono font-medium">Multi-Chain (Base · Solana · NEAR)</span>
              </li>
            </ul>
            <div className="border-t border-line/60 pt-3">
              <Field label="Direct counterparty (optional)" hint="Leave blank to list publicly on the Market so ANY buyer can purchase.">
                <input
                  className={fieldClass}
                  placeholder="Optional: leave blank for public marketplace listing"
                  value={buyerAccount}
                  onChange={(event) => setBuyerAccount(event.target.value)}
                />
              </Field>
            </div>
          </div>
        ) : null}
        {step === 2 ? (
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Credit</dt>
              <dd className="text-right font-medium">
                {provider} · {models.join(", ")} · ${credit.toFixed(2)} USD
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Price</dt>
              <dd className="tabular font-medium text-brand">
                ${price.toFixed(2)} USDC · {ratioOf(price, credit)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Collateral</dt>
              <dd className="tabular font-medium">
                {collateral}% · ${escrow.sellerDeposit.toFixed(2)} USDC
              </dd>
            </div>
            <div className="flex justify-between items-center gap-4">
              <dt className="text-muted">Seller</dt>
              {sellerAccount ? (
                <dd className="font-mono text-xs flex items-center gap-2">
                  <span className="rounded bg-surface-2 border border-line px-1.5 py-0.5 text-[10px] uppercase font-semibold text-brand">
                    {app.nearAccount && sellerAccount === app.nearAccount ? "NEAR" : app.evmAccount && sellerAccount === app.evmAccount ? "Base EVM" : app.solanaAccount && sellerAccount === app.solanaAccount ? "Solana" : "Connected"}
                  </span>
                  <span>{sellerAccount}</span>
                </dd>
              ) : (
                <dd className="flex items-center gap-2">
                  <span className="text-amber-400 text-xs font-sans">Wallet not connected</span>
                  <button
                    type="button"
                    onClick={() => app.openConnectModal()}
                    className="rounded bg-brand/10 border border-brand/30 px-2 py-0.5 text-xs font-semibold text-brand hover:bg-brand/20 transition-all"
                  >
                    Connect
                  </button>
                </dd>
              )}
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Target</dt>
              <dd className="font-medium text-mint">
                {buyerAccount.trim() ? `Direct deal with ${buyerAccount.trim()}` : "Public Market Listing (Any buyer)"}
              </dd>
            </div>
          </dl>
        ) : null}
        {step === 2 && !sellerAccount ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <span className="text-base">⚠️</span>
              <span>Connect your wallet (Base EVM, Solana, or NEAR) to publish this listing on the marketplace.</span>
            </div>
            <Button size="sm" onClick={() => app.openConnectModal()}>
              Connect
            </Button>
          </div>
        ) : null}
        {error ? <p className="mt-3 text-xs font-medium text-danger">{error}</p> : null}
        <div className="mt-5 flex justify-between items-center">
          <Button variant="ghost" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>Back</Button>
          {step < 2 ? (
            <Button onClick={next}>Continue</Button>
          ) : !sellerAccount ? (
            <Button onClick={() => app.openConnectModal()}>
              Connect Wallet to Publish
            </Button>
          ) : (
            <Button onClick={sign}>
              {buyerAccount.trim() ? "Create deal on NEAR" : "Publish to Market"}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
