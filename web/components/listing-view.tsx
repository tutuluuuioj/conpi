"use client";

import { useRouter } from "next/navigation";
import { ratioOf, usd, middle } from "@/lib/format";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState, Overline } from "./ui";
import { Store } from "lucide-react";

export function ListingView({ id }: { id: string }) {
  const app = useApp();
  const router = useRouter();
  const listing = app.listings.find((item) => item.id === id);
  if (!listing) {
    return <EmptyState icon={<Store className="h-6 w-6" />} title="Listing not found." body="It may have been cancelled." action={<Button href="/">Back to market</Button>} />;
  }
  const escrow = escrowOf({ price: listing.price, buyerCollateralPct: listing.buyerCollateralPct, sellerCollateralPct: listing.collateralPct, releasedUsd: 0 });
  const open = async () => {
    const dealId = await app.openTicket(listing.id);
    if (dealId) router.push(`/deals/${dealId}/ticket`);
  };
  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="space-y-6 lg:col-span-8">
        <div>
          <Overline>{listing.type === "sell" ? "Sell listing" : "Buy request"}</Overline>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">{listing.provider} · {listing.model}</h1>
          <p className="mt-2 text-muted">{usd(listing.credit)} credit at {usd(listing.price)} · {ratioOf(listing.price, listing.credit)}</p>
        </div>
        <Card>
          <dl className="grid gap-4 sm:grid-cols-2 text-sm">
            <div><dt className="text-muted">Allowlist</dt><dd className="mt-1 font-medium">{listing.models.join(", ")}</dd></div>
            <div><dt className="text-muted">Rate limit</dt><dd className="mt-1 font-medium">{listing.rateLimit}</dd></div>
            <div><dt className="text-muted">Seller collateral</dt><dd className="mt-1 font-medium">{listing.collateralPct}% · {usd(escrow.sellerCollateral)}</dd></div>
            <div><dt className="text-muted">Buyer collateral</dt><dd className="mt-1 font-medium">{listing.buyerCollateralPct}% · {usd(escrow.buyerCollateral)}</dd></div>
            <div><dt className="text-muted">Token</dt><dd className="mt-1 font-medium">{listing.token}</dd></div>
            <div><dt className="text-muted">Seller</dt><dd className="mt-1 font-mono">{middle(listing.seller, 12, 4)} · {listing.reputation} deals</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted">Expected test call</dt><dd className="mt-1 font-medium">{listing.expectedTest}</dd></div>
          </dl>
        </Card>
      </div>
      <aside className="lg:col-span-4">
        <Card className="lg:sticky lg:top-24">
          <Overline>Escrow you would lock</Overline>
          <p className="mt-3 text-[32px] font-semibold leading-10 tabular">{usd(escrow.total)}</p>
          <ul className="mt-4 space-y-2 text-sm">
            <li className="flex justify-between"><span className="text-muted">Price</span><span className="tabular">{usd(listing.price)}</span></li>
            <li className="flex justify-between"><span className="text-muted">Buyer collateral</span><span className="tabular">{usd(escrow.buyerCollateral)}</span></li>
            <li className="flex justify-between"><span className="text-muted">Seller collateral</span><span className="tabular">{usd(escrow.sellerCollateral)}</span></li>
          </ul>
          <Button className="mt-5 w-full" onClick={() => void open()} disabled={!app.account || app.paused}>{listing.type === "sell" ? "Quick buy" : "Fill request"}</Button>
          <p className="mt-3 text-xs text-muted">The seller key is collected after deposit, and only by the enclave.</p>
        </Card>
      </aside>
    </div>
  );
}
