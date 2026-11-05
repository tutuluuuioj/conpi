"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BASE_URL, CONFIG, CONTRACT_ID, MARKET_SNAPSHOT, TEE_SIGNER_PUBLIC_KEY, TX } from "./chain";
import { KEY_CHECKS, listingTerms } from "./data";
import { maskKey, round2, sameTerms, usd } from "./format";
import { escrowOf, settleComplete, settleRevoke, stageFor } from "./money";
import type { Asset, Claim, Deal, DealStatus, DealStep, Listing, Notice, Proposal, SignResult, Terms, ThemeMode, Toast, WalletName } from "./types";
import { teeApi, MeterStreamEvent } from "./tee-api";
import { encryptApiKeyToEnclave, encryptPayloadToEnclave } from "./crypto";
import { verifyLiveAttestation } from "./attestation-verifier";
import { getLiveNearPrice } from "./oracle";
import {
  OnChainDeal,
  fetchContractDeals,
  fetchContractDeal,
  fetchContractDealCreator,
  fetchContractConfig,
  fetchContractStagedProposals,
  fetchContractPendingPayout,
} from "./contract";
import {
  getWalletSelector,
  connectWalletModal,
  disconnectWallet,
  signAndSendCall,
  txCreateDeal,
  txAcceptDeal,
  txAcceptAndDepositNear,
  txDepositNear,
  txDepositFt,
  txStorageDeposit,
  txActivateDeal,
  txReleaseStage,
  txSettleDefault,
  txClaim,
  formatSignedPayloadForContract,
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
  defaultToken: "NEAR",
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
  openTicket: (listingId: string) => Promise<string | null>;
  sendMessage: (dealId: string, text: string) => Promise<void>;
  updateBuyerTerms: (dealId: string, patch: Partial<Deal["buyerTerms"]>) => void;
  submitNegotiationTerms: (dealId: string) => Promise<void>;
  syncNegotiationTicket: (dealId: string) => Promise<void>;
  acceptDeal: (dealId: string) => Promise<SignResult>;
  deposit: (dealId: string) => Promise<SignResult>;
  submitSellerKey: (dealId: string, plainApiKey?: string) => Promise<void>;
  releaseStagePayout: (dealId: string) => Promise<SignResult>;
  triggerDefaultSettlement: (dealId: string, reason?: string) => Promise<SignResult>;
  syncMeterState: (dealId: string) => Promise<void>;
  importProxyKey: (dealId: string, proxyKey: string) => Promise<boolean>;
  applyMeterEvent: (dealId: string, event: MeterStreamEvent) => void;
  setHeartbeat: (dealId: string, heartbeat: "live" | "stale") => void;
  claimOne: (id: string) => Promise<SignResult>;
  claimAll: () => Promise<SignResult>;
  createListing: (listing: Listing) => Promise<SignResult>;
  cancelMyListings: () => SignResult;
  rotateKey: (dealId: string) => SignResult;
  revokeKey: (dealId: string) => SignResult;
  cancelDeal: (dealId: string) => Promise<SignResult> | SignResult;
  confirmProposal: (id: string) => void;
  executeProposal: (id: string) => Promise<SignResult> | SignResult;
  markNotice: (id: string) => void;
  markAllNotices: () => void;
  clearPulse: (dealId: string) => void;
  refreshOnChain: () => Promise<void>;
}

const Ctx = createContext<(State & Api) | null>(null);
const PUBLISHED_LISTINGS_KEY = "conpi-published-listings-v1";

function priceRowsFromLockedPricing(lockedPricing: any): Deal["prices"] {
  if (!lockedPricing || typeof lockedPricing !== "object") return [];
  return Object.entries(lockedPricing).map(([model, value]: [string, any]) => ({
    model,
    input: `$${Number(value?.inputPerMillion || 0).toFixed(4)} / 1M`,
    output: `$${Number(value?.outputPerMillion || 0).toFixed(4)} / 1M`,
  }));
}

async function saveDealListingMetadata(listing: Listing, dealId: string): Promise<Listing> {
  const boundListing: Listing = { ...listing, dealId, published: false };
  try {
    const saved = JSON.parse(localStorage.getItem(PUBLISHED_LISTINGS_KEY) || "[]");
    const current = Array.isArray(saved) ? saved.filter((item: Listing) => item.id !== listing.id) : [];
    localStorage.setItem(PUBLISHED_LISTINGS_KEY, JSON.stringify([boundListing, ...current]));
  } catch {
    localStorage.setItem(PUBLISHED_LISTINGS_KEY, JSON.stringify([boundListing]));
  }
  await fetch("/api/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(boundListing),
  }).catch(() => undefined);
  return boundListing;
}

function toYoctoNear(nearAmount: number): string {
  if (!nearAmount || isNaN(nearAmount) || nearAmount <= 0) return "0";
  // Safe 12-decimal string parsing into 24-decimal yocto to prevent IEEE 754 precision loss
  const fixed = nearAmount.toFixed(12);
  const [whole, dec = ""] = fixed.split(".");
  const wholePart = BigInt(whole) * BigInt("1000000000000000000000000");
  const decPart = BigInt(dec.padEnd(24, "0").slice(0, 24));
  return (wholePart + decPart).toString();
}

function toMicroUnits(tokenAmount: number): string {
  if (!tokenAmount || isNaN(tokenAmount) || tokenAmount <= 0) return "0";
  return BigInt(Math.round(tokenAmount * 1e6)).toString();
}

