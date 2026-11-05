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
}: {
  children: React.ReactNode;
  tone?: keyof typeof TONE;
  icon?: React.ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-semibold", TONE[tone])}>
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
  token,
  stage,
  pulse,
}: {
  price: number;
  priceUsd?: number;
  token?: Asset;
  stage: number;
  pulse?: number | null;
}) {
  const isNear = token === "NEAR";
  const amountNear = price / 4;
  const amountUsd = priceUsd ? priceUsd / 4 : amountNear * 4.02;

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
              {isNear ? (
                <span>
                  {amountNear.toFixed(4)} NEAR
                  <span className="block text-[11px] opacity-75">
                    ({usd(amountUsd)}) {done ? "released" : "pending"}
                  </span>
                </span>
              ) : (
                <span>{usd(amountNear)} {done ? "released" : "pending"}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EscrowTable({ deal }: { deal: Deal }) {
  const escrow = escrowOf(deal);
  const live = deal.status === "Active" || deal.step === "live";
  const settled = deal.step === "settled" && deal.split;
  const isNear = deal.token === "NEAR";
  const fmtAsset = (amount: number) =>
    isNear ? `${amount.toFixed(4)} NEAR` : usd(amount);

  const rows = [
    ["Buyer price", fmtAsset(deal.price), "Locked"],
    [`Buyer collateral (${deal.buyerCollateralPct}%)`, fmtAsset(escrow.buyerCollateral), settled ? "Settled" : "Locked, refunded on completion"],
    [`Seller collateral (${deal.sellerCollateralPct}%)`, fmtAsset(escrow.sellerCollateral), settled ? "Settled" : "Locked, returned on completion"],
    ["Total in escrow", fmtAsset(escrow.total), "NEAR contract"],
  ];
  if (live || settled) {
    rows.push(["Released", fmtAsset(deal.releasedUsd), "Paid to the seller"]);
    rows.push(["Remaining", fmtAsset(Math.max(0, escrow.total - (deal.split ? deal.split.seller + (deal.outcome === "completed" ? 0 : deal.split.buyer) : deal.releasedUsd))), "Still in the contract"]);
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
      {settled && deal.split ? <SplitBar deal={deal} /> : live ? <LiveBar released={deal.releasedUsd} total={escrow.total} token={deal.token} /> : <LockedBar />}
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
  const amount = (value: number) => token === "NEAR" ? assetAmount(value, "NEAR") : usd(value);
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

export function SplitBar({ deal }: { deal: Deal }) {
  const escrow = escrowOf(deal);
  const split = deal.split;
  if (!split || escrow.total <= 0) return null;
  const amount = (value: number) => deal.token === "NEAR" ? assetAmount(value, "NEAR") : usd(value);
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
        Seller {amount(split.seller)} · Buyer {amount(split.buyer)}
        {split.slashed ? ` · ${amount(split.slashed)} slashed` : ""}
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

export function OutcomeBanner({ deal }: { deal: Deal }) {
  if (!deal.outcome) return null;
  const tone = deal.outcome === "completed" ? "mint" : deal.outcome === "revoked" || deal.outcome === "quota" || deal.outcome === "provider_ban" ? "danger" : deal.outcome === "deposit_timeout" ? "neutral" : "warning";
  return <div className={cn("rounded-lg border px-4 py-3 text-sm", TONE[tone])}>{outcomeCopy(deal)}</div>;
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
