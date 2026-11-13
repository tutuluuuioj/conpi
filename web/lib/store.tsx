"use client";

import "@/lib/polyfill";
import { Buffer } from "buffer";
if (typeof window !== "undefined") {
  (window as any).Buffer = (window as any).Buffer || Buffer;
}

export function bytesToHex(bytes: number[] | Uint8Array | null | undefined): string {
  if (!bytes || !bytes.length) return "";
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function sendClientDebugLog(msg: any) {
  if (typeof window !== "undefined") {
    fetch("/api/debug-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }
}

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BASE_URL, CONFIG, CONTRACT_ID, MARKET_SNAPSHOT, TEE_SIGNER_PUBLIC_KEY, TX } from "./chain";
import { KEY_CHECKS, listingTerms } from "./data";
import { maskKey, round2, sameTerms, usd } from "./format";
import { escrowOf, settleComplete, settleRevoke, stageFor } from "./money";
import type { Asset, Claim, Deal, DealStatus, DealStep, Listing, Notice, Proposal, Provider, SignResult, Terms, ThemeMode, Toast, WalletName, WalletChain } from "./types";
import { teeApi, MeterStreamEvent } from "./tee-api";
import { encryptApiKeyToEnclave, encryptPayloadToEnclave } from "./crypto";
import { verifyLiveAttestation } from "./attestation-verifier";
import { getLiveNearPrice } from "./oracle";
import { deriveForeignVaultAddress, BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, computeForeignTransferSighash } from "./chain-signatures";
import { connectMetaMask, disconnectEvmWallet } from "./evm-wallet";
import { connectSolanaWallet, disconnectSolanaWallet, signSolanaDealAcceptance } from "./solana-wallet";
import { toNearAccountId, fromNearAccountId, isValidNearAccountId } from "./near-account";
import { MAKER_VAULT_CONFIG } from "./maker-vault";
import { signSellerKeyAuthorization } from "./seller-key-auth";
import {
  OnChainDeal,
  fetchContractDeals,
  fetchContractDeal,
  fetchContractDealCreator,
  fetchContractConfig,
  fetchContractStagedProposals,
  fetchContractPendingPayout,
  fetchContractForeignDeal,
} from "./contract";
import {
  getWalletSelector,
  connectWalletModal,
  disconnectWallet,
  signAndSendCall,
  txCreateDeal,
  txRegisterForeignChainDeal,
  txAcceptDeal,
  txAcceptAndDepositNear,
  txDepositNear,
  txDepositFt,
  txStorageDeposit,
  txActivateDeal,
  txReleaseStage,
  txReleaseStageForeign,
  txSettleDefault,
  txSettleDefaultForeign,
  txRecordForeignDeposit,
  txClaim,
  txTimeoutRefundForeign,
  txClaimSellerForeignPayout,
  txSetForeignSellerAddress,
  txSetForeignBuyerAddress,
  txRequestAutoRelease,
  txFinalizeAutoRelease,
  txFinalizeAutoReleaseForeign,
  formatSignedPayloadForContract,
} from "./wallet";

interface State {
  theme: ThemeMode;
  account: string | null;
  wallet: WalletName | null;
  walletChain: WalletChain;
  nearAccount: string | null;
  evmAccount: string | null;
  solanaAccount: string | null;
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
  isConnectModalOpen: boolean;
}

const seed: State = {
  theme: "dark",
  account: null,
  wallet: null,
  walletChain: "near",
  nearAccount: null,
  evmAccount: null,
  solanaAccount: null,
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
  isConnectModalOpen: false,
};

interface Api {
  setTheme: (theme: ThemeMode) => void;
  setDefaultToken: (token: Asset) => void;
  connect: (wallet?: WalletName) => void;
  openConnectModal: () => void;
  closeConnectModal: () => void;
  connectEvm: (walletName?: "MetaMask" | "Coinbase") => Promise<string>;
  connectSolana: (walletName?: "Phantom" | "Solflare") => Promise<string>;
  disconnect: () => void;
  disconnectEvm: () => void;
  disconnectSolana: () => void;
  switchActiveChain: (chain: "near" | "evm" | "solana") => void;
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
  proposeTerms: (dealId: string, patch: Partial<Deal["buyerTerms"]>) => Promise<void>;
  acceptProposal: (dealId: string, proposal: any) => Promise<void>;
  createNegotiatedDeal: (dealId: string) => Promise<string | null>;
  submitNegotiationTerms: (dealId: string) => Promise<void>;
  syncNegotiationTicket: (dealId: string) => Promise<void>;
  acceptDeal: (dealId: string) => Promise<SignResult>;
  deposit: (dealId: string) => Promise<SignResult>;
  depositForeignBaseUsdc: (
    dealId: string,
    evmTxHash: string,
    buyerEvmAddress?: string,
    sellerEvmAddress?: string
  ) => Promise<SignResult>;
  depositSolanaCollateral: (dealId: string, solanaTxSignature: string) => Promise<SignResult>;
  depositUsdcViaMakerVault: (
    dealId: string,
    chain: "base" | "solana" | "near",
    txHash: string,
    amountUsdc: number,
    buyerAddress?: string,
    sellerPayoutChain?: "base" | "solana" | "near",
    sellerPayoutAddress?: string
  ) => Promise<SignResult>;
  submitSellerKey: (dealId: string, plainApiKey?: string) => Promise<void>;
  releaseStagePayout: (dealId: string) => Promise<SignResult>;
  triggerDefaultSettlement: (dealId: string, reason?: string) => Promise<SignResult>;
  syncMeterState: (dealId: string, silent?: boolean) => Promise<void>;
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
  claimSellerForeignPayout?: (dealId: string) => Promise<SignResult>;
  setForeignSellerAddress?: (dealId: string, sellerAddress: string) => Promise<SignResult>;
  setForeignBuyerAddress?: (dealId: string, buyerAddress: string) => Promise<SignResult>;
  requestAutoRelease?: (dealId: string) => Promise<SignResult>;
  finalizeAutoRelease?: (dealId: string) => Promise<SignResult>;
  confirmProposal: (id: string) => void;
  executeProposal: (id: string) => Promise<SignResult> | SignResult;
  markNotice: (id: string) => void;
  markAllNotices: () => void;
  clearPulse: (dealId: string) => void;
  refreshOnChain: () => Promise<void>;
  pushToast: (toast: Omit<Toast, "id">) => string;
}

const Ctx = createContext<(State & Api) | null>(null);
const PUBLISHED_LISTINGS_KEY = "conpi-published-listings-v1";
const DEAL_DEPOSIT_DURATION_SEC = 3_600;
const DEAL_KEY_DURATION_SEC = 3_600;

function withExplicitListingUsd(listing: Listing): Listing {
  return {
    ...listing,
    creditUsd: listing.creditUsd ?? listing.credit,
    priceUsd: listing.priceUsd ?? listing.price,
  };
}

export const KNOWN_PRICING: Record<string, { input: string; output: string }> = {
  "minimax/minimax-m3.1-flash": { input: "$0.1500 / 1M", output: "$0.6000 / 1M" },
  "deepseek/deepseek-v4-flash-0731": { input: "$0.0566 / 1M", output: "$0.3000 / 1M" },
  "deepseek/deepseek-v4.1-flash-1017": { input: "$0.0566 / 1M", output: "$0.3000 / 1M" },
  "z-ai/glm-5.3-flash": { input: "$0.0566 / 1M", output: "$0.3000 / 1M" },
  "claude-sonnet-4-6": { input: "$3.0000 / 1M", output: "$15.0000 / 1M" },
  "anthropic/claude-sonnet-4.6": { input: "$3.0000 / 1M", output: "$15.0000 / 1M" },
  "meta-llama/llama-3-70b": { input: "$0.5900 / 1M", output: "$0.7900 / 1M" },
  "gpt-4o": { input: "$2.5000 / 1M", output: "$10.0000 / 1M" },
  "gpt-4o-mini": { input: "$0.1500 / 1M", output: "$0.6000 / 1M" },
};

export function defaultPricesForModels(models: string[]): Deal["prices"] {
  const list = models && models.length ? models : ["gpt-4o", "gpt-4o-mini"];
  return list.map((m) => {
    const known = KNOWN_PRICING[m] || KNOWN_PRICING[m.toLowerCase()];
    if (known) return { model: m, input: known.input, output: known.output };
    return { model: m, input: "$0.0566 / 1M", output: "$0.3000 / 1M" };
  });
}

function priceRowsFromLockedPricing(lockedPricing: any): Deal["prices"] {
  if (!lockedPricing || typeof lockedPricing !== "object") return [];
  return Object.entries(lockedPricing).map(([model, value]: [string, any]) => {
    let inputNum = Number(
      value?.inputPerMillion ??
      value?.promptUsdPer1M ??
      value?.prompt ??
      value?.input ??
      value?.inputPerMillionUsd ??
      0
    );
    let outputNum = Number(
      value?.outputPerMillion ??
      value?.completionUsdPer1M ??
      value?.completion ??
      value?.output ??
      value?.outputPerMillionUsd ??
      0
    );
    if (inputNum === 0 && outputNum === 0) {
      if (model.includes("minimax")) {
        inputNum = 0.15;
        outputNum = 0.60;
      } else {
        inputNum = 0.0566;
        outputNum = 0.30;
      }
    }
    return {
      model,
      input: `$${inputNum.toFixed(4)} / 1M`,
      output: `$${outputNum.toFixed(4)} / 1M`,
    };
  });
}

async function saveDealListingMetadata(listing: Listing, dealId: string): Promise<Listing> {
  const boundListing: Listing = withExplicitListingUsd({ ...listing, dealId, published: false });
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

function onChainTermsHashHex(deal: OnChainDeal | null | undefined): string | undefined {
  const hash = deal?.terms_hash;
  if (!Array.isArray(hash) || hash.length !== 32) return undefined;
  return Buffer.from(hash).toString("hex");
}

async function waitForOnChainTermsHash(dealId: number, attempts = 8): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const termsHash = onChainTermsHashHex(await fetchContractDeal(dealId));
    if (termsHash) return termsHash;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error(`Deal #${dealId} was created, but its on-chain terms are not visible yet. Refresh the Deals page; do not submit Quick Buy again.`);
}

function teeTermSheetForDeal(deal: Deal, party: "buyer" | "seller") {
  const terms = party === "buyer" ? deal.buyerTerms : deal.sellerTerms;
  const creditAmountUsd = terms.creditUsd ?? deal.creditUsd ?? terms.credit;
  const priceUsd = terms.priceUsd ?? deal.priceUsd ?? terms.price;
  if (!Number.isFinite(creditAmountUsd) || Number(creditAmountUsd) <= 0 || !Number.isFinite(priceUsd) || Number(priceUsd) <= 0) {
    throw new Error("Original USD listing amounts are missing. Reload the deal metadata before submitting TEE terms.");
  }
  return {
    provider: deal.provider,
    models: terms.models,
    creditAmountUsd: Number(creditAmountUsd),
    priceUsd: Number(priceUsd),
    buyerCollateralPct: terms.buyerCollateralPct,
    sellerCollateralPct: terms.sellerCollateralPct,
    token: MAKER_VAULT_CONFIG.near.tokenAddress,
    depositDurationSec: DEAL_DEPOSIT_DURATION_SEC,
    keyDurationSec: DEAL_KEY_DURATION_SEC,
    teeLivenessTimeoutSec: CONFIG.teeLivenessSec,
    slashBpsProviderBan: CONFIG.slashProviderBanBps,
    slashBpsRevoke: CONFIG.slashRevokeBps,
    slashBpsBuyerBreach: CONFIG.slashBuyerBreachBps,
    deadline: (terms.deadline && terms.deadline.length >= 10) ? terms.deadline.slice(0, 10) : "2026-12-02",
  };
}

function toMicroUnits(tokenAmount: number): string {
  if (!tokenAmount || isNaN(tokenAmount) || tokenAmount <= 0) return "0";
  return BigInt(Math.round(tokenAmount * 1e6)).toString();
}

async function dealParamsForListing(listing: Listing, buyer: string, seller: string) {
  const nearBuyer = toNearAccountId(buyer);
  const nearSeller = toNearAccountId(seller);
  if (nearBuyer.toLowerCase() === nearSeller.toLowerCase()) {
    throw new Error("Buyer and seller must use different accounts");
  }

  const priceUnits = toMicroUnits(listing.price);
  const creditUnits = toMicroUnits(listing.credit);
  const buyerCollateralUnits = toMicroUnits((listing.price * (listing.buyerCollateralPct || 0)) / 100);
  const sellerCollateralUnits = toMicroUnits((listing.price * (listing.collateralPct || 0)) / 100);

  return {
    buyer: nearBuyer,
    seller: nearSeller,
    token: MAKER_VAULT_CONFIG.near.tokenAddress,
    price: priceUnits,
    credit_amount: creditUnits,
    buyer_collateral: buyerCollateralUnits,
    seller_collateral: sellerCollateralUnits,
    tee_pubkey: TEE_SIGNER_PUBLIC_KEY,
    deposit_duration_sec: DEAL_DEPOSIT_DURATION_SEC,
    key_duration_sec: DEAL_KEY_DURATION_SEC,
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

function mapOnChainDeal(
  d: OnChainDeal,
  currentAccount: string | null,
  listing?: Listing | Deal,
  foreignDeal?: any,
  existingDeal?: Deal,
  allConnectedAccounts?: string[]
): Deal {
  const raw = d as any;
  const chainStatus = String(d.status);
  const priceUsdc = Number(d.price) / 1e6;
  const creditUsdc = Number(d.credit_amount) / 1e6;
  const meteredUsdc = Number(d.metered_value ?? raw.last_signed?.metered_value ?? 0) / 1e6;
  const releasedUsdc = Number(d.released_amount ?? raw.released_to_seller ?? 0) / 1e6;
  const toBigInt = (value: string | number | boolean | undefined): bigint => {
    if (typeof value === "boolean" || value === undefined || value === null || value === "") return BigInt(0);
    try { return BigInt(value); } catch { return BigInt(0); }
  };
  const requiredBuyerDeposit = toBigInt(d.price) + toBigInt(d.buyer_collateral);
  const requiredSellerDeposit = toBigInt(d.seller_collateral);
  const currentBuyerDeposit = toBigInt(d.buyer_deposited);
  const currentSellerDeposit = toBigInt(d.seller_deposited);
  const chainConfirmsFunding = ["Deposited", "Funded", "Active", "Settled", "Completed", "Defaulted", "SettledTimeout"].includes(chainStatus);
  const isForeignFunded = Boolean(
    chainConfirmsFunding &&
    foreignDeal &&
    foreignDeal.buyer_address &&
    foreignDeal.buyer_address !== "0x0000000000000000000000000000000000000000" &&
    Number(foreignDeal.foreign_amount) > 0
  );
  const vaultBuyer = Boolean(raw.vault_buyer_deposited || (raw.vault_deposits && raw.vault_deposits.length >= 1));
  const vaultSeller = Boolean(raw.vault_seller_deposited || (raw.vault_deposits && raw.vault_deposits.length >= 2));
  const existing = existingDeal || ((listing && "buyerDeposited" in listing) ? (listing as Deal) : undefined);
  const buyerDeposited = Boolean(
    isForeignFunded ||
    (chainConfirmsFunding && vaultBuyer) ||
    (requiredBuyerDeposit > BigInt(0) && currentBuyerDeposit >= requiredBuyerDeposit)
  );
  const sellerDeposited = Boolean(existing?.sellerDeposited || vaultSeller || (requiredSellerDeposit > BigInt(0) && currentSellerDeposit >= requiredSellerDeposit));
  const buyerDepositRemainingYocto = isForeignFunded ? BigInt(0) : (requiredBuyerDeposit > currentBuyerDeposit ? requiredBuyerDeposit - currentBuyerDeposit : BigInt(0));
  const sellerDepositRemainingYocto = requiredSellerDeposit > currentSellerDeposit ? requiredSellerDeposit - currentSellerDeposit : BigInt(0);
  const buyerSubmitted = Boolean(d.terms_submitted_by_buyer ?? d.terms_hash?.length);
  const sellerSubmitted = Boolean(d.terms_submitted_by_seller ?? raw.counterparty_accepted);
  const currentStage = Number(d.current_stage ?? raw.stage_reached ?? raw.last_signed?.stage ?? 0);

  const accountsToCheck = Array.from(new Set([
    currentAccount,
    ...(allConnectedAccounts || []),
  ].filter((a): a is string => Boolean(a && a.trim()))));

  const isSeller = Boolean(
    accountsToCheck.length &&
    accountsToCheck.some((acc) => {
      const nearAcc = toNearAccountId(acc);
      const accLower = acc.toLowerCase();
      const sLower = d.seller.toLowerCase();
      const lstSeller = (listing as any)?.seller?.toLowerCase();
      return (
        accLower === sLower ||
        (nearAcc && nearAcc.toLowerCase() === sLower) ||
        (lstSeller && accLower === lstSeller) ||
        (lstSeller && nearAcc && nearAcc.toLowerCase() === lstSeller)
      );
    })
  );
  const role: "buyer" | "seller" = isSeller ? "seller" : "buyer";
  // USDC is the platform's settlement asset on every rail. Its presence in a
  // listing does not make a deal foreign-chain funded; only a contract-locked
  // foreign deal record does. Treating every USDC listing as foreign silently
  // removed the buyer collateral from NEAR deposits.
  const isForeign = Boolean(
    foreignDeal && (Number(foreignDeal.foreign_amount) > 0 || foreignDeal.vault_address)
  );
  const foreignUsdcAmount = (foreignDeal && Number(foreignDeal.foreign_amount) > 0)
    ? Number(foreignDeal.foreign_amount) / 1e6
    : ((listing as any)?.priceUsd || (listing as any)?.price || 0.04);
  const token: Asset = "USDC";

  let status: DealStatus = "Created";
  if (chainStatus === "Active") status = "Active";
  else if (chainStatus === "Deposited" || chainStatus === "Funded") status = "Funded";
  else if (chainStatus === "Settled" || chainStatus === "Completed") status = "Completed";
  else if (chainStatus === "Defaulted") status = "Defaulted";
  else if (chainStatus === "Cancelled" || chainStatus === "SettledTimeout") status = "Cancelled";

  const counterpartyAccepted = Boolean(d.counterparty_accepted);

  let step: DealStep = "negotiate";
  if (chainStatus === "Active") step = "live";
  else if (["Settled", "Completed", "Defaulted", "Cancelled", "SettledTimeout"].includes(chainStatus)) step = "settled";
  else if (chainStatus === "Deposited" || chainStatus === "Funded") step = "key";
  else if (d.terms_hash && d.terms_hash.length > 0) step = "deposit";
  else if (buyerSubmitted && sellerSubmitted) step = "deposit";
  else if (buyerSubmitted || sellerSubmitted) step = "terms";

  const termsHashHex = d.terms_hash && d.terms_hash.length ? "0x" + bytesToHex(d.terms_hash) : null;
  const rawPrice = Number(d.price);
  const buyerCollateralPct = isForeign ? 0 : (rawPrice > 0 ? Math.round((Number(d.buyer_collateral) / rawPrice) * 100) : 10);
  const sellerCollateralPct = rawPrice > 0 ? Math.round((Number(d.seller_collateral) / rawPrice) * 100) : 20;

  let provider = (listing?.provider || "OpenRouter") as Provider;
  let model = listing?.model || "z-ai/glm-5.3-flashx-legal";
  if (!listing) {
    const rawModel = (raw.model || raw.models?.[0] || "").toLowerCase();
    if (rawModel.includes("/") || rawModel.includes("deepseek") || rawModel.includes("llama") || rawModel.includes("glm") || rawModel.includes("qwen")) {
      provider = "OpenRouter";
      model = raw.model || "z-ai/glm-5.3-flashx-legal";
    } else if (rawModel.includes("claude") || rawModel.includes("anthropic")) {
      provider = "Anthropic";
      model = raw.model || "claude-3-5-haiku";
    } else if (rawModel.includes("gpt")) {
      provider = "OpenAI";
      model = raw.model || "gpt-4o";
    } else {
      provider = "OpenRouter";
      model = "z-ai/glm-5.3-flashx-legal";
    }
  } else if (listing.provider === "OpenAI") {
    const m = (listing.model || "").toLowerCase();
    if (m.includes("/") || m.includes("deepseek") || m.includes("llama") || m.includes("glm") || m.includes("qwen")) {
      provider = "OpenRouter";
    } else if (m.includes("claude") || m.includes("anthropic")) {
      provider = "Anthropic";
    }
  }

  const models = listing?.models?.length ? listing.models : [model];
  const prices = (listing as Deal)?.prices?.length ? (listing as Deal).prices : defaultPricesForModels(models);

  const isLegacyYocto = requiredBuyerDeposit > BigInt(1e15) || requiredSellerDeposit > BigInt(1e15);
  const decimalDivisor = isLegacyYocto ? 1e24 : 1e6;
  const onChainUsdcPrice = isLegacyYocto ? (Number(toBigInt(d.price) / BigInt(1e15)) / 1e9) * 3.6 : Number(d.price) / 1e6;
  const displayPrice = isForeign ? foreignUsdcAmount : (onChainUsdcPrice || (listing as any)?.price || 0.04);
  const displayCredit = (listing as any)?.creditUsd || (listing as any)?.credit || displayPrice || 10;

  const defaultTerms: Terms = {
    credit: displayCredit,
    price: displayPrice,
    buyerCollateralPct,
    sellerCollateralPct,
    token,
    models,
    deadline: "2026-12-02",
  };

  const calculatedUsedUsd = (displayPrice * currentStage) / 100;
  const releasedUsdVal = (raw as any).releasedUsd !== undefined
    ? Number((raw as any).releasedUsd)
    : (chainStatus === "Settled" || chainStatus === "Completed")
      ? displayPrice
      : (displayPrice * currentStage) / 100;

  return {
    id: String(d.id),
    listingId: listing?.id || `lst-${d.id}`,
    role,
    status,
    step,
    provider,
    model,
    models,
    credit: displayCredit,
    creditUsd: displayCredit,
    price: displayPrice,
    priceUsd: displayPrice,
    buyerCollateralPct,
    sellerCollateralPct,
    token,
    buyer: fromNearAccountId(d.buyer, (listing as any)?.buyer),
    seller: fromNearAccountId(d.seller, (listing as any)?.seller),
    buyerCanonical: d.buyer,
    sellerCanonical: d.seller,
    deadline: defaultTerms.deadline,
    termsHash: termsHashHex,
    counterpartyAccepted,
    buyerSubmitted,
    sellerSubmitted,
    buyerTerms: defaultTerms,
    sellerTerms: defaultTerms,
    buyerDeposited,
    sellerDeposited,
    vault_buyer_deposited: Boolean(raw.vault_buyer_deposited || vaultBuyer),
    vault_seller_deposited: Boolean(raw.vault_seller_deposited || vaultSeller),
    vault_deposits: raw.vault_deposits,
    buyerDepositRemaining: Number(buyerDepositRemainingYocto) / decimalDivisor,
    sellerDepositRemaining: Number(sellerDepositRemainingYocto) / decimalDivisor,
    depositDeadline: d.deposit_deadline
      ? new Date(Number(toBigInt(d.deposit_deadline) / BigInt(1_000_000))).toISOString()
      : new Date(Date.now() + 86400000 * 2).toISOString(),
    keyStatus: ["Active", "Settled", "Completed"].includes(chainStatus) ? "verified" : "idle",
    keyChecks: KEY_CHECKS.map((label) => ({ label, ok: ["Active", "Settled", "Completed"].includes(chainStatus) })),
    proxyKey: "",
    proxyRevoked: chainStatus === "Defaulted" || chainStatus === "Cancelled",
    baseUrl: raw.baseUrl || (raw.active_vault_deal || (raw.status === "Active" && raw.proxyKey) ? "http://localhost:4000/v1" : BASE_URL),
    active_vault_deal: raw.active_vault_deal,
    usedUsd: calculatedUsedUsd,
    tokens: Math.round(calculatedUsedUsd * 500000),
    stage: (chainStatus === "Settled" || chainStatus === "Completed") ? 100 : currentStage,
    releasedUsd: releasedUsdVal,
    lastUpdate: "On-chain NEAR Testnet",
    heartbeat: "stale",
    lastCheckpoint: d.last_checkpoint_time ? new Date(Number(d.last_checkpoint_time) / 1e6).toLocaleTimeString() : "Recent",
    outcome: chainStatus === "Settled" || chainStatus === "Completed" ? "completed" : chainStatus === "Defaulted" ? "revoked" : null,
    foreignInfo: foreignDeal || undefined,
    split: (chainStatus === "Settled" || chainStatus === "Completed") ? {
      seller: isForeign ? foreignUsdcAmount : (displayPrice + (displayPrice * (sellerCollateralPct / 100))),
      buyer: isForeign ? 0 : (displayPrice * (buyerCollateralPct / 100)),
      slashed: 0,
      lines: isForeign ? [
        { label: "Price released to seller", amount: foreignUsdcAmount, note: foreignDeal?.seller_claimed ? "Paid to seller via Maker Vault" : "Settling via Maker Vault", tone: "mint" },
        { label: "Seller collateral returned", amount: displayPrice * (sellerCollateralPct / 100), note: `$${(displayPrice * (sellerCollateralPct / 100)).toFixed(2)} USDC returned on contract`, tone: "mint" },
        { label: "Buyer collateral waived", amount: 0, note: "Waived for Maker Vault escrow", tone: "mint" },
      ] : [
        { label: "Price released to seller", amount: displayPrice, note: "Full price metered & released in USDC", tone: "mint" },
        { label: "Seller collateral returned", amount: displayPrice * (sellerCollateralPct / 100), note: "100% returned in USDC upon completion", tone: "mint" },
        { label: "Buyer collateral refunded", amount: displayPrice * (buyerCollateralPct / 100), note: "100% refunded in USDC upon completion", tone: "mint" },
      ],
    } : null,
    messages: [
      { id: "m1", sender: d.seller, text: `Created on-chain deal #${d.id} for $${displayPrice.toFixed(2)} USDC`, time: "On-chain" },
      { id: "m2", sender: d.buyer, text: `Escrow terms recorded at ${termsHashHex ? termsHashHex.slice(0, 12) + "..." : "pending"}`, time: "On-chain" },
    ],
    activity: [
      { id: "a1", title: `On-chain Deal #${d.id} ${d.status}`, detail: `Status: ${d.status} · Stage: ${currentStage}% · Metered: $${((displayPrice * currentStage) / 100).toFixed(4)} USDC`, time: "Live" }
    ],
    prices,
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
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem("conpi:cached_deals_v2");
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setState((s) => (s.deals.length === 0 ? { ...s, deals: parsed, isLoadingOnChain: false } : s));
          }
        }
        const evmAddr = localStorage.getItem("conpi_evm_address");
        const solAddr = localStorage.getItem("conpi_solana_address");
        const solWallet = (localStorage.getItem("conpi_solana_wallet") as WalletName) || "Phantom";
        if (evmAddr || solAddr) {
          setState((s) => ({
            ...s,
            evmAccount: evmAddr || s.evmAccount,
            solanaAccount: solAddr || s.solanaAccount,
            account: s.account || evmAddr || solAddr,
            wallet: s.wallet || (evmAddr ? "MetaMask" : solWallet),
            walletChain: s.wallet ? s.walletChain : (evmAddr ? "evm" : solAddr ? "solana" : "near"),
          }));
        }
      } catch {}
    }

    let unsubscribe: (() => void) | null = null;
    getWalletSelector().then((ws) => {
      if (!ws) return;
      const sub = ws.selector.store.observable.subscribe((selectorState) => {
        const active = selectorState.accounts.find((a) => a.active) || selectorState.accounts[0];
        if (active) {
          const walletType = (selectorState.selectedWalletId || "MyNearWallet") as WalletName;
          setState((s) => {
            if (s.account === active.accountId && s.nearAccount === active.accountId && s.wallet === walletType && s.walletChain === "near") {
              return s;
            }
            return {
              ...s,
              account: active.accountId,
              nearAccount: active.accountId,
              wallet: walletType,
              walletChain: "near",
            };
          });
        } else {
          setState((s) => {
            const nextAccount = s.walletChain === "near" ? (s.evmAccount || s.solanaAccount || null) : s.account;
            const nextWallet = s.walletChain === "near" ? (s.evmAccount ? "MetaMask" : s.solanaAccount ? "Phantom" : null) : s.wallet;
            const nextChain = s.walletChain === "near" ? (s.evmAccount ? "evm" : s.solanaAccount ? "solana" : "near") : s.walletChain;
            if (s.nearAccount === null && s.account === nextAccount && s.wallet === nextWallet && s.walletChain === nextChain) {
              return s;
            }
            return {
              ...s,
              nearAccount: null,
              account: nextAccount,
              wallet: nextWallet,
              walletChain: nextChain,
            };
          });
        }
      });
      unsubscribe = () => sub.unsubscribe();
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // 2. Fetch live data from contract
  const loadOnChainData = async (isBackground = false) => {
    if (!isBackground) {
      setState((s) => ({ ...s, isLoadingOnChain: true }));
    }
    try {
      const [onChainDeals, stagedProposals, liveNearPrice, serverListings] = await Promise.all([
        fetchContractDeals(0, 100).catch((err) => {
          console.warn("fetchContractDeals failed in loadOnChainData:", err);
          return null;
        }),
        fetchContractStagedProposals().catch(() => []),
        getLiveNearPrice().catch(() => 4.02),
        fetch("/api/listings", { cache: "no-store" })
          .then((res) => res.ok ? res.json() : null)
          .then((data) => Array.isArray(data?.listings) ? data.listings as Listing[] : [])
          .catch(() => [] as Listing[]),
      ]);

      if (!onChainDeals || !Array.isArray(onChainDeals) || onChainDeals.length === 0) {
        if (stateRef.current.deals.length > 0) {
          // Keep current state if contract query returned null/empty due to transient RPC issues
          setState((s) => ({ ...s, isLoadingOnChain: false }));
          return;
        }
      }
      const safeOnChainDeals = (Array.isArray(onChainDeals) && onChainDeals.length > 0)
        ? onChainDeals
        : [];

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
        .map(withExplicitListingUsd)
        .filter((listing, index, all) => all.findIndex((item) => item.id === listing.id) === index);

      // Fetch live TEE meter only for active or funded deals with a proxy key
      const meterMap = new Map<number, any>();
      const activeDeals = safeOnChainDeals.filter((d) => d.status === "Active" || d.status === "Funded");
      await Promise.all(
        activeDeals.map(async (d) => {
          const proxyKey = storedKeys[String(d.id)] || stateRef.current.deals.find((item) => item.id === String(d.id))?.proxyKey;
          if (!proxyKey) return;
          try {
            const endpoints = [
              `/api/vault/meter?dealId=${d.id}`,
              `http://localhost:4000/v1/deals/${d.id}/meter`,
              `${BASE_URL}/deals/${d.id}/meter`,
            ];
            for (const url of endpoints) {
              try {
                const res = await fetch(url, {
                  headers: { Authorization: `Bearer ${proxyKey}` },
                  cache: "no-store",
                  signal: AbortSignal.timeout(3000),
                });
                if (res.ok) {
                  const data = await res.json();
                  meterMap.set(Number(d.id), data);
                  if (typeof window !== "undefined" && data.lockedPricing) {
                    try {
                      localStorage.setItem(`conpi:locked_pricing_${d.id}`, JSON.stringify(data.lockedPricing));
                    } catch {}
                  }
                  break;
                }
              } catch {}
            }
          } catch {}
        })
      );

      const foreignDealsMap = new Map<number, any>();
      const candidateDeals = safeOnChainDeals.filter((d, idx) => {
        const st = String(d.status);
        if (st === "Completed" || st === "Settled" || st === "Cancelled") return false;
        if (idx >= safeOnChainDeals.length - 4) return true;
        return st === "Created" || st === "Funded" || st === "Active";
      }).slice(-4);
      await Promise.all(
        candidateDeals.map(async (d) => {
          try {
            const fd = await fetchContractForeignDeal(Number(d.id));
            if (fd) foreignDealsMap.set(Number(d.id), fd);
          } catch {}
        })
      );

      const currentAccount = stateRef.current.account;
      const allConnectedAccounts = [
        stateRef.current.account,
        stateRef.current.solanaAccount,
        stateRef.current.evmAccount,
        stateRef.current.nearAccount,
      ].filter((x): x is string => Boolean(x && x.trim()));
      const mappedDeals: Deal[] = [];
      for (const d of safeOnChainDeals) {
        try {
          const existing = stateRef.current.deals.find((item) => item.id === String(d.id));
          const listing = metadataListings.find((item) => String(item.dealId || "") === String(d.id));
          const foreignDeal = foreignDealsMap.get(Number(d.id));
          const mapped = mapOnChainDeal(d, currentAccount, listing, foreignDeal, existing, allConnectedAccounts);
          const resolvedProxyKey = existing?.proxyKey || storedKeys[String(d.id)] || "";
          const liveMeter = meterMap.get(Number(d.id));

          const creditUsd = Number(liveMeter?.creditUsd) || existing?.creditUsd || mapped.credit;
          const priceUsd = Number(liveMeter?.priceUsd) || existing?.priceUsd || mapped.price;
          const usedUsd = Number(
            liveMeter?.usedUsd !== undefined
              ? liveMeter.usedUsd
              : existing?.usedUsd !== undefined && existing.usedUsd > 0
                ? existing.usedUsd
                : mapped.usedUsd
          );
          const tokens = Number(liveMeter?.tokensTotal ?? existing?.tokens ?? mapped.tokens);

          const onChainStage = (String(d.status) === "Settled" || String(d.status) === "Completed")
            ? 100
            : Number(d.current_stage ?? (d as any).stage_reached ?? (d as any).last_signed?.stage ?? 0);
          // A metered threshold is not a released payout. Only the escrow
          // contract can confirm a stage as paid; showing the local meter as
          // "released" hid failed Solana relays from both parties.
          const stage = onChainStage;

          const lastUpdate = liveMeter?.timestamp
            ? `TEE Enclave (${new Date(liveMeter.timestamp).toLocaleTimeString()})`
            : existing?.lastUpdate || mapped.lastUpdate;

          let provider = liveMeter?.provider || listing?.provider || existing?.provider || mapped.provider;
          let models = Array.isArray(liveMeter?.models) && liveMeter.models.length
            ? liveMeter.models
            : listing?.models?.length ? listing.models : existing?.models?.length ? existing.models : mapped.models;
          let model = liveMeter?.model || listing?.model || existing?.model || models[0] || mapped.model;

          // Auto-correct provider if mismatched
          if (provider === "OpenAI") {
            const m = (model || "").toLowerCase();
            if (m.includes("/") || m.includes("deepseek") || m.includes("llama") || m.includes("glm") || m.includes("qwen") || m.includes("mistral")) {
              provider = "OpenRouter";
            } else if (m.includes("claude") || m.includes("anthropic")) {
              provider = "Anthropic";
            }
          }

          const heartbeat: "live" | "stale" = Boolean(
            (liveMeter?.timestamp && Date.now() - new Date(liveMeter.timestamp).getTime() < 120_000) ||
            (resolvedProxyKey && existing?.heartbeat === "live")
          ) ? "live" : "stale";

          let cachedPricing: any = null;
          if (typeof window !== "undefined") {
            try {
              const raw = localStorage.getItem(`conpi:locked_pricing_${d.id}`);
              if (raw) cachedPricing = JSON.parse(raw);
            } catch {}
          }
          const effectiveLockedPricing = liveMeter?.lockedPricing || cachedPricing;
          const lockedPriceRows = priceRowsFromLockedPricing(effectiveLockedPricing);
          const prices = lockedPriceRows.length
            ? lockedPriceRows
            : existing?.prices?.length
              ? existing.prices
              : mapped.prices;

          mappedDeals.push({
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
            heartbeat,
            lastUpdate,
            prices,
            pricingSnapshotHash: liveMeter?.pricingSnapshotHash || existing?.pricingSnapshotHash,
            usageReceiptCount: Number(liveMeter?.usageReceiptCount ?? existing?.usageReceiptCount ?? 0),
            lastUsageReceipt: liveMeter?.lastUsageReceipt ?? existing?.lastUsageReceipt ?? null,
            buyerTerms: listing
              ? { ...(existing?.buyerTerms || listingTerms(listing)), creditUsd: listing.creditUsd ?? listing.credit, priceUsd: listing.priceUsd ?? listing.price }
              : existing?.buyerTerms || mapped.buyerTerms,
            sellerTerms: listing
              ? { ...(existing?.sellerTerms || listingTerms(listing)), creditUsd: listing.creditUsd ?? listing.credit, priceUsd: listing.priceUsd ?? listing.price }
              : existing?.sellerTerms || mapped.sellerTerms,
          });
        } catch (err: any) {
          console.error(`Failed to map deal #${d.id}:`, err);
          sendClientDebugLog({ error: `Failed to map deal #${d.id}`, message: err?.message });
        }
      }



      // Generate listings from models and active offers
      const generatedListings: Listing[] = mappedDeals.map((deal) => ({
        id: `lst-${deal.id}`,
        type: "sell",
        dealId: deal.id,
        provider: deal.provider,
        model: deal.model,
        models: deal.models?.length ? deal.models : [deal.model],
        credit: deal.credit,
        price: deal.price,
        collateralPct: deal.sellerCollateralPct || 20,
        buyerCollateralPct: deal.buyerCollateralPct || 10,
        seller: deal.seller,
        reputation: 15,
        tee: true,
        token: deal.token,
        published: false,
        rateLimit: "60 req/min",
        expectedTest: `One completion probe on ${deal.model}`,
        createdAt: deal.createdAt || new Date().toISOString(),
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
            token: "USDC",
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
            token: "USDC",
            rateLimit: "120 req/min",
            expectedTest: "Anthropic message completion probe",
            createdAt: new Date().toISOString(),
          }
        );
      }

      // Query claims for user
      const userClaims: Claim[] = [];
      if (currentAccount) {
        const pendingUsdc = await fetchContractPendingPayout(currentAccount, MAKER_VAULT_CONFIG.near.tokenAddress);
        if (Number(pendingUsdc) > 0) {
          userClaims.push({
            id: `claim-usdc-${currentAccount}`,
            token: "USDC",
            amount: Number(pendingUsdc) / 1e6,
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

      if (typeof window !== "undefined" && mappedDeals.length > 0) {
        try {
          localStorage.setItem("conpi:cached_deals_v2", JSON.stringify(mappedDeals));
        } catch {}
      }

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
    } catch (err: any) {
      console.warn("Failed to load on-chain contract data:", err);
      sendClientDebugLog({
        error: "Failed to load on-chain contract data in loadOnChainData",
        message: err?.message,
        stack: err?.stack,
      });
      setState((s) => ({ ...s, isLoadingOnChain: false }));
    }
  };

  useEffect(() => {
    loadOnChainData(false);
    const interval = setInterval(() => loadOnChainData(true), 25000);
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
      let latestProposal: any = null;
      for (const msg of (ticket.messages || [])) {
        if (msg.text?.startsWith("PROPOSAL:")) {
          try {
            latestProposal = JSON.parse(msg.text.slice(9));
          } catch {}
        }
      }

      patchDeal(dealId, (deal) => {
        const patchTerms = (latestProposal && ticket.matched) ? {
          price: latestProposal.price,
          priceUsd: latestProposal.price,
          credit: latestProposal.credit,
          creditUsd: latestProposal.credit,
          buyerCollateralPct: latestProposal.buyerCollateralPct,
          sellerCollateralPct: latestProposal.sellerCollateralPct,
          token: latestProposal.token || deal.token,
        } : null;

        return {
          ...deal,
          matched: Boolean(ticket.matched),
          buyerSubmitted: ticket.buyerSubmitted,
          sellerSubmitted: ticket.sellerSubmitted,
          termDiffFields: ticket.diffFields || [],
          termsHash: ticket.termsHashHex ? `0x${ticket.termsHashHex.replace(/^0x/, "")}` : deal.termsHash,
          buyerTerms: patchTerms ? { ...deal.buyerTerms, ...patchTerms } : deal.buyerTerms,
          sellerTerms: patchTerms ? { ...deal.sellerTerms, ...patchTerms } : deal.sellerTerms,
          messages: (ticket.messages || []).map((message) => ({
            id: message.id,
            sender: message.sender,
            text: message.text,
            time: new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          })),
          lastUpdate: ticket.matched ? "Terms matched inside verified TEE" : "Private negotiation active",
        };
      });
    };

    const submitPartyTermsToTee = async (deal: Deal, party: "buyer" | "seller") => {
      let ticket = await teeApi.getTicket(deal.id).catch(() => null);
      if (!ticket) {
        ticket = await teeApi.initTicket(
          deal.id,
          Number(deal.id),
          deal.buyerCanonical || toNearAccountId(deal.buyer),
          deal.sellerCanonical || toNearAccountId(deal.seller),
          deal.termsHash?.replace(/^0x/, "")
        );
      }
      // If the ticket in the enclave is already fully matched, return it directly so
      // we never accidentally overwrite matched terms with differing browser local state.
      if (ticket && ticket.matched && ticket.termsHashHex) {
        applyTicketState(deal.id, ticket);
        return ticket;
      }
      // Always refresh the connected party's encrypted term sheet. A previous
      // browser session may have submitted legacy NEAR-denominated values, and
      // treating "submitted" as immutable would permanently strand the deal.
      const enclaveKey = await getVerifiedEncryptionKey();
      const encryptedEnvelope = encryptPayloadToEnclave(JSON.stringify(teeTermSheetForDeal(deal, party)), enclaveKey);
      ticket = await teeApi.submitTerms(deal.id, party, encryptedEnvelope);
      applyTicketState(deal.id, ticket);
      return ticket;
    };

    return {
      setTheme: (theme) => setState((s) => ({ ...s, theme })),
      setDefaultToken: (defaultToken) => setState((s) => ({ ...s, defaultToken })),
      openConnectModal: () => setState((s) => ({ ...s, isConnectModalOpen: true })),
      closeConnectModal: () => setState((s) => ({ ...s, isConnectModalOpen: false })),
      connect: async () => {
        setState((s) => ({ ...s, isConnectModalOpen: true }));
      },
      connectEvm: async (walletName: "MetaMask" | "Coinbase" = "MetaMask") => {
        try {
          const res = await connectMetaMask();
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem("conpi_evm_address", res.address);
              localStorage.setItem("conpi_evm_wallet", walletName);
            } catch {}
          }
          setState((s) => ({
            ...s,
            evmAccount: res.address,
            account: s.account || res.address,
            wallet: s.wallet || (walletName as WalletName),
            walletChain: s.wallet ? s.walletChain : "evm",
          }));
          pushToast({ kind: "success", title: `Connected ${walletName}: ${res.address.slice(0, 6)}...${res.address.slice(-4)}` });
          return res.address;
        } catch (err: any) {
          pushToast({ kind: "error", title: err?.message || "Failed to connect EVM wallet" });
          throw err;
        }
      },
      connectSolana: async (walletName: "Phantom" | "Solflare" = "Phantom") => {
        try {
          const res = await connectSolanaWallet(walletName);
          setState((s) => ({
            ...s,
            solanaAccount: res.address,
            account: s.account || res.address,
            wallet: s.wallet || (walletName as WalletName),
            walletChain: s.wallet ? s.walletChain : "solana",
          }));
          pushToast({ kind: "success", title: `Connected ${res.walletName}: ${res.address.slice(0, 4)}...${res.address.slice(-4)}` });
          return res.address;
        } catch (err: any) {
          pushToast({ kind: "error", title: err?.message || "Failed to connect Solana wallet" });
          throw err;
        }
      },
      disconnect: async () => {
        try { await disconnectWallet(); } catch (e) { console.warn("disconnect near error:", e); }
        try { disconnectEvmWallet(); } catch (e) { console.warn("disconnect evm error:", e); }
        try { await disconnectSolanaWallet(); } catch (e) { console.warn("disconnect solana error:", e); }
        if (typeof window !== "undefined") {
          try {
            localStorage.removeItem("conpi_evm_address");
            localStorage.removeItem("conpi_evm_wallet");
            localStorage.removeItem("conpi_solana_address");
            localStorage.removeItem("conpi_solana_wallet");
          } catch {}
        }
        setState((s) => ({
          ...s,
          account: null,
          wallet: null,
          nearAccount: null,
          evmAccount: null,
          solanaAccount: null,
          walletChain: "near",
        }));
        pushToast({ kind: "info", title: "Disconnected all wallets" });
      },
      switchActiveChain: (chain: "near" | "evm" | "solana") => {
        setState((s) => {
          if (chain === "solana" && s.solanaAccount) {
            return {
              ...s,
              account: s.solanaAccount,
              wallet: (typeof window !== "undefined" && (localStorage.getItem("conpi_solana_wallet") as WalletName)) || "Phantom",
              walletChain: "solana",
            };
          }
          if (chain === "evm" && s.evmAccount) {
            return {
              ...s,
              account: s.evmAccount,
              wallet: (typeof window !== "undefined" && (localStorage.getItem("conpi_evm_wallet") as WalletName)) || "MetaMask",
              walletChain: "evm",
            };
          }
          if (chain === "near" && s.nearAccount) {
            return {
              ...s,
              account: s.nearAccount,
              wallet: "MyNearWallet",
              walletChain: "near",
            };
          }
          return s;
        });
        setTimeout(loadOnChainData, 50);
      },
      disconnectEvm: () => {
        disconnectEvmWallet();
        setState((s) => {
          const isEvmActive = s.walletChain === "evm";
          return {
            ...s,
            evmAccount: null,
            account: isEvmActive ? (s.nearAccount || s.solanaAccount || null) : s.account,
            wallet: isEvmActive ? (s.nearAccount ? "MyNearWallet" : s.solanaAccount ? "Phantom" : null) : s.wallet,
            walletChain: isEvmActive ? (s.nearAccount ? "near" : s.solanaAccount ? "solana" : "near") : s.walletChain,
          };
        });
        pushToast({ kind: "info", title: "Disconnected EVM wallet" });
      },
      disconnectSolana: async () => {
        await disconnectSolanaWallet();
        setState((s) => {
          const isSolanaActive = s.walletChain === "solana";
          return {
            ...s,
            solanaAccount: null,
            account: isSolanaActive ? (s.nearAccount || s.evmAccount || null) : s.account,
            wallet: isSolanaActive ? (s.nearAccount ? "MyNearWallet" : s.evmAccount ? "MetaMask" : null) : s.wallet,
            walletChain: isSolanaActive ? (s.nearAccount ? "near" : s.evmAccount ? "evm" : "near") : s.walletChain,
          };
        });
        pushToast({ kind: "info", title: "Disconnected Solana wallet" });
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
        const nearBuyer = toNearAccountId(buyer);
        const nearSeller = toNearAccountId(seller);
        if (nearBuyer.toLowerCase() === nearSeller.toLowerCase()) {
          pushToast({ kind: "error", title: "Choose a different wallet", body: "Buyer and seller must be two different accounts." });
          return null;
        }

        const pendingToast = pushToast({ kind: "pending", title: "Create deal on NEAR", body: `Confirm the transaction as buyer ${buyer}.` });
        let outcome: any;
        let id: string;
        let txHash = "";
        let createdTermsHashHex: string | undefined;
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
              .filter((item) => Number(item.id) > previousMaxId && item.buyer === nearBuyer && item.seller === nearSeller)
              .sort((a, b) => Number(b.id) - Number(a.id))[0];
            if (created) onChainId = Number(created.id);
          }
          if (onChainId === null) throw new Error("The transaction succeeded, but its on-chain deal ID could not be resolved");
          id = String(onChainId);
          createdTermsHashHex = await waitForOnChainTermsHash(onChainId);
          const boundListing = await saveDealListingMetadata(listing, id);
          setState((s) => ({
            ...s,
            listings: s.listings.map((item) => item.id === listing.id ? boundListing : item),
          }));

          // Remember multi-chain payout addresses
          if (typeof window !== "undefined") {
            try {
              if (seller.startsWith("0x")) {
                localStorage.setItem(`conpi_seller_evm_${id}`, seller);
              } else if (seller.length >= 32 && !seller.includes(".")) {
                localStorage.setItem(`conpi_seller_solana_${id}`, seller);
              }
            } catch {}
          }

          // The buyer cannot register payout parameters. The seller locks the
          // deterministic vault, token, amount and payout address on-chain
          // before this deal can accept a foreign deposit.
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
          creditUsd: listing.creditUsd ?? listing.credit,
          price: listing.price,
          priceUsd: listing.priceUsd ?? listing.price,
          buyerCollateralPct: listing.buyerCollateralPct,
          sellerCollateralPct: listing.collateralPct,
          token: listing.token,
          buyer,
          seller,
          deadline: agreed.deadline,
          termsHash: `0x${createdTermsHashHex}`,
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
          const ticket = await teeApi.initTicket(id, Number(id), buyer, seller, createdTermsHashHex);
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
        const enhancedPatch = {
          ...patch,
          ...(patch.price !== undefined ? { priceUsd: patch.price } : {}),
          ...(patch.credit !== undefined ? { creditUsd: patch.credit } : {}),
        };
        patchDeal(dealId, (deal) => ({
          ...deal,
          buyerTerms: deal.role === "buyer" ? { ...deal.buyerTerms, ...enhancedPatch } : deal.buyerTerms,
          sellerTerms: deal.role === "seller" ? { ...deal.sellerTerms, ...enhancedPatch } : deal.sellerTerms,
        }));
      },
      proposeTerms: async (dealId, patch) => {
        const account = stateRef.current.account;
        if (!account) return;
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;

        const enhancedPatch = {
          ...patch,
          ...(patch.price !== undefined ? { priceUsd: patch.price } : {}),
          ...(patch.credit !== undefined ? { creditUsd: patch.credit } : {}),
        };
        patchDeal(dealId, (d) => ({
          ...d,
          buyerTerms: d.role === "buyer" ? { ...d.buyerTerms, ...enhancedPatch } : d.buyerTerms,
          sellerTerms: d.role === "seller" ? { ...d.sellerTerms, ...enhancedPatch } : d.sellerTerms,
        }));

        const updatedDeal = {
          ...deal,
          buyerTerms: deal.role === "buyer" ? { ...deal.buyerTerms, ...enhancedPatch } : deal.buyerTerms,
          sellerTerms: deal.role === "seller" ? { ...deal.sellerTerms, ...enhancedPatch } : deal.sellerTerms,
        };

        const ownTerms = deal.role === "buyer" ? updatedDeal.buyerTerms : updatedDeal.sellerTerms;
        try {
          const ticket = await submitPartyTermsToTee(updatedDeal, deal.role);
          applyTicketState(dealId, ticket);

          const proposalPayload = {
            type: "proposal",
            price: Number(ownTerms.price),
            credit: Number(ownTerms.credit),
            buyerCollateralPct: Number(ownTerms.buyerCollateralPct),
            sellerCollateralPct: Number(ownTerms.sellerCollateralPct),
            token: ownTerms.token || "USDC",
            proposer: account,
          };
          const proposalMsg = `PROPOSAL:${JSON.stringify(proposalPayload)}`;

          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptPayloadToEnclave(proposalMsg, enclaveKey);
          const updatedTicket = await teeApi.sendMessage(dealId, account, encryptedEnvelope);
          applyTicketState(dealId, updatedTicket);

          pushToast({
            kind: ticket.matched ? "success" : "info",
            title: ticket.matched ? "Terms matched in TEE!" : "Encrypted proposal sent",
            body: ticket.matched
              ? "Both parties agreed! Terms matched inside TEE."
              : `Proposed price $${ownTerms.price}. Counterparty can now accept in chat.`,
          });
        } catch (err: any) {
          pushToast({ kind: "error", title: "Proposal failed", body: err.message });
        }
      },
      acceptProposal: async (dealId, proposal) => {
        const account = stateRef.current.account;
        if (!account) return;
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;

        const enhancedPatch = {
          price: Number(proposal.price),
          priceUsd: Number(proposal.price),
          credit: Number(proposal.credit),
          creditUsd: Number(proposal.credit),
          buyerCollateralPct: Number(proposal.buyerCollateralPct),
          sellerCollateralPct: Number(proposal.sellerCollateralPct),
          token: proposal.token || deal.token,
        };

        patchDeal(dealId, (d) => ({
          ...d,
          buyerTerms: d.role === "buyer" ? { ...d.buyerTerms, ...enhancedPatch } : d.buyerTerms,
          sellerTerms: d.role === "seller" ? { ...d.sellerTerms, ...enhancedPatch } : d.sellerTerms,
        }));

        const updatedDeal = {
          ...deal,
          buyerTerms: deal.role === "buyer" ? { ...deal.buyerTerms, ...enhancedPatch } : deal.buyerTerms,
          sellerTerms: deal.role === "seller" ? { ...deal.sellerTerms, ...enhancedPatch } : deal.sellerTerms,
        };

        try {
          const ticket = await submitPartyTermsToTee(updatedDeal, deal.role);
          applyTicketState(dealId, ticket);

          const confirmMsg = `✅ I accepted your proposed price of $${proposal.price}! Encrypted terms matched in TEE.`;
          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptPayloadToEnclave(confirmMsg, enclaveKey);
          const updatedTicket = await teeApi.sendMessage(dealId, account, encryptedEnvelope);
          applyTicketState(dealId, updatedTicket);

          pushToast({
            kind: "success",
            title: "Proposal accepted!",
            body: `Terms matched at $${proposal.price} inside the TEE enclave.`,
          });
        } catch (err: any) {
          pushToast({ kind: "error", title: "Failed to accept proposal", body: err.message });
        }
      },
      createNegotiatedDeal: async (dealId) => {
        const current = stateRef.current;
        const deal = current.deals.find((item) => item.id === dealId);
        if (!deal || !current.account) return null;

        const ownTerms = deal.role === "buyer" ? deal.buyerTerms : deal.sellerTerms;
        const buyer = deal.buyer;
        const seller = deal.seller;

        // 100% USDC-only: store six-decimal amounts and bind the NEAR-side
        // escrow to its canonical NEP-141 USDC contract. Foreign rails keep
        // their chain-specific token address in ForeignDeal.
        const priceUnits = toMicroUnits(ownTerms.price);
        const creditUnits = toMicroUnits(ownTerms.credit);
        const buyerColUnits = toMicroUnits((ownTerms.price * (ownTerms.buyerCollateralPct || 0)) / 100);
        const sellerColUnits = toMicroUnits((ownTerms.price * (ownTerms.sellerCollateralPct || 0)) / 100);

        const pendingToast = pushToast({
          kind: "pending",
          title: "Creating negotiated deal on NEAR...",
          body: `Confirm deal creation at negotiated price $${ownTerms.price} USDC.`,
        });

        try {
          const beforeDeals = await fetchContractDeals(0, 100);
          const previousMaxId = Math.max(0, ...beforeDeals.map((item) => Number(item.id) || 0));

          const nearBuyer = toNearAccountId(buyer);
          const nearSeller = toNearAccountId(seller);

          const params = {
            buyer: nearBuyer,
            seller: nearSeller,
            token: MAKER_VAULT_CONFIG.near.tokenAddress,
            price: priceUnits,
            credit_amount: creditUnits,
            buyer_collateral: buyerColUnits,
            seller_collateral: sellerColUnits,
            tee_pubkey: TEE_SIGNER_PUBLIC_KEY,
            deposit_duration_sec: DEAL_DEPOSIT_DURATION_SEC,
            key_duration_sec: DEAL_KEY_DURATION_SEC,
            tee_liveness_timeout_sec: CONFIG.teeLivenessSec,
            slash_bps_provider_ban: CONFIG.slashProviderBanBps,
            slash_bps_revoke: CONFIG.slashRevokeBps,
            slash_bps_buyer_breach: CONFIG.slashBuyerBreachBps,
          };

          const outcome: any = await txCreateDeal(params);
          let newDealId = createdDealIdFromOutcome(outcome);
          for (let attempt = 0; newDealId === null && attempt < 5; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            const deals = await fetchContractDeals(0, 100);
            const created = deals
              .filter((item) => Number(item.id) > previousMaxId && item.buyer === nearBuyer && item.seller === nearSeller)
              .sort((a, b) => Number(b.id) - Number(a.id))[0];
            if (created) newDealId = Number(created.id);
          }
          if (newDealId === null) throw new Error("The transaction succeeded, but the new on-chain deal ID could not be resolved");

          const newIdStr = String(newDealId);
          const createdTermsHashHex = await waitForOnChainTermsHash(newDealId);

          // Carry over TEE ticket messages and init ticket for the new deal
          try {
            await teeApi.initTicket(newIdStr, newDealId, buyer, seller, createdTermsHashHex);
            for (const msg of deal.messages) {
              const enclaveKey = await getVerifiedEncryptionKey();
              const env = encryptPayloadToEnclave(msg.text, enclaveKey);
              await teeApi.sendMessage(newIdStr, msg.sender, env);
            }
          } catch {}

          replaceToast(pendingToast, {
            kind: "success",
            title: `Negotiated Deal #${newIdStr} Created!`,
            body: `Terms locked at $${ownTerms.price}. Ready for deposit.`,
          });
          setTimeout(loadOnChainData, 1500);
          return newIdStr;
        } catch (err: any) {
          replaceToast(pendingToast, {
            kind: "error",
            title: "Failed to create negotiated deal",
            body: err.message,
          });
          return null;
        }
      },
      submitNegotiationTerms: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        try {
          const party = deal.role;
          const ticket = await submitPartyTermsToTee(deal, party);
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
            ticket = await teeApi.initTicket(
              dealId,
              Number(dealId),
              deal.buyerCanonical || toNearAccountId(deal.buyer),
              deal.sellerCanonical || toNearAccountId(deal.seller),
              deal.termsHash?.replace(/^0x/, "")
            );
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

          const solanaAddress = stateRef.current.solanaAccount;
          const sellerCanonical = (deal.sellerCanonical || toNearAccountId(deal.seller)).toLowerCase();
          const solanaSeller = solanaAddress && toNearAccountId(solanaAddress).toLowerCase() === sellerCanonical;
          if (solanaSeller) {
            // Submit the seller's encrypted term sheet now, so the key
            // activation screen cannot proceed until the buyer has supplied
            // their matching term sheet as well.
            await submitPartyTermsToTee(deal, "seller");
            const [onChain, vault] = await Promise.all([
              teeApi.getNearDeal(Number(dealId)),
              teeApi.getSolanaVaultConfig(),
            ]);
            if (!onChain) throw new Error("The on-chain deal could not be loaded");
            const acceptance = await signSolanaDealAcceptance({
              contractId: CONTRACT_ID,
              network: "testnet",
              dealId: Number(dealId),
              termsHashHex: cleanHex,
              vaultAddress: String(vault?.vault_address || ""),
              tokenMint: String(vault?.token_mint || ""),
              sellerCollateralAtomic: String(onChain.seller_collateral || "0"),
              sellerCanonicalAddress: toNearAccountId(solanaAddress),
            });
            const result = await teeApi.acceptSolanaDeal(Number(dealId), {
              expectedHashHex: cleanHex,
              ...acceptance,
              sellerAddress: toNearAccountId(acceptance.sellerAddress),
            });
            if (!result.ok) throw new Error(result.error || "Solana seller acceptance was rejected");
            setTimeout(loadOnChainData, 1_500);
            return {
              ok: true,
              title: "Deal accepted by Solana seller",
              body: "The Solana wallet signature and payout vault are now locked on the NEAR escrow.",
              href: result.transactionHash ? `https://testnet.nearblocks.io/txns/${result.transactionHash}` : undefined,
            };
          }

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

        try {
          const tokenContract = MAKER_VAULT_CONFIG.near.tokenAddress;
          const initialDeal = await fetchContractDeal(Number(dealId));
          if (!initialDeal) throw new Error(`Deal #${dealId} was not found on-chain`);
          if (initialDeal.token !== tokenContract) {
            throw new Error(`Deal #${dealId} was created with legacy native-NEAR terms and cannot accept USDC. Create a new deal before depositing.`);
          }
          const requiredAtomic = isBuyer
            ? BigInt(initialDeal.price || "0") + BigInt(initialDeal.buyer_collateral || "0")
            : BigInt(initialDeal.seller_collateral || "0");
          const alreadyDepositedAtomic = BigInt(
            isBuyer ? initialDeal.buyer_deposited || "0" : initialDeal.seller_deposited || "0"
          );
          const remainingAtomic = requiredAtomic > alreadyDepositedAtomic
            ? requiredAtomic - alreadyDepositedAtomic
            : BigInt(0);
          if (remainingAtomic === BigInt(0)) {
            await loadOnChainData();
            return {
              ok: true,
              title: "USDC deposit already complete",
              body: "The escrow already has this wallet's full required deposit.",
            };
          }
          await submitPartyTermsToTee(deal, deal.role);
          // 100% USDC deposits on NEAR using official Circle Native USDC:
          // Derive the transfer from fresh contract state, not rounded browser
          // listing metadata. This safely tops up a partial deposit exactly.
          const rawAmount = remainingAtomic.toString();
          const transferAmount = Number(remainingAtomic) / 1e6;

          const outcome: any = await txDepositFt(tokenContract, Number(dealId), rawAmount);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || "";

          if (!txHash) throw new Error("USDC Deposit transaction was not confirmed");

          await new Promise((resolve) => setTimeout(resolve, 1200));
          const recordedDeal = await fetchContractDeal(Number(dealId));
          const required = isBuyer
            ? BigInt(recordedDeal?.price || "0") + BigInt(recordedDeal?.buyer_collateral || "0")
            : BigInt(recordedDeal?.seller_collateral || "0");
          const deposited = BigInt(isBuyer ? recordedDeal?.buyer_deposited || "0" : recordedDeal?.seller_deposited || "0");
          if (!recordedDeal || required <= BigInt(0) || deposited < required) {
            throw new Error("The NEAR escrow contract did not record the full deposit");
          }
          const funded = ["Funded", "Active"].includes(String(recordedDeal.status));

          patchDeal(dealId, (item) => ({
            ...item,
            buyerDeposited: isBuyer ? true : item.buyerDeposited,
            sellerDeposited: !isBuyer ? true : item.sellerDeposited,
            step: funded ? "key" : "deposit",
            status: funded ? "Funded" : "Created",
            activity: [
              {
                id: crypto.randomUUID(),
                title: "USDC Escrow Deposited",
                detail: `$${transferAmount.toFixed(6)} USDC locked in Conpi Maker Vault (NEAR).`,
                tx: txHash,
                time: "Now",
              },
              ...item.activity,
            ],
          }));

          setTimeout(loadOnChainData, 2000);
          return {
            ok: true,
            title: "USDC Deposit Confirmed on NEAR",
            body: `$${transferAmount.toFixed(6)} USDC locked in Conpi Maker Vault.`,
            href: `https://testnet.nearblocks.io/txns/${txHash}`,
          };
        } catch (err: any) {
          return { ok: false, title: "Deposit failed", body: err.message };
        }
      },
      depositForeignBaseUsdc: async (dealId, evmTxHash, buyerEvmAddress, sellerEvmAddress) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };

        try {
          await submitPartyTermsToTee(deal, deal.role);
          const termsHashHex = deal.termsHash?.replace(/^0x/, "") || "";
          const usdcNominal = deal.priceUsd && deal.priceUsd > 0
            ? deal.priceUsd
            : deal.price;
          const expectedUsdcAtomic = Math.round(usdcNominal * 1e6).toString();

          if (!sellerEvmAddress || sellerEvmAddress === "0x0000000000000000000000000000000000000000") {
            return {
              ok: false,
              title: "Seller Address Required",
              body: "The seller must specify their Base Sepolia payout address before funds can be deposited.",
            };
          }
          if (buyerEvmAddress && sellerEvmAddress.toLowerCase() === buyerEvmAddress.toLowerCase()) {
            return {
              ok: false,
              title: "Invalid Recipient",
              body: "Seller payout address cannot match the buyer address. Buyer cannot redirect seller payouts to themselves.",
            };
          }

          // Foreign settlement parameters are seller-locked before a buyer can
          // deposit. The buyer may only bind their own refund address.
          let onChainForeign = await fetchContractForeignDeal(Number(dealId));
          if (
            !onChainForeign ||
            !onChainForeign.vault_address ||
            BigInt(onChainForeign.foreign_amount || "0") <= BigInt(0)
          ) {
            throw new Error("The seller must lock the foreign vault, payout address, token, and amount before the buyer deposits");
          }
          if (BigInt(onChainForeign.foreign_amount) !== BigInt(expectedUsdcAtomic)) {
            throw new Error("The requested deposit does not match the seller-locked on-chain amount");
          }
          if (
            onChainForeign?.vault_address &&
            (!onChainForeign.buyer_address || onChainForeign.buyer_address === "0x0000000000000000000000000000000000000000") &&
            buyerEvmAddress &&
            buyerEvmAddress !== "0x0000000000000000000000000000000000000000"
          ) {
            await txSetForeignBuyerAddress(Number(dealId), buyerEvmAddress);
            await new Promise((r) => setTimeout(r, 800));
            onChainForeign = await fetchContractForeignDeal(Number(dealId));
          }
          if (!buyerEvmAddress || buyerEvmAddress === "0x0000000000000000000000000000000000000000") {
            throw new Error("Connect the Base buyer wallet before verifying the deposit");
          }

          const result = await teeApi.verifyForeignDeposit({
            dealId: Number(dealId),
            txHash: evmTxHash,
            termsHashHex,
            expectedAmountAtomic: expectedUsdcAtomic,
            sellerAddress: sellerEvmAddress,
            autoRelay: true,
          });

          if (!result.ok) {
            throw new Error(result.error || "TEE verification of Base Sepolia deposit failed");
          }

          // Fallback to manual on-chain deposit recording if auto-relay failed or was unconfigured
          if (!result.relayResult?.transactionHash && result.payload?.signatureHex) {
            try {
              await txRecordForeignDeposit(
                Number(dealId),
                evmTxHash,
                result.payload.payload,
                result.payload.signatureHex
              );
            } catch (fbErr) {
              console.warn("Manual fallback txRecordForeignDeposit warning:", fbErr);
            }
          }

          await new Promise((r) => setTimeout(r, 1200));
          const fundedDeal = await fetchContractDeal(Number(dealId));
          const requiredBuyerDeposit = fundedDeal
            ? BigInt(fundedDeal.price || "0") + BigInt(fundedDeal.buyer_collateral || "0")
            : BigInt(0);
          const buyerDepositRecorded = fundedDeal
            ? BigInt(fundedDeal.buyer_deposited || "0") >= requiredBuyerDeposit && requiredBuyerDeposit > BigInt(0)
            : false;
          if (!buyerDepositRecorded) {
            throw new Error(result.relayResult?.error || "Deposit was verified, but the TEE-signed escrow record has not been confirmed on NEAR");
          }
          const funded = ["Funded", "Active"].includes(String(fundedDeal?.status));

          patchDeal(dealId, (item) => ({
            ...item,
            buyerDeposited: true,
            step: funded ? "key" : "deposit",
            status: funded ? "Funded" : "Created",
            activity: [
              {
                id: crypto.randomUUID(),
                title: "Base Sepolia Deposit Verified",
                detail: `Deposited $${deal.price} USDC on Base Sepolia. Attested by TEE.`,
                tx: evmTxHash,
                time: "Now",
              },
              ...item.activity,
            ],
          }));

          setTimeout(loadOnChainData, 2000);

          return {
            ok: true,
            title: funded ? "Base Sepolia Deposit Funded" : "Base Sepolia Deposit Recorded",
            body: funded
              ? "Transaction confirmed on Base Sepolia and the escrow is Funded."
              : "Buyer deposit is recorded on-chain; the deal remains Created until the seller collateral is deposited.",
            href: `https://sepolia.basescan.org/tx/${evmTxHash}`,
          };
        } catch (err: any) {
          return { ok: false, title: "Base Deposit Verification Failed", body: err.message };
        }
      },
      depositSolanaCollateral: async (dealId, solanaTxSignature) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        try {
          const solanaAccount = stateRef.current.solanaAccount;
          const sellerCanonical = (deal.sellerCanonical || toNearAccountId(deal.seller)).toLowerCase();
          if (!solanaAccount || toNearAccountId(solanaAccount).toLowerCase() !== sellerCanonical) {
            throw new Error("Connect the Solana seller wallet before recording collateral");
          }
          await submitPartyTermsToTee(deal, "seller");
          const termsHashHex = deal.termsHash?.replace(/^0x/, "") || "";
          if (termsHashHex.length !== 64) throw new Error("Deal terms hash is missing");
          const result = await teeApi.verifySolanaCollateral(Number(dealId), {
            txSignature: solanaTxSignature,
            termsHashHex,
          });
          if (!result.ok) throw new Error(result.error || "TEE rejected the Solana collateral transfer");
          patchDeal(dealId, (item) => ({
            ...item,
            sellerDeposited: true,
            status: item.buyerDeposited ? "Funded" : "Created",
            step: item.buyerDeposited ? "key" : "deposit",
            activity: [{
              id: crypto.randomUUID(),
              title: "Solana seller collateral verified",
              detail: "The TEE verified the exact USDC transfer to the Chain Signatures vault.",
              tx: solanaTxSignature,
              time: "Now",
            }, ...item.activity],
          }));
          setTimeout(loadOnChainData, 1_500);
          return {
            ok: true,
            title: "Solana collateral recorded",
            body: "The NEAR escrow has recorded the verified seller collateral.",
            href: `https://explorer.solana.com/tx/${solanaTxSignature}?cluster=devnet`,
          };
        } catch (err: any) {
          return { ok: false, title: "Solana collateral failed", body: err?.message || String(err) };
        }
      },
      depositUsdcViaMakerVault: async (
        dealId,
        chain,
        txHash,
        amountUsdc,
        buyerAddress,
        sellerPayoutChain,
        sellerPayoutAddress
      ) => {
        void dealId;
        void chain;
        void txHash;
        void amountUsdc;
        void buyerAddress;
        void sellerPayoutChain;
        void sellerPayoutAddress;
        return {
          ok: false,
          title: "Shared Maker Vault deposits are paused",
          body: "Use the per-deal Base vault or the on-chain NEAR escrow. A browser-verified pooled deposit cannot mark a deal Funded.",
        };
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
          const connectedAccount = (stateRef.current.account || "").trim().toLowerCase();
          const nearConnected = toNearAccountId(connectedAccount);
          const sellerAddress = deal.seller.trim().toLowerCase();
          const sellerCanonical = (deal.sellerCanonical || toNearAccountId(deal.seller)).trim().toLowerCase();
          const isSellerMatch =
            connectedAccount === sellerAddress ||
            connectedAccount === sellerCanonical ||
            nearConnected === sellerCanonical ||
            (stateRef.current.solanaAccount && toNearAccountId(stateRef.current.solanaAccount).toLowerCase() === sellerCanonical) ||
            (stateRef.current.solanaAccount && stateRef.current.solanaAccount.toLowerCase() === sellerAddress) ||
            (stateRef.current.nearAccount && (
              stateRef.current.nearAccount.toLowerCase() === sellerAddress ||
              toNearAccountId(stateRef.current.nearAccount).toLowerCase() === sellerCanonical
            ));
          if (!isSellerMatch) {
            pushToast({ kind: "error", title: "Seller wallet required", body: `Connect seller wallet (${deal.seller}) before submitting the provider key.` });
            return;
          }
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
          const liveAttestation = await verifyLiveAttestation();
          if (!liveAttestation.verified || !liveAttestation.signerPublicKeyNear) {
            pushToast({
              kind: "error",
              title: "TEE verification failed",
              body: liveAttestation.errors?.join("; ") || "The current enclave identity could not be verified.",
            });
            return;
          }
          const dealTeeSigner = String(onChain?.tee_pubkey || "").trim();
          if (dealTeeSigner && dealTeeSigner !== liveAttestation.signerPublicKeyNear) {
            pushToast({
              kind: "error",
              title: "Deal uses the retired TEE",
              body: `Deal #${dealId} was created for the previous enclave and cannot be activated by the current Phala CVM. Create a new deal; do not resubmit the provider key here.`,
            });
            return;
          }
          if (onChain && !onChain.counterparty_accepted && deal.termsHash) {
            if (stateRef.current.solanaAccount && toNearAccountId(stateRef.current.solanaAccount).toLowerCase() === sellerCanonical) {
              throw new Error("Accept the deal with the Solana seller wallet before submitting the provider key.");
            }
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

          const ticket = await submitPartyTermsToTee(deal, "seller");
          if (!ticket.matched) {
            pushToast({
              kind: "error",
              title: "Buyer TEE confirmation required",
              body: `Connect ${deal.buyer} and submit the encrypted terms before retrying the provider key.`,
            });
            return;
          }

          const enclaveKey = await getVerifiedEncryptionKey();
          const encryptedEnvelope = encryptApiKeyToEnclave(plainApiKey, enclaveKey);
          const sellerAuthorization = await signSellerKeyAuthorization(stateRef.current.walletChain, {
            dealId: Number(dealId),
            seller: sellerCanonical,
            provider,
            model,
            models,
            termsHashHex: deal.termsHash ? deal.termsHash.replace(/^0x/, "") : "00".repeat(32),
            encryptedEnvelope,
          });
          const res = await teeApi.submitKey(Number(dealId), {
            provider,
            model,
            models,
            creditUsd: deal.sellerTerms.creditUsd ?? deal.buyerTerms.creditUsd ?? deal.creditUsd ?? deal.credit,
            priceUsd: deal.sellerTerms.priceUsd ?? deal.buyerTerms.priceUsd ?? deal.priceUsd ?? deal.price,
            termsHashHex: deal.termsHash ? deal.termsHash.replace(/^0x/, "") : "00".repeat(32),
            encryptedEnvelope,
            sellerAuthorization,
          });

          if (!res.ok) {
            pushToast({ kind: "error", title: "Enclave preflight failed", body: res.error || "Preflight check rejected key" });
            return;
          }

          if (!res.activatePayload || !res.activateSignatureHex) {
            pushToast({ kind: "error", title: "Missing TEE activation payload or signature" });
            return;
          }

          let txHash = res.activationTxHash || "";
          if (!res.activationRelayed && !res.activationAlreadyActive) {
            pushToast({ kind: "pending", title: "Submitting deal activation transaction to NEAR..." });
            const outcome: any = await txActivateDeal(Number(dealId), res.activatePayload, res.activateSignatureHex);
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || "";
          }
          if (!txHash && !res.activationAlreadyActive) {
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
            activity: [{ id: crypto.randomUUID(), title: "Deal Activated via TEE", detail: "Hardware proof verified. Proxy key live.", tx: txHash || undefined, time: "Now" }, ...item.activity],
          }));

          pushToast({
            kind: "success",
            title: "Deal Activated!",
            body: res.activationRelayed ? "TEE relayer activated the deal. Proxy key is ready for inference." : "Proxy key is active and ready for inference.",
            href: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : undefined,
          });
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
            let mData: any = null;
            try {
              let mRes = await fetch(`${BASE_URL}/deals/${dealId}/meter`);
              if (!mRes.ok) mRes = await fetch(`/api/vault/meter?dealId=${dealId}`);
              if (!mRes.ok) mRes = await fetch(`http://localhost:4000/v1/deals/${dealId}/meter`);
              if (mRes.ok) mData = await mRes.json();
            } catch {}
            const used = Number(mData?.usedUsd ?? deal.usedUsd ?? 0);
            const creditUsd = Number(mData?.creditUsd || deal.creditUsd || deal.credit);
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

          const target = stagePayloads[stagePayloads.length - 1];
          const stg = Number(target.payload.stage);
          pushToast({ kind: "pending", title: `Submitting on-chain release for Stage ${stg}%...` });

          let txHash: string;
          const onChainForeign = await fetchContractForeignDeal(Number(dealId));
          if (onChainForeign) {
            const foreignAmount = BigInt(onChainForeign.foreign_amount || "0");
            const stageDelta = BigInt(stg) - BigInt(deal.stage || 0);
            const payoutAmount = (stageDelta * foreignAmount) / BigInt(100);
            const { sighashBytes, sighash } = computeForeignTransferSighash({
              recipient: onChainForeign.seller_address,
              amountAtomic: payoutAmount,
              nonce: Number(onChainForeign.evm_nonce || 0),
              tokenAddress: onChainForeign.token_address,
              chainId: Number(onChainForeign.chain_id || BASE_SEPOLIA_CHAIN_ID),
            });
            const outcome: any = await txReleaseStageForeign(
              Number(dealId),
              stg,
              target.payload,
              target.signatureHex,
              {
                nonce: Number(onChainForeign.evm_nonce || 0),
                recipient: onChainForeign.seller_address,
                amount: payoutAmount.toString(),
                sighash: sighashBytes,
              }
            );
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;

            // Auto-broadcast via TEE
            const receipts = outcome?.receipts_outcome || [];
            for (const r of receipts) {
              for (const log of (r?.outcome?.logs || [])) {
                if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
                  try {
                    const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
                    const ev = (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null)
                      || (parsed.standard === "foreign_tx_signed" ? parsed.event : null)
                      || (parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null);
                    if (ev) {
                      teeApi.broadcastPayout({
                        dealId: Number(dealId),
                        stage: Number(ev.stage || stg),
                        chainId: Number(ev.chain_id || BASE_SEPOLIA_CHAIN_ID),
                        recipient: ev.recipient || onChainForeign.seller_address,
                        amountAtomic: String(ev.amount || payoutAmount.toString()),
                        sighashHex: (ev.sighash_hex?.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`) || sighash,
                        rHex: ev.r_hex,
                        sHex: ev.s_hex,
                        recoveryId: Number(ev.recovery_id),
                        nonce: Number(onChainForeign.evm_nonce || 0),
                      }).catch(() => {});
                    }
                  } catch {}
                }
              }
            }
          } else {
            const outcome: any = await txReleaseStage(Number(dealId), stg, target.payload, target.signatureHex);
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          }
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
          let txHash: string;
          const onChainForeign = await fetchContractForeignDeal(Number(dealId));
          if (onChainForeign) {
            const onChainDeal = await fetchContractDeal(Number(dealId));
            const foreignAmount = BigInt(onChainForeign.foreign_amount || "0");
            let refundAmount = foreignAmount;
            if (deal.status === "Active" && onChainDeal) {
              const lastMetered = BigInt(onChainDeal.last_signed?.metered_value || "0");
              const creditAmount = BigInt(onChainDeal.credit_amount || "1");
              const fractionBps = creditAmount === BigInt(0) ? BigInt(0) : (lastMetered * BigInt(10000)) / creditAmount;
              const clampedBps = fractionBps > BigInt(10000) ? BigInt(10000) : fractionBps;
              const sellerEarned = (clampedBps * foreignAmount) / BigInt(10000);
              const alreadyReleased = (BigInt(onChainDeal.stage_reached || 0) * foreignAmount) / BigInt(100);
              const effectiveTaken = sellerEarned > alreadyReleased ? sellerEarned : alreadyReleased;
              refundAmount = foreignAmount > effectiveTaken ? foreignAmount - effectiveTaken : BigInt(0);
            }
            const { sighashBytes, sighash } = computeForeignTransferSighash({
              recipient: onChainForeign.buyer_address,
              amountAtomic: refundAmount,
              nonce: Number(onChainForeign.evm_nonce || 0),
              tokenAddress: onChainForeign.token_address,
              chainId: Number(onChainForeign.chain_id || BASE_SEPOLIA_CHAIN_ID),
            });
            const outcome: any = await txSettleDefaultForeign(
              Number(dealId),
              payloadToSubmit,
              signatureHexToSubmit,
              {
                nonce: Number(onChainForeign.evm_nonce || 0),
                recipient: onChainForeign.buyer_address,
                amount: refundAmount.toString(),
                sighash: sighashBytes,
              }
            );
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;

            // Auto-broadcast via TEE
            const receipts = outcome?.receipts_outcome || [];
            for (const r of receipts) {
              for (const log of (r?.outcome?.logs || [])) {
                if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
                  try {
                    const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
                    const ev = (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null)
                      || (parsed.standard === "foreign_tx_signed" ? parsed.event : null)
                      || (parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null);
                    if (ev) {
                      teeApi.broadcastPayout({
                        dealId: Number(dealId),
                        stage: Number(ev.stage || 0),
                        chainId: Number(ev.chain_id || BASE_SEPOLIA_CHAIN_ID),
                        recipient: ev.recipient || onChainForeign.buyer_address,
                        amountAtomic: String(ev.amount || refundAmount.toString()),
                        sighashHex: (ev.sighash_hex?.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`) || sighash,
                        rHex: ev.r_hex,
                        sHex: ev.s_hex,
                        recoveryId: Number(ev.recovery_id),
                        nonce: Number(onChainForeign.evm_nonce || 0),
                      }).catch(() => {});
                    }
                  } catch {}
                }
              }
            }
          } else {
            const outcome: any = await txSettleDefault(
              Number(dealId),
              payloadToSubmit,
              signatureHexToSubmit
            );
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          }
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
      syncMeterState: async (dealId, silent = false) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal?.proxyKey) {
          if (!silent) {
            pushToast({ kind: "error", title: "Proxy key required", body: "Import or copy this deal's cpk_live_ key to view its private meter." });
          }
          return;
        }

        const endpoints = (deal.baseUrl?.includes("localhost") || (deal as any).active_vault_deal)
          ? [
              `/api/vault/meter?dealId=${dealId}`,
              `http://localhost:4000/v1/deals/${dealId}/meter`,
              `${BASE_URL}/deals/${dealId}/meter`,
            ]
          : [
              `${BASE_URL}/deals/${dealId}/meter`,
              `/api/vault/meter?dealId=${dealId}`,
              `http://localhost:4000/v1/deals/${dealId}/meter`,
            ];

        let data: any = null;
        let lastStatus = 0;

        for (const url of endpoints) {
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${deal.proxyKey}` },
              cache: "no-store",
            });
            if (res.ok) {
              data = await res.json();
              break;
            } else {
              lastStatus = res.status;
            }
          } catch {}
        }

        if (data) {
          if (typeof window !== "undefined" && data.lockedPricing) {
            try {
              localStorage.setItem(`conpi:locked_pricing_${dealId}`, JSON.stringify(data.lockedPricing));
            } catch {}
          }
          patchDeal(dealId, (item) => {
            const creditUsd = Number(data.creditUsd) || item.creditUsd || item.credit;
            const priceUsd = Number(data.priceUsd) || item.priceUsd || item.price;
            const usedUsd = Number(data.usedUsd ?? item.usedUsd);
            const tokens = Number(data.tokensTotal ?? item.tokens);
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
              // Usage crossing a threshold is not proof of payment. Keep the
              // stage loaded from the escrow contract until its transfer is
              // confirmed on-chain.
              stage: item.stage,
              prices: lockedPriceRows.length ? lockedPriceRows : item.prices,
              pricingSnapshotHash: data.pricingSnapshotHash || item.pricingSnapshotHash,
              usageReceiptCount: Number(data.usageReceiptCount ?? item.usageReceiptCount ?? 0),
              lastUsageReceipt: data.lastUsageReceipt ?? item.lastUsageReceipt ?? null,
              lastUpdate: `TEE Enclave (${new Date().toLocaleTimeString()})`,
              heartbeat: data.active ? "live" : item.heartbeat,
            };
          });

          if (!silent) {
            pushToast({
              kind: "success",
              title: "Meter synced with TEE enclave",
              body: `$${Number(data.usedUsd || 0).toFixed(4)} USD · ${Number(data.tokensTotal || 0).toLocaleString()} tokens`,
            });
          }
        } else {
          if (!silent) {
            pushToast({ kind: "error", title: "Failed to sync meter", body: lastStatus ? `Enclave returned HTTP ${lastStatus}` : "Enclave unavailable" });
          }
        }
      },
      importProxyKey: async (dealId, candidate) => {
        const proxyKey = candidate.trim();
        if (!/^cpk_live_[A-Za-z0-9_-]{16,}$/.test(proxyKey)) {
          pushToast({ kind: "error", title: "Invalid proxy key", body: "Paste the cpk_live_ key issued by the TEE for this deal." });
          return false;
        }
        try {
          const meterData = await teeApi.getMeter(Number(dealId), proxyKey);
          const raw = localStorage.getItem("conpi:deal_keys");
          const stored = raw ? JSON.parse(raw) : {};
          stored[String(dealId)] = proxyKey;
          localStorage.setItem("conpi:deal_keys", JSON.stringify(stored));
          patchDeal(dealId, (deal) => {
            const creditUsd = Number(meterData?.creditUsd) || deal.creditUsd || deal.credit;
            const usedUsd = Number(meterData?.usedUsd ?? deal.usedUsd);
            const tokens = Number(meterData?.tokensTotal ?? deal.tokens);
            return {
              ...deal,
              proxyKey,
              heartbeat: "live",
              usedUsd,
              tokens,
              stage: deal.stage,
            };
          });
          pushToast({ kind: "success", title: "Private live meter connected", body: "Authenticated WebSocket updates are now enabled for this browser." });
          return true;
        } catch (err: any) {
          pushToast({ kind: "error", title: "Proxy key rejected", body: err.message });
          return false;
        }
      },
      applyMeterEvent: (dealId, event) => {
        patchDeal(dealId, (deal) => {
          const creditUsd = Number(event.creditUsd) || deal.creditUsd || deal.credit;
          const priceUsd = Number(event.priceUsd) || deal.priceUsd || deal.price;
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
            stage: deal.stage,
            prices: lockedPriceRows.length ? lockedPriceRows : deal.prices,
            pricingSnapshotHash: event.pricingSnapshotHash || deal.pricingSnapshotHash,
            usageReceiptCount: Number(event.usageReceiptCount ?? deal.usageReceiptCount ?? 0),
            lastUsageReceipt: event.lastUsageReceipt ?? deal.lastUsageReceipt ?? null,
            heartbeat: event.active ? "live" : deal.heartbeat,
            pulseStage: deal.pulseStage,
            lastUpdate: `TEE Enclave (${new Date(event.timestamp).toLocaleTimeString()})`,
          };
        });
      },
      setHeartbeat: (dealId, heartbeat) => patchDeal(dealId, (deal) => ({ ...deal, heartbeat })),
      claimOne: async (id) => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        try {
          const outcome: any = await txClaim(MAKER_VAULT_CONFIG.near.tokenAddress);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Claim transaction failed");
          setState((s) => ({
            ...s,
            claims: s.claims.map((item) => (item.id === id ? { ...item, claimed: true, tx: txHash } : item)),
          }));
          return { ok: true, title: "Payout claimed on-chain", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "USDC payout settled to your account." };
        } catch (err: any) {
          return { ok: false, title: "Claim transaction failed", body: err.message };
        }
      },
      claimAll: async () => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        try {
          const outcome: any = await txClaim(MAKER_VAULT_CONFIG.near.tokenAddress);
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
        const activeAccount = current.account || current.nearAccount || current.evmAccount || current.solanaAccount;
        if (!activeAccount) return { ok: false, title: "Connect a wallet first" };
        if (listing.seller && listing.seller.trim().toLowerCase() !== activeAccount.trim().toLowerCase()) {
          return { ok: false, title: "Listing owner mismatch", body: "The connected seller wallet must own the listing." };
        }

        const buyer = (listing as any).buyer?.trim();
        // If buyer is explicitly provided and different from seller, create direct deal on-chain
        if (buyer) {
          const nearBuyer = toNearAccountId(buyer);
          const nearSeller = toNearAccountId(activeAccount);
          if (nearBuyer.toLowerCase() === nearSeller.toLowerCase()) {
            return {
              ok: false,
              title: "Buyer and seller must differ",
              body: "You cannot create a deal with yourself. Please enter your second testnet wallet for the Buyer, or leave blank to publish publicly.",
            };
          }

          pushToast({ kind: "pending", title: "Awaiting wallet approval to create deal on NEAR..." });
          try {
            const params = await dealParamsForListing(listing, buyer, activeAccount);
            const outcome: any = await txCreateDeal(params);
            const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
            let dealId = createdDealIdFromOutcome(outcome);
            if (!dealId) {
              await new Promise((r) => setTimeout(r, 1500));
              const deals = await fetchContractDeals(0, 100);
              const latest = deals.filter((d) => d.buyer === nearBuyer && d.seller === nearSeller).sort((a, b) => Number(b.id) - Number(a.id))[0];
              if (latest) dealId = Number(latest.id);
            }

            if (dealId) {
              const createdTermsHashHex = await waitForOnChainTermsHash(Number(dealId));
              const boundListing = await saveDealListingMetadata(listing, String(dealId));
              setState((s) => ({
                ...s,
                listings: [boundListing, ...s.listings.filter((item) => item.id !== listing.id)],
              }));
              await teeApi.initTicket(String(dealId), Number(dealId), buyer, activeAccount, createdTermsHashHex);

              if (listing.token === "USDC" || (listing.token as any) === "USDC.base") {
                try {
                  const vault = deriveForeignVaultAddress(CONTRACT_ID, Number(dealId));
                  const foreignAmount = Math.round(listing.price * 1e6).toString();
                  const savedSellerEvm = typeof window !== "undefined" ? (localStorage.getItem(`conpi_seller_evm_${dealId}`) || localStorage.getItem("conpi_last_seller_evm") || "0x0000000000000000000000000000000000000000") : "0x0000000000000000000000000000000000000000";
                  console.log(`[createListing] Auto-registering foreign deal #${dealId} on Base Sepolia... Vault: ${vault.address}`);
                  await txRegisterForeignChainDeal(
                    Number(dealId),
                    BASE_SEPOLIA_CHAIN_ID,
                    vault.address,
                    BASE_SEPOLIA_USDC,
                    buyer.startsWith("0x") ? buyer : "0x0000000000000000000000000000000000000000",
                    savedSellerEvm,
                    foreignAmount
                  );
                } catch (fErr) {
                  console.warn("[createListing] Auto-register foreign chain deal failed or already registered:", fErr);
                }
              }
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
        const publishedListing: Listing = withExplicitListingUsd({ ...listing, seller: activeAccount, published: true });
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
          const onChainForeign = await fetchContractForeignDeal(Number(dealId));
          let txHash: string;
          if (onChainForeign) {
            const onChainDeal = await fetchContractDeal(Number(dealId));
            const foreignAmount = BigInt(onChainForeign.foreign_amount || "0");
            let refundAmount = foreignAmount;
            if (deal.status === "Active" && onChainDeal) {
              const lastMetered = BigInt(onChainDeal.last_signed?.metered_value || "0");
              const creditAmount = BigInt(onChainDeal.credit_amount || "1");
              const fractionBps = creditAmount === BigInt(0) ? BigInt(0) : (lastMetered * BigInt(10000)) / creditAmount;
              const clampedBps = fractionBps > BigInt(10000) ? BigInt(10000) : fractionBps;
              const sellerEarned = (clampedBps * foreignAmount) / BigInt(10000);
              const alreadyReleased = (BigInt(onChainDeal.stage_reached || 0) * foreignAmount) / BigInt(100);
              const effectiveTaken = sellerEarned > alreadyReleased ? sellerEarned : alreadyReleased;
              refundAmount = foreignAmount > effectiveTaken ? foreignAmount - effectiveTaken : BigInt(0);
            }
            const { sighashBytes, sighash: sighashHex } = computeForeignTransferSighash({
              recipient: onChainForeign.buyer_address,
              amountAtomic: refundAmount,
              nonce: Number(onChainForeign.evm_nonce || 0),
              tokenAddress: onChainForeign.token_address,
              chainId: Number(onChainForeign.chain_id || BASE_SEPOLIA_CHAIN_ID),
            });
            const outcome: any = await txTimeoutRefundForeign(Number(dealId), {
              nonce: Number(onChainForeign.evm_nonce || 0),
              recipient: onChainForeign.buyer_address,
              amount: refundAmount.toString(),
              sighash: sighashBytes,
            });
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;

            // Auto-broadcast payout signature to Base Sepolia via enclave relayer
            const receipts = outcome?.receipts_outcome || [];
            for (const r of receipts) {
              for (const log of (r?.outcome?.logs || [])) {
                if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
                  try {
                    const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
                    const ev = (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null)
                      || (parsed.standard === "foreign_tx_signed" ? parsed.event : null)
                      || (parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null);
                    if (ev) {
                      teeApi.broadcastPayout({
                        dealId: Number(dealId),
                        stage: Number(ev.stage || 0),
                        chainId: Number(ev.chain_id || BASE_SEPOLIA_CHAIN_ID),
                        recipient: ev.recipient || onChainForeign.buyer_address,
                        amountAtomic: String(ev.amount || refundAmount.toString()),
                        sighashHex: (ev.sighash_hex?.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`) || sighashHex,
                        rHex: ev.r_hex,
                        sHex: ev.s_hex,
                        recoveryId: Number(ev.recovery_id),
                        nonce: Number(onChainForeign.evm_nonce || 0),
                      }).catch(() => {});
                    }
                  } catch {}
                }
              }
            }
          } else {
            const outcome: any = await signAndSendCall("timeout_refund", { deal_id: Number(dealId) }, "50000000000000");
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          }
          if (!txHash) throw new Error("Timeout refund transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Deal refunded on NEAR", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "Timeout refund executed." };
        } catch (err: any) {
          return { ok: false, title: "Timeout refund failed", body: err.message };
        }
      },
      claimSellerForeignPayout: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };
        try {
          const onChainForeign = await fetchContractForeignDeal(Number(dealId));
          if (!onChainForeign) throw new Error("Not a registered foreign deal");
          const onChainDeal = await fetchContractDeal(Number(dealId));
          const foreignAmount = BigInt(onChainForeign.foreign_amount || "0");
          const lastMetered = BigInt(onChainDeal?.last_signed?.metered_value || "0");
          const creditAmount = BigInt(onChainDeal?.credit_amount || "1");
          const isCompleted = onChainDeal?.status === "Completed";
          const foreignReleasedAlready = Number(onChainForeign.evm_nonce || 0) === 0
            ? BigInt(0)
            : (BigInt(onChainDeal?.stage_reached || 0) * foreignAmount) / BigInt(100);
          const fractionBps = isCompleted
            ? BigInt(10000)
            : (creditAmount === BigInt(0) ? BigInt(0) : (lastMetered * BigInt(10000)) / creditAmount);
          const clampedBps = fractionBps > BigInt(10000) ? BigInt(10000) : fractionBps;
          const sellerEarned = (clampedBps * foreignAmount) / BigInt(10000);
          const sellerOwed = sellerEarned > foreignReleasedAlready ? sellerEarned - foreignReleasedAlready : BigInt(0);
          if (sellerOwed === BigInt(0)) throw new Error("No remaining foreign payout owed to seller");

          const { sighashBytes, sighash: sighashHex } = computeForeignTransferSighash({
            recipient: onChainForeign.seller_address,
            amountAtomic: sellerOwed,
            nonce: Number(onChainForeign.evm_nonce || 0),
            tokenAddress: onChainForeign.token_address,
            chainId: Number(onChainForeign.chain_id || BASE_SEPOLIA_CHAIN_ID),
          });

          const outcome: any = await txClaimSellerForeignPayout(Number(dealId), {
            nonce: Number(onChainForeign.evm_nonce || 0),
            recipient: onChainForeign.seller_address,
            amount: sellerOwed.toString(),
            sighash: sighashBytes,
          });
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Claim seller foreign payout transaction failed");

          // Auto-broadcast payout signature to Base Sepolia via enclave relayer
          const receipts = outcome?.receipts_outcome || [];
          for (const r of receipts) {
            for (const log of (r?.outcome?.logs || [])) {
              if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
                try {
                  const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
                  const ev = (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null)
                    || (parsed.standard === "foreign_tx_signed" ? parsed.event : null)
                    || (parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null);
                  if (ev) {
                    teeApi.broadcastPayout({
                      dealId: Number(dealId),
                      stage: Number(ev.stage || 0),
                      chainId: Number(ev.chain_id || BASE_SEPOLIA_CHAIN_ID),
                      recipient: ev.recipient || onChainForeign.seller_address,
                      amountAtomic: String(ev.amount || sellerOwed.toString()),
                      sighashHex: (ev.sighash_hex?.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`) || sighashHex,
                      rHex: ev.r_hex,
                      sHex: ev.s_hex,
                      recoveryId: Number(ev.recovery_id),
                      nonce: Number(onChainForeign.evm_nonce || 0),
                    }).catch(() => {});
                  }
                } catch {}
              }
            }
          }

          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Seller payout initiated on Base Sepolia", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: "MPC signature requested." };
        } catch (err: any) {
          return { ok: false, title: "Claim failed", body: err.message };
        }
      },
      setForeignSellerAddress: async (dealId, sellerAddress) => {
        try {
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem(`conpi_seller_evm_${dealId}`, sellerAddress);
            } catch {}
          }
          const deal = stateRef.current.deals.find((d) => d.id === dealId);
          if (!deal) throw new Error("Deal not found");
          const existing = await fetchContractForeignDeal(Number(dealId));
          let outcome: any;
          if (!existing || !existing.vault_address || BigInt(existing.foreign_amount || "0") === BigInt(0)) {
            const vault = deriveForeignVaultAddress(CONTRACT_ID, Number(dealId)).address;
            const priceUsd = deal.priceUsd && deal.priceUsd > 0 ? deal.priceUsd : deal.price;
            const expectedAmount = Math.round(priceUsd * 1_000_000).toString();
            outcome = await txRegisterForeignChainDeal(
              Number(dealId),
              BASE_SEPOLIA_CHAIN_ID,
              vault,
              BASE_SEPOLIA_USDC,
              "0x0000000000000000000000000000000000000000",
              sellerAddress,
              expectedAmount
            );
          } else {
            outcome = await txSetForeignSellerAddress(Number(dealId), sellerAddress);
          }
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Set foreign seller address transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Seller EVM address updated", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: sellerAddress };
        } catch (err: any) {
          return { ok: false, title: "Update address failed", body: err.message };
        }
      },
      setForeignBuyerAddress: async (dealId, buyerAddress) => {
        try {
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem(`conpi_buyer_evm_${dealId}`, buyerAddress);
            } catch {}
          }
          const outcome: any = await txSetForeignBuyerAddress(Number(dealId), buyerAddress);
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Set foreign buyer address transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Buyer EVM refund address updated", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: buyerAddress };
        } catch (err: any) {
          return { ok: false, title: "Update address failed", body: err.message };
        }
      },
      requestAutoRelease: async (dealId) => {
        try {
          const outcome: any = await txRequestAutoRelease(Number(dealId));
          const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          if (!txHash) throw new Error("Request auto release transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Auto-release notice initiated", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: `24-hour notice period active for Deal #${dealId}.` };
        } catch (err: any) {
          return { ok: false, title: "Request auto release failed", body: err.message };
        }
      },
      finalizeAutoRelease: async (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return { ok: false, title: "Deal not found" };

        try {
          const onChainForeign = await fetchContractForeignDeal(Number(dealId));
          let txHash: string;
          if (onChainForeign) {
            const foreignAmount = BigInt(onChainForeign.foreign_amount || "0");
            const alreadyReleased = (BigInt(deal.stage || 0) * foreignAmount) / BigInt(100);
            const payoutAmount = foreignAmount - alreadyReleased;
            if (payoutAmount <= BigInt(0)) {
              return { ok: false, title: "No remaining payout owed" };
            }
            const { sighashBytes, sighash } = computeForeignTransferSighash({
              recipient: onChainForeign.seller_address,
              amountAtomic: payoutAmount,
              nonce: Number(onChainForeign.evm_nonce || 0),
              tokenAddress: onChainForeign.token_address,
              chainId: Number(onChainForeign.chain_id || BASE_SEPOLIA_CHAIN_ID),
            });
            const outcome: any = await txFinalizeAutoReleaseForeign(Number(dealId), {
              nonce: Number(onChainForeign.evm_nonce || 0),
              recipient: onChainForeign.seller_address,
              amount: payoutAmount.toString(),
              sighash: sighashBytes,
            });
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;

            // Auto-broadcast payout if event emitted
            const receipts = outcome?.receipts_outcome || [];
            for (const r of receipts) {
              for (const log of (r?.outcome?.logs || [])) {
                if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
                  try {
                    const parsed = JSON.parse(log.slice("EVENT_JSON:".length));
                    const ev = (parsed.standard === "conpi" && parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null)
                      || (parsed.standard === "foreign_tx_signed" ? parsed.event : null)
                      || (parsed.event === "foreign_tx_signed" ? (parsed.data?.[0] || parsed.data) : null);
                    if (ev) {
                      teeApi.broadcastPayout({
                        dealId: Number(dealId),
                        stage: 100,
                        chainId: Number(ev.chain_id || BASE_SEPOLIA_CHAIN_ID),
                        recipient: ev.recipient || onChainForeign.seller_address,
                        amountAtomic: String(ev.amount || payoutAmount.toString()),
                        sighashHex: (ev.sighash_hex?.startsWith("0x") ? ev.sighash_hex : `0x${ev.sighash_hex}`) || sighash,
                        rHex: ev.r_hex,
                        sHex: ev.s_hex,
                        recoveryId: Number(ev.recovery_id ?? 0),
                        nonce: Number(onChainForeign.evm_nonce || 0),
                      }).catch((e: any) => console.warn("Relay broadcast notice:", e));
                    }
                  } catch {}
                }
              }
            }
          } else {
            const outcome: any = await txFinalizeAutoRelease(Number(dealId));
            txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id;
          }

          if (!txHash) throw new Error("Finalize auto release transaction failed");
          setTimeout(loadOnChainData, 2000);
          return { ok: true, title: "Deal auto-released and completed", href: `https://testnet.nearblocks.io/txns/${txHash}`, body: `Deal #${dealId} finalized.` };
        } catch (err: any) {
          return { ok: false, title: "Auto release failed", body: err.message };
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
      pushToast,
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