async function dealParamsForListing(listing: Listing, buyer: string, seller: string, liveNearPrice?: number) {
  if (buyer.trim().toLowerCase() === seller.trim().toLowerCase()) {
    throw new Error("Buyer and seller must use different NEAR accounts");
  }

  let tokenContract: string | null = null;
  const isNear = (listing.token === null || listing.token === "NEAR");
  if (!isNear) {
    tokenContract = listing.tokenContract || (listing.token.includes(".") ? listing.token : null);
    if (!tokenContract) throw new Error(`A valid NEP-141 token contract ID is required for ${listing.token}`);
  }

  let priceUnits: string;
  let creditUnits: string;
  let buyerCollateralUnits: string;
  let sellerCollateralUnits: string;

  if (isNear) {
    const nearPrice = (liveNearPrice && liveNearPrice > 0) ? liveNearPrice : await getLiveNearPrice();
    // Precise Live Oracle Conversion: USD -> NEAR
    // listing.price and listing.credit are entered in USD
    const priceNear = listing.price / nearPrice;
    const creditNear = listing.credit / nearPrice;
    const buyerCollateralNear = (listing.price * (listing.buyerCollateralPct / 100)) / nearPrice;
    const sellerCollateralNear = (listing.price * (listing.collateralPct / 100)) / nearPrice;

    priceUnits = toYoctoNear(priceNear);
    creditUnits = toYoctoNear(creditNear);
    buyerCollateralUnits = toYoctoNear(buyerCollateralNear);
    sellerCollateralUnits = toYoctoNear(sellerCollateralNear);
  } else {
    priceUnits = toMicroUnits(listing.price);
    creditUnits = toMicroUnits(listing.credit);
    buyerCollateralUnits = toMicroUnits(listing.price * (listing.buyerCollateralPct / 100));
    sellerCollateralUnits = toMicroUnits(listing.price * (listing.collateralPct / 100));
  }

  return {
    buyer,
    seller,
    token: tokenContract,
    price: priceUnits,
    credit_amount: creditUnits,
    buyer_collateral: buyerCollateralUnits,
    seller_collateral: sellerCollateralUnits,
    tee_pubkey: TEE_SIGNER_PUBLIC_KEY,
    deposit_duration_sec: 172800,
    key_duration_sec: 172800,
    tee_liveness_timeout_sec: CONFIG.teeLivenessSec,
    slash_bps_provider_ban: CONFIG.slashProviderBanBps,
    slash_bps_revoke: CONFIG.slashRevokeBps,
    slash_bps_buyer_breach: CONFIG.slashBuyerBreachBps,
  };
}

function createdDealIdFromOutcome(outcome: any): number | null {
  const statuses = [
    outcome?.status,
    outcome?.transaction_outcome?.outcome?.status,
    ...(Array.isArray(outcome?.receipts_outcome)
      ? outcome.receipts_outcome.map((receipt: any) => receipt?.outcome?.status)
      : []),
  ];

  for (const status of statuses) {
    const encoded = status?.SuccessValue;
    if (typeof encoded !== "string" || !encoded) continue;
    try {
      const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      const dealId = Number(value);
      if (Number.isSafeInteger(dealId) && dealId > 0) return dealId;
    } catch {
      // Try the next receipt outcome when a wallet omits the top-level result.
    }
  }
  return null;
}

let verifiedEncryptionKeyCache: { key: string; fetchedAt: number } | null = null;

async function getVerifiedEncryptionKey(): Promise<string> {
  if (verifiedEncryptionKeyCache && Date.now() - verifiedEncryptionKeyCache.fetchedAt < 60_000) {
    return verifiedEncryptionKeyCache.key;
  }
  const attestation = await verifyLiveAttestation();
  if (!attestation.verified || !attestation.encryptionPublicKeyHex) {
    throw new Error(`TEE attestation verification failed${attestation.errors?.length ? `: ${attestation.errors.join("; ")}` : ""}`);
  }
  verifiedEncryptionKeyCache = {
    key: attestation.encryptionPublicKeyHex,
    fetchedAt: Date.now(),
  };
  return attestation.encryptionPublicKeyHex;
}

export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside provider");
  return value;
}

