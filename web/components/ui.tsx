"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  AlertOctagon,
  ArrowUpRight,
  Check,
  Circle,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  HandCoins,
  Info,
  Loader2,
  Lock,
  Scissors,
  Timer,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { absoluteTime, assetAmount, countdown, maskKey, middle, usd } from "@/lib/format";
import { escrowOf, outcomeCopy } from "@/lib/money";
import type { Asset, Deal, DealStatus, DealStep } from "@/lib/types";
import { explorerAccount, explorerTx } from "@/lib/chain";

const STEPS: { id: DealStep; label: string }[] = [
  { id: "negotiate", label: "Negotiate" },
  { id: "terms", label: "Terms hash" },
  { id: "deposit", label: "Deposit" },
  { id: "key", label: "Key check" },
  { id: "live", label: "Live" },
  { id: "settled", label: "Settled" },
];

export function steps() {
  return STEPS;
}

export function Button({
  variant = "primary",
  size = "md",
  href,
  loading,
  icon,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "link";
  size?: "sm" | "md" | "lg";
  href?: string;
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  const classes = cn(
    "focus-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-semibold transition duration-hover ease-conpi",
    "disabled:pointer-events-none disabled:opacity-40",
    size === "sm" && "h-8 px-3 text-[13px]",
    size === "md" && "h-11 px-4 text-sm md:h-10",
    size === "lg" && "h-12 px-5 text-sm",
    variant === "primary" && "bg-brand text-brand-ink hover:brightness-110",
    variant === "secondary" && "border border-line bg-surface-2 text-ink hover:border-brand/40",
    variant === "ghost" && "text-ink hover:bg-surface-2",
    variant === "danger" && "bg-danger text-white dark:text-bg",
    variant === "link" && "h-auto px-0 text-brand underline-offset-2 hover:underline",
    className,
  );
  const content = (
    <>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <button className={classes} {...props}>
      {content}
    </button>
  );
}

const STATUS: Record<DealStatus, { tone: string; icon: typeof Check; label: string }> = {
  Created: { tone: "neutral", icon: Circle, label: "Created" },
  Funded: { tone: "brand", icon: Lock, label: "Funded" },
  Active: { tone: "mint", icon: Activity, label: "Active" },
  Completed: { tone: "mint", icon: Check, label: "Completed" },
  Defaulted: { tone: "danger", icon: Scissors, label: "Defaulted" },
  "Buyer breach": { tone: "warning", icon: AlertOctagon, label: "Buyer breach" },
  Cancelled: { tone: "neutral", icon: X, label: "Cancelled" },
  "Timeout settled": { tone: "warning", icon: Timer, label: "Timeout settled" },
  "Auto-released": { tone: "info", icon: Timer, label: "Auto-released" },
  "Pending claim": { tone: "warning", icon: HandCoins, label: "Pending claim" },
};

const TONE: Record<string, string> = {
  mint: "border-mint/30 bg-mint/10 text-mint",
  danger: "border-danger/30 bg-danger/10 text-danger",
  warning: "border-warning/35 bg-warning/10 text-warning",
  info: "border-blue/30 bg-blue/10 text-blue",
  brand: "border-brand/30 bg-brand/10 text-brand",
  neutral: "border-line bg-surface-2 text-muted",
  amber: "border-amber/40 bg-amber/10 text-amber",
};

export function Badge({
  children,
  tone = "neutral",
  icon,
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONE;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold", TONE[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: DealStatus }) {
  const item = STATUS[status];
  const Icon = item.icon;
  return (
    <Badge tone={item.tone as keyof typeof TONE} icon={<Icon className="h-3 w-3" aria-hidden />}>
      {item.label}
    </Badge>
  );
}

export function Card({ id, className, children, interactive }: { id?: string; className?: string; children: React.ReactNode; interactive?: boolean }) {
  return (
    <div id={id} className={cn("rounded-lg border border-line bg-surface p-4 shadow-1 md:p-5", interactive && "transition duration-hover ease-conpi hover:border-brand/40 hover:shadow-2", className)}>
      {children}
    </div>
  );
}

export function Overline({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{children}</div>;
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs font-medium text-danger">{error}</span> : hint ? <span className="mt-1 block text-xs font-medium tracking-[0.01em] text-muted">{hint}</span> : null}
    </label>
  );
}

export const fieldClass =
  "focus-ring h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-base text-ink outline-none md:text-sm";

export function Hint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <Info className="h-3.5 w-3.5 text-muted" aria-label={text} />
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-56 -translate-x-1/2 rounded-md border border-line bg-surface px-2.5 py-2 text-left text-xs font-medium normal-case tracking-normal text-ink shadow-2 group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

export function HashChip({
  value,
  href,
  onCopy,
}: {
  value: string;
  href?: string;
  onCopy: (value: string) => void;
}) {
  return (
    <span className="group relative inline-flex max-w-full items-center gap-1 rounded-sm border border-line bg-surface-2 py-1 pl-2 pr-1 font-mono text-[13px] text-ink">
      <span className="truncate">{middle(value)}</span>
      <button type="button" className="focus-ring rounded p-1 text-muted hover:text-ink" aria-label="Copy" onClick={() => onCopy(value)}>
        <Copy className="h-3.5 w-3.5" />
      </button>
      {href ? (
        <a className="focus-ring rounded p-1 text-muted hover:text-ink" href={href} target="_blank" rel="noreferrer" aria-label="Open in NEAR explorer">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : null}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 hidden max-w-xs break-all rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink shadow-2 group-hover:block group-focus-within:block">
        {value}
      </span>
    </span>
  );
}

export function SecretKey({ value, onCopy, revoked }: { value: string; onCopy: (value: string) => void; revoked?: boolean }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), 30000);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]" aria-live="polite">
        {revoked ? "Revoked" : shown ? value : maskKey(value)}
      </span>
      <button type="button" className="focus-ring rounded p-1 text-muted hover:text-ink" aria-label={shown ? "Hide key" : "Reveal key. The key is masked."} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        className="focus-ring rounded p-1 text-muted hover:text-ink"
        aria-label={copied ? "Copied" : "Copy key"}
        onClick={() => {
          onCopy(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check className="h-4 w-4 text-mint" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
}

export function useTween(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = from.current;
    const t0 = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 400);
      const eased = 1 - (1 - p) ** 3;
      setShown(start + (value - start) * eased);
      if (p < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

export function Meter({
  used,
  credit,
  stage,
  compact,
  pulse,
}: {
  used: number;
  credit: number;
  stage: number;
  compact?: boolean;
  pulse?: number | null;
}) {
  const width = credit ? Math.min(100, (used / credit) * 100) : 0;
  const tween = useTween(width);
  const ticks = [25, 50, 75, 100];
  return (
    <div>
      <div
        className={cn("relative rounded-full bg-surface-2", compact ? "h-2" : "h-3")}
        role="progressbar"
        aria-valuenow={Math.round(width)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${Math.round(width)}% used, ${usd(used)} of ${usd(credit)}`}
      >
        <div className="h-full rounded-full bg-mint transition-[width] duration-[600ms] ease-conpi" style={{ width: `${tween}%` }} />
        {ticks.map((tick) => (
          <span key={tick} className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-line" style={{ left: `${tick}%` }} />
        ))}
      </div>
      {!compact ? (
        <div className="mt-2 grid grid-cols-4 text-[11px] font-medium text-muted">
          {ticks.map((tick) => {
            const done = stage >= tick;
            return (
              <span key={tick} className={cn("inline-flex items-center gap-1", tick === 50 && "justify-center", tick === 75 && "justify-center", tick === 100 && "justify-end", done && "text-mint")}>
                {done ? <Check className={cn("h-3 w-3", pulse === tick && "tick-glow rounded-full")} /> : <span className="h-1.5 w-1.5 rounded-full bg-line" />}
                {tick}%
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function StageTicks({
  price,
  priceUsd,
  stage,
  pulse,
}: {
  price: number;
  priceUsd?: number;
  token?: Asset;
  stage: number;
  pulse?: number | null;
}) {
  const amountUsd = priceUsd ? priceUsd / 4 : price / 4;

  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[25, 50, 75, 100].map((tick) => {
        const done = stage >= tick;
        return (
          <div key={tick} className={cn("rounded-md border px-2 py-1.5 text-xs", done ? "border-mint/40 bg-mint/10 text-mint" : "border-line text-muted", pulse === tick && "tick-glow")}>
            <div className="flex items-center gap-1 font-semibold">
              {done ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />}
              {tick}%
            </div>
            <div className="tabular mt-0.5">
              <span>{usd(amountUsd)} {done ? "released" : "pending"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EscrowTable({ deal, foreignInfo }: { deal: Deal; foreignInfo?: any }) {
  const escrow = escrowOf(deal);
  const live = deal.status === "Active" || deal.step === "live";
  const settled = deal.status === "Completed" || deal.step === "settled" || !!deal.split;
  const effectiveForeignInfo = foreignInfo || (deal as any).foreignInfo;
  const isForeign = Boolean(
    (effectiveForeignInfo && Number(effectiveForeignInfo.foreign_amount) > 0) ||
    deal.token === "USDC"
  );
  const foreignUsdcAmount = isForeign
    ? (effectiveForeignInfo && Number(effectiveForeignInfo.foreign_amount) > 0
        ? Number(effectiveForeignInfo.foreign_amount) / 1e6
        : (deal.priceUsd || deal.price || 0.04))
    : 0;
  const sellerColUsdc = (deal.price * deal.sellerCollateralPct) / 100;
  const fmtAsset = (amount: number) => usd(amount);

  let rows: [string, string, string][];

  if (isForeign) {
    const isClaimedOnBase = Boolean(effectiveForeignInfo?.seller_claimed);
    const priceState = settled
      ? (isClaimedOnBase ? "Paid to seller on Base Sepolia" : "Settling on Base Sepolia")
      : deal.buyerDeposited
        ? "Locked in Base Sepolia Vault"
        : "Awaiting buyer USDC deposit";

    const buyerColState = "Waived in Maker Vault";
    const sellerColState = settled
      ? "Returned to seller in USDC"
      : deal.sellerDeposited
        ? "Locked in USDC escrow, returned on completion"
        : "Awaiting seller USDC deposit";

    const totalDeposited = settled
      ? "$0.00 USDC"
      : (deal.buyerDeposited && deal.sellerDeposited)
        ? `$${(foreignUsdcAmount + sellerColUsdc).toFixed(2)} USDC`
        : deal.buyerDeposited
          ? `$${foreignUsdcAmount.toFixed(2)} USDC (in Vault)`
          : deal.sellerDeposited
            ? `$${sellerColUsdc.toFixed(2)} USDC (Collateral)`
            : "$0.00 USDC";

    const escrowState = settled
      ? "Settled (0.0000 in escrow)"
      : (deal.buyerDeposited && deal.sellerDeposited)
        ? "Locked in Vault & NEAR contract"
        : "Partial deposit";

    const releasedAmount = settled
      ? foreignUsdcAmount
      : (foreignUsdcAmount * (deal.stage || 0)) / 100;
    const remainingAmount = settled
      ? 0
      : Math.max(0, foreignUsdcAmount - releasedAmount);

    rows = [
      ["Buyer price", `$${foreignUsdcAmount.toFixed(4)} USDC`, priceState],
      [`Buyer collateral (${deal.buyerCollateralPct}%)`, "$0.0000 USDC", buyerColState],
      [`Seller collateral (${deal.sellerCollateralPct}%)`, `$${sellerColUsdc.toFixed(4)} USDC`, sellerColState],
      ["Total in escrow", totalDeposited, escrowState],
    ];

    if (live || settled) {
      rows.push([
        "Released",
        `$${releasedAmount.toFixed(4)} USDC`,
        isClaimedOnBase ? "Paid to seller on Base Sepolia" : "Settling on Base Sepolia",
      ]);
      rows.push([
        "Remaining",
        `$${remainingAmount.toFixed(4)} USDC`,
        settled ? "All funds settled" : "Still in Base Sepolia Vault",
      ]);
    }
  } else {
    const priceState = settled
      ? "Released to seller"
      : deal.buyerDeposited
        ? "Locked in contract"
        : "Awaiting buyer deposit";

    const buyerColState = settled
      ? "Refunded to buyer"
      : deal.buyerDeposited
        ? "Locked, refunded on completion"
        : "Awaiting buyer deposit";

    const sellerColState = settled
      ? "Returned to seller"
      : deal.sellerDeposited
        ? "Locked, returned on completion"
        : "Awaiting seller deposit";

    const buyerDepositedAmount = deal.buyerDeposited
      ? escrow.buyerDeposit
      : Math.max(0, escrow.buyerDeposit - (deal.buyerDepositRemaining ?? escrow.buyerDeposit));

    const sellerDepositedAmount = deal.sellerDeposited
      ? escrow.sellerDeposit
      : Math.max(0, escrow.sellerDeposit - (deal.sellerDepositRemaining ?? escrow.sellerDeposit));

    const totalDeposited = settled
      ? 0
      : (deal.buyerDeposited && deal.sellerDeposited)
        ? escrow.total
        : (buyerDepositedAmount + sellerDepositedAmount);

    const escrowState = settled
      ? "Settled (0.0000 in escrow)"
      : (deal.buyerDeposited && deal.sellerDeposited)
        ? "Locked in NEAR contract"
        : (deal.buyerDeposited || deal.sellerDeposited)
          ? "Partial deposit in contract"
          : "Awaiting deposits (0 in contract)";

    rows = [
      ["Buyer price", fmtAsset(deal.price), priceState],
      [`Buyer collateral (${deal.buyerCollateralPct}%)`, fmtAsset(escrow.buyerCollateral), buyerColState],
      [`Seller collateral (${deal.sellerCollateralPct}%)`, fmtAsset(escrow.sellerCollateral), sellerColState],
      ["Total in escrow", fmtAsset(totalDeposited), escrowState],
    ];
    if (live || settled) {
      rows.push(["Released", fmtAsset(settled ? deal.price : deal.releasedUsd), "Paid to the seller"]);
      rows.push(["Remaining", fmtAsset(settled ? 0 : Math.max(0, escrow.total - (deal.split ? deal.split.seller + (deal.outcome === "completed" ? 0 : deal.split.buyer) : deal.releasedUsd))), settled ? "All funds settled" : "Still in the contract"]);
    }
  }
  return (
    <div>
      <div className="hidden md:block">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            <tr>
              <th className="pb-2 font-semibold">Line</th>
              <th className="pb-2 text-right font-semibold">Amount</th>
              <th className="pb-2 text-right font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([line, amount, state]) => (
              <tr key={line} className="border-t border-line">
                <td className="py-2">{line}</td>
                <td className="tabular py-2 text-right">{amount}</td>
                <td className="py-2 text-right text-muted">{state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map(([line, amount, state]) => (
          <li key={line} className="rounded-md border border-line bg-surface-2 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <span>{line}</span>
              <span className="tabular font-semibold">{amount}</span>
            </div>
            <div className="text-xs text-muted">{state}</div>
          </li>
        ))}
      </ul>
      {settled && deal.split ? (
        <SplitBar deal={deal} foreignInfo={foreignInfo} />
      ) : live ? (
        <LiveBar released={deal.releasedUsd} total={escrow.total} token={deal.token} />
      ) : (deal.buyerDeposited && deal.sellerDeposited) ? (
        <LockedBar />
      ) : (
        <DepositStatusBar
          buyerDeposited={deal.buyerDeposited}
          sellerDeposited={deal.sellerDeposited}
          buyerPct={escrow.total > 0 ? (escrow.buyerDeposit / escrow.total) * 100 : 80}
          sellerPct={escrow.total > 0 ? (escrow.sellerDeposit / escrow.total) * 100 : 20}
        />
      )}
      {deal.matched && deal.buyerTerms?.price && Math.abs(deal.buyerTerms.price - (deal.priceUsd ?? deal.price)) > 0.0001 ? (
        <p className="mt-2 text-[11px] text-muted italic">
          * This table shows Deal #{deal.id}&apos;s on-chain escrow (${(deal.priceUsd ?? deal.price).toFixed(3)}). New terms (${deal.buyerTerms.price}) are verified in TEE and apply when created on NEAR.
        </p>
      ) : null}
    </div>
  );
}

function DepositStatusBar({
  buyerDeposited,
  sellerDeposited,
  buyerPct,
  sellerPct,
}: {
  buyerDeposited: boolean;
  sellerDeposited: boolean;
  buyerPct: number;
  sellerPct: number;
}) {
  const noneDeposited = !buyerDeposited && !sellerDeposited;
  return (
    <div className="mt-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-2 border border-line" aria-hidden>
        {buyerDeposited ? (
          <div className="bg-violet transition-all" style={{ width: `${buyerPct}%` }} />
        ) : null}
        {sellerDeposited ? (
          <div className="bg-violet/70 transition-all" style={{ width: `${sellerPct}%` }} />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
        {noneDeposited ? (
          <Legend swatch="bg-surface-3 border border-line" label="Awaiting deposits (0% in contract)" />
        ) : (
          <>
            <Legend
              swatch={buyerDeposited ? "bg-violet" : "bg-surface-3 border border-line"}
              label={buyerDeposited ? "Buyer deposited" : "Buyer awaiting deposit"}
            />
            <Legend
              swatch={sellerDeposited ? "bg-violet/70" : "bg-surface-3 border border-line"}
              label={sellerDeposited ? "Seller deposited" : "Seller awaiting deposit"}
            />
          </>
        )}
      </div>
    </div>
  );
}

function LockedBar() {
  return (
    <div className="mt-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-violet" aria-hidden />
      <div className="mt-2 flex gap-3 text-[11px] text-muted">
        <Legend swatch="bg-violet" label="Locked" />
      </div>
    </div>
  );
}

function LiveBar({ released, total, token }: { released: number; total: number; token: Asset }) {
  const rel = total ? (released / total) * 100 : 0;
  const amount = (value: number) => usd(value);
  return (
    <div className="mt-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-violet" role="img" aria-label={`${amount(released)} released, ${amount(Math.max(0, total - released))} still locked`}>
        <div className="bg-mint" style={{ width: `${rel}%` }} />
      </div>
      <div className="mt-2 flex gap-3 text-[11px] text-muted">
        <Legend swatch="bg-violet" label="Locked" />
        <Legend swatch="bg-mint" label="Released" />
      </div>
    </div>
  );
}

export function SplitBar({ deal, foreignInfo }: { deal: Deal; foreignInfo?: any }) {
  const escrow = escrowOf(deal);
  const split = deal.split;
  if (!split || escrow.total <= 0) return null;
  const isForeign = Boolean(foreignInfo && Number(foreignInfo.foreign_amount) > 0);
  const foreignUsdcAmount = isForeign ? Number(foreignInfo.foreign_amount) / 1e6 : 0;
  const sellerColUsdc = (deal.price * deal.sellerCollateralPct) / 100;
  const amount = (value: number) => usd(value);
  const refunded = Math.max(0, split.buyer - split.slashed);
  const parts = [
    { key: "released", width: (split.seller / escrow.total) * 100, className: "bg-mint" },
    { key: "slashed", width: (split.slashed / escrow.total) * 100, className: "pattern-slash" },
    { key: "refund", width: (refunded / escrow.total) * 100, className: "pattern-refund" },
  ];
  return (
    <div className="mt-4">
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Seller ${amount(split.seller)}, buyer ${amount(split.buyer)}${split.slashed ? `, ${amount(split.slashed)} slashed` : ""}`}>
        {parts.filter((part) => part.width > 0).map((part) => (
          <div key={part.key} className={part.className} style={{ width: `${part.width}%` }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
        <Legend swatch="bg-violet" label="Locked" />
        <Legend swatch="bg-mint" label="Released" />
        <Legend swatch="pattern-slash" label="Slashed" />
        <Legend swatch="pattern-refund" label="Refunded" />
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {isForeign ? (
          <>
            Seller <strong className="text-ink">${foreignUsdcAmount.toFixed(4)} USDC</strong> + <strong className="text-ink">${sellerColUsdc.toFixed(4)} USDC</strong> (Collateral returned) · Buyer Collateral waived
          </>
        ) : (
          <>
            Seller {amount(split.seller)} · Buyer {amount(split.buyer)}
            {split.slashed ? ` · ${amount(split.slashed)} slashed` : ""}
          </>
        )}
      </p>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2.5 w-4 rounded-sm border border-line", swatch)} />
      {label}
    </span>
  );
}

export function Stepper({ deal, onPick }: { deal: Deal; onPick: (step: DealStep) => void }) {
  const index = STEPS.findIndex((step) => step.id === deal.step);
  const failed = deal.outcome === "revoked" || deal.outcome === "quota" || deal.outcome === "provider_ban" || deal.status === "Cancelled";
  return (
    <ol className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-0">
      {STEPS.map((step, i) => {
        const done = i < index || (deal.step === "settled" && i <= index);
        const current = step.id === deal.step;
        const mark = deal.steps[step.id];
        return (
          <li key={step.id} className="lg:flex-1">
            <button type="button" disabled={i > index} onClick={() => onPick(step.id)} className="focus-ring flex w-full items-start gap-3 rounded-md text-left disabled:cursor-default lg:flex-col lg:gap-2">
              <span className="flex items-center lg:w-full">
                <span className={cn(
                  "relative grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                  done && "border-mint bg-mint text-bg",
                  current && !failed && "border-brand text-brand",
                  current && failed && "border-danger text-danger",
                  !done && !current && "border-line text-muted",
                )}>
                  {done ? <Check className="h-3.5 w-3.5" /> : failed && current ? <X className="h-3.5 w-3.5" /> : i + 1}
                  {current && !failed ? <span className="pulse-dot pointer-events-none absolute inset-0 rounded-full border border-brand" /> : null}
                </span>
                {i < STEPS.length - 1 ? <span className="ml-3 hidden h-px flex-1 bg-line lg:block" /> : null}
              </span>
              <span className="relative">
                <span className={cn("block text-sm font-semibold", !done && !current && "text-muted")}>{step.label}</span>
                {mark ? (
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted" title={mark.time}>
                    {mark.time}
                    {mark.tx ? <ArrowUpRight className="h-3 w-3" /> : null}
                  </span>
                ) : <span className="mt-0.5 block text-[11px] text-muted">Waiting</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function OutcomeBanner({ deal, foreignInfo }: { deal: Deal; foreignInfo?: any }) {
  if (!deal.outcome) return null;
  const effectiveForeignInfo = foreignInfo || (deal as any).foreignInfo;
  const isForeign = Boolean(
    (effectiveForeignInfo && Number(effectiveForeignInfo.foreign_amount) > 0) ||
    deal.token === "USDC"
  );
  const foreignUsdc = isForeign
    ? (effectiveForeignInfo && Number(effectiveForeignInfo.foreign_amount) > 0
        ? Number(effectiveForeignInfo.foreign_amount) / 1e6
        : (deal.priceUsd || deal.price || 0.04))
    : 0;
  const sellerColUsdc = Number(((deal.price * deal.sellerCollateralPct) / 100).toFixed(4));

  const copy = () => {
    if (deal.outcome === "completed") {
      if (isForeign) {
        if (effectiveForeignInfo?.seller_claimed) {
          return `Deal completed. $${foreignUsdc.toFixed(4)} USDC paid to the seller, $${sellerColUsdc.toFixed(4)} USDC collateral returned.`;
        }
        return `Deal completed. Payout ($${foreignUsdc.toFixed(4)} USDC) settling... $${sellerColUsdc.toFixed(4)} USDC collateral returned.`;
      }
      return outcomeCopy(deal);
    }
    return outcomeCopy(deal);
  };

  const tone = deal.outcome === "completed" ? "mint" : deal.outcome === "revoked" || deal.outcome === "quota" || deal.outcome === "provider_ban" ? "danger" : deal.outcome === "deposit_timeout" ? "neutral" : "warning";
  return <div className={cn("rounded-lg border px-4 py-3 text-sm", TONE[tone])}>{copy()}</div>;
}

export function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  if (now === null) return <span className="tabular">—</span>;
  const left = countdown(until, now);
  return (
    <span className={cn("tabular", left.urgent && "text-warning")} title={absoluteTime(until)}>
      {left.label}
    </span>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-muted">{icon}</div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  locked,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  locked?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusable = () => Array.from(root?.querySelectorAll<HTMLElement>("button, a, input, select, textarea, [tabindex]:not([tabindex='-1'])") ?? []).filter((el) => !el.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, locked, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget && !locked) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[88vh] w-full overflow-auto rounded-t-xl border border-line bg-surface shadow-3 md:max-w-[520px] md:rounded-xl">
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button type="button" className="focus-ring rounded p-1 text-muted hover:text-ink" aria-label="Close" onClick={onClose} disabled={locked}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4 text-sm text-muted">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

export function DualRange({
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  format: (n: number) => string;
}) {
  const [a, b] = value;
  const left = ((a - min) / (max - min)) * 100;
  const right = ((b - min) / (max - min)) * 100;
  return (
    <div>
      <div className="mb-2 flex justify-between text-[13px] tabular text-ink">
        <span>{format(a)}</span>
        <span>{format(b)}</span>
      </div>
      <div className="relative h-6">
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-2" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
        <input className="range-thumb" type="range" min={min} max={max} step={step} value={a} aria-label="Minimum" onChange={(event) => onChange([Math.min(Number(event.target.value), b), b])} />
        <input className="range-thumb" type="range" min={min} max={max} step={step} value={b} aria-label="Maximum" onChange={(event) => onChange([a, Math.max(Number(event.target.value), a)])} />
      </div>
    </div>
  );
}

export function SingleRange({
  min,
  max,
  step,
  value,
  onChange,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  const pos = ((value - min) / (max - min)) * 100;
  return (
    <div className="relative h-6">
      <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-surface-2" />
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand" style={{ width: `${pos}%` }} />
      <input className="range-thumb" type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}

export function BlockLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return <Link href={href} className={className}>{children}</Link>;
}

export function accountHref(account: string) {
  return explorerAccount(account);
}

export function txHref(tx: string) {
  return explorerTx(tx);
}

export function OpenAILogo({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function AnthropicLogo({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223L8.616 7.82l2.291 5.945Z" />
    </svg>
  );
}

export function OpenRouterLogo({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032q-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237c-2.911 2.066-2.731 1.95-4.14 2.75c-.396.223-1.342.574-2.185.798c-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799c1.41.798 1.228.683 4.14 2.75c2.126 1.509 4.22 2.11 6.148 2.236c.88.058 1.716.041 2.555.005v1.918l7.222-4.168l-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021c-1.364-.09-2.417-.357-3.979-1.465c-2.244-1.593-2.866-2.027-3.68-2.508c.889-.518 1.449-.906 3.822-2.59c1.56-1.109 2.614-1.377 3.978-1.466c.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
    </svg>
  );
}

export function DeepSeekLogo({ className = "h-3.5 w-3.5 shrink-0" }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.17 4.17 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.951-.306c-.328-.314-.403-.787-.196-1.157.208-.37.606-.593 1.026-.563.42.03.784.309.923.708.139.399.022.846-.202 1.158z" />
    </svg>
  );
}

export function ProviderLogo({
  provider,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  provider?: string | null;
  className?: string;
}) {
  const norm = (provider || "").toLowerCase();
  if (norm.includes("openai")) return <OpenAILogo className={className} />;
  if (norm.includes("anthropic") || norm.includes("claude")) return <AnthropicLogo className={className} />;
  if (norm.includes("openrouter")) return <OpenRouterLogo className={className} />;
  if (norm.includes("deepseek")) return <DeepSeekLogo className={className} />;
  return null;
}
