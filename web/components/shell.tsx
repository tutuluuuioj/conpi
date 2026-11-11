"use client";

import "@/lib/polyfill";
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
  Loader2,
  Plus,
  Check,
} from "lucide-react";
import { CODE_HASH, CONTRACT_ID, DAO_ID, NETWORK, explorerAccount } from "@/lib/chain";
import { assetAmount, middle } from "@/lib/format";
import { pendingClaimTotal, unreadCount, useApp } from "@/lib/store";
import type { WalletName, WalletChain } from "@/lib/types";
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

interface MultiWalletOption {
  id: string;
  name: string;
  chain: "evm" | "solana" | "near";
  chainName: string;
  detail: string;
  tag: string;
}

const MULTI_WALLETS: MultiWalletOption[] = [
  // EVM (Base Sepolia)
  {
    id: "metamask",
    name: "MetaMask",
    chain: "evm",
    chainName: "Base Sepolia",
    detail: "Pay or receive in Base Sepolia USDC & ETH",
    tag: "EVM",
  },
  {
    id: "coinbase",
    name: "Coinbase Wallet",
    chain: "evm",
    chainName: "Base Sepolia",
    detail: "Smart Wallet & browser extension",
    tag: "EVM",
  },
  // Solana (Solana Devnet)
  {
    id: "phantom",
    name: "Phantom",
    chain: "solana",
    chainName: "Solana Devnet",
    detail: "Pay or receive in Devnet SOL & SPL-USDC",
    tag: "Solana",
  },
  {
    id: "solflare",
    name: "Solflare",
    chain: "solana",
    chainName: "Solana Devnet",
    detail: "Solana browser extension & web wallet",
    tag: "Solana",
  },
  // NEAR Protocol (NEAR Testnet)
  {
    id: "mynearwallet",
    name: "MyNearWallet",
    chain: "near",
    chainName: "NEAR Testnet",
    detail: "Web-based testnet wallet account",
    tag: "NEAR",
  },
  {
    id: "meteor",
    name: "Meteor",
    chain: "near",
    chainName: "NEAR Testnet",
    detail: "Browser extension & web wallet",
    tag: "NEAR",
  },
  {
    id: "here",
    name: "HERE",
    chain: "near",
    chainName: "NEAR Testnet",
    detail: "Mobile & Telegram wallet",
    tag: "NEAR",
  },
  {
    id: "sender",
    name: "Sender",
    chain: "near",
    chainName: "NEAR Testnet",
    detail: "Browser extension",
    tag: "NEAR",
  },
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
  const [walletTab, setWalletTab] = useState<"all" | "evm" | "solana" | "near">("all");
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
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
                <button
                  type="button"
                  className="focus-ring flex h-10 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 hover:border-brand/40"
                  onClick={() => { setMenu((v) => !v); setBell(false); }}
                >
                  <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${
                    app.walletChain === "evm"
                      ? "bg-blue-500/20 text-blue-400"
                      : app.walletChain === "solana"
                      ? "bg-purple-500/20 text-purple-400"
                      : "bg-emerald-500/20 text-emerald-400"
                  }`}>
                    {app.walletChain === "evm" ? "🔷" : app.walletChain === "solana" ? "🟣" : "Ⓝ"}
                  </span>
                  <span className="hidden font-mono text-[13px] sm:inline">{middle(app.account, 8, 4)}</span>
                </button>
                {menu ? (
                  <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-line bg-surface p-2 shadow-2">
                    <div className="px-2 py-2 border-b border-line">
                      <div className="flex items-center justify-between text-xs text-muted mb-1">
                        <span>Active Identity</span>
                        <span className={`text-[10px] uppercase font-semibold tracking-wider font-mono px-1.5 py-0.5 rounded ${
                          app.walletChain === "evm"
                            ? "bg-blue-500/10 text-blue-400"
                            : app.walletChain === "solana"
                            ? "bg-purple-500/10 text-purple-400"
                            : "bg-emerald-500/10 text-emerald-400"
                        }`}>
                          {(app.walletChain || "near").toUpperCase()}
                        </span>
                      </div>
                      <div className="font-mono text-xs break-all text-ink font-semibold">{app.account}</div>
                      <div className="mt-0.5 text-[11px] text-muted">{app.wallet}</div>
                    </div>

                    {/* Multi-Chain Connected Accounts List */}
                    <div className="px-2 py-2 border-b border-line space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Connected Chains</span>
                        <span className="text-[10px] text-muted">Click to switch</span>
                      </div>
                      {app.nearAccount && (
                        <div className={`flex items-center justify-between text-xs p-1.5 rounded border transition-colors ${
                          app.walletChain === "near"
                            ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                            : "bg-surface-2 border-line/60 hover:bg-surface-3 text-muted hover:text-ink cursor-pointer"
                        }`} onClick={() => app.switchActiveChain("near")}>
                          <span className="flex items-center gap-1.5 font-medium">
                            <span>Ⓝ NEAR</span>
                            {app.walletChain === "near" && (
                              <span className="text-[9px] uppercase px-1 py-0.2 bg-emerald-500/20 text-emerald-400 rounded font-semibold">Active</span>
                            )}
                          </span>
                          <span className="font-mono text-[11px]">{middle(app.nearAccount, 6, 4)}</span>
                        </div>
                      )}
                      {app.evmAccount && (
                        <div className={`flex items-center justify-between text-xs p-1.5 rounded border transition-colors ${
                          app.walletChain === "evm"
                            ? "bg-blue-500/10 border-blue-500/40 text-blue-300"
                            : "bg-surface-2 border-line/60 hover:bg-surface-3 text-muted hover:text-ink cursor-pointer"
                        }`} onClick={() => app.switchActiveChain("evm")}>
                          <span className="flex items-center gap-1.5 font-medium">
                            <span>🔷 Base EVM</span>
                            {app.walletChain === "evm" && (
                              <span className="text-[9px] uppercase px-1 py-0.2 bg-blue-500/20 text-blue-400 rounded font-semibold">Active</span>
                            )}
                          </span>
                          <span className="font-mono text-[11px]">{middle(app.evmAccount, 6, 4)}</span>
                        </div>
                      )}
                      {app.solanaAccount && (
                        <div className={`flex items-center justify-between text-xs p-1.5 rounded border transition-colors ${
                          app.walletChain === "solana"
                            ? "bg-purple-500/10 border-purple-500/40 text-purple-300"
                            : "bg-surface-2 border-line/60 hover:bg-surface-3 text-muted hover:text-ink cursor-pointer"
                        }`} onClick={() => app.switchActiveChain("solana")}>
                          <span className="flex items-center gap-1.5 font-medium">
                            <span>🟣 Solana</span>
                            {app.walletChain === "solana" && (
                              <span className="text-[9px] uppercase px-1 py-0.2 bg-purple-500/20 text-purple-400 rounded font-semibold">Active</span>
                            )}
                          </span>
                          <span className="font-mono text-[11px]">{middle(app.solanaAccount, 6, 4)}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        className="w-full text-left flex items-center gap-1 text-xs text-brand hover:underline pt-1 font-medium"
                        onClick={() => { setMenu(false); setConnect(true); }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Connect another wallet / chain
                      </button>
                    </div>

                    <div className="px-2 py-2 border-b border-line space-y-1 text-xs tabular">
                      <div className="flex justify-between font-medium"><span className="text-muted">USDC Balance</span><span className="text-emerald-400 font-semibold">{assetAmount(app.usdc, "")} USDC</span></div>
                    </div>

                    <div className="py-1">
                      <Link href="/history" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2">Receipts</Link>
                      <Link href="/claims" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2">Claims</Link>
                      <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2" onClick={() => app.copy(app.account!)}><Copy className="h-3.5 w-3.5" /> Copy active address</button>
                      {app.walletChain === "near" && (
                        <a className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2" href={explorerAccount(app.account)} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> NEAR Explorer</a>
                      )}
                      {app.walletChain === "evm" && (
                        <a className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2" href={`https://sepolia.basescan.org/address/${app.account}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> BaseScan</a>
                      )}
                      {app.walletChain === "solana" && (
                        <a className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2" href={`https://explorer.solana.com/address/${app.account}?cluster=devnet`} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Solana Explorer</a>
                      )}
                      <Link href="/settings" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-2">Settings</Link>
                      {app.walletChain === "evm" && app.solanaAccount && (
                        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink hover:bg-surface-2" onClick={() => { app.disconnectEvm(); setMenu(false); }}><LogOut className="h-3.5 w-3.5" /> Disconnect EVM only</button>
                      )}
                      {app.walletChain === "solana" && app.evmAccount && (
                        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:text-ink hover:bg-surface-2" onClick={() => { void app.disconnectSolana(); setMenu(false); }}><LogOut className="h-3.5 w-3.5" /> Disconnect Solana only</button>
                      )}
                      <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-danger hover:bg-surface-2" onClick={() => { void app.disconnect(); setMenu(false); }}><LogOut className="h-3.5 w-3.5" /> Disconnect All</button>
                    </div>
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

      <Modal open={connect || app.isConnectModalOpen} title="Connect a wallet" onClose={() => { setConnect(false); app.closeConnectModal(); }}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Connect your wallet to trade, deposit escrow funds, or receive milestone payouts on your preferred chain.
          </p>

          {/* Chain Tabs */}
          <div className="grid grid-cols-4 gap-1 p-1 rounded-lg border border-line bg-surface-2">
            <button
              type="button"
              className={`py-1.5 text-xs font-medium rounded-md transition-all text-center ${
                walletTab === "all" ? "bg-surface shadow text-ink font-semibold" : "text-muted hover:text-ink"
              }`}
              onClick={() => setWalletTab("all")}
            >
              All
            </button>
            <button
              type="button"
              className={`py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${
                walletTab === "evm" ? "bg-surface shadow text-brand font-semibold" : "text-muted hover:text-ink"
              }`}
              onClick={() => setWalletTab("evm")}
            >
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              Base EVM
            </button>
            <button
              type="button"
              className={`py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${
                walletTab === "solana" ? "bg-surface shadow text-purple-400 font-semibold" : "text-muted hover:text-ink"
              }`}
              onClick={() => setWalletTab("solana")}
            >
              <span className="h-2 w-2 rounded-full bg-purple-500" />
              Solana
            </button>
            <button
              type="button"
              className={`py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${
                walletTab === "near" ? "bg-surface shadow text-emerald-400 font-semibold" : "text-muted hover:text-ink"
              }`}
              onClick={() => setWalletTab("near")}
            >
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              NEAR
            </button>
          </div>

          {/* Wallets List */}
          <ul className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {MULTI_WALLETS.filter((w) => walletTab === "all" || w.chain === walletTab).map((wallet) => {
              const isConnecting = connectingWalletId === wallet.id;
              const isConnected =
                (wallet.chain === "near" && app.nearAccount && (app.wallet === wallet.name || app.account === app.nearAccount)) ||
                (wallet.chain === "evm" && app.evmAccount && (app.wallet === wallet.name || app.account === app.evmAccount)) ||
                (wallet.chain === "solana" && app.solanaAccount && (app.wallet === wallet.name || app.account === app.solanaAccount));

              return (
                <li key={wallet.id}>
                  <button
                    type="button"
                    disabled={isConnecting}
                    className="focus-ring flex w-full items-center justify-between rounded-lg border border-line p-3 text-left hover:border-brand/50 hover:bg-surface-2/60 transition-all disabled:opacity-60"
                    onClick={async () => {
                      setConnectingWalletId(wallet.id);
                      try {
                        if (wallet.chain === "evm") {
                          await app.connectEvm(wallet.name as any);
                          setConnect(false);
                          app.closeConnectModal();
                        } else if (wallet.chain === "solana") {
                          await app.connectSolana(wallet.name as any);
                          setConnect(false);
                          app.closeConnectModal();
                        } else {
                          setConnect(false);
                          app.closeConnectModal();
                          const { connectWalletModal } = await import("@/lib/wallet");
                          await connectWalletModal();
                        }
                      } catch (err) {
                        console.warn("Wallet connect failed:", err);
                      } finally {
                        setConnectingWalletId(null);
                      }
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base font-bold ${
                        wallet.chain === "evm"
                          ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                          : wallet.chain === "solana"
                          ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      }`}>
                        {wallet.chain === "evm" ? "🔷" : wallet.chain === "solana" ? "🟣" : "Ⓝ"}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink">{wallet.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            wallet.chain === "evm"
                              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                              : wallet.chain === "solana"
                              ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                              : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          }`}>
                            {wallet.chainName}
                          </span>
                        </div>
                        <p className="text-xs text-muted mt-0.5">{wallet.detail}</p>
                      </div>
                    </div>

                    <div className="shrink-0 pl-2">
                      {isConnecting ? (
                        <Loader2 className="h-4 w-4 animate-spin text-brand" />
                      ) : isConnected ? (
                        <span className="flex items-center gap-1 text-xs text-mint font-medium">
                          <Check className="h-3.5 w-3.5" /> Connected
                        </span>
                      ) : (
                        <span className="text-xs text-muted hover:text-ink">Connect →</span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="rounded-md border border-line bg-surface-2 p-2.5 text-[11px] text-muted space-y-1">
            <span className="font-semibold text-ink block">Omnichain Settlement</span>
            <p>
              Conpi uses <strong>NEAR Chain Signatures</strong> & <strong>MPC</strong> to connect Base Sepolia (EVM), Solana Devnet (SVM), and NEAR Testnet into one seamless market.
            </p>
          </div>
        </div>
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
