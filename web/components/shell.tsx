"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Bell,
  Copy,
  ExternalLink,
  Gauge,
  LogOut,
  Menu,
  ShieldCheck,
  Store,
  Wallet,
  X,
} from "lucide-react";
import { CODE_HASH, CONTRACT_ID, DAO_ID, NETWORK, explorerAccount } from "@/lib/chain";
import { assetAmount, middle } from "@/lib/format";
import { pendingClaimTotal, unreadCount, useApp } from "@/lib/store";
import type { WalletName } from "@/lib/types";
import { Button, HashChip, Modal } from "./ui";
import { AttestationBadge } from "./attestation-badge";

const NAV = [
  { href: "/", label: "Market", icon: Store },
  { href: "/deals", label: "Deals", icon: ArrowLeftRight },
  { href: "/meter", label: "Meter", icon: Gauge },
  { href: "/trust", label: "Trust", icon: ShieldCheck },
  { href: "/governance", label: "Governance", icon: LandmarkIcon },
];

function LandmarkIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={props.className} fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path d="M4 10h16M6 10v7M10 10v7M14 10v7M18 10v7M3 19h18M12 3l9 5H3l9-5Z" />
    </svg>
  );
}

const WALLETS: { name: WalletName; detail: string }[] = [
  { name: "MyNearWallet", detail: "Browser wallet" },
  { name: "Meteor", detail: "Browser wallet" },
  { name: "HERE", detail: "Mobile wallet" },
  { name: "Sender", detail: "Browser extension" },
  { name: "Ledger", detail: "Hardware wallet" },
];

