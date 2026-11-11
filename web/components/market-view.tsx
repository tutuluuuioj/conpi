"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SlidersHorizontal, Store } from "lucide-react";
import { MODELS } from "@/lib/data";
import { ratioOf, usd, middle } from "@/lib/format";
import { marketOpenEscrow, useApp } from "@/lib/store";
import type { Listing, Provider } from "@/lib/types";

import { Badge, Button, Card, DualRange, EmptyState, Modal, ProviderLogo, SingleRange, fieldClass } from "./ui";

const PROVIDERS: Provider[] = ["OpenAI", "Anthropic", "OpenRouter"];

function readFilters(params: URLSearchParams) {
  const providers = (params.get("provider") ?? "").split(",").filter(Boolean) as Provider[];
  return {
    side: params.get("side") === "buy" ? "buy" : "sell",
    providers,
    model: params.get("model") ?? "",
    creditMin: Number(params.get("cmin") ?? 0),
    creditMax: Number(params.get("cmax") ?? 1000),
    ratio: Number(params.get("ratio") ?? 1),
    token: params.get("token") ?? "",
    sort: params.get("sort") ?? "newest",
  };
}

export function MarketSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-64 rounded-lg" />)}
    </div>
  );
}

export function MarketView() {
  const params = useSearchParams();
  const router = useRouter();
  const app = useApp();
  const filters = readFilters(params);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(6);
  const [modelQuery, setModelQuery] = useState(filters.model);

  const write = (next: Partial<ReturnType<typeof readFilters>>) => {
    const value = { ...filters, ...next };
    const query = new URLSearchParams();
    if (value.side === "buy") query.set("side", "buy");
    if (value.providers.length) query.set("provider", value.providers.join(","));
    if (value.model) query.set("model", value.model);
    if (value.creditMin > 0) query.set("cmin", String(value.creditMin));
    if (value.creditMax !== 1000) query.set("cmax", String(value.creditMax));
    if (value.ratio < 1) query.set("ratio", String(value.ratio));
    if (value.token) query.set("token", value.token);
    if (value.sort !== "ratio") query.set("sort", value.sort);
    const text = query.toString();
    router.replace(text ? `/?${text}` : "/", { scroll: false });
    setShown(6);
  };

  const sellCount = app.listings.filter((listing) => listing.type === "sell").length;
  const buyCount = app.listings.length - sellCount;

  const filtered = useMemo(() => {
    const rows = app.listings.filter((listing) => {
      if (listing.published === false || listing.dealId) return false;
      if (listing.type !== filters.side) return false;
      if (filters.providers.length && !filters.providers.includes(listing.provider)) return false;
      if (filters.model && !listing.models.some((model) => model.toLowerCase().includes(filters.model.toLowerCase())) && listing.model !== filters.model) return false;
      if (listing.credit < filters.creditMin || listing.credit > filters.creditMax) return false;
      if (listing.price / listing.credit > filters.ratio + 0.0001) return false;
      if (filters.token && listing.token !== filters.token) return false;
      return true;
    });
    rows.sort((a, b) => {
      if (filters.sort === "newest") return +new Date(b.createdAt) - +new Date(a.createdAt);
      if (filters.sort === "largest") return b.credit - a.credit;
      if (filters.sort === "reputation") return b.reputation - a.reputation;
      return a.price / a.credit - b.price / b.credit;
    });
    return rows;
  }, [app.listings, filters]);

  const visible = filtered.slice(0, shown);
  const medians = PROVIDERS.map((provider) => {
    const rows = app.deals.filter((d) => d.provider === provider && d.credit > 0 && d.price > 0);
    const source = rows.length > 0 ? rows : app.listings.filter((l) => l.provider === provider && l.credit > 0 && l.price > 0);
    if (!source.length) return null;
    const ratios = source.map((item) => item.price / item.credit).filter((r) => r > 0 && isFinite(r)).sort((a, b) => a - b);
    if (!ratios.length) return null;
    const mid = ratios[Math.floor(ratios.length / 2)];
    return `${provider} ${mid.toFixed(2)}×`;
  }).filter(Boolean);

  const quick = async (listing: Listing) => {
    if (!app.account) return;
    const id = await app.openTicket(listing.id);
    if (id) router.push(`/deals/${id}/ticket`);
  };

  const controls = (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {PROVIDERS.map((provider) => {
          const on = filters.providers.includes(provider);
          return (
            <button
              key={provider}
              type="button"
              className={`focus-ring inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs font-semibold transition-colors ${
                on ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-ink hover:border-line-hover"
              }`}
              onClick={() => write({ providers: on ? filters.providers.filter((item) => item !== provider) : [...filters.providers, provider] })}
            >
              <ProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />
              <span>{provider}</span>
            </button>
          );
        })}
      </div>
      <label className="block text-[13px] font-medium">
        Model
        <input className={`${fieldClass} mt-1.5`} value={modelQuery} placeholder="Search models" onChange={(event) => { setModelQuery(event.target.value); write({ model: event.target.value }); }} list="models" />
        <datalist id="models">{MODELS.map((model) => <option key={model} value={model} />)}</datalist>
      </label>
      <div>
        <div className="mb-1 text-[13px] font-medium">Credit size</div>
        <DualRange min={0} max={1000} step={1} value={[filters.creditMin, filters.creditMax]} onChange={([creditMin, creditMax]) => write({ creditMin, creditMax })} format={(n) => `$${n}`} />
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[13px] font-medium"><span>Price ratio</span><span className="tabular">≤ {filters.ratio.toFixed(2)}×</span></div>
        <SingleRange min={0.5} max={1} step={0.01} value={filters.ratio} label="Maximum price ratio" onChange={(ratio) => write({ ratio })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-[13px] font-medium">Token
          <select className={`${fieldClass} mt-1.5`} value={filters.token || "USDC"} onChange={(event) => write({ token: event.target.value })}>
            <option value="USDC">USDC (Multi-Chain)</option>
          </select>
        </label>
        <label className="text-[13px] font-medium">Sort
          <select className={`${fieldClass} mt-1.5`} value={filters.sort} onChange={(event) => write({ sort: event.target.value })}>
            <option value="ratio">Best ratio</option>
            <option value="newest">Newest</option>
            <option value="largest">Largest</option>
            <option value="reputation">Seller reputation</option>
          </select>
        </label>
      </div>
      <button type="button" className="text-left text-sm font-semibold text-brand" onClick={() => { setModelQuery(""); router.replace("/"); }}>Reset</button>
    </div>
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Buy and sell API credit, settled by escrow on NEAR</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">The provider key stays inside the attested enclave. Buyers receive a proxy key and pay only for what the meter delivers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-md border border-line bg-surface p-1">
            <button type="button" className={`rounded px-3 py-1.5 text-sm font-semibold ${filters.side === "sell" ? "bg-surface-2 text-ink" : "text-muted"}`} onClick={() => write({ side: "sell" })}>Sell listings <span className="tabular text-muted">{sellCount}</span></button>
            <button type="button" className={`rounded px-3 py-1.5 text-sm font-semibold ${filters.side === "buy" ? "bg-surface-2 text-ink" : "text-muted"}`} onClick={() => write({ side: "buy" })}>Buy requests <span className="tabular text-muted">{buyCount}</span></button>
          </div>
          <Button href="/new">Create listing</Button>
        </div>
      </div>

      <div className="lg:hidden">
        <Button variant="secondary" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setOpen(true)}>Filters</Button>
      </div>
      <Card className="hidden lg:block">{controls}</Card>
      <Modal open={open} title="Filters" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Show results</Button>}>{controls}</Modal>

      {filtered.length === 0 ? (
        <EmptyState icon={<Store className="h-6 w-6" />} title="No listings match these filters." body="Widen the ratio or clear a provider." action={<div className="flex gap-2"><Button variant="secondary" onClick={() => router.replace("/")}>Reset filters</Button><Button href="/new">Create listing</Button></div>} />
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((listing) => (
              <Card key={listing.id} interactive>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge icon={<ProviderLogo provider={listing.provider} className="h-3 w-3 shrink-0" />}>
                      {listing.provider}
                    </Badge>
                    <span className="truncate text-sm text-muted">{listing.model}</span>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-mint"><span className="h-1.5 w-1.5 rounded-full bg-mint" /> TEE</span>
                </div>
                <h3 className="mt-4 text-[26px] font-semibold leading-[34px] tabular md:text-[32px] md:leading-10">{usd(listing.credit)} <span className="text-base font-medium text-muted">credit</span></h3>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-lg font-semibold tabular">{usd(listing.price)}</span>
                  <span className="rounded-sm bg-brand/10 px-1.5 py-0.5 text-xs font-semibold text-brand">{ratioOf(listing.price, listing.credit)}</span>
                </div>
                <p className="mt-3 text-[13px] text-muted">Collateral {listing.collateralPct}%</p>
                <div className="mt-3 flex items-center justify-between text-[13px]">
                  <span className="font-mono text-ink">{middle(listing.seller, 10, 4)}</span>
                  <span className="text-muted">{listing.reputation} deals</span>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button className="flex-1" onClick={() => quick(listing)} disabled={!app.account || app.paused}>{listing.type === "sell" ? "Quick buy" : "Fill request"}</Button>
                  <Button variant="ghost" href={`/listings/${listing.id}`}>Details</Button>
                </div>
              </Card>
            ))}
          </div>
          {shown < filtered.length ? (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setShown((count) => count + 3)}>Load more</Button>
            </div>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 text-sm text-muted">
        <span>Open escrow <span className="tabular font-semibold text-ink">{usd(marketOpenEscrow(app.deals))}</span></span>
        <span>Deals settled <span className="tabular font-semibold text-ink">{app.deals.filter((deal) => ["Completed", "Defaulted", "Timeout settled", "Auto-released"].includes(deal.status) || deal.outcome === "completed" || deal.outcome === "revoked").length}</span></span>
        <span>Median ratio {medians.join(" · ")}</span>
      </div>
    </div>
  );
}
