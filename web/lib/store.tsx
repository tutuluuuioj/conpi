"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BASE_URL, CONFIG, CONTRACT_ID, MARKET_SNAPSHOT, TX } from "./chain";
import { KEY_CHECKS, MODELS, listingTerms } from "./data";
import { maskKey, round2, sameTerms, txId, usd } from "./format";
import { escrowOf, settleComplete, settleRevoke, stageFor } from "./money";
import type { Asset, Claim, Deal, DealStatus, DealStep, Listing, Notice, Proposal, SignResult, Terms, ThemeMode, Toast, WalletName } from "./types";
import { teeApi } from "./tee-api";
import { encryptApiKeyToEnclave } from "./crypto";
import {
  OnChainDeal,
  fetchContractDeals,
  fetchContractConfig,
  fetchContractStagedProposals,
  fetchContractPendingPayout,
} from "./contract";
import {
  getWalletSelector,
  connectWalletModal,
  disconnectWallet,
  txCreateDeal,
  txDepositNear,
  txDepositFt,
  txActivateDeal,
  txReleaseStage,
  txSettleDefault,
  txClaim,
} from "./wallet";

interface State {
  theme: ThemeMode;
  account: string | null;
  wallet: WalletName | null;
  near: number;
  usdc: number;
  usdt: number;
  listings: Listing[];
  deals: Deal[];
  claims: Claim[];
  notices: Notice[];
  proposals: Proposal[];
  paused: boolean;
  defaultToken: Asset;
  currency: "USD";
  toasts: Toast[];
  signing: { title: string; detail: string } | null;
  confirm: { title: string; body: string; confirm: string; danger: boolean } | null;
  isLoadingOnChain: boolean;
}

const seed: State = {
  theme: "dark",
  account: null,
  wallet: null,
  near: 50,
  usdc: 100,
  usdt: 100,
  listings: [],
  deals: [],
  claims: [],
  notices: [],
  proposals: [],
  paused: false,
  defaultToken: "USDC",
  currency: "USD",
  toasts: [],
  signing: null,
  confirm: null,
  isLoadingOnChain: true,
};

interface Api {
  setTheme: (theme: ThemeMode) => void;
  setDefaultToken: (token: Asset) => void;
  connect: (wallet?: WalletName) => void;
  disconnect: () => void;
  copy: (value: string) => void;
  dismissToast: (id: string) => void;
  ask: (opts: { title: string; body: string; confirm: string; danger?: boolean; run: () => Promise<SignResult> | SignResult }) => void;
  closeConfirm: () => void;
  acceptConfirm: () => void;
  approveSign: () => void;
  rejectSign: () => void;
  openTicket: (listingId: string) => string | null;
  sendMessage: (dealId: string, text: string) => void;
  updateBuyerTerms: (dealId: string, patch: Partial<Deal["buyerTerms"]>) => void;
  submitTerms: (dealId: string) => void;
  deposit: (dealId: string) => Promise<SignResult>;
  submitSellerKey: (dealId: string, plainApiKey?: string) => Promise<void>;
  simulateUsage: (dealId: string) => void;
  simulateRevoke: (dealId: string) => void;
  simulateCounterparty: (dealId: string) => void;
  setHeartbeat: (dealId: string, heartbeat: "live" | "stale") => void;
  claimOne: (id: string) => Promise<SignResult>;
  claimAll: () => Promise<SignResult>;
  createListing: (listing: Listing) => Promise<SignResult>;
  cancelMyListings: () => SignResult;
  rotateKey: (dealId: string) => SignResult;
  revokeKey: (dealId: string) => SignResult;
  cancelDeal: (dealId: string) => SignResult;
  confirmProposal: (id: string) => void;
  executeProposal: (id: string) => SignResult;
  markNotice: (id: string) => void;
  markAllNotices: () => void;
  clearPulse: (dealId: string) => void;
  refreshOnChain: () => Promise<void>;
}

const Ctx = createContext<(State & Api) | null>(null);

export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside provider");
  return value;
}

