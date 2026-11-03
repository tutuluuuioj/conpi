import { CONFIG } from "./chain";
import { round2, usd } from "./format";
import type { Deal, Split, SplitLine } from "./types";

export interface Escrow {
  buyerCollateral: number;
  sellerCollateral: number;
  buyerDeposit: number;
  sellerDeposit: number;
  total: number;
  stageSize: number;
  released: number;
  remaining: number;
}

export function escrowOf(deal: Pick<Deal, "price" | "buyerCollateralPct" | "sellerCollateralPct" | "releasedUsd">): Escrow {
  const buyerCollateral = round2((deal.price * deal.buyerCollateralPct) / 100);
  const sellerCollateral = round2((deal.price * deal.sellerCollateralPct) / 100);
  const buyerDeposit = round2(deal.price + buyerCollateral);
  const total = round2(buyerDeposit + sellerCollateral);
  const stageSize = round2(deal.price / 4);
  const released = round2(deal.releasedUsd);
  const remaining = round2(Math.max(0, total - released));
  return { buyerCollateral, sellerCollateral, buyerDeposit, sellerDeposit: sellerCollateral, total, stageSize, released, remaining };
}

export function stageFor(used: number, credit: number) {
  const pct = credit ? used / credit : 0;
  if (pct >= 1) return 100;
  if (pct >= 0.75) return 75;
  if (pct >= 0.5) return 50;
  if (pct >= 0.25) return 25;
  return 0;
}

export function settleRevoke(deal: Deal): Split {
  const e = escrowOf(deal);
  const fraction = deal.credit ? deal.usedUsd / deal.credit : 0;
  const sellerEarned = round2(fraction * deal.price);
  const already = round2(deal.releasedUsd);
  const priceOwed = round2(Math.max(0, sellerEarned - already));
  const unused = round2(deal.price - sellerEarned);
  const slashed = round2((e.sellerCollateral * CONFIG.slashRevokeBps) / 10000);
  const sellerColBack = round2(e.sellerCollateral - slashed);
  const toSeller = round2(priceOwed + sellerColBack);
  const toBuyer = round2(unused + e.buyerCollateral + slashed);
  const sellerTotal = round2(already + toSeller);
  const lines: SplitLine[] = [
    { label: `Stage releases already paid`, amount: already, note: "Included in the seller total", tone: "mint" },
    { label: "Seller settlement", amount: toSeller, note: `${usd(priceOwed)} usage still owed + ${usd(sellerColBack)} collateral returned`, tone: "mint" },
    { label: "Buyer settlement", amount: toBuyer, note: `${usd(unused)} unused price + ${usd(e.buyerCollateral)} collateral + ${usd(slashed)} slash`, tone: "blue" },
    { label: "Seller collateral slashed", amount: slashed, note: `${CONFIG.slashRevokeBps / 100}% of seller collateral, paid to the buyer`, tone: "orange" },
  ];
  return { seller: sellerTotal, buyer: toBuyer, slashed, lines };
}

export function settleComplete(deal: Deal): Split {
  const e = escrowOf(deal);
  const lines: SplitLine[] = [
    { label: "Price paid to the seller", amount: deal.price, note: "Released across 25 / 50 / 75 / 100%", tone: "mint" },
    { label: "Buyer collateral returned", amount: e.buyerCollateral, note: "Returned on completion", tone: "blue" },
    { label: "Seller collateral returned", amount: e.sellerCollateral, note: "Returned on completion", tone: "violet" },
  ];
  return {
    seller: round2(deal.price + e.sellerCollateral),
    buyer: e.buyerCollateral,
    slashed: 0,
    lines,
  };
}

export function cashMoves(split: Split) {
  return round2(split.lines.filter((line) => line.label !== "Seller collateral slashed").reduce((sum, line) => sum + line.amount, 0));
}

export function outcomeCopy(deal: Deal) {
  const e = escrowOf(deal);
  const usedPct = deal.credit ? Math.round((deal.usedUsd / deal.credit) * 100) : 0;
  switch (deal.outcome) {
    case "completed":
      return `Deal completed. ${usd(deal.price)} paid to the seller, collateral returned to both sides.`;
    case "revoked":
      return `The seller's key was revoked at ${usedPct}%. ${CONFIG.slashRevokeBps / 100}% of seller collateral (${usd(deal.split?.slashed ?? 0)}) was slashed.`;
    case "quota":
      return "The seller's credit ran out (insufficient_quota). Settled from the last checkpoint.";
    case "provider_ban":
      return `The provider disabled the seller's key. ${CONFIG.slashProviderBanBps / 100}% of seller collateral was slashed.`;
    case "buyer_breach":
      return `The buyer broke the usage terms. Buyer collateral was slashed at the buyer-breach rate (${CONFIG.slashBuyerBreachBps / 100}%).`;
    case "auto_release":
      return "30 days passed. Remaining payment was released after notice on 1 Dec.";
    case "tee_timeout":
      return "The TEE stopped reporting. The deal settled from the last checkpoint.";
    case "deposit_timeout":
      return "The other side did not deposit in time. Your deposit was refunded.";
    default:
      return `${usd(e.released)} released of ${usd(e.total)} locked.`;
  }
}

export function netFor(deal: Deal) {
  if (!deal.split || !deal.outcome) return null;
  if (deal.outcome === "deposit_timeout") return 0;
  const e = escrowOf(deal);
  if (deal.role === "buyer") {
    return round2(deal.split.buyer - e.buyerDeposit);
  }
  return round2(deal.split.seller - e.sellerDeposit);
}
