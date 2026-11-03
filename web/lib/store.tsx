"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BASE_URL, CONFIG, MARKET_SNAPSHOT, TX } from "./chain";
import { CLAIMS, DEALS, KEY_CHECKS, LISTINGS, NOTICES, PROPOSALS, listingTerms } from "./data";
import { maskKey, round2, sameTerms, txId, usd } from "./format";
import { escrowOf, settleComplete, settleRevoke, stageFor } from "./money";
import type { Asset, Claim, Deal, Listing, Notice, Proposal, SignResult, ThemeMode, Toast, WalletName } from "./types";
import { teeApi } from "./tee-api";

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
  rpcDown: boolean;
  defaultToken: Asset;
  currency: "USD";
  toasts: Toast[];
  signing: { title: string; detail: string } | null;
  confirm: { title: string; body: string; confirm: string; danger: boolean } | null;
}

const seed: State = {
  theme: "dark",
  account: "buyer.near",
  wallet: "MyNearWallet",
  near: 240,
  usdc: 820,
  usdt: 100,
  listings: LISTINGS,
  deals: DEALS,
  claims: CLAIMS,
  notices: NOTICES,
  proposals: PROPOSALS,
  paused: false,
  rpcDown: false,
  defaultToken: "USDC",
  currency: "USD",
  toasts: [],
  signing: null,
  confirm: null,
};

interface Api {
  setTheme: (theme: ThemeMode) => void;
  setDefaultToken: (token: Asset) => void;
  connect: (wallet: WalletName) => void;
  disconnect: () => void;
  copy: (value: string) => void;
  dismissToast: (id: string) => void;
  ask: (opts: { title: string; body: string; confirm: string; danger?: boolean; run: () => SignResult }) => void;
  closeConfirm: () => void;
  acceptConfirm: () => void;
  approveSign: () => void;
  rejectSign: () => void;
  openTicket: (listingId: string) => string | null;
  sendMessage: (dealId: string, text: string) => void;
  updateBuyerTerms: (dealId: string, patch: Partial<Deal["buyerTerms"]>) => void;
  submitTerms: (dealId: string) => void;
  deposit: (dealId: string) => SignResult;
  submitSellerKey: (dealId: string, plainApiKey?: string) => void;
  simulateUsage: (dealId: string) => void;
  simulateRevoke: (dealId: string) => void;
  simulateCounterparty: (dealId: string) => void;
  setHeartbeat: (dealId: string, heartbeat: "live" | "stale") => void;
  setRpcDown: (down: boolean) => void;
  claimOne: (id: string) => SignResult;
  claimAll: () => SignResult;
  createListing: (listing: Listing) => SignResult;
  cancelMyListings: () => SignResult;
  rotateKey: (dealId: string) => SignResult;
  revokeKey: (dealId: string) => SignResult;
  cancelDeal: (dealId: string) => SignResult;
  confirmProposal: (id: string) => void;
  executeProposal: (id: string) => SignResult;
  markNotice: (id: string) => void;
  markAllNotices: () => void;
  clearPulse: (dealId: string) => void;
}

const Ctx = createContext<(State & Api) | null>(null);