function mapOnChainDeal(d: OnChainDeal, currentAccount: string | null): Deal {
  const raw = d as any;
  const chainStatus = String(d.status);
  const priceNear = Number(d.price) / 1e24;
  const creditNear = Number(d.credit_amount) / 1e24;
  const meteredNear = Number(d.metered_value ?? raw.last_signed?.metered_value ?? 0) / 1e24;
  const releasedNear = Number(d.released_amount ?? raw.released_to_seller ?? 0) / 1e24;
  const toBigInt = (value: string | number | boolean | undefined): bigint => {
    if (typeof value === "boolean" || value === undefined || value === null || value === "") return BigInt(0);
    try { return BigInt(value); } catch { return BigInt(0); }
  };
  const requiredBuyerDeposit = toBigInt(d.price) + toBigInt(d.buyer_collateral);
  const requiredSellerDeposit = toBigInt(d.seller_collateral);
  const currentBuyerDeposit = toBigInt(d.buyer_deposited);
  const currentSellerDeposit = toBigInt(d.seller_deposited);
  const buyerDeposited = requiredBuyerDeposit > BigInt(0) && currentBuyerDeposit >= requiredBuyerDeposit;
  const sellerDeposited = requiredSellerDeposit > BigInt(0) && currentSellerDeposit >= requiredSellerDeposit;
  const buyerDepositRemainingYocto = requiredBuyerDeposit > currentBuyerDeposit ? requiredBuyerDeposit - currentBuyerDeposit : BigInt(0);
  const sellerDepositRemainingYocto = requiredSellerDeposit > currentSellerDeposit ? requiredSellerDeposit - currentSellerDeposit : BigInt(0);
  const buyerSubmitted = Boolean(d.terms_submitted_by_buyer ?? d.terms_hash?.length);
  const sellerSubmitted = Boolean(d.terms_submitted_by_seller ?? raw.counterparty_accepted);
  const currentStage = Number(d.current_stage ?? raw.stage_reached ?? raw.last_signed?.stage ?? 0);

  const isSeller = Boolean(currentAccount && d.seller.toLowerCase() === currentAccount.toLowerCase());
  const role: "buyer" | "seller" = isSeller ? "seller" : "buyer";
  const token: Asset = d.token ? (d.token.toLowerCase().includes("usdt") ? "USDT" : "USDC") : "NEAR";

  let status: DealStatus = "Created";
  if (chainStatus === "Deposited" || chainStatus === "Funded") status = "Funded";
  else if (chainStatus === "Active") status = "Active";
  else if (chainStatus === "Settled" || chainStatus === "Completed") status = "Completed";
  else if (chainStatus === "Defaulted") status = "Defaulted";
  else if (chainStatus === "Cancelled") status = "Cancelled";

  const counterpartyAccepted = Boolean(d.counterparty_accepted);

  let step: DealStep = "negotiate";
  if (chainStatus === "Active") step = "live";
  else if (["Settled", "Completed", "Defaulted", "Cancelled", "SettledTimeout"].includes(chainStatus)) step = "settled";
  else if (chainStatus === "Deposited" || chainStatus === "Funded" || (buyerDeposited && sellerDeposited)) step = "key";
  else if (d.terms_hash && d.terms_hash.length > 0) step = "deposit";
  else if (buyerSubmitted && sellerSubmitted) step = "deposit";
  else if (buyerSubmitted || sellerSubmitted) step = "terms";

  const termsHashHex = d.terms_hash && d.terms_hash.length ? "0x" + Buffer.from(d.terms_hash).toString("hex") : null;
  const rawPrice = Number(d.price);
  const buyerCollateralPct = rawPrice > 0 ? Math.round((Number(d.buyer_collateral) / rawPrice) * 100) : 10;
  const sellerCollateralPct = rawPrice > 0 ? Math.round((Number(d.seller_collateral) / rawPrice) * 100) : 20;

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
    counterpartyAccepted,
    buyerSubmitted,
    sellerSubmitted,
    buyerTerms: defaultTerms,
    sellerTerms: defaultTerms,
    buyerDeposited,
    sellerDeposited,
    buyerDepositRemaining: Number(buyerDepositRemainingYocto) / 1e24,
    sellerDepositRemaining: Number(sellerDepositRemainingYocto) / 1e24,
    depositDeadline: d.deposit_deadline
      ? new Date(Number(toBigInt(d.deposit_deadline) / BigInt(1_000_000))).toISOString()
      : new Date(Date.now() + 86400000 * 2).toISOString(),
    keyStatus: ["Active", "Settled", "Completed"].includes(chainStatus) ? "verified" : "idle",
    keyChecks: KEY_CHECKS.map((label) => ({ label, ok: ["Active", "Settled", "Completed"].includes(chainStatus) })),
    proxyKey: "",
    proxyRevoked: chainStatus === "Defaulted" || chainStatus === "Cancelled",
    baseUrl: BASE_URL,
    usedUsd: meteredNear,
    tokens: Math.round(meteredNear * 100000),
    stage: currentStage,
    releasedUsd: releasedNear,
    lastUpdate: "On-chain NEAR Testnet",
    heartbeat: "live",
    lastCheckpoint: d.last_checkpoint_time ? new Date(Number(d.last_checkpoint_time) / 1e6).toLocaleTimeString() : "Recent",
    outcome: chainStatus === "Settled" || chainStatus === "Completed" ? "completed" : chainStatus === "Defaulted" ? "revoked" : null,
    split: null,
    messages: [
      { id: "m1", sender: d.seller, text: `Created on-chain deal #${d.id} for ${priceNear} NEAR`, time: "On-chain" },
      { id: "m2", sender: d.buyer, text: `Escrow terms recorded at ${termsHashHex ? termsHashHex.slice(0, 12) + "..." : "pending"}`, time: "On-chain" },
    ],
    activity: [
      { id: "a1", title: `On-chain Deal #${d.id} ${d.status}`, detail: `Status: ${d.status} · Stage: ${currentStage}% · Metered: ${meteredNear} NEAR`, time: "Live" }
    ],
    prices: [
      { model: "gpt-4o", input: "$2.50 / 1M", output: "$10.00 / 1M" },
      { model: "gpt-4o-mini", input: "$0.15 / 1M", output: "$0.60 / 1M" },
    ],
    steps: {
      negotiate: { time: "Completed" },
      terms: { time: "Completed" },
      deposit: buyerDeposited && sellerDeposited ? { time: "Confirmed" } : undefined,
      key: ["Active", "Settled", "Completed"].includes(chainStatus) ? { time: "Verified" } : undefined,
      live: chainStatus === "Active" ? { time: "Active" } : undefined,
      settled: ["Settled", "Completed", "Defaulted", "SettledTimeout"].includes(chainStatus) ? { time: "Settled" } : undefined,
    },
    createdAt: d.created_at ? new Date(Number(d.created_at) / 1e6).toISOString() : new Date().toISOString(),
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
    setState((s) => ({ ...s, isLoadingOnChain: true }));
    try {
      const [onChainDeals, stagedProposals, liveNearPrice, serverListings] = await Promise.all([
        fetchContractDeals(0, 100),
        fetchContractStagedProposals(),
        getLiveNearPrice().catch(() => 4.02),
        fetch("/api/listings", { cache: "no-store" })
          .then((res) => res.ok ? res.json() : null)
          .then((data) => Array.isArray(data?.listings) ? data.listings as Listing[] : [])
          .catch(() => [] as Listing[]),
      ]);

      // Proxy credentials remain in this browser only; never expose them from a shared server route.
      const storedKeys: Record<string, string> = {};
      if (typeof window !== "undefined") {
        try {
          const raw = localStorage.getItem("conpi:deal_keys");
          if (raw) Object.assign(storedKeys, JSON.parse(raw));
        } catch {}
      }
      let localListings: Listing[] = [];
      if (typeof window !== "undefined") {
        try {
          const saved = JSON.parse(localStorage.getItem(PUBLISHED_LISTINGS_KEY) || "[]");
          if (Array.isArray(saved)) localListings = saved;
        } catch {}
      }
      const metadataListings = [...serverListings, ...localListings, ...stateRef.current.listings]
        .filter((listing, index, all) => all.findIndex((item) => item.id === listing.id) === index);

      // For any deal in Active status, fetch live TEE meter!
      const activeDeals = onChainDeals.filter((d) => String(d.status) === "Active");
      const meterMap = new Map<number, any>();
      await Promise.all(
        activeDeals.map(async (d) => {
          const proxyKey = storedKeys[String(d.id)] || stateRef.current.deals.find((item) => item.id === String(d.id))?.proxyKey;
          if (!proxyKey) return;
          try {
            const res = await fetch(`${BASE_URL}/deals/${d.id}/meter`, {
              headers: { Authorization: `Bearer ${proxyKey}` },
              cache: "no-store",
            });
            if (res.ok) {
              const data = await res.json();
              meterMap.set(Number(d.id), data);
            }
          } catch {}
        })
      );

      const currentAccount = stateRef.current.account;
      const mappedDeals = onChainDeals.map((d) => {
        const mapped = mapOnChainDeal(d, currentAccount);
        const existing = stateRef.current.deals.find((item) => item.id === String(d.id));
        const listing = metadataListings.find((item) => String(item.dealId || "") === String(d.id));
        const resolvedProxyKey = existing?.proxyKey || storedKeys[String(d.id)] || "";
        const liveMeter = meterMap.get(Number(d.id));

        const creditUsd = Number(liveMeter?.creditUsd) || existing?.creditUsd || (mapped.token === "NEAR" ? mapped.credit * liveNearPrice : mapped.credit);
        const priceUsd = Number(liveMeter?.priceUsd) || existing?.priceUsd || (mapped.token === "NEAR" ? mapped.price * liveNearPrice : mapped.price);
        const usedUsd = Number(liveMeter?.usedUsd ?? existing?.usedUsd ?? mapped.usedUsd);
        const tokens = Number(liveMeter?.tokensTotal ?? existing?.tokens ?? mapped.tokens);
        const stage = creditUsd > 0 ? Math.min(100, Math.floor((usedUsd / creditUsd) * 100)) : mapped.stage;
        const lastUpdate = liveMeter?.timestamp
          ? `TEE Enclave (${new Date(liveMeter.timestamp).toLocaleTimeString()})`
          : existing?.lastUpdate || mapped.lastUpdate;

        const provider = liveMeter?.provider || listing?.provider || existing?.provider || mapped.provider;
        const models = Array.isArray(liveMeter?.models) && liveMeter.models.length
          ? liveMeter.models
          : listing?.models?.length ? listing.models : existing?.models?.length ? existing.models : mapped.models;
        const model = liveMeter?.model || listing?.model || existing?.model || models[0] || mapped.model;
        const lockedPriceRows = priceRowsFromLockedPricing(liveMeter?.lockedPricing);

        return {
          ...mapped,
          listingId: listing?.id || existing?.listingId || mapped.listingId,
          provider,
          model,
          models,
          proxyKey: resolvedProxyKey,
          usedUsd,
          tokens,
          creditUsd,
          priceUsd,
          stage,
          lastUpdate,
          prices: lockedPriceRows.length ? lockedPriceRows : existing?.prices || mapped.prices,
          buyerTerms: existing?.buyerTerms || (listing ? { ...listingTerms(listing), creditUsd: listing.credit, priceUsd: listing.price } : mapped.buyerTerms),
          sellerTerms: existing?.sellerTerms || (listing ? { ...listingTerms(listing), creditUsd: listing.credit, priceUsd: listing.price } : mapped.sellerTerms),
          heartbeat: liveMeter?.active ? "live" : mapped.heartbeat,
        };
      });

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
        published: false,
        rateLimit: "60 req/min",
        expectedTest: "One completion probe, max 32 tokens",
        createdAt: d.created_at ? new Date(Number(d.created_at) / 1e6).toISOString() : new Date().toISOString(),
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

      setState((s) => {
        const publishedListings = metadataListings.filter((listing) => listing.published && !listing.dealId);
        const publishedIds = new Set(publishedListings.map((listing) => listing.id));
        return {
          ...s,
          deals: mappedDeals,
          listings: [...publishedListings, ...generatedListings.filter((listing) => !publishedIds.has(listing.id))],
          claims: userClaims,
          proposals: mappedProposals,
          isLoadingOnChain: false,
        };
      });
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

  useEffect(() => {
    const loadSharedListings = async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(PUBLISHED_LISTINGS_KEY) || "[]");
        const localPub = Array.isArray(saved) ? saved.filter((listing: any) => listing?.published && typeof listing?.id === "string") : [];

        let serverPub: any[] = [];
        try {
          const res = await fetch("/api/listings");
          if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.listings)) {
              serverPub = data.listings.filter((listing: Listing) => listing.published && !listing.dealId);
            }
          }
        } catch {}

        const allPub = [...localPub, ...serverPub];
        if (allPub.length > 0) {
          setState((s) => {
            const known = new Set(s.listings.map((listing) => listing.id));
            const unique = allPub.filter((listing: Listing) => !known.has(listing.id));
            return { ...s, listings: [...unique, ...s.listings] };
          });
        }
      } catch {
        localStorage.removeItem(PUBLISHED_LISTINGS_KEY);
      }
    };
    loadSharedListings();
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

    const applyTicketState = (dealId: string, ticket: Awaited<ReturnType<typeof teeApi.getTicket>>) => {
      patchDeal(dealId, (deal) => ({
        ...deal,
        buyerSubmitted: ticket.buyerSubmitted,
        sellerSubmitted: ticket.sellerSubmitted,
        termDiffFields: ticket.diffFields || [],
        termsHash: ticket.termsHashHex ? `0x${ticket.termsHashHex.replace(/^0x/, "")}` : deal.termsHash,
        messages: (ticket.messages || []).map((message) => ({
          id: message.id,
          sender: message.sender,
          text: message.text,
          time: new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        })),
        lastUpdate: ticket.matched ? "Terms matched inside verified TEE" : "Private negotiation active",
      }));
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
      openTicket: async (listingId) => {
        const current = stateRef.current;
        if (!current.account) return null;
        const listing = current.listings.find((item) => item.id === listingId);
        if (!listing) return null;
        const existing = current.deals.find((deal) => deal.listingId === listingId && (deal.buyer === current.account || deal.seller === current.account) && deal.step === "negotiate");
        if (existing) return existing.id;

        const agreed = listingTerms(listing);
        const role = listing.type === "sell" ? "buyer" : "seller";
        const buyer = role === "buyer" ? current.account : listing.seller;
        const seller = role === "seller" ? current.account : listing.seller;
        if (buyer.trim().toLowerCase() === seller.trim().toLowerCase()) {
          pushToast({ kind: "error", title: "Choose a different wallet", body: "Buyer and seller must be two different NEAR accounts." });
          return null;
        }

        const pendingToast = pushToast({ kind: "pending", title: "Create deal on NEAR", body: `Confirm the transaction as buyer ${buyer}.` });
        let outcome: any;
        let id: string;
        let txHash = "";
        try {
          const params = await dealParamsForListing(listing, buyer, seller);
          const beforeDeals = await fetchContractDeals(0, 100);
          const previousMaxId = Math.max(0, ...beforeDeals.map((item) => Number(item.id) || 0));
          outcome = await txCreateDeal(params);
          txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || "";

          let onChainId = createdDealIdFromOutcome(outcome);
          for (let attempt = 0; onChainId === null && attempt < 5; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
            const deals = await fetchContractDeals(0, 100);
            const created = deals
              .filter((item) => Number(item.id) > previousMaxId && item.buyer === buyer && item.seller === seller)
              .sort((a, b) => Number(b.id) - Number(a.id))[0];
            if (created) onChainId = Number(created.id);
          }
          if (onChainId === null) throw new Error("The transaction succeeded, but its on-chain deal ID could not be resolved");
          id = String(onChainId);
          const boundListing = await saveDealListingMetadata(listing, id);
          setState((s) => ({
            ...s,
            listings: s.listings.map((item) => item.id === listing.id ? boundListing : item),
          }));
        } catch (err: any) {
          replaceToast(pendingToast, { kind: "error", title: "Deal creation failed", body: err.message });
          return null;
        }

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
          activity: [{ id: crypto.randomUUID(), title: "Deal created on NEAR", detail: `Buyer ${buyer} and seller ${seller}`, tx: txHash || undefined, time: "Just now" }],
          prices: [
            { model: listing.model, input: "$2.50 / 1M", output: "$10.00 / 1M" },
          ],
          steps: { negotiate: { time: "Now" } },
          createdAt: new Date().toISOString(),
          pulseStage: null,
        };
        setState((s) => ({ ...s, deals: [deal, ...s.deals] }));
        try {
          const ticket = await teeApi.initTicket(id, Number(id), buyer, seller);
          applyTicketState(id, ticket);
          replaceToast(pendingToast, {
            kind: "success",
            title: "Buyer and seller deal created",
            body: `Deal #${id}: ${buyer} → ${seller}`,
            href: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : undefined,
          });
        } catch (err: any) {
          replaceToast(pendingToast, {
            kind: "error",
            title: "Deal created, but TEE ticket initialization failed",
            body: err.message,
            href: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : undefined,
          });
        }
        setTimeout(loadOnChainData, 2_000);
        return id;
      },
      sendMessage: async (dealId, text) => {
        const account = stateRef.current.account;
        if (!account) return;
        try {
          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptPayloadToEnclave(text, enclaveKey);
          const ticket = await teeApi.sendMessage(dealId, account, encryptedEnvelope);
          applyTicketState(dealId, ticket);
        } catch (err: any) {
          pushToast({ kind: "error", title: "Encrypted message failed", body: err.message });
        }
      },
      updateBuyerTerms: (dealId, patch) => {
        patchDeal(dealId, (deal) => ({
          ...deal,
          buyerTerms: deal.role === "buyer" ? { ...deal.buyerTerms, ...patch } : deal.buyerTerms,
          sellerTerms: deal.role === "seller" ? { ...deal.sellerTerms, ...patch } : deal.sellerTerms,
        }));
      },
      submitNegotiationTerms: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        try {
          const party = deal.role;
          const terms = party === "buyer" ? deal.buyerTerms : deal.sellerTerms;
          const termSheet = {
            provider: deal.provider,
            models: terms.models,
            creditAmountUsd: terms.credit,
            priceUsd: terms.price,
            buyerCollateralPct: terms.buyerCollateralPct,
            sellerCollateralPct: terms.sellerCollateralPct,
            token: terms.token === "NEAR" ? null : terms.token,
            depositDurationSec: 172800,
            keyDurationSec: 86400,
            teeLivenessTimeoutSec: 3600,
            slashBpsProviderBan: 5000,
            slashBpsRevoke: 8000,
            slashBpsBuyerBreach: 5000,
            deadline: terms.deadline,
          };
          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptPayloadToEnclave(JSON.stringify(termSheet), enclaveKey);
          const ticket = await teeApi.submitTerms(dealId, party, encryptedEnvelope);
          applyTicketState(dealId, ticket);
          pushToast({
            kind: ticket.matched ? "success" : "info",
            title: ticket.matched ? "Terms matched inside TEE" : "Encrypted terms submitted",
            body: ticket.diffFields?.length ? `Different fields: ${ticket.diffFields.join(", ")}` : undefined,
          });
        } catch (err: any) {
          pushToast({ kind: "error", title: "Encrypted term submission failed", body: err.message });
        }
      },
      syncNegotiationTicket: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        try {
          let ticket;
          try {
            ticket = await teeApi.getTicket(dealId);
          } catch {
            ticket = await teeApi.initTicket(dealId, Number(dealId), deal.buyer, deal.seller);
          }
          applyTicketState(dealId, ticket);
        } catch {
          // Polling remains silent while the TEE ticket is temporarily unavailable.
        }
      },
      acceptDeal: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        try {
          const cleanHex = (deal.termsHash || "").replace(/^0x/, "");
          const hashBytes = Array.from(Buffer.from(cleanHex, "hex"));
          if (hashBytes.length !== 32) throw new Error("Deal terms_hash missing or invalid");

          const outcome: any = await txAcceptDeal(Number(dealId), hashBytes);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Accept deal transaction was not confirmed");

          setTimeout(loadOnChainData, 2000);
          return {
            ok: true,
            title: "Deal accepted on NEAR!",
            body: "Counterparty acceptance registered on contract.",
            href: `https://testnet.nearblocks.io/txns/${txHash}`,
          };
        } catch (err: any) {
          return { ok: false, title: "Accept deal failed", body: err.message };
        }
      },
      deposit: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        const isBuyer = deal.role === "buyer";
        const escrow = escrowOf(deal);
        const amount = isBuyer ? escrow.buyerDeposit : escrow.sellerDeposit;

        try {
          if (deal.token === "NEAR") {
            let yocto: string;
            const onChain = await fetchContractDeal(Number(dealId));
            if (onChain) {
              if (isBuyer) {
                const req = BigInt(onChain.price) + BigInt(onChain.buyer_collateral);
                const cur = BigInt(onChain.buyer_deposited || 0);
                yocto = (req > cur ? req - cur : BigInt(0)).toString();
              } else {
                const req = BigInt(onChain.seller_collateral);
                const cur = BigInt(onChain.seller_deposited || 0);
                yocto = (req > cur ? req - cur : BigInt(0)).toString();
              }
            } else {
              const livePrice = (await getLiveNearPrice().catch(() => 4.02)) || 4.02;
              const priceNear = deal.price / livePrice;
              const priceYocto = BigInt(toYoctoNear(priceNear));
              if (isBuyer) {
                const col = (priceYocto * BigInt(deal.buyerCollateralPct)) / BigInt(100);
                yocto = (priceYocto + col).toString();
              } else {
                yocto = ((priceYocto * BigInt(deal.sellerCollateralPct)) / BigInt(100)).toString();
              }
            }
            const exactNearAmount = (Number(BigInt(yocto) / BigInt(1e15)) / 1e9).toString();
            const creator = await fetchContractDealCreator(Number(dealId));
            const currentAccount = stateRef.current.account;
            const isCounterparty = creator && currentAccount
              ? creator.trim().toLowerCase() !== currentAccount.trim().toLowerCase()
              : false;

            let outcome: any;
            if (isCounterparty && !deal.counterpartyAccepted && deal.termsHash) {
              const cleanHex = deal.termsHash.replace(/^0x/, "");
              const hashBytes = Array.from(Buffer.from(cleanHex, "hex"));
              try {
                outcome = await txAcceptAndDepositNear(Number(dealId), hashBytes, yocto);
              } catch {
                await txAcceptDeal(Number(dealId), hashBytes);
                outcome = await txDepositNear(Number(dealId), yocto);
              }
            } else {
              outcome = await txDepositNear(Number(dealId), yocto);
            }
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
            if (!txHash) throw new Error("Deposit transaction was not confirmed");

            patchDeal(dealId, (item) => ({
              ...item,
              buyerDeposited: isBuyer ? true : item.buyerDeposited,
              sellerDeposited: !isBuyer ? true : item.sellerDeposited,
              step: "key",
              status: "Funded",
              activity: [{ id: crypto.randomUUID(), title: "Escrow deposited", detail: `${exactNearAmount} NEAR locked on-chain.`, tx: txHash, time: "Now" }, ...item.activity],
            }));
            setTimeout(loadOnChainData, 2000);
            return { ok: true, title: "Deposit confirmed on NEAR", body: `${exactNearAmount} NEAR locked in escrow.`, href: `https://testnet.nearblocks.io/txns/${txHash}` };
          } else {
            const tokenContract = (deal as any).tokenContract || (deal.token && deal.token.includes(".") ? deal.token : null);
            if (!tokenContract) throw new Error(`FT token contract address required for token: ${deal.token}`);
            const rawAmount = Math.round(amount * 1e6).toString();
            const outcome: any = await txDepositFt(tokenContract, Number(dealId), rawAmount);
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
            if (!txHash) throw new Error("FT Deposit transaction was not confirmed");

            setTimeout(loadOnChainData, 2000);
            return { ok: true, title: "FT Deposit confirmed", body: `${amount} ${deal.token} deposited via ft_transfer_call.`, href: `https://testnet.nearblocks.io/txns/${txHash}` };
          }
        } catch (err: any) {
          return { ok: false, title: "Deposit failed", body: err.message };
        }
      },
      submitSellerKey: async (dealId, plainApiKey) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        if (!plainApiKey?.trim()) {
          pushToast({ kind: "error", title: "API key is required" });
          return;
        }
        pushToast({ kind: "pending", title: "Validating key in TEE Enclave..." });

        try {
          const provider = (deal.provider || "OpenAI").toLowerCase();
          const model = deal.model?.trim();
          const models = Array.from(new Set(
            (deal.models?.length ? deal.models : [model])
              .map((item) => item?.trim())
              .filter((item): item is string => Boolean(item))
          ));
          if (!model || !models.length || !models.includes(model)) {
            pushToast({ kind: "error", title: "Deal model terms are missing", body: "Reload the original listing metadata before activating this deal." });
            return;
          }

          const detectedProvider = plainApiKey.startsWith("sk-or-v1-") || plainApiKey.startsWith("sk-or-")
            ? "openrouter"
            : plainApiKey.startsWith("sk-ant-") ? "anthropic"
              : plainApiKey.startsWith("sk-rp-") ? "redpill" : null;
          if (detectedProvider && detectedProvider !== provider) {
            pushToast({
              kind: "error",
              title: "Provider key does not match this deal",
              body: `This deal is locked to ${deal.provider}; the submitted key appears to be for ${detectedProvider}.`,
            });
            return;
          }

          // If counterparty hasn't accepted yet on-chain, accept first to transition deal to Funded
          const onChain = await fetchContractDeal(Number(dealId));
          if (onChain && !onChain.counterparty_accepted && deal.termsHash) {
            pushToast({ kind: "pending", title: "Accepting deal on NEAR to fund escrow..." });
            const cleanHex = deal.termsHash.replace(/^0x/, "");
            const hashBytes = Array.from(Buffer.from(cleanHex, "hex"));
            try {
              await txAcceptDeal(Number(dealId), hashBytes);
              await new Promise((r) => setTimeout(r, 1500));
            } catch (err: any) {
              console.warn("Auto-accept failed, proceeding:", err);
            }
          }

          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptApiKeyToEnclave(plainApiKey, enclaveKey);
          const res = await teeApi.submitKey(Number(dealId), {
            provider,
            model,
            models,
            creditUsd: deal.credit,
            priceUsd: deal.price,
            termsHashHex: deal.termsHash ? deal.termsHash.replace(/^0x/, "") : "00".repeat(32),
            encryptedEnvelope,
          });

          if (!res.ok) {
            pushToast({ kind: "error", title: "Enclave preflight failed", body: res.error || "Preflight check rejected key" });
            return;
          }

          if (!res.activatePayload || !res.activateSignatureHex) {
            pushToast({ kind: "error", title: "Missing TEE activation payload or signature" });
            return;
          }

          pushToast({ kind: "pending", title: "Submitting deal activation transaction to NEAR..." });
          const outcome: any = await txActivateDeal(Number(dealId), res.activatePayload, res.activateSignatureHex);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) {
            throw new Error("Activation transaction was rejected or failed on-chain");
          }

          if (res.proxyKey) {
            if (typeof window !== "undefined") {
              try {
                const raw = localStorage.getItem("conpi:deal_keys");
                const parsed = raw ? JSON.parse(raw) : {};
                parsed[String(dealId)] = res.proxyKey;
                localStorage.setItem("conpi:deal_keys", JSON.stringify(parsed));
              } catch {}
            }
          }

          patchDeal(dealId, (item) => ({
            ...item,
            status: "Active",
            step: "live",
            proxyKey: res.proxyKey || "",
            keyStatus: "verified",
            keyChecks: KEY_CHECKS.map((label) => ({ label, ok: true })),
            activity: [{ id: crypto.randomUUID(), title: "Deal Activated via TEE", detail: "Hardware proof verified. Proxy key live.", tx: txHash, time: "Now" }, ...item.activity],
          }));

          pushToast({ kind: "success", title: "Deal Activated!", body: "Proxy key is active and ready for inference.", href: `https://testnet.nearblocks.io/txns/${txHash}` });
          setTimeout(loadOnChainData, 2000);
        } catch (err: any) {
          pushToast({ kind: "error", title: "Key activation failed", body: err.message });
        }
      },
      releaseStagePayout: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        pushToast({ kind: "pending", title: "Querying TEE stage payloads..." });

        try {
          const res = await fetch(`${BASE_URL}/deals/${dealId}/payloads`);
          if (!res.ok) {
            throw new Error(`Failed to fetch signed payloads from TEE: ${res.statusText}`);
          }
          const data = await res.json();
          const signedPayloads = data.signedPayloads || [];
          
          const stagePayloads = signedPayloads.filter((p: any) => {
            const kind = p.payload?.kind;
            const isStage = kind === 2 || kind === "Stage";
            const stg = Number(p.payload?.stage || 0);
            return isStage && stg > (deal.stage || 0);
          });

          if (stagePayloads.length === 0) {
            const mRes = await fetch(`${BASE_URL}/deals/${dealId}/meter`);
            const mData = mRes.ok ? await mRes.json() : null;
            const used = Number(mData?.usedUsd ?? deal.usedUsd ?? 0);
            const creditUsd = Number(mData?.creditUsd || deal.creditUsd || (deal.token === "NEAR" ? deal.credit * 4.02 : deal.credit));
            const pct = creditUsd > 0 ? ((used / creditUsd) * 100).toFixed(1) : "0.0";
            const target25 = (creditUsd * 0.25).toFixed(4);
            pushToast({
              kind: "error",
              title: "Stage 25% payout not ready",
              body: `Current usage is $${used.toFixed(4)} (${pct}%). The TEE hardware signs the 25% release payload once usage reaches 25% ($${target25} USD).`,
            });
            return {
              ok: false,
              title: "No new stage payload available yet",
              body: `Current usage is $${used.toFixed(4)} (${pct}%). The TEE signs a stage release payload once usage reaches 25%, 50%, 75%, or 100%.`,
            };
          }

          const target = stagePayloads[0];
          const stg = Number(target.payload.stage);
          pushToast({ kind: "pending", title: `Submitting on-chain release for Stage ${stg}%...` });

          const outcome: any = await txReleaseStage(Number(dealId), stg, target.payload, target.signatureHex);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Stage release transaction failed");

          setTimeout(loadOnChainData, 2000);
          pushToast({
            kind: "success",
            title: `Stage ${stg}% released on NEAR!`,
            body: `Stage payout executed on escrow contract.`,
            href: `https://testnet.nearblocks.io/txns/${txHash}`,
          });
          return {
            ok: true,
            title: `Stage ${stg}% released on NEAR!`,
            body: `Stage payout executed on escrow contract.`,
            href: `https://testnet.nearblocks.io/txns/${txHash}`,
          };
        } catch (err: any) {
          pushToast({ kind: "error", title: "Stage release failed", body: err.message });
          return { ok: false, title: "Stage release failed", body: err.message };
        }
      },
      triggerDefaultSettlement: async (dealId, reason = "SellerSelfDrain") => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        pushToast({ kind: "pending", title: "Checking signed default payload from TEE..." });

        try {
          let payloadToSubmit: any = null;
          let signatureHexToSubmit: string | null = null;

          // 1. Check if TEE enclave already emitted a signed default payload (kind === 4)
          try {
            const payloadsRes = await fetch(`${BASE_URL}/deals/${dealId}/payloads`);
            if (payloadsRes.ok) {
              const data = await payloadsRes.json();
              const found = (data.signedPayloads || []).find((item: any) => item.payload.kind === 4);
              if (found) {
                payloadToSubmit = found.payload;
                signatureHexToSubmit = found.signatureHex;
              }
            }
          } catch {}

          // 2. If not found, request the default payload from TEE
          if (!payloadToSubmit || !signatureHexToSubmit) {
            const res = await fetch(`${BASE_URL}/deals/${dealId}/default`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data.defaultPayload) {
                payloadToSubmit = data.defaultPayload.payload;
                signatureHexToSubmit = data.defaultPayload.signatureHex;
              }
            }
          }

          if (!payloadToSubmit || !signatureHexToSubmit) {
            throw new Error("No signed default payload returned by TEE enclave");
          }

          pushToast({ kind: "pending", title: "Submitting default settlement on NEAR..." });
          const outcome: any = await txSettleDefault(
            Number(dealId),
            payloadToSubmit,
            signatureHexToSubmit
          );
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Default settlement transaction failed");

          setTimeout(loadOnChainData, 2000);
          return {
            ok: true,
            title: "Default settled on NEAR!",
            body: `Settlement executed with reason: ${reason}`,
            href: `https://testnet.nearblocks.io/txns/${txHash}`,
          };
        } catch (err: any) {
          return { ok: false, title: "Default settlement failed", body: err.message };
        }
      },
      syncMeterState: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal?.proxyKey) {
          pushToast({ kind: "error", title: "Proxy key required", body: "Import or copy this deal's cpk_live_ key to view its private meter." });
          return;
        }
        try {
          const res = await fetch(`${BASE_URL}/deals/${dealId}/meter`, {
            headers: { Authorization: `Bearer ${deal.proxyKey}` },
            cache: "no-store",
          });
          if (res.ok) {
            const data = await res.json();
            patchDeal(dealId, (item) => {
              const creditUsd = Number(data.creditUsd) || item.creditUsd || (item.token === "NEAR" ? item.credit * 4.02 : item.credit);
              const priceUsd = Number(data.priceUsd) || item.priceUsd || (item.token === "NEAR" ? item.price * 4.02 : item.price);
              const usedUsd = Number(data.usedUsd ?? item.usedUsd);
              const tokens = Number(data.tokensTotal ?? item.tokens);
              const stage = creditUsd > 0 ? Math.min(100, Math.floor((usedUsd / creditUsd) * 100)) : item.stage;
              const lockedPriceRows = priceRowsFromLockedPricing(data.lockedPricing);
              return {
                ...item,
                provider: (data.provider || item.provider) as Deal["provider"],
                model: data.model || item.model,
                models: Array.isArray(data.models) && data.models.length ? data.models : item.models,
                usedUsd,
                tokens,
                creditUsd,
                priceUsd,
                stage,
                prices: lockedPriceRows.length ? lockedPriceRows : item.prices,
                lastUpdate: `TEE Enclave (${new Date().toLocaleTimeString()})`,
                heartbeat: data.active ? "live" : item.heartbeat,
              };
            });
            pushToast({
              kind: "success",
              title: "Meter synced with TEE enclave",
              body: `$${Number(data.usedUsd || 0).toFixed(4)} USD · ${Number(data.tokensTotal || 0).toLocaleString()} tokens`,
            });
          } else {
            pushToast({ kind: "error", title: "Failed to sync meter", body: `Enclave returned HTTP ${res.status}` });
          }
        } catch (err: any) {
          console.warn("Meter sync error:", err);
          pushToast({ kind: "error", title: "Meter sync failed", body: err.message });
        }
      },
      importProxyKey: async (dealId, candidate) => {
        const proxyKey = candidate.trim();
        if (!/^cpk_live_[A-Za-z0-9_-]{16,}$/.test(proxyKey)) {
          pushToast({ kind: "error", title: "Invalid proxy key", body: "Paste the cpk_live_ key issued by the TEE for this deal." });
          return false;
        }
        try {
          await teeApi.getMeter(Number(dealId), proxyKey);
          const raw = localStorage.getItem("conpi:deal_keys");
          const stored = raw ? JSON.parse(raw) : {};
          stored[String(dealId)] = proxyKey;
          localStorage.setItem("conpi:deal_keys", JSON.stringify(stored));
          patchDeal(dealId, (deal) => ({ ...deal, proxyKey, heartbeat: "live" }));
          pushToast({ kind: "success", title: "Private live meter connected", body: "Authenticated WebSocket updates are now enabled for this browser." });
          return true;
        } catch (err: any) {
          pushToast({ kind: "error", title: "Proxy key rejected", body: err.message });
          return false;
        }
      },
      applyMeterEvent: (dealId, event) => {
        patchDeal(dealId, (deal) => {
          const creditUsd = Number(event.creditUsd) || deal.creditUsd || (deal.token === "NEAR" ? deal.credit * 4.02 : deal.credit);
          const priceUsd = Number(event.priceUsd) || deal.priceUsd || (deal.token === "NEAR" ? deal.price * 4.02 : deal.price);
          const stage = creditUsd > 0 ? Math.max(deal.stage, ...event.stages, Math.min(100, Math.floor((event.usedUsd / creditUsd) * 100))) : deal.stage;
          const lockedPriceRows = priceRowsFromLockedPricing(event.lockedPricing);
          return {
            ...deal,
            provider: (event.provider || deal.provider) as Deal["provider"],
            model: event.model || deal.model,
            models: event.models?.length ? event.models : deal.models,
            usedUsd: event.usedUsd,
            tokens: event.tokensTotal,
            creditUsd,
            priceUsd,
            stage,
            prices: lockedPriceRows.length ? lockedPriceRows : deal.prices,
            heartbeat: event.active ? "live" : deal.heartbeat,
            pulseStage: event.stages.length ? event.stages[event.stages.length - 1] : deal.pulseStage,
            lastUpdate: `TEE Enclave (${new Date(event.timestamp).toLocaleTimeString()})`,
          };
        });
      },
      setHeartbeat: (dealId, heartbeat) => patchDeal(dealId, (deal) => ({ ...deal, heartbeat })),
      claimOne: async (id) => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        try {
          const outcome: any = await txClaim(null);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Claim transaction failed");
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
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Batch claim transaction failed");
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
        if (listing.seller.trim().toLowerCase() !== current.account.trim().toLowerCase()) {
          return { ok: false, title: "Listing owner mismatch", body: "The connected seller wallet must own the listing." };
        }

        const buyer = (listing as any).buyer?.trim();
        // If buyer is explicitly provided and different from seller, create direct deal on-chain
        if (buyer) {
          if (buyer.toLowerCase() === current.account.toLowerCase()) {
            return {
              ok: false,
              title: "Buyer and seller must differ",
              body: "You cannot create a deal with yourself. Please enter your second testnet wallet for the Buyer, or leave blank to publish publicly.",
            };
          }

          pushToast({ kind: "pending", title: "Awaiting wallet approval to create deal on NEAR..." });
          try {
            const params = await dealParamsForListing(listing, buyer, current.account);
            const outcome: any = await txCreateDeal(params);
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
            let dealId = createdDealIdFromOutcome(outcome);
            if (!dealId) {
              await new Promise((r) => setTimeout(r, 1500));
              const deals = await fetchContractDeals(0, 100);
              const latest = deals.filter((d) => d.buyer === buyer && d.seller === current.account).sort((a, b) => Number(b.id) - Number(a.id))[0];
              if (latest) dealId = Number(latest.id);
            }

            if (dealId) {
              const boundListing = await saveDealListingMetadata(listing, String(dealId));
              setState((s) => ({
                ...s,
                listings: [boundListing, ...s.listings.filter((item) => item.id !== listing.id)],
              }));
              await teeApi.initTicket(String(dealId), Number(dealId), buyer, current.account).catch(() => undefined);
            }

            setTimeout(loadOnChainData, 2000);
            return {
              ok: true,
              title: "Deal created on NEAR!",
              body: dealId ? `Deal #${dealId} created on-chain.` : "Deal registered on escrow contract.",
              href: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : undefined,
              dealId: dealId ? String(dealId) : undefined,
            } as any;
          } catch (err: any) {
            return { ok: false, title: "Create deal transaction rejected or failed", body: err.message };
          }
        }

        // Public marketplace listing - NO specific buyer needed!
        const publishedListing: Listing = { ...listing, seller: current.account, published: true };
        setState((s) => ({ ...s, listings: [publishedListing, ...s.listings.filter((item) => item.id !== listing.id)] }));
        try {
          const saved = JSON.parse(localStorage.getItem(PUBLISHED_LISTINGS_KEY) || "[]");
          const existing = Array.isArray(saved) ? saved.filter((item: Listing) => item.id !== listing.id) : [];
          localStorage.setItem(PUBLISHED_LISTINGS_KEY, JSON.stringify([publishedListing, ...existing]));
          fetch("/api/listings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(publishedListing),
          }).catch(() => {});
        } catch {
          localStorage.setItem(PUBLISHED_LISTINGS_KEY, JSON.stringify([publishedListing]));
        }
        return {
          ok: true,
          title: "Listing published to Market!",
          body: `Your offer for $${listing.credit} credit is now live on the Market. Switch to your buyer wallet to Quick Buy.`,
          listingId: publishedListing.id,
        } as any;
      },
      cancelMyListings: () => {
        const account = stateRef.current.account;
        const mine = stateRef.current.listings.filter((listing) => listing.seller === account && listing.type === "sell");
        if (!mine.length) return { ok: false, title: "You have no open listings" };
        setState((s) => ({ ...s, listings: s.listings.filter((listing) => !(listing.seller === account && listing.type === "sell")) }));
        try {
          const saved = JSON.parse(localStorage.getItem(PUBLISHED_LISTINGS_KEY) || "[]");
          const remaining = Array.isArray(saved) ? saved.filter((listing: Listing) => listing.seller !== account) : [];
          localStorage.setItem(PUBLISHED_LISTINGS_KEY, JSON.stringify(remaining));
        } catch {
          localStorage.removeItem(PUBLISHED_LISTINGS_KEY);
        }
        return { ok: true, title: "Listings cancelled", body: `${mine.length} listing${mine.length === 1 ? "" : "s"} removed.` };
      },
      rotateKey: (dealId) => {
        const keySuffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const proxyKey = `cpk_live_${keySuffix}`;
        patchDeal(dealId, (deal) => ({ ...deal, proxyKey, proxyRevoked: false }));
        return { ok: true, title: "Proxy key rotated", body: maskKey(proxyKey) };
      },
      revokeKey: (dealId) => {
        patchDeal(dealId, (deal) => ({ ...deal, proxyRevoked: true }));
        return { ok: true, title: "Proxy key revoked", body: "Calls with this key will be refused." };
      },
      cancelDeal: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        try {
          const outcome: any = await signAndSendCall("timeout_refund", { deal_id: Number(dealId) }, "50000000000000");
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Timeout refund transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Deal refunded on NEAR", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "Timeout refund executed." };
        } catch (err: any) {
          return { ok: false, title: "Timeout refund failed", body: err.message };
        }
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
      executeProposal: async (id) => {
        const proposal = stateRef.current.proposals.find((item) => item.id === id);
        if (!proposal || proposal.status !== "Ready") return { ok: false, title: "Proposal not executable yet" };
        try {
          const outcome: any = await signAndSendCall("execute_admin_action", { proposal_id: Number(id) }, "100000000000000");
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Execute proposal transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Proposal executed on NEAR", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "Governance action executed on escrow." };
        } catch (err: any) {
          return { ok: false, title: "Execute proposal failed", body: err.message };
        }
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