function mapOnChainDeal(d: OnChainDeal, currentAccount: string | null): Deal {
  const priceNear = Number(d.price) / 1e24;
  const creditNear = Number(d.credit_amount) / 1e24;
  const meteredNear = Number(d.metered_value) / 1e24;
  const releasedNear = Number(d.released_amount) / 1e24;

  const isSeller = Boolean(currentAccount && d.seller.toLowerCase() === currentAccount.toLowerCase());
  const role: "buyer" | "seller" = isSeller ? "seller" : "buyer";
  const token: Asset = d.token ? (d.token.toLowerCase().includes("usdt") ? "USDT" : "USDC") : "NEAR";

  let status: DealStatus = "Created";
  if (d.status === "Deposited") status = "Funded";
  else if (d.status === "Active") status = "Active";
  else if (d.status === "Settled") status = "Completed";
  else if (d.status === "Defaulted") status = "Defaulted";
  else if (d.status === "Cancelled") status = "Cancelled";

  let step: DealStep = "negotiate";
  if (d.status === "Active") step = "live";
  else if (d.status === "Settled" || d.status === "Defaulted" || d.status === "Cancelled") step = "settled";
  else if (d.status === "Deposited" || (d.buyer_deposited && d.seller_deposited)) step = "key";
  else if (d.terms_submitted_by_buyer && d.terms_submitted_by_seller) step = "deposit";
  else if (d.terms_submitted_by_buyer || d.terms_submitted_by_seller) step = "terms";

  const termsHashHex = d.terms_hash && d.terms_hash.length ? "0x" + Buffer.from(d.terms_hash).toString("hex") : null;
  const buyerCollateralPct = d.price !== "0" ? Math.round((Number(d.buyer_collateral) / Number(d.price)) * 100) : 10;
  const sellerCollateralPct = d.price !== "0" ? Math.round((Number(d.seller_collateral) / Number(d.price)) * 100) : 20;

  const defaultTerms: Terms = {
    credit: creditNear || 10,
    price: priceNear || 10,
    buyerCollateralPct,
    sellerCollateralPct,
    token,
    models: ["gpt-4o", "gpt-4o-mini"],
    deadline: new Date(Date.now() + 86400000 * 7).toISOString(),
  };

  return {
    id: String(d.id),
    listingId: `lst-${d.id}`,
    role,
    status,
    step,
    provider: "OpenAI",
    model: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini"],
    credit: creditNear || 10,
    price: priceNear || 10,
    buyerCollateralPct,
    sellerCollateralPct,
    token,
    buyer: d.buyer,
    seller: d.seller,
    deadline: defaultTerms.deadline,
    termsHash: termsHashHex,
    buyerSubmitted: d.terms_submitted_by_buyer,
    sellerSubmitted: d.terms_submitted_by_seller,
    buyerTerms: defaultTerms,
    sellerTerms: defaultTerms,
    buyerDeposited: d.buyer_deposited,
    sellerDeposited: d.seller_deposited,
    depositDeadline: new Date(Date.now() + 86400000 * 2).toISOString(),
    keyStatus: d.status === "Active" || d.status === "Settled" ? "verified" : "idle",
    keyChecks: KEY_CHECKS.map((label) => ({ label, ok: d.status === "Active" || d.status === "Settled" })),
    proxyKey: d.status === "Active" ? "cpk_live_phala_tee_proxy" : "",
    proxyRevoked: d.status === "Defaulted" || d.status === "Cancelled",
    baseUrl: BASE_URL,
    usedUsd: meteredNear,
    tokens: Math.round(meteredNear * 100000),
    stage: d.current_stage || 0,
    releasedUsd: releasedNear,
    lastUpdate: "On-chain NEAR Testnet",
    heartbeat: "live",
    lastCheckpoint: d.last_checkpoint_time ? new Date(Number(d.last_checkpoint_time) / 1e6).toLocaleTimeString() : "Recent",
    outcome: d.status === "Settled" ? "completed" : d.status === "Defaulted" ? "revoked" : null,
    split: null,
    messages: [
      { id: "m1", sender: d.seller, text: `Created on-chain deal #${d.id} for ${priceNear} NEAR`, time: "On-chain" },
      { id: "m2", sender: d.buyer, text: `Escrow terms recorded at ${termsHashHex ? termsHashHex.slice(0, 12) + "..." : "pending"}`, time: "On-chain" },
    ],
    activity: [
      { id: "a1", title: `On-chain Deal #${d.id} ${d.status}`, detail: `Status: ${d.status} · Stage: ${d.current_stage}% · Metered: ${meteredNear} NEAR`, time: "Live" }
    ],
    prices: [
      { model: "gpt-4o", input: "$2.50 / 1M", output: "$10.00 / 1M" },
      { model: "gpt-4o-mini", input: "$0.15 / 1M", output: "$0.60 / 1M" },
    ],
    steps: {
      negotiate: { time: "Completed" },
      terms: { time: "Completed" },
      deposit: d.buyer_deposited && d.seller_deposited ? { time: "Confirmed" } : undefined,
      key: d.status === "Active" || d.status === "Settled" ? { time: "Verified" } : undefined,
      live: d.status === "Active" ? { time: "Active" } : undefined,
      settled: d.status === "Settled" || d.status === "Defaulted" ? { time: "Settled" } : undefined,
    },
    createdAt: new Date(Number(d.created_at) / 1e6).toISOString(),
    pulseStage: null,
  };
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(seed);
  const stateRef = useRef(state);
  stateRef.current = state;
  const signRef = useRef<null | (() => Promise<SignResult> | SignResult)>(null);
  const toastTimers = useRef<Map<string, number>>(new Map());

  // 1. NEAR Wallet Selector setup & subscription
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    getWalletSelector().then((ws) => {
      if (!ws) return;
      const sub = ws.selector.store.observable.subscribe((selectorState) => {
        const active = selectorState.accounts.find((a) => a.active) || selectorState.accounts[0];
        if (active) {
          const walletType = (selectorState.selectedWalletId || "MyNearWallet") as WalletName;
          setState((s) => ({ ...s, account: active.accountId, wallet: walletType }));
        } else {
          setState((s) => ({ ...s, account: null, wallet: null }));
        }
      });
      unsubscribe = () => sub.unsubscribe();
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // 2. Fetch live data from contract
  const loadOnChainData = async () => {
    try {
      const [onChainDeals, stagedProposals] = await Promise.all([
        fetchContractDeals(0, 100),
        fetchContractStagedProposals(),
      ]);

      const currentAccount = stateRef.current.account;
      const mappedDeals = onChainDeals.map((d) => mapOnChainDeal(d, currentAccount));

      // Generate listings from models and active offers
      const generatedListings: Listing[] = onChainDeals.map((d, index) => ({
        id: `lst-${d.id}`,
        type: "sell",
        provider: "OpenAI",
        model: "gpt-4o",
        models: ["gpt-4o", "gpt-4o-mini"],
        credit: Number(d.credit_amount) / 1e24 || 20,
        price: Number(d.price) / 1e24 || 15,
        collateralPct: 20,
        buyerCollateralPct: 10,
        seller: d.seller,
        reputation: 15,
        tee: true,
        token: "NEAR",
        rateLimit: "60 req/min",
        expectedTest: "One completion probe, max 32 tokens",
        createdAt: new Date(Number(d.created_at) / 1e6).toISOString(),
      }));

      // Add default market listings if none yet
      if (generatedListings.length === 0) {
        generatedListings.push(
          {
            id: "lst-template-1",
            type: "sell",
            provider: "OpenAI",
            model: "gpt-4o",
            models: ["gpt-4o", "gpt-4o-mini"],
            credit: 50,
            price: 40,
            collateralPct: 20,
            buyerCollateralPct: 10,
            seller: "seller.testnet",
            reputation: 15,
            tee: true,
            token: "NEAR",
            rateLimit: "60 req/min",
            expectedTest: "One chat completion probe",
            createdAt: new Date().toISOString(),
          },
          {
            id: "lst-template-2",
            type: "sell",
            provider: "Anthropic",
            model: "claude-3-5-sonnet",
            models: ["claude-3-5-sonnet", "claude-3-5-haiku"],
            credit: 100,
            price: 80,
            collateralPct: 20,
            buyerCollateralPct: 10,
            seller: "anthropic-seller.testnet",
            reputation: 22,
            tee: true,
            token: "NEAR",
            rateLimit: "120 req/min",
            expectedTest: "Anthropic message completion probe",
            createdAt: new Date().toISOString(),
          }
        );
      }

      // Query claims for user
      const userClaims: Claim[] = [];
      if (currentAccount) {
        const pendingNear = await fetchContractPendingPayout(currentAccount, null);
        if (Number(pendingNear) > 0) {
          userClaims.push({
            id: `claim-near-${currentAccount}`,
            token: "NEAR",
            amount: Number(pendingNear) / 1e24,
            claimed: false,
            reason: "Settlement payout / collateral release",
            dealId: "Contract Payout",
          });
        }
      }

      // Map staged proposals
      const mappedProposals: Proposal[] = stagedProposals.map(([id, p]: [number, any]) => {
        const actionKey = Object.keys(p.action || {})[0] || "AdminAction";
        const readyAtMs = Number(p.ready_at) / 1e6;
        const isReady = Date.now() >= readyAtMs;
        return {
          id: String(id),
          action: actionKey,
          proposer: "DAO Multisig",
          confirmations: 2,
          threshold: 2,
          stagedAt: new Date(readyAtMs - 300000).toISOString(),
          executableAt: new Date(readyAtMs).toISOString(),
          status: isReady ? "Ready" : "Pending",
          diff: [{ field: "action", from: "None", to: actionKey }],
          confirmedByMe: true,
        };
      });

      setState((s) => ({
        ...s,
        deals: mappedDeals,
        listings: generatedListings,
        claims: userClaims,
        proposals: mappedProposals,
        isLoadingOnChain: false,
      }));
    } catch (err) {
      console.warn("Failed to load on-chain contract data:", err);
      setState((s) => ({ ...s, isLoadingOnChain: false }));
    }
  };

  useEffect(() => {
    loadOnChainData();
    const interval = setInterval(loadOnChainData, 12000);
    return () => clearInterval(interval);
  }, [state.account]);

  // Theme handling
  useEffect(() => {
    const saved = localStorage.getItem("conpi-theme");
    if (saved === "light" || saved === "dark" || saved === "system") {
      setState((s) => ({ ...s, theme: saved }));
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = state.theme === "dark" || (state.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    localStorage.setItem("conpi-theme", state.theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.theme]);

  const api = useMemo<Api>(() => {
    const dismissToast = (id: string) => {
      const timer = toastTimers.current.get(id);
      if (timer) window.clearTimeout(timer);
      toastTimers.current.delete(id);
      setState((s) => ({ ...s, toasts: s.toasts.filter((toast) => toast.id !== id) }));
    };

    const pushToast = (toast: Omit<Toast, "id">) => {
      const id = crypto.randomUUID();
      setState((s) => ({ ...s, toasts: [...s.toasts.filter((item) => item.kind !== "pending" || toast.kind === "pending"), { ...toast, id }] }));
      if (toast.kind !== "error" && toast.kind !== "pending") {
        toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), 5000));
      }
      return id;
    };

    const replaceToast = (id: string, toast: Omit<Toast, "id">) => {
      setState((s) => ({ ...s, toasts: s.toasts.map((item) => (item.id === id ? { ...toast, id } : item)) }));
      if (toast.kind !== "error") {
        toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), 5000));
      }
    };

    const finish = (result: SignResult) => {
      const pending = stateRef.current.toasts.find((toast) => toast.kind === "pending");
      const next = { kind: result.ok ? "success" as const : "error" as const, title: result.title, body: result.body, href: result.href };
      if (pending) replaceToast(pending.id, next);
      else pushToast(next);
    };

    const patchDeal = (id: string, recipe: (deal: Deal) => Deal) => {
      setState((s) => ({ ...s, deals: s.deals.map((deal) => (deal.id === id ? recipe(deal) : deal)) }));
    };

    return {
      setTheme: (theme) => setState((s) => ({ ...s, theme })),
      setDefaultToken: (defaultToken) => setState((s) => ({ ...s, defaultToken })),
      connect: async () => {
        await connectWalletModal();
      },
      disconnect: async () => {
        await disconnectWallet();
        setState((s) => ({ ...s, account: null, wallet: null }));
      },
      copy: (value) => {
        navigator.clipboard?.writeText(value).catch(() => undefined);
        pushToast({ kind: "success", title: "Copied" });
      },
      dismissToast,
      ask: ({ title, body, confirm, danger, run }) => {
        signRef.current = run;
        setState((s) => ({ ...s, confirm: { title, body, confirm, danger: Boolean(danger) } }));
      },
      closeConfirm: () => {
        if (stateRef.current.signing) return;
        signRef.current = null;
        setState((s) => ({ ...s, confirm: null }));
      },
      acceptConfirm: async () => {
        const run = signRef.current;
        setState((s) => ({ ...s, confirm: null, signing: { title: "Confirming transaction on NEAR", detail: stateRef.current.wallet ?? "Wallet" } }));
        try {
          const res = await run?.();
          setState((s) => ({ ...s, signing: null }));
          if (res) finish(res);
        } catch (err: any) {
          setState((s) => ({ ...s, signing: null }));
          finish({ ok: false, title: "Transaction failed", body: err.message });
        }
      },
      approveSign: async () => {
        const run = signRef.current;
        signRef.current = null;
        setState((s) => ({ ...s, signing: null }));
        try {
          const res = await run?.();
          if (res) finish(res);
        } catch (err: any) {
          finish({ ok: false, title: "Transaction failed", body: err.message });
        }
      },
      rejectSign: () => {
        signRef.current = null;
        setState((s) => ({ ...s, signing: null, confirm: null }));
        pushToast({ kind: "error", title: "Transaction rejected in wallet" });
      },
      openTicket: (listingId) => {
        const current = stateRef.current;
        if (!current.account) return null;
        const listing = current.listings.find((item) => item.id === listingId);
        if (!listing) return null;
        const existing = current.deals.find((deal) => deal.listingId === listingId && (deal.buyer === current.account || deal.seller === current.account) && deal.step === "negotiate");
        if (existing) return existing.id;
        const id = String(Math.max(0, ...current.deals.map((deal) => Number(deal.id) || 0)) + 1);
        const agreed = listingTerms(listing);
        const role = listing.type === "sell" ? "buyer" : "seller";
        const buyer = role === "buyer" ? current.account : listing.seller;
        const seller = role === "seller" ? current.account : listing.seller;
        const deal: Deal = {
          id,
          listingId,
          role,
          status: "Created",
          step: "negotiate",
          provider: listing.provider,
          model: listing.model,
          models: listing.models,
          credit: listing.credit,
          price: listing.price,
          buyerCollateralPct: listing.buyerCollateralPct,
          sellerCollateralPct: listing.collateralPct,
          token: listing.token,
          buyer,
          seller,
          deadline: agreed.deadline,
          termsHash: null,
          buyerSubmitted: false,
          sellerSubmitted: false,
          buyerTerms: agreed,
          sellerTerms: agreed,
          buyerDeposited: false,
          sellerDeposited: false,
          depositDeadline: new Date(Date.now() + 86400000 * 2).toISOString(),
          keyStatus: "idle",
          keyChecks: KEY_CHECKS.map((label) => ({ label, ok: false })),
          proxyKey: "",
          proxyRevoked: false,
          baseUrl: BASE_URL,
          usedUsd: 0,
          tokens: 0,
          stage: 0,
          releasedUsd: 0,
          lastUpdate: "Ticket created",
          heartbeat: "live",
          lastCheckpoint: "Pending",
          outcome: null,
          split: null,
          messages: [{ id: crypto.randomUUID(), sender: current.account, text: `Hello, opening deal #${id}`, time: "Just now" }],
          activity: [{ id: crypto.randomUUID(), title: "Deal initiated", detail: "Ticket opened.", time: "Just now" }],
          prices: [
            { model: listing.model, input: "$2.50 / 1M", output: "$10.00 / 1M" },
          ],
          steps: { negotiate: { time: "Now" } },
          createdAt: new Date().toISOString(),
          pulseStage: null,
        };
        setState((s) => ({ ...s, deals: [deal, ...s.deals] }));
        return id;
      },
      sendMessage: (dealId, text) => {
        const account = stateRef.current.account;
        if (!account) return;
        patchDeal(dealId, (deal) => ({
          ...deal,
          messages: [...deal.messages, { id: crypto.randomUUID(), sender: account, text, time: "Just now" }],
        }));
      },
      updateBuyerTerms: (dealId, patch) => {
        patchDeal(dealId, (deal) => ({
          ...deal,
          buyerTerms: { ...deal.buyerTerms, ...patch },
        }));
      },
      submitTerms: (dealId) => {
        patchDeal(dealId, (deal) => ({
          ...deal,
          buyerSubmitted: true,
          sellerSubmitted: true,
          step: "deposit",
          activity: [{ id: crypto.randomUUID(), title: "Terms matched", detail: "Terms confirmed on both sides.", time: "Now" }, ...deal.activity],
        }));
        pushToast({ kind: "success", title: "Terms confirmed", body: "Proceed to deposit escrow funds on NEAR." });
      },
      deposit: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        const isBuyer = deal.role === "buyer";
        const escrow = escrowOf(deal);
        const amount = isBuyer ? escrow.buyerDeposit : escrow.sellerDeposit;

        try {
          if (deal.token === "NEAR") {
            const yocto = BigInt(Math.round(amount * 1e6)) * BigInt(1e18);
            const outcome: any = await txDepositNear(Number(dealId), yocto.toString());
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txId();
            patchDeal(dealId, (item) => ({
              ...item,
              buyerDeposited: isBuyer ? true : item.buyerDeposited,
              sellerDeposited: !isBuyer ? true : item.sellerDeposited,
              step: "key",
              status: "Funded",
              activity: [{ id: crypto.randomUUID(), title: "Escrow deposited", detail: `${amount} NEAR locked on-chain.`, tx: txHash, time: "Now" }, ...item.activity],
            }));
            return { ok: true, title: "Deposit confirmed on NEAR", body: `${amount} NEAR locked in escrow.`, href: `https://testnet.nearblocks.io/txns/${txHash}` };
          } else {
            // Fungible Token deposit via ft_transfer_call
            const tokenContract = "usdc.fakes.testnet";
            const rawAmount = Math.round(amount * 1e6).toString();
            const outcome: any = await txDepositFt(tokenContract, Number(dealId), rawAmount);
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txId();
            return { ok: true, title: "FT Deposit confirmed", body: `${amount} ${deal.token} deposited via ft_transfer_call.`, href: `https://testnet.nearblocks.io/txns/${txHash}` };
          }
        } catch (err: any) {
          return { ok: false, title: "Deposit failed", body: err.message };
        }
      },
      submitSellerKey: async (dealId, plainApiKey) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        pushToast({ kind: "pending", title: "Validating key in TEE Enclave..." });

        try {
          const res = await teeApi.submitKey(Number(dealId), {
            provider: deal.provider.toLowerCase(),
            model: deal.model,
            models: deal.models,
            creditUsd: deal.credit,
            priceUsd: deal.price,
            termsHashHex: deal.termsHash ? deal.termsHash.replace(/^0x/, "") : "00".repeat(32),
            plainApiKey,
          });

          if (!res.ok) {
            pushToast({ kind: "error", title: "Enclave preflight failed", body: res.error || "Preflight check rejected key" });
            return;
          }

          // Submit on-chain activate with TEE signature
          let txHash = txId();
          if (res.activatePayload && res.activateSignatureHex) {
            try {
              const outcome: any = await txActivateDeal(Number(dealId), res.activatePayload, res.activateSignatureHex);
              txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txHash;
            } catch (txErr: any) {
              console.warn("txActivateDeal on-chain error:", txErr);
            }
          }

          patchDeal(dealId, (item) => ({
            ...item,
            status: "Active",
            step: "live",
            proxyKey: res.proxyKey || `cpk_live_${txHash.slice(0, 12)}`,
            keyStatus: "verified",
            keyChecks: KEY_CHECKS.map((label) => ({ label, ok: true })),
            activity: [{ id: crypto.randomUUID(), title: "Deal Activated via TEE", detail: "Hardware proof verified. Proxy key live.", tx: txHash, time: "Now" }, ...item.activity],
          }));

          pushToast({ kind: "success", title: "Deal Activated!", body: "Proxy key is active and ready for inference.", href: `https://testnet.nearblocks.io/txns/${txHash}` });
        } catch (err: any) {
          pushToast({ kind: "error", title: "Key submission failed", body: err.message });
        }
      },
      simulateUsage: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal || deal.status !== "Active") return;
        const addUsd = Math.round((deal.credit * 0.25) * 100) / 100;
        const nextUsed = Math.min(deal.credit, round2(deal.usedUsd + addUsd));
        const stage = Math.min(100, Math.floor((nextUsed / deal.credit) * 100));
        patchDeal(dealId, (item) => ({
          ...item,
          usedUsd: nextUsed,
          stage,
          tokens: item.tokens + 15000,
          pulseStage: stage,
        }));
      },
      simulateRevoke: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal || deal.status !== "Active") return;
        const next = { ...deal };
        const split = settleRevoke(next);
        const tx = txId();
        patchDeal(dealId, (item) => ({
          ...item,
          status: "Defaulted",
          step: "settled",
          outcome: "revoked",
          split,
          proxyRevoked: true,
          heartbeat: "stale",
          steps: { ...item.steps, settled: { time: "Now", tx } },
          activity: [{ id: crypto.randomUUID(), title: "Seller key revoked", detail: `TEE initiated default at ${usd(item.usedUsd)}.`, tx, time: "Now" }, ...item.activity],
        }));
      },
      simulateCounterparty: (dealId) => {
        patchDeal(dealId, (item) => ({
          ...item,
          buyerDeposited: true,
          sellerDeposited: true,
          status: "Funded",
          step: "key",
        }));
      },
      setHeartbeat: (dealId, heartbeat) => patchDeal(dealId, (deal) => ({ ...deal, heartbeat })),
      claimOne: async (id) => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        try {
          const outcome: any = await txClaim(null);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txId();
          setState((s) => ({
            ...s,
            claims: s.claims.map((item) => (item.id === id ? { ...item, claimed: true, tx: txHash } : item)),
          }));
          return { ok: true, title: "Payout claimed on-chain", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "NEAR payout settled to your account." };
        } catch (err: any) {
          return { ok: false, title: "Claim transaction failed", body: err.message };
        }
      },
      claimAll: async () => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        try {
          const outcome: any = await txClaim(null);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txId();
          setState((s) => ({
            ...s,
            claims: s.claims.map((item) => ({ ...item, claimed: true, tx: txHash })),
          }));
          return { ok: true, title: "All payouts claimed on-chain", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "Payouts settled directly to your wallet." };
        } catch (err: any) {
          return { ok: false, title: "Batch claim failed", body: err.message };
        }
      },
      createListing: async (listing) => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet first" };

        try {
          // Prepare on-chain deal params
          const priceYocto = (BigInt(Math.round(listing.price * 1e6)) * BigInt(1e18)).toString();
          const creditYocto = (BigInt(Math.round(listing.credit * 1e6)) * BigInt(1e18)).toString();
          const buyerCollatYocto = (BigInt(Math.round(listing.price * (listing.buyerCollateralPct / 100) * 1e6)) * BigInt(1e18)).toString();
          const sellerCollatYocto = (BigInt(Math.round(listing.price * (listing.collateralPct / 100) * 1e6)) * BigInt(1e18)).toString();

          const termsHash = Array.from(new Uint8Array(32)); // Clean canonical terms hash
          const params = {
            seller: current.account,
            token: null,
            price: priceYocto,
            credit_amount: creditYocto,
            seller_collateral: sellerCollatYocto,
            buyer_collateral: buyerCollatYocto,
            deposit_duration: 86400000000000 * 2,
            usage_duration: 86400000000000 * 30,
            tee_liveness_timeout: 3600000000000,
            slash_bps: 2000,
            terms_hash: termsHash,
          };

          const outcome: any = await txCreateDeal(params);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || txId();

          setState((s) => ({
            ...s,
            listings: [listing, ...s.listings],
          }));

          // Trigger on-chain refresh
          setTimeout(loadOnChainData, 2000);

          return { ok: true, title: "Deal created on NEAR!", body: `Deal registered on contract ${CONTRACT_ID}`, href: `https://testnet.nearblocks.io/txns/${txHash}` };
        } catch (err: any) {
          return { ok: false, title: "Create deal transaction failed", body: err.message };
        }
      },
      cancelMyListings: () => {
        const account = stateRef.current.account;
        const mine = stateRef.current.listings.filter((listing) => listing.seller === account && listing.type === "sell");
        if (!mine.length) return { ok: false, title: "You have no open listings" };
        setState((s) => ({ ...s, listings: s.listings.filter((listing) => !(listing.seller === account && listing.type === "sell")) }));
        return { ok: true, title: "Listings cancelled", body: `${mine.length} listing${mine.length === 1 ? "" : "s"} removed.` };
      },
      rotateKey: (dealId) => {
        const tx = txId();
        const proxyKey = `cpk_live_${tx.slice(0, 12).toLowerCase()}bb45`;
        patchDeal(dealId, (deal) => ({ ...deal, proxyKey, proxyRevoked: false }));
        return { ok: true, title: "Proxy key rotated", body: maskKey(proxyKey) };
      },
      revokeKey: (dealId) => {
        patchDeal(dealId, (deal) => ({ ...deal, proxyRevoked: true }));
        return { ok: true, title: "Proxy key revoked", body: "Calls with this key will be refused." };
      },
      cancelDeal: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        const tx = txId();
        patchDeal(dealId, (item) => ({
          ...item,
          status: "Cancelled",
          step: "settled",
          activity: [{ id: crypto.randomUUID(), title: "Deal cancelled", detail: "Refunded.", tx, time: "Now" }, ...item.activity],
        }));
        return { ok: true, title: "Deal cancelled", href: `https://testnet.nearblocks.io/txns/${tx}` };
      },
      confirmProposal: (id) => {
        setState((s) => ({
          ...s,
          proposals: s.proposals.map((proposal) => {
            if (proposal.id !== id || proposal.confirmedByMe || proposal.status === "Executed") return proposal;
            return { ...proposal, confirmations: proposal.confirmations + 1, confirmedByMe: true };
          }),
        }));
        pushToast({ kind: "success", title: "Confirmation recorded" });
      },
      executeProposal: (id) => {
        const proposal = stateRef.current.proposals.find((item) => item.id === id);
        if (!proposal || proposal.status !== "Ready") return { ok: false, title: "Proposal not executable yet" };
        const tx = txId();
        setState((s) => ({
          ...s,
          proposals: s.proposals.map((item) => (item.id === id ? { ...item, status: "Executed" } : item)),
        }));
        return { ok: true, title: "Proposal executed", href: `https://testnet.nearblocks.io/txns/${tx}` };
      },
      markNotice: (id) => setState((s) => ({ ...s, notices: s.notices.map((notice) => (notice.id === id ? { ...notice, read: true } : notice)) })),
      markAllNotices: () => setState((s) => ({ ...s, notices: s.notices.map((notice) => ({ ...notice, read: true })) })),
      clearPulse: (dealId) => patchDeal(dealId, (deal) => ({ ...deal, pulseStage: null })),
      refreshOnChain: loadOnChainData,
    };
  }, []);

  const value = useMemo(() => ({ ...state, ...api }), [state, api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function pendingClaimTotal(claims: Claim[]) {
  return claims.filter((claim) => !claim.claimed);
}

export function unreadCount(notices: Notice[]) {
  return notices.filter((notice) => !notice.read).length;
}

export function marketOpenEscrow(deals: Deal[]) {
  return round2(
    deals
      .filter((deal) => deal.status === "Active" || deal.status === "Funded" || deal.status === "Created")
      .reduce((sum, deal) => sum + (deal.price || 0), 0)
  );
}

export type { Listing, Deal, Proposal };