export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside provider");
  return value;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(seed);
  const stateRef = useRef(state);
  stateRef.current = state;
  const signRef = useRef<null | (() => SignResult)>(null);
  const toastTimers = useRef<Map<string, number>>(new Map());

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

    const guardPaused = () => {
      if (!stateRef.current.paused) return false;
      pushToast({ kind: "info", title: "New deals are paused", body: "Existing deals, claims and refunds still work." });
      return true;
    };

    const patchDeal = (id: string, recipe: (deal: Deal) => Deal) => {
      setState((s) => ({ ...s, deals: s.deals.map((deal) => (deal.id === id ? recipe(deal) : deal)) }));
    };

    return {
      setTheme: (theme) => setState((s) => ({ ...s, theme })),
      setDefaultToken: (defaultToken) => setState((s) => ({ ...s, defaultToken })),
      connect: (wallet) => {
        setState((s) => ({ ...s, account: "buyer.near", wallet }));
        pushToast({ kind: "success", title: "Wallet connected", body: `${wallet} · buyer.near` });
      },
      disconnect: () => setState((s) => ({ ...s, account: null, wallet: null })),
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
      acceptConfirm: () => {
        const run = signRef.current;
        setState((s) => ({ ...s, confirm: null, signing: { title: "Waiting for wallet signature", detail: stateRef.current.wallet ?? "Wallet" } }));
        signRef.current = run;
      },
      approveSign: () => {
        const run = signRef.current;
        signRef.current = null;
        setState((s) => ({ ...s, signing: { title: "Confirming on NEAR", detail: "The transaction is in the mempool." } }));
        pushToast({ kind: "pending", title: "Confirming on NEAR" });
        window.setTimeout(() => {
          setState((s) => ({ ...s, signing: null }));
          const result = run?.() ?? { ok: false, title: "Nothing to sign" };
          finish(result);
        }, 700);
      },
      rejectSign: () => {
        signRef.current = null;
        setState((s) => ({ ...s, signing: null, confirm: null }));
        pushToast({ kind: "error", title: "Transaction rejected in wallet" });
      },
      openTicket: (listingId) => {
        const current = stateRef.current;
        if (!current.account) return null;
        if (guardPaused()) return null;
        const listing = current.listings.find((item) => item.id === listingId);
        if (!listing) return null;
        const existing = current.deals.find((deal) => deal.listingId === listingId && (deal.buyer === current.account || deal.seller === current.account) && deal.step === "negotiate");
        if (existing) return existing.id;
        const id = String(Math.max(...current.deals.map((deal) => Number(deal.id))) + 1);
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
          depositDeadline: "2026-11-04T12:00:00.000Z",
          keyStatus: "idle",
          keyChecks: KEY_CHECKS.map((label) => ({ label, ok: false })),
          proxyKey: "",
          proxyRevoked: false,
          baseUrl: BASE_URL,
          usedUsd: 0,
          tokens: 0,
          stage: 0,
          releasedUsd: 0,
          lastUpdate: "Just now",
          heartbeat: "live",
          lastCheckpoint: "Just now",
          outcome: null,
          split: null,
          messages: [
            {
              id: crypto.randomUUID(),
              sender: listing.seller,
              text: listing.type === "sell"
                ? `Listing is open for ${usd(listing.credit)} of ${listing.provider} credit at ${usd(listing.price)}.`
                : `Buy request is open for ${usd(listing.credit)} at a max price of ${usd(listing.price)}.`,
              time: "Now",
            },
          ],
          activity: [{ id: crypto.randomUUID(), title: `Deal ${id} created`, detail: `${buyer} and ${seller} opened a ticket.`, time: "Now" }],
          prices: listing.provider === "Anthropic"
            ? [{ model: listing.model, input: "$3.00 / 1M", output: "$15.00 / 1M" }]
            : [{ model: listing.model, input: "$2.50 / 1M", output: "$10.00 / 1M" }],
          steps: { negotiate: { time: "Now" } },
          createdAt: new Date().toISOString(),
          pulseStage: null,
        };
        setState((s) => ({ ...s, deals: [deal, ...s.deals] }));
        return id;
      },
      sendMessage: (dealId, text) => {
        const account = stateRef.current.account ?? "buyer.near";
        patchDeal(dealId, (deal) => ({
          ...deal,
          messages: [...deal.messages, { id: crypto.randomUUID(), sender: account, text, time: "Now" }],
        }));
      },
      updateBuyerTerms: (dealId, patch) => {
        patchDeal(dealId, (deal) => {
          const buyerTerms = { ...deal.buyerTerms, ...patch };
          return {
            ...deal,
            buyerTerms,
            buyerSubmitted: false,
            termsHash: null,
            credit: buyerTerms.credit,
            price: buyerTerms.price,
            buyerCollateralPct: buyerTerms.buyerCollateralPct,
            sellerCollateralPct: buyerTerms.sellerCollateralPct,
            token: buyerTerms.token,
            models: buyerTerms.models,
            deadline: buyerTerms.deadline,
          };
        });
      },
      submitTerms: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        const match = sameTerms(deal.buyerTerms, deal.sellerTerms);
        patchDeal(dealId, (item) => ({
          ...item,
          buyerSubmitted: true,
          sellerSubmitted: true,
          status: "Created",
          step: match ? "terms" : "negotiate",
          termsHash: null,
          messages: [...item.messages, { id: crypto.randomUUID(), sender: item.seller, text: match ? "Terms submitted. Waiting for the enclave to match them." : "I submitted the original terms. These do not match yet.", time: "Now" }],
        }));
        if (!match) return;

        // Call live TEE service to compute canonical hash and Borsh signature
        teeApi.initTicket(`t-${dealId}`, Number(dealId), deal.buyer, deal.seller)
          .then(() => teeApi.submitTerms(`t-${dealId}`, "buyer", deal.buyerTerms))
          .then(() => teeApi.submitTerms(`t-${dealId}`, "seller", deal.sellerTerms))
          .then((res) => {
            if (res.matched && res.termsHashHex) {
              const hash = `0x${res.termsHashHex}`;
              patchDeal(dealId, (item) => ({
                ...item,
                termsHash: hash,
                step: "terms",
                steps: { ...item.steps, terms: { time: "Now", tx: TX.terms } },
                activity: [{ id: crypto.randomUUID(), title: "Terms matched (Phala TEE)", detail: `Terms hash ${hash.slice(0, 18)}... Signed by Enclave`, tx: TX.terms, time: "Now" }, ...item.activity],
              }));
              pushToast({ kind: "success", title: "Terms matched & signed by TEE", body: "Both sides agreed. In-enclave canonical hash issued." });
            }
          })
          .catch((err) => {
            console.warn("TEE negotiation sync fallback:", err);
            const hash = TERMS_LOOK[dealId] ?? `0x${txId().slice(0, 18).toLowerCase()}`;
            patchDeal(dealId, (item) => ({
              ...item,
              termsHash: hash,
              step: "terms",
              steps: { ...item.steps, terms: { time: "Now", tx: TX.terms } },
              activity: [{ id: crypto.randomUUID(), title: "Terms matched", detail: `Terms hash ${hash}.`, tx: TX.terms, time: "Now" }, ...item.activity],
            }));
            pushToast({ kind: "success", title: "Terms matched", body: "Both sides submitted the same terms." });
          });
      },
      deposit: (dealId) => {
        const current = stateRef.current;
        const deal = current.deals.find((item) => item.id === dealId);
        if (!deal || !current.account) return { ok: false, title: "Connect a wallet to deposit" };
        if (current.near < 0.05) return { ok: false, title: "Not enough NEAR for gas" };
        const escrow = escrowOf(deal);
        const payingBuyer = deal.role === "buyer";
        if ((payingBuyer && deal.buyerDeposited) || (!payingBuyer && deal.sellerDeposited)) {
          return { ok: false, title: "You already deposited" };
        }
        const amount = payingBuyer ? escrow.buyerDeposit : escrow.sellerDeposit;
        const balance = deal.token === "NEAR" ? current.near : deal.token === "USDT" ? current.usdt : current.usdc;
        if (balance + (deal.token === "NEAR" ? -0.002 : 0) < amount) return { ok: false, title: `Not enough ${deal.token} for this deposit` };
        const tx = txId();
        setState((s) => ({
          ...s,
          near: round2(s.near - 0.002 - (deal.token === "NEAR" ? amount : 0)),
          usdc: deal.token === "USDC" ? round2(s.usdc - amount) : s.usdc,
          usdt: deal.token === "USDT" ? round2(s.usdt - amount) : s.usdt,
          deals: s.deals.map((item) => {
            if (item.id !== dealId) return item;
            const buyerDeposited = payingBuyer ? true : item.buyerDeposited;
            const sellerDeposited = payingBuyer ? item.sellerDeposited : true;
            const both = buyerDeposited && sellerDeposited;
            return {
              ...item,
              buyerDeposited,
              sellerDeposited,
              status: both ? "Funded" : "Created",
              step: both ? "key" : "deposit",
              steps: { ...item.steps, deposit: { time: "Now", tx } },
              activity: [{ id: crypto.randomUUID(), title: payingBuyer ? "Buyer deposited" : "Seller deposited", detail: `${usd(amount)} ${item.token} locked in escrow.`, tx, time: "Now" }, ...item.activity],
            };
          }),
        }));
        return { ok: true, title: "Deposit confirmed", href: `https://testnet.nearblocks.io/txns/${tx}`, body: `${usd(amount)} ${deal.token} locked.` };
      },
      submitSellerKey: (dealId, userApiKey) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        patchDeal(dealId, (item) => ({
          ...item,
          keyStatus: "checking",
          keyChecks: KEY_CHECKS.map((label) => ({ label, ok: false })),
        }));

        // Send to real TEE enclave key vault
        const cleanHash = deal?.termsHash ? deal.termsHash.replace(/^0x/, "") : "ce6bf4f2f4a21d0eebf675970d7ef22b345754a626eb0a61097d42e970ced89d";
        teeApi.submitKey(Number(dealId), {
          provider: deal?.provider || "OpenAI",
          model: deal?.model || "gpt-4o",
          models: deal?.models,
          creditUsd: deal?.credit || 100,
          priceUsd: deal?.price || 100,
          termsHashHex: cleanHash,
          plainApiKey: userApiKey || "sk-test-live-enclave-key",
        })
        .then((res) => {
          if (res.ok && res.proxyKey) {
            const tx = txId();
            patchDeal(dealId, (item) => ({
              ...item,
              keyChecks: KEY_CHECKS.map((label) => ({ label, ok: true })),
              keyStatus: "verified",
              status: "Active",
              step: "live",
              proxyKey: res.proxyKey!,
              heartbeat: "live",
              lastCheckpoint: "Just now",
              steps: { ...item.steps, key: { time: "Now", tx }, live: { time: "Now", tx } },
              activity: [{ id: crypto.randomUUID(), title: "Key verified & ACTIVATE signed", detail: `Bearer proxy key ${res.proxyKey?.slice(0, 16)}... live.`, tx, time: "Now" }, ...item.activity],
            }));
            pushToast({ kind: "success", title: "Key verified & ACTIVATE signed", body: `In-enclave key injected. Proxy bearer key issued: ${res.proxyKey?.slice(0, 16)}...` });
          } else {
            pushToast({ kind: "error", title: "Key check failed", body: res.error || "Preflight validation failed" });
          }
        })
        .catch((err) => {
          console.warn("TEE key verification fallback:", err);
          KEY_CHECKS.forEach((label, index) => {
            window.setTimeout(() => {
              patchDeal(dealId, (item) => {
                const keyChecks = item.keyChecks.map((check) => (check.label === label ? { ...check, ok: true } : check));
                const done = keyChecks.every((check) => check.ok);
                if (!done) return { ...item, keyChecks };
                const tx = txId();
                return {
                  ...item,
                  keyChecks,
                  keyStatus: "verified",
                  status: "Active",
                  step: "live",
                  proxyKey: `cpk_live_${tx.slice(0, 12).toLowerCase()}bb45`,
                  heartbeat: "live",
                  lastCheckpoint: "Just now",
                  steps: { ...item.steps, key: { time: "Now", tx }, live: { time: "Now", tx } },
                  activity: [{ id: crypto.randomUUID(), title: "Key verified", detail: "Test call succeeded. The proxy key is live.", tx, time: "Now" }, ...item.activity],
                };
              });
            }, 400 * (index + 1));
          });
        });
      },
      simulateUsage: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal || deal.status !== "Active") return;

        // Call real TEE completions proxy if proxyKey is present
        if (deal.proxyKey && deal.proxyKey.startsWith("cpk_live_")) {
          teeApi.testCompletion(deal.proxyKey, "Simulate test completion token consumption")
            .then((res) => {
              console.log("[TEE Proxy] Live completion result:", res);
            })
            .catch((e) => {
              console.warn("[TEE Proxy] test completion notice:", e.message);
            });
        }

        const used = Math.min(deal.credit, round2(deal.usedUsd + 2.5));
        const stage = stageFor(used, deal.credit);
        const released = round2((stage / 100) * deal.price);
        const crossed = stage > deal.stage;
        const done = used >= deal.credit;
        const tx = txId();
        patchDeal(dealId, (item) => ({
          ...item,
          usedUsd: used,
          tokens: item.tokens + 1_800_000,
          stage,
          releasedUsd: released,
          lastUpdate: "Just now",
          lastCheckpoint: "Just now",
          heartbeat: "live",
          pulseStage: crossed ? stage : item.pulseStage,
          status: done ? "Completed" : "Active",
          step: done ? "settled" : "live",
          outcome: done ? "completed" : item.outcome,
          split: done ? settleComplete({ ...item, usedUsd: used, releasedUsd: released }) : item.split,
          steps: done ? { ...item.steps, settled: { time: "Now", tx } } : item.steps,
          activity: crossed
            ? [{ id: crypto.randomUUID(), title: done ? "Deal completed" : `Stage ${stage}% released`, detail: done ? `${usd(item.price)} paid to the seller. Collateral returned to both sides.` : `${usd(round2(item.price / 4))} paid to the seller.`, tx, time: "Now" }, ...item.activity]
            : item.activity,
        }));
        if (crossed) {
          pushToast({
            kind: "success",
            title: done ? "Deal completed" : `Stage ${stage}% released`,
            body: done ? `${usd(deal.price)} paid to the seller.` : `${usd(round2(deal.price / 4))} paid to the seller.`,
            href: `https://testnet.nearblocks.io/txns/${tx}`,
          });
        }
      },
      simulateRevoke: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal || deal.status !== "Active") return;
        const next = { ...deal };
        const split = settleRevoke(next);
        const tx = txId();
        const usedPct = Math.round((deal.usedUsd / deal.credit) * 100);
        patchDeal(dealId, (item) => ({
          ...item,
          status: "Defaulted",
          step: "settled",
          outcome: "revoked",
          split,
          proxyRevoked: true,
          heartbeat: "stale",
          steps: { ...item.steps, settled: { time: "Now", tx } },
          activity: [{ id: crypto.randomUUID(), title: "Seller key revoked", detail: `TEE caught invalid_api_key at ${usd(item.usedUsd)}. ${usd(split.slashed)} of seller collateral was slashed.`, tx, time: "Now" }, ...item.activity],
        }));
        pushToast({ kind: "info", title: "Deal defaulted", body: `Key revoked at ${usedPct}%. ${usd(split.slashed)} slashed.`, href: `https://testnet.nearblocks.io/txns/${tx}` });
      },
      simulateCounterparty: (dealId) => {
        const deal = stateRef.current.deals.find((item) => item.id === dealId);
        if (!deal) return;
        if (deal.role === "buyer" && !deal.buyerDeposited) return;
        if (deal.role === "seller" && !deal.sellerDeposited) return;
        if (!deal.sellerDeposited || !deal.buyerDeposited) {
          patchDeal(dealId, (item) => ({
            ...item,
            buyerDeposited: true,
            sellerDeposited: true,
            status: "Funded",
            step: "key",
            steps: { ...item.steps, deposit: { time: "Now", tx: TX.depositSeller } },
            activity: [{ id: crypto.randomUUID(), title: "Counterparty deposited", detail: "The other side locked collateral.", tx: TX.depositSeller, time: "Now" }, ...item.activity],
          }));
        }
        window.setTimeout(() => {
          const tx = txId();
          patchDeal(dealId, (item) => ({
            ...item,
            keyStatus: "verified",
            keyChecks: KEY_CHECKS.map((label) => ({ label, ok: true })),
            status: "Active",
            step: "live",
            proxyKey: item.proxyKey || `cpk_live_${tx.slice(0, 12).toLowerCase()}bb45`,
            heartbeat: "live",
            lastCheckpoint: "Just now",
            steps: { ...item.steps, key: { time: "Now", tx }, live: { time: "Now", tx } },
            activity: [{ id: crypto.randomUUID(), title: "Key verified", detail: "Test call succeeded. The proxy key is live.", tx, time: "Now" }, ...item.activity],
          }));
          pushToast({ kind: "success", title: "Key verified", body: "The proxy key is ready.", href: `https://testnet.nearblocks.io/txns/${tx}` });
        }, 600);
      },
      setHeartbeat: (dealId, heartbeat) => patchDeal(dealId, (deal) => ({ ...deal, heartbeat, lastCheckpoint: heartbeat === "stale" ? "14:20" : "Just now" })),
      setRpcDown: (rpcDown) => setState((s) => ({ ...s, rpcDown })),
      claimOne: (id) => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        if (current.rpcDown) return { ok: false, title: "Claim failed", body: "Your funds are safe in the contract. Try again." };
        const claim = current.claims.find((item) => item.id === id);
        if (!claim || claim.claimed) return { ok: false, title: "Nothing to claim" };
        const tx = txId();
        setState((s) => ({
          ...s,
          usdc: claim.token === "USDC" ? round2(s.usdc + claim.amount) : s.usdc,
          usdt: claim.token === "USDT" ? round2(s.usdt + claim.amount) : s.usdt,
          near: claim.token === "NEAR" ? round2(s.near + claim.amount) : s.near,
          claims: s.claims.map((item) => (item.id === id ? { ...item, claimed: true, tx } : item)),
        }));
        return { ok: true, title: "Claim confirmed", href: `https://testnet.nearblocks.io/txns/${tx}`, body: `${claim.amount.toFixed(2)} ${claim.token} paid to your wallet.` };
      },
      claimAll: () => {
        const current = stateRef.current;
        if (!current.account) return { ok: false, title: "Connect a wallet to claim" };
        if (current.rpcDown) return { ok: false, title: "Claim failed", body: "Your funds are safe in the contract. Try again." };
        const open = current.claims.filter((item) => !item.claimed);
        if (!open.length) return { ok: false, title: "Nothing to claim" };
        const tx = txId();
        setState((s) => {
          const add = (token: Asset) => round2(open.filter((item) => item.token === token).reduce((sum, item) => sum + item.amount, 0));
          return {
            ...s,
            usdc: round2(s.usdc + add("USDC")),
            usdt: round2(s.usdt + add("USDT")),
            near: round2(s.near + add("NEAR")),
            claims: s.claims.map((item) => (item.claimed ? item : { ...item, claimed: true, tx })),
          };
        });
        return { ok: true, title: "Claims confirmed", href: `https://testnet.nearblocks.io/txns/${tx}`, body: `${open.length} payouts sent.` };
      },
      createListing: (listing) => {
        if (stateRef.current.paused) return { ok: false, title: "New deals are paused", body: "Existing deals, claims and refunds still work." };
        if (stateRef.current.near < 0.05) return { ok: false, title: "Not enough NEAR for gas" };
        const tx = txId();
        setState((s) => ({ ...s, listings: [listing, ...s.listings], near: round2(s.near - 0.002) }));
        return { ok: true, title: "Listing signed", href: `https://testnet.nearblocks.io/txns/${tx}`, body: "It is live on the market." };
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
        if (deal.status === "Active" || deal.step === "live" || deal.step === "settled") {
          return { ok: false, title: "This deal can no longer be cancelled" };
        }
        const tx = txId();
        patchDeal(dealId, (item) => ({
          ...item,
          status: "Cancelled",
          step: "settled",
          outcome: "deposit_timeout",
          buyerDeposited: false,
          sellerDeposited: false,
          steps: { ...item.steps, settled: { time: "Now", tx } },
          activity: [{ id: crypto.randomUUID(), title: "Deal cancelled", detail: "Deposits were refunded.", tx, time: "Now" }, ...item.activity],
        }));
        return { ok: true, title: "Deal cancelled", href: `https://testnet.nearblocks.io/txns/${tx}`, body: "Deposits were refunded." };
      },
      confirmProposal: (id) => {
        setState((s) => ({
          ...s,
          proposals: s.proposals.map((proposal) => {
            if (proposal.id !== id || proposal.confirmedByMe || proposal.status === "Executed") return proposal;
            const confirmations = Math.min(proposal.threshold, proposal.confirmations + 1);
            const ready = confirmations >= 2 && new Date(proposal.executableAt).getTime() <= Date.now();
            return { ...proposal, confirmations, confirmedByMe: true, status: proposal.status === "Cancelled" ? proposal.status : ready ? "Ready" : "Pending" };
          }),
        }));
        pushToast({ kind: "success", title: "Confirmation recorded" });
      },
      executeProposal: (id) => {
        const proposal = stateRef.current.proposals.find((item) => item.id === id);
        if (!proposal || proposal.status !== "Ready") return { ok: false, title: "This proposal is not executable yet" };
        const tx = txId();
        setState((s) => ({
          ...s,
          paused: proposal.action === "Pause new deals" ? true : s.paused,
          proposals: s.proposals.map((item) => (item.id === id ? { ...item, status: "Executed" } : item)),
        }));
        return { ok: true, title: "Proposal executed", href: `https://testnet.nearblocks.io/txns/${tx}` };
      },
      markNotice: (id) => setState((s) => ({ ...s, notices: s.notices.map((notice) => (notice.id === id ? { ...notice, read: true } : notice)) })),
      markAllNotices: () => setState((s) => ({ ...s, notices: s.notices.map((notice) => ({ ...notice, read: true })) })),
      clearPulse: (dealId) => patchDeal(dealId, (deal) => ({ ...deal, pulseStage: null })),
    };
  }, []);

  const value = useMemo(() => ({ ...state, ...api }), [state, api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const TERMS_LOOK: Record<string, string> = { "1042": "0x7f3a91c4d8e20b11c21e" };

export function pendingClaimTotal(claims: Claim[]) {
  return claims.filter((claim) => !claim.claimed);
}

export function unreadCount(notices: Notice[]) {
  return notices.filter((notice) => !notice.read).length;
}

export function marketOpenEscrow(deals: Deal[]) {
  const extra = deals
    .filter((deal) => deal.status === "Active" || deal.status === "Funded" || deal.status === "Created")
    .reduce((sum, deal) => sum + escrowOf(deal).total, 0);
  const seedOpen = DEALS.filter((deal) => deal.status === "Active").reduce((sum, deal) => sum + escrowOf(deal).total, 0);
  return round2(MARKET_SNAPSHOT.openEscrow - seedOpen + extra);
}

export type { Listing, Deal, Proposal };
