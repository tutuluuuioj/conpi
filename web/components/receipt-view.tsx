"use client";

import { CODE_HASH, CONTRACT_ID } from "@/lib/chain";
import { assetAmount, usd } from "@/lib/format";
import { cashMoves, escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import { Button, EmptyState } from "./ui";
import { ReceiptText } from "lucide-react";

export function ReceiptView({ id }: { id: string }) {
  const app = useApp();
  const deal = app.deals.find((item) => item.id === id);
  if (!deal) {
    return <EmptyState icon={<ReceiptText className="h-6 w-6" />} title="Receipt not found." body="This deal has no record." action={<Button href="/history">History</Button>} />;
  }
  const escrow = escrowOf(deal);
  const locked = (deal.buyerDeposited ? escrow.buyerDeposit : 0) + (deal.sellerDeposited ? escrow.sellerDeposit : 0) || escrow.total;
  const moves = deal.split ? cashMoves(deal.split) : 0;
  const amount = (value: number) => deal.token === "NEAR" ? assetAmount(value, "NEAR") : usd(value);
  const payload = {
    deal: deal.id,
    buyer: deal.buyer,
    seller: deal.seller,
    termsHash: deal.termsHash,
    credit: deal.credit,
    price: deal.price,
    token: deal.token,
    outcome: deal.outcome,
    split: deal.split,
    contract: CONTRACT_ID,
    codeHash: CODE_HASH,
  };
  return (
    <article className="receipt mx-auto max-w-3xl rounded-lg border border-line bg-white p-8 text-[#12141A]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#5c6578]">Conpi receipt</p>
          <h1 className="mt-2 text-[32px] font-semibold leading-10">Deal {deal.id}</h1>
          <p className="mt-1 text-sm">{deal.provider} · {deal.model}</p>
        </div>
        <div className="no-print flex gap-2">
          <button type="button" className="focus-ring h-10 rounded bg-[#12141A] px-4 text-sm font-semibold text-white" onClick={() => window.print()}>Download PDF</button>
          <button type="button" className="focus-ring h-10 rounded px-3 text-sm font-semibold text-[#12141A]" onClick={() => app.copy(JSON.stringify(payload, null, 2))}>Copy JSON</button>
        </div>
      </div>
      <dl className="mt-8 grid gap-4 text-sm sm:grid-cols-2">
        <div><dt className="text-[#5c6578]">Buyer</dt><dd className="font-mono">{deal.buyer}</dd></div>
        <div><dt className="text-[#5c6578]">Seller</dt><dd className="font-mono">{deal.seller}</dd></div>
        <div className="sm:col-span-2"><dt className="text-[#5c6578]">Terms hash</dt><dd className="font-mono break-all">{deal.termsHash ?? "Not matched"}</dd></div>
      </dl>
      <h2 className="mt-8 text-lg font-semibold">Locked prices</h2>
      <table className="mt-2 w-full text-left text-sm">
        <tbody>
          {deal.prices.map((row) => (
            <tr key={row.model} className="border-t border-[#e2e5ec]"><td className="py-2">{row.model}</td><td className="py-2 text-right tabular">{row.input}</td><td className="py-2 text-right tabular">{row.output}</td></tr>
          ))}
        </tbody>
      </table>
      <h2 className="mt-8 text-lg font-semibold">Releases</h2>
      <ul className="mt-2 divide-y divide-[#e2e5ec] text-sm">
        {deal.activity.filter((event) => event.tx).map((event) => (
          <li key={event.id} className="flex justify-between gap-4 py-2"><span>{event.title}</span><span className="font-mono text-xs">{event.tx}</span></li>
        ))}
      </ul>
      <h2 className="mt-8 text-lg font-semibold">Final split</h2>
      {deal.split ? (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {deal.split.lines.map((line) => (
              <tr key={line.label} className="border-t border-[#e2e5ec]">
                <td className="py-2">{line.label}<div className="text-xs text-[#5c6578]">{line.note}</div></td>
                <td className="py-2 text-right tabular">{amount(line.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-[#e2e5ec]">
              <td className="py-2">Seller total<div className="text-xs text-[#5c6578]">Stage releases plus this settlement</div></td>
              <td className="py-2 text-right tabular">{amount(deal.split.seller)}</td>
            </tr>
            <tr className="border-t border-[#e2e5ec]">
              <td className="py-2">Buyer total<div className="text-xs text-[#5c6578]">Includes the slashed collateral</div></td>
              <td className="py-2 text-right tabular">{amount(deal.split.buyer)}</td>
            </tr>
            <tr className="border-t border-[#12141A] font-semibold">
              <td className="py-2">Cash moved</td>
              <td className="py-2 text-right tabular">{amount(moves)}</td>
            </tr>
            <tr>
              <td className="py-2">Escrow</td>
              <td className="py-2 text-right tabular">{amount(locked || escrow.total)}</td>
            </tr>
          </tbody>
        </table>
      ) : <p className="mt-2 text-sm">This deal is still open. Escrow locked: {amount(escrow.total)}.</p>}
      {deal.split && Math.abs(moves - (locked || escrow.total)) > 0.02 ? <p className="mt-3 text-sm text-[#b02a30]">The split does not match the escrow. Do not treat this receipt as final.</p> : deal.split ? <p className="mt-3 text-sm">The cash lines sum to the escrow.</p> : null}
      <p className="mt-8 font-mono text-xs text-[#5c6578]">Contract {CONTRACT_ID}<br />Code hash {CODE_HASH}</p>
    </article>
  );
}