function active(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const app = useApp();
  const claims = pendingClaimTotal(app.claims);
  const unread = unreadCount(app.notices);
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const [connect, setConnect] = useState(false);
  const [more, setMore] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
      if (!bellRef.current?.contains(event.target as Node)) setBell(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    setMore(false);
    setMenu(false);
    setBell(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#content" className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[80] focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="no-print sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1280px] items-center justify-between gap-3 px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-brand-ink">
              <span className="h-2.5 w-2.5 rotate-45 bg-current" />
            </span>
            <span className="text-base font-semibold tracking-tight">Conpi</span>
          </Link>
          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 lg:flex" aria-label="Primary">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} aria-current={active(pathname, item.href) ? "page" : undefined} className={`focus-ring rounded px-2.5 py-2 text-sm font-medium ${active(pathname, item.href) ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <AttestationBadge />
            <span className="hidden items-center gap-1.5 rounded-full border border-amber/40 bg-amber/10 px-2.5 py-1 text-xs font-semibold text-amber sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-amber" />
              {NETWORK === "testnet" ? "Testnet" : "Mainnet"}
            </span>
            <div className="relative" ref={bellRef}>
              <button type="button" className="focus-ring relative grid h-10 w-10 place-items-center rounded-md text-ink hover:bg-surface-2" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} onClick={() => { setBell((v) => !v); setMenu(false); }}>
                <Bell className="h-5 w-5" />
                {unread || claims.length ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-brand" /> : null}
              </button>
              {bell ? (
                <div className="absolute right-0 z-50 mt-2 w-[320px] rounded-lg border border-line bg-surface p-2 shadow-2">
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-sm font-semibold text-ink">Notifications</span>
                    <button type="button" className="text-xs font-medium text-brand" onClick={app.markAllNotices}>Mark read</button>
                  </div>
                  <ul className="max-h-80 overflow-auto">
                    {app.notices.slice(0, 10).map((notice) => (
                      <li key={notice.id}>
                        <Link href={notice.href} onClick={() => app.markNotice(notice.id)} className="block rounded-md px-2 py-2 hover:bg-surface-2">
                          <div className="flex items-center gap-2">
                            {!notice.read ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : <span className="h-1.5 w-1.5" />}
                            <span className="text-sm font-medium text-ink">{notice.title}</span>
                          </div>
                          <p className="pl-3.5 text-xs text-muted">{notice.body}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link href="/notifications" className="block px-2 py-2 text-center text-xs font-semibold text-brand">View all</Link>
                </div>
              ) : null}
            </div>
            {app.account ? (
              <div className="relative" ref={menuRef}>
                <button type="button" className="focus-ring flex h-10 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5" onClick={() => { setMenu((v) => !v); setBell(false); }}>
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-brand text-[11px] font-semibold text-brand-ink">B</span>
                  <span className="hidden font-mono text-[13px] sm:inline">{middle(app.account, 10, 4)}</span>
                </button>
                {menu ? (
                  <div className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-line bg-surface p-2 shadow-2">
                    <div className="px-2 py-2">
                      <div className="font-mono text-[13px]">{app.account}</div>
                      <div className="mt-1 text-xs text-muted">{app.wallet}</div>
                      <div className="mt-2 space-y-1 text-sm tabular">
                        <div className="flex justify-between"><span className="text-muted">NEAR</span><span>{assetAmount(app.near, "")}</span></div>
                        <div className="flex justify-between"><span className="text-muted">USDC</span><span>{assetAmount(app.usdc, "")}</span></div>
                        <div className="flex justify-between"><span className="text-muted">USDT</span><span>{assetAmount(app.usdt, "")}</span></div>
                      </div>
                    </div>
                    <Link href="/history" className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2">Receipts</Link>
                    <Link href="/claims" className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2">Claims</Link>
                    <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2" onClick={() => app.copy(app.account!)}><Copy className="h-4 w-4" /> Copy address</button>
                    <a className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2" href={explorerAccount(app.account)} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Explorer</a>
                    <Link href="/settings" className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-surface-2">Settings</Link>
                    <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-danger hover:bg-surface-2" onClick={() => { app.disconnect(); setMenu(false); }}><LogOut className="h-4 w-4" /> Disconnect</button>
                  </div>
                ) : null}
              </div>
            ) : (
              <Button size="sm" icon={<Wallet className="h-4 w-4" />} onClick={() => setConnect(true)}>Connect</Button>
            )}
          </div>
        </div>
      </header>

      {app.paused ? (
        <div className="no-print border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-sm text-warning">
          New deals are paused. Existing deals, claims and refunds still work.
        </div>
      ) : null}
      {claims.length ? (
        <div className="no-print border-b border-brand/20 bg-brand/10 px-4 py-2 text-center text-sm">
          <Link href="/claims" className="font-medium text-ink">
            You have {claims.map((claim) => `${claim.amount.toFixed(2)} ${claim.token}`).join(" and ")} ready to claim.
          </Link>
        </div>
      ) : null}

      <main id="content" className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-28 pt-8 md:px-6 lg:pb-16">
        {children}
      </main>

      <footer className="no-print border-t border-line">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Contract</span>
            <HashChip value={CONTRACT_ID} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">DAO</span>
            <HashChip value={DAO_ID} href={explorerAccount(DAO_ID)} onCopy={app.copy} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Code</span>
            <HashChip value={CODE_HASH} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} />
          </div>
          <div className="flex gap-4 text-sm">
            <Link href="/trust" className="text-muted hover:text-ink">Trust</Link>
            <Link href="/trust#verify" className="text-muted hover:text-ink">Docs</Link>
          </div>
        </div>
      </footer>

      <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur lg:hidden" aria-label="Mobile" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <ul className="grid h-16 grid-cols-5">
          {NAV.slice(0, 4).map((item) => {
            const Icon = item.icon;
            const on = active(pathname, item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} className={`flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium ${on ? "text-ink" : "text-muted"}`}>
                  <Icon className="h-5 w-5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button type="button" className="flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted" onClick={() => setMore(true)}>
              <Menu className="h-5 w-5" />
              More
            </button>
          </li>
        </ul>
      </nav>

      {more ? (
        <div className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-16 rounded-t-xl border border-line bg-surface p-3" onClick={(event) => event.stopPropagation()}>
            {[
              ["/governance", "Governance"],
              ["/history", "Receipts and history"],
              ["/claims", "Claims"],
              ["/notifications", "Notifications"],
              ["/settings", "Settings"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="block rounded-md px-3 py-3 text-sm font-medium hover:bg-surface-2">{label}</Link>
            ))}
          </div>
        </div>
      ) : null}

      <Modal open={connect} title="Connect a wallet" onClose={() => setConnect(false)}>
        <ul className="space-y-2">
          {WALLETS.map((wallet) => (
            <li key={wallet.name}>
              <button type="button" className="focus-ring flex w-full items-center justify-between rounded-lg border border-line px-3 py-3 text-left hover:border-brand/40" onClick={() => { app.connect(wallet.name); setConnect(false); }}>
                <span>
                  <span className="block text-sm font-semibold text-ink">{wallet.name}</span>
                  <span className="text-xs text-muted">{wallet.detail}</span>
                </span>
                <Wallet className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={Boolean(app.confirm)}
        title={app.confirm?.title ?? ""}
        onClose={app.closeConfirm}
        footer={
          <>
            <Button variant="ghost" onClick={app.closeConfirm}>Back</Button>
            <Button variant={app.confirm?.danger ? "danger" : "primary"} onClick={app.acceptConfirm}>{app.confirm?.confirm}</Button>
          </>
        }
      >
        <p className="text-sm text-ink">{app.confirm?.body}</p>
      </Modal>

      <Modal open={Boolean(app.signing)} title={app.signing?.title ?? ""} locked onClose={() => undefined}>
        <p className="text-sm text-ink">{app.signing?.detail} is asking you to sign this transaction.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={app.rejectSign}>Reject</Button>
          <Button onClick={app.approveSign}>Approve</Button>
        </div>
      </Modal>

      <div className="no-print pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3 md:inset-x-auto md:right-4 md:items-end">
        {app.toasts.map((toast) => (
          <div key={toast.id} role={toast.kind === "error" ? "alert" : "status"} className="pointer-events-auto w-full max-w-[360px] rounded-lg border border-line bg-surface p-3 shadow-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-ink">{toast.title}</div>
                {toast.body ? <p className="mt-1 text-xs text-muted">{toast.body}</p> : null}
                {toast.href ? <a className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand" href={toast.href} target="_blank" rel="noreferrer">View transaction <ExternalLink className="h-3 w-3" /></a> : null}
              </div>
              {toast.kind !== "pending" ? (
                <button type="button" aria-label="Dismiss" className="text-muted" onClick={() => app.dismissToast(toast.id)}><X className="h-4 w-4" /></button>
              ) : <span className="mt-1 h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-brand" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
