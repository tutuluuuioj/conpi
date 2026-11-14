"use client";

import { FormEvent, useEffect, useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftRight,
  Fingerprint,
  Lock,
  MessagesSquare,
  Send,
  Globe,
  ExternalLink,
  Copy,
  Check,
  ShieldCheck,
  Wallet,
  Loader2,
  AlertTriangle,
  Clock,
} from "lucide-react";
import { BASE_URL, CONTRACT_ID } from "@/lib/chain";
import { clockTime, maskKey, middle, ratioOf, usd } from "@/lib/format";
import { isSolanaAddress, toNearAccountId } from "@/lib/near-account";
import { escrowOf } from "@/lib/money";
import { useApp } from "@/lib/store";
import { MAKER_VAULT_CONFIG, type VaultChain } from "@/lib/maker-vault";
import { MakerVaultCard } from "./maker-vault-card";
import { teeApi } from "@/lib/tee-api";
import {
  deriveForeignVaultAddress,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_EXPLORER,
} from "@/lib/chain-signatures";
import { fetchContractDeal, fetchContractForeignDeal } from "@/lib/contract";
import {
  connectMetaMask,
  isMetaMaskInstalled,
  sendBaseUsdcDeposit,
  getBaseUsdcBalance,
  getBaseEthBalance,
  seedVaultGas,
} from "@/lib/evm-wallet";
import { sendSolanaUsdcDeposit } from "@/lib/solana-wallet";
import type { DealStep } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  Countdown,
  EmptyState,
  EscrowTable,
  HashChip,
  Meter,
  OutcomeBanner,
  Overline,
  ProviderLogo,
  SecretKey,
  StageTicks,
  StatusBadge,
  Stepper,
  fieldClass,
  txHref,
} from "./ui";

export function DealView({ id }: { id: string }) {
  const app = useApp();
  const router = useRouter();
  const deal = app.deals.find((item) => item.id === id);
  const [view, setView] = useState<DealStep>(deal?.step ?? "negotiate");
  const [key, setKey] = useState("");
  const [snippet, setSnippet] = useState<"curl" | "python" | "node">("curl");
  const [report, setReport] = useState("");
  const [keyHidden, setKeyHidden] = useState<boolean>(false);
  const [isClaimingBuyerKey, setIsClaimingBuyerKey] = useState(false);
  const [chatMsg, setChatMsg] = useState("");
  const [sellerEvmAddress, setSellerEvmAddress] = useState("");
  const [foreignInfo, setForeignInfo] = useState<any>(null);
  const [solanaInfo, setSolanaInfo] = useState<any>(null);
  const [selectedPayChain, setSelectedPayChain] = useState<VaultChain>("base");
  const [isProcessingDeposit, setIsProcessingDeposit] = useState(false);
  const [isAcceptingDeal, setIsAcceptingDeal] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositSuccess, setDepositSuccess] = useState<string | null>(null);
  const [manualTxHash, setManualTxHash] = useState("");
  const [copiedVault, setCopiedVault] = useState<string | null>(null);
  const [sellerPayoutRail, setSellerPayoutRail] = useState<VaultChain>("base");
  const [sellerPayoutCustomAddress, setSellerPayoutCustomAddress] = useState("");

  const effectiveSellerEvmAddress = useMemo(() => {
    if (sellerEvmAddress && sellerEvmAddress.trim() && sellerEvmAddress.trim() !== "0x0000000000000000000000000000000000000000") {
      return sellerEvmAddress.trim();
    }
    if (foreignInfo?.seller_address && foreignInfo.seller_address !== "0x0000000000000000000000000000000000000000") {
      return foreignInfo.seller_address.trim();
    }
    if ((deal as any)?.foreignInfo?.seller_address && (deal as any).foreignInfo.seller_address !== "0x0000000000000000000000000000000000000000") {
      return (deal as any).foreignInfo.seller_address.trim();
    }
    if (typeof window !== "undefined" && deal?.id) {
      const cached = localStorage.getItem(`conpi_seller_evm_${deal.id}`) || localStorage.getItem("conpi_last_seller_evm");
      if (cached && cached !== "0x0000000000000000000000000000000000000000") return cached.trim();
    }
    return "";
  }, [sellerEvmAddress, foreignInfo?.seller_address, (deal as any)?.foreignInfo?.seller_address, deal?.id]);
  const [isUpdatingSellerAddress, setIsUpdatingSellerAddress] = useState(false);
  const [sellerAddressStatus, setSellerAddressStatus] = useState<{ type: "idle" | "success" | "error"; msg?: string }>({ type: "idle" });
  const [isClaimingForeignPayout, setIsClaimingForeignPayout] = useState(false);
  const [buyerEvmAddressInput, setBuyerEvmAddressInput] = useState("");
  const [isUpdatingBuyerAddress, setIsUpdatingBuyerAddress] = useState(false);
  const [isRequestingAutoRelease, setIsRequestingAutoRelease] = useState(false);
  const [isFinalizingAutoRelease, setIsFinalizingAutoRelease] = useState(false);
  const [isConfirmingDeposit, setIsConfirmingDeposit] = useState(false);
  const [hasAutoAdvanced, setHasAutoAdvanced] = useState(false);
  const [vaultEthBal, setVaultEthBal] = useState<string | null>(null);
  const [isFundingGas, setIsFundingGas] = useState(false);
  const [buyerTermsRepairAttempt, setBuyerTermsRepairAttempt] = useState(0);
  const prevStepRef = useRef<DealStep | null>(null);
  const buyerTermsRepairRef = useRef<string | null>(null);

  useEffect(() => {
    if (!deal?.id) return;
    const cached = typeof window !== "undefined" ? (localStorage.getItem(`conpi_seller_evm_${deal.id}`) || localStorage.getItem("conpi_last_seller_evm")) : null;
    if (cached && cached !== "0x0000000000000000000000000000000000000000") {
      setSellerEvmAddress(cached);
    }

    const loadForeign = () => {
      fetchContractForeignDeal(Number(deal.id))
        .then((info) => {
          if (info) {
            setForeignInfo(info);
            if (info.seller_address && info.seller_address !== "0x0000000000000000000000000000000000000000") {
              setSellerEvmAddress(info.seller_address);
              if (typeof window !== "undefined") {
                try {
                  localStorage.setItem(`conpi_seller_evm_${deal.id}`, info.seller_address);
                  localStorage.setItem("conpi_last_seller_evm", info.seller_address);
                } catch {}
              }
            }
            if (info.buyer_address && !buyerEvmAddressInput) {
              setBuyerEvmAddressInput(info.buyer_address);
            }
          }
        })
        .catch(() => {});
    };

    loadForeign();
    const interval = setInterval(loadForeign, 3000);
    return () => clearInterval(interval);
  }, [deal?.id]);

  const handleUpdateSellerEvmAddress = async () => {
    if (!deal?.id || !sellerEvmAddress.trim() || !app.setForeignSellerAddress) return;
    setIsUpdatingSellerAddress(true);
    setSellerAddressStatus({ type: "idle" });
    try {
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(`conpi_seller_evm_${deal.id}`, sellerEvmAddress.trim());
          localStorage.setItem("conpi_last_seller_evm", sellerEvmAddress.trim());
        } catch {}
      }
      const res = await app.setForeignSellerAddress(deal.id, sellerEvmAddress.trim());
      if (res.ok) {
        setSellerAddressStatus({ type: "success", msg: "Payout address saved on-chain & verified." });
        const updated = await fetchContractForeignDeal(Number(deal.id));
        if (updated) {
          setForeignInfo(updated);
        } else {
          setForeignInfo((prev: any) => ({
            chain_id: 84532,
            vault_address: prev?.vault_address || "",
            token_address: prev?.token_address || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            buyer_address: prev?.buyer_address || "0x0000000000000000000000000000000000000000",
            seller_address: sellerEvmAddress.trim(),
            foreign_amount: prev?.foreign_amount || "0",
            evm_nonce: prev?.evm_nonce || 0,
            seller_claimed: prev?.seller_claimed || false,
          }));
        }
      } else {
        setSellerAddressStatus({ type: "error", msg: res.body || res.title || "Failed to update payout address on NEAR." });
      }
    } catch (err: any) {
      setSellerAddressStatus({ type: "error", msg: err?.message || "Failed to save address." });
    } finally {
      setIsUpdatingSellerAddress(false);
    }
  };

  const handleUpdateBuyerEvmAddress = async () => {
    if (!deal?.id || !buyerEvmAddressInput.trim() || !app.setForeignBuyerAddress) return;
    setIsUpdatingBuyerAddress(true);
    try {
      const res = await app.setForeignBuyerAddress(deal.id, buyerEvmAddressInput.trim());
      if (res.ok) {
        const updated = await fetchContractForeignDeal(Number(deal.id));
        if (updated) setForeignInfo(updated);
      }
    } finally {
      setIsUpdatingBuyerAddress(false);
    }
  };

  const handleRequestAutoRelease = async () => {
    if (!deal?.id || !app.requestAutoRelease) return;
    setIsRequestingAutoRelease(true);
    try {
      await app.requestAutoRelease(deal.id);
      setTimeout(app.refreshOnChain, 1500);
    } finally {
      setIsRequestingAutoRelease(false);
    }
  };

  const handleFinalizeAutoRelease = async () => {
    if (!deal?.id || !app.finalizeAutoRelease) return;
    setIsFinalizingAutoRelease(true);
    try {
      await app.finalizeAutoRelease(deal.id);
      setTimeout(app.refreshOnChain, 1500);
    } finally {
      setIsFinalizingAutoRelease(false);
    }
  };

  const handleClaimSellerForeignPayout = async () => {
    if (!deal?.id || !app.claimSellerForeignPayout) return;
    setIsClaimingForeignPayout(true);
    try {
      const res = await app.claimSellerForeignPayout(deal.id);
      if (res.ok) {
        const updated = await fetchContractForeignDeal(Number(deal.id));
        if (updated) setForeignInfo(updated);
      }
    } finally {
      setIsClaimingForeignPayout(false);
    }
  };

  const foreignVault = useMemo(() => {
    if (!deal?.id) return null;
    try {
      return deriveForeignVaultAddress(CONTRACT_ID, deal.id);
    } catch {
      return null;
    }
  }, [deal?.id]);

  useEffect(() => {
    const vAddr = foreignInfo?.vault_address || foreignVault?.address;
    if (!vAddr) return;
    getBaseEthBalance(vAddr as any).then(setVaultEthBal).catch(() => {});
  }, [foreignInfo?.vault_address, foreignVault?.address]);

  const handleFundVaultGas = async () => {
    const vAddr = foreignInfo?.vault_address || foreignVault?.address;
    if (!vAddr) return;
    setIsFundingGas(true);
    try {
      await seedVaultGas(vAddr as any, "0.0005");
      app.pushToast({
        kind: "success",
        title: "Vault Gas Funded!",
        body: "0.0005 ETH added to vault. Automated streaming payouts active.",
      });
      const updated = await getBaseEthBalance(vAddr as any);
      setVaultEthBal(updated);
    } catch (err: any) {
      app.pushToast({
        kind: "error",
        title: "Fund gas failed",
        body: err?.message || String(err),
      });
    } finally {
      setIsFundingGas(false);
    }
  };

  const baseUsdcAmount = useMemo(() => {
    if (foreignInfo?.foreign_amount && Number(foreignInfo.foreign_amount) > 0) {
      return Number(foreignInfo.foreign_amount) / 1e6;
    }
    if (deal?.priceUsd && deal.priceUsd > 0) {
      return Math.max(0.01, Number(deal.priceUsd.toFixed(2)));
    }
    return Math.max(0.01, Number((deal?.price || 0.04).toFixed(2)));
  }, [foreignInfo?.foreign_amount, deal?.priceUsd, deal?.price]);

  const dealPriceUsdc = useMemo(() => {
    if (!deal) return 0.04;
    if (deal.priceUsd && deal.priceUsd > 0) return deal.priceUsd;
    return Number(deal.price) || 0.04;
  }, [deal]);

  const requiredBuyerUsdc = useMemo(() => {
    if (!deal) return 0.04;
    const col = ((deal.buyerCollateralPct || 0) / 100) * dealPriceUsdc;
    return Number((dealPriceUsdc + col).toFixed(4));
  }, [deal, dealPriceUsdc]);

  const requiredSellerUsdc = useMemo(() => {
    if (!deal) return 0.01;
    const col = ((deal.sellerCollateralPct || 20) / 100) * dealPriceUsdc;
    return Number(col.toFixed(4));
  }, [deal, dealPriceUsdc]);

  const formatUsdcAmount = (amount: number) => {
    const hasSubCentPrecision = Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8;
    return hasSubCentPrecision ? amount.toFixed(4) : amount.toFixed(2);
  };

  const isSellerParty = useMemo(() => {
    if (!deal) return false;
    if (deal.role === "seller") return true;
    const sLower = deal.seller.toLowerCase();
    const canonicalSeller = (deal.sellerCanonical || toNearAccountId(deal.seller)).toLowerCase();
    const activeAccount = (
      app.walletChain === "near" ? app.nearAccount || app.account :
      app.walletChain === "solana" ? app.solanaAccount || app.account :
      app.walletChain === "evm" ? app.evmAccount || app.account :
      app.account
    )?.trim();
    if (!activeAccount) return false;
    const accLower = activeAccount.toLowerCase();
    const nearAcc = toNearAccountId(activeAccount);
    return (
      accLower === sLower ||
      accLower === canonicalSeller ||
      (nearAcc && nearAcc.toLowerCase() === canonicalSeller)
    );
  }, [deal?.role, deal?.seller, deal?.sellerCanonical, app.account, app.solanaAccount, app.evmAccount, app.nearAccount, app.walletChain]);

  const isBuyerParty = useMemo(() => {
    if (!deal) return false;
    const canonicalBuyer = (deal.buyerCanonical || toNearAccountId(deal.buyer)).toLowerCase();
    const activeAccount = (
      app.walletChain === "near" ? app.nearAccount || app.account :
      app.walletChain === "solana" ? app.solanaAccount || app.account :
      app.walletChain === "evm" ? app.evmAccount || app.account :
      app.account
    )?.trim();
    if (!activeAccount) return false;
    return (
      activeAccount.toLowerCase() === canonicalBuyer ||
      toNearAccountId(activeAccount).toLowerCase() === canonicalBuyer
    );
  }, [deal?.buyer, deal?.buyerCanonical, app.account, app.solanaAccount, app.evmAccount, app.nearAccount, app.walletChain]);

  const isBuyerRole = !isSellerParty;
  const isSolanaSellerDeal = Boolean(
    deal
      && (
        isSolanaAddress(deal.seller) ||
        (/^[0-9a-f]{64}$/i.test(deal.sellerCanonical || deal.seller)
          && !(deal.sellerCanonical || deal.seller).startsWith("000000000000000000000000"))
      )
  );
  const requiredDepositUsdc = isBuyerRole
    ? (deal?.buyerDepositRemaining ?? requiredBuyerUsdc)
    : (deal?.sellerDepositRemaining ?? requiredSellerUsdc);
  const buyerAlreadyDepositedUsdc = Math.max(0, requiredBuyerUsdc - (deal?.buyerDepositRemaining ?? requiredBuyerUsdc));
  const sellerAlreadyDepositedUsdc = Math.max(0, requiredSellerUsdc - (deal?.sellerDepositRemaining ?? requiredSellerUsdc));
  const activeVaultAddress = selectedPayChain === "base"
    ? String(foreignInfo?.vault_address || "")
    : selectedPayChain === "solana" && isSolanaSellerDeal
      ? String(solanaInfo?.vault_address || MAKER_VAULT_CONFIG.solana.vaultAddress)
      : MAKER_VAULT_CONFIG[selectedPayChain].vaultAddress;

  useEffect(() => {
    if (!deal?.id || !isSolanaSellerDeal) {
      setSolanaInfo(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      teeApi.getSolanaDeal(Number(deal.id))
        .then((info) => {
          if (!cancelled) setSolanaInfo(info);
        })
        .catch(() => {
          // The seller may not have accepted yet. The default is only used to
          // display guidance; the TEE always verifies the locked on-chain
          // address before recording a transfer.
          if (!cancelled) setSolanaInfo(null);
        });
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deal?.id, isSolanaSellerDeal]);

  useEffect(() => {
    if (!isSolanaSellerDeal) return;
    setSelectedPayChain(isSellerParty ? "solana" : "near");
  }, [isSolanaSellerDeal, isSellerParty, deal?.id]);

  const handleMakerVaultPay = async () => {
    if (!deal) return;
    setIsProcessingDeposit(true);
    setDepositError(null);
    setDepositSuccess(null);

    try {
      if (isSolanaSellerDeal && isBuyerRole && selectedPayChain !== "near") {
        throw new Error("This buyer deposits USDC through the NEAR escrow for the Solana seller deal.");
      }
      if (isSolanaSellerDeal && isSellerParty && selectedPayChain !== "solana") {
        throw new Error("This seller collateral must be sent from Solana to the Chain Signatures vault.");
      }
      if (selectedPayChain === "base") {
        if (!isBuyerRole) {
          throw new Error("Seller collateral must be deposited through the NEAR escrow contract");
        }
        const lockedVault = foreignInfo?.vault_address;
        if (!lockedVault || Number(foreignInfo?.foreign_amount || 0) <= 0) {
          throw new Error("The seller must lock the per-deal Base vault and amount on-chain before payment");
        }
        let evm = app.evmAccount;
        if (!evm) {
          evm = await app.connectEvm();
        }
        const { txHash } = await sendBaseUsdcDeposit({
          vaultAddress: lockedVault as any,
          amountUsdc: requiredDepositUsdc.toFixed(2),
        });
        const res = await app.depositForeignBaseUsdc(
          deal.id,
          txHash,
          evm || "",
          effectiveSellerEvmAddress || ""
        );
        if (!res.ok) throw new Error(res.body || "Verification failed");
        setDepositSuccess(`Deposit of $${formatUsdcAmount(requiredDepositUsdc)} USDC confirmed on Base Sepolia!`);
      } else if (selectedPayChain === "solana") {
        if (!isSolanaSellerDeal) {
          throw new Error("Solana USDC is available when the seller accepted this deal with a Solana wallet.");
        }
        if (!isSellerParty) throw new Error("Only the Solana seller can fund this collateral transfer.");
        const { txHash } = await sendSolanaUsdcDeposit({
          vaultAddress: activeVaultAddress,
          amountUsdc: requiredDepositUsdc.toFixed(6),
        });
        const res = await app.depositSolanaCollateral(deal.id, txHash);
        if (!res.ok) throw new Error(res.body || "TEE verification failed");
        setDepositSuccess(`Seller collateral of $${formatUsdcAmount(requiredDepositUsdc)} USDC was verified on Solana.`);
      } else {
        const res = await app.deposit(deal.id);
        if (!res.ok) throw new Error(res.body || "Deposit failed");
        setDepositSuccess(`Deposit of $${formatUsdcAmount(requiredDepositUsdc)} USDC confirmed on NEAR!`);
      }
    } catch (err: any) {
      setDepositError(err?.message || "Deposit transaction failed");
    } finally {
      setIsProcessingDeposit(false);
    }
  };

  const handleAcceptDeal = async () => {
    if (!deal) return;
    setIsAcceptingDeal(true);
    setDepositError(null);
    try {
      const result = await app.acceptDeal(deal.id);
      app.pushToast({
        kind: result.ok ? "success" : "error",
        title: result.title,
        body: result.body,
        href: result.href,
      });
      if (!result.ok) {
        setDepositError(result.body || result.title);
        return;
      }
      setDepositSuccess("Solana seller acceptance recorded. The collateral rail is now unlocked.");
      await app.refreshOnChain();
    } finally {
      setIsAcceptingDeal(false);
    }
  };

  const handleVerifyManualTx = async () => {
    if (!deal || !manualTxHash.trim()) return;
    setIsProcessingDeposit(true);
    setDepositError(null);
    setDepositSuccess(null);

    try {
      if (selectedPayChain === "solana") {
        const res = await app.depositSolanaCollateral(deal.id, manualTxHash.trim());
        if (!res.ok) throw new Error(res.body || "Solana collateral verification failed");
        setDepositSuccess(`Solana seller collateral verified for this deal.`);
        setManualTxHash("");
        return;
      }
      if (selectedPayChain !== "base") {
        throw new Error("Manual verification is available for the verified Solana seller collateral or the per-deal Base vault.");
      }
      if (!app.evmAccount) throw new Error("Connect the Base buyer wallet that sent the deposit");
      const res = await app.depositForeignBaseUsdc(
        deal.id,
        manualTxHash.trim(),
        app.evmAccount,
        effectiveSellerEvmAddress || ""
      );
      if (!res.ok) throw new Error(res.body || "Deposit verification failed");
      setDepositSuccess(`Deposit of $${formatUsdcAmount(requiredDepositUsdc)} USDC verified on ${selectedPayChain.toUpperCase()}!`);
      setManualTxHash("");
    } catch (err: any) {
      setDepositError(err?.message || "Verification failed");
    } finally {
      setIsProcessingDeposit(false);
    }
  };

  const isForeign = Boolean(foreignInfo && Number(foreignInfo.foreign_amount) > 0);
  const isForeignSettling = Boolean(isForeign && !foreignInfo?.seller_claimed && (deal?.status === "Completed" || deal?.step === "settled"));

  // Automated Zero-Click Settlement for Foreign Deals:
  // As soon as the deal reaches Completed / settled on NEAR, if the seller is logged in and foreign USDC has not been claimed yet, auto-trigger the MPC claim and broadcast!
  useEffect(() => {
    if (
      deal?.id &&
      isSellerParty &&
      isForeign &&
      !foreignInfo?.seller_claimed &&
      (deal.status === "Completed" || deal.step === "settled") &&
      !isClaimingForeignPayout &&
      app.claimSellerForeignPayout
    ) {
      console.log(`[Zero-Click Auto-Settle] Deal #${deal.id} completed. Auto-claiming foreign payout on Base Sepolia...`);
      handleClaimSellerForeignPayout();
    }
  }, [deal?.id, isSellerParty, isForeign, foreignInfo?.seller_claimed, deal?.status, deal?.step, isClaimingForeignPayout]);

  useEffect(() => {
    if (!deal?.id) return;
    void app.syncNegotiationTicket(deal.id);
    const interval = window.setInterval(() => void app.syncNegotiationTicket(deal.id), 2500);
    return () => window.clearInterval(interval);
  }, [deal?.id, app.syncNegotiationTicket]);

  // A funded buyer has already accepted the canonical on-chain terms. If a
  // previous TEE restart predates durable negotiation storage, restore that
  // buyer's encrypted term sheet once while their matching wallet is present.
  useEffect(() => {
    if (!deal || !app.nearAccount || app.walletChain !== "near") return;
    if (!["Funded", "Active"].includes(deal.status) || (deal.buyerSubmitted && deal.matched)) return;
    if (app.nearAccount.trim().toLowerCase() !== deal.buyer.trim().toLowerCase()) return;
    const attemptKey = `${deal.id}:${buyerTermsRepairAttempt}`;
    if (buyerTermsRepairRef.current === attemptKey) return;
    buyerTermsRepairRef.current = attemptKey;
    let retryTimer: number | undefined;
    void app.submitNegotiationTerms(deal.id).finally(() => {
      retryTimer = window.setTimeout(() => setBuyerTermsRepairAttempt((value) => value + 1), 15_000);
    });
    return () => {
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [deal?.id, deal?.status, deal?.buyer, deal?.buyerSubmitted, buyerTermsRepairAttempt, app.nearAccount, app.walletChain, app.submitNegotiationTerms]);

  const handleSendChat = (event: FormEvent) => {
    event.preventDefault();
    if (!chatMsg.trim() || !deal) return;
    const text = chatMsg.trim();
    setChatMsg("");
    void app.sendMessage(deal.id, text);
  };

  useEffect(() => {
    if (typeof window !== "undefined" && deal?.id) {
      const isHidden = localStorage.getItem(`conpi:hide_proxy_key_${deal.id}`) === "true";
      setKeyHidden(isHidden);
    }
  }, [deal?.id]);

  const handleCopyAndHide = (keyToCopy: string) => {
    app.copy(keyToCopy);
    setKeyHidden(true);
    if (typeof window !== "undefined" && deal?.id) {
      localStorage.setItem(`conpi:hide_proxy_key_${deal.id}`, "true");
    }
  };

  const handleRevealKey = () => {
    setKeyHidden(false);
    if (typeof window !== "undefined" && deal?.id) {
      localStorage.removeItem(`conpi:hide_proxy_key_${deal.id}`);
    }
  };

  const isForeignBuyerDeposited = Boolean(
    deal?.buyerDeposited ||
    (deal as any)?.vault_buyer_deposited
  );
  const isSellerDeposited = Boolean(
    deal?.sellerDeposited ||
    (deal as any)?.vault_seller_deposited
  );
  const bothDeposited = Boolean(
    deal &&
    (deal.buyerDeposited || isForeignBuyerDeposited) &&
    (deal.sellerDeposited || isSellerDeposited)
  );

  const effectiveStep: DealStep = useMemo(() => {
    if (!deal) return "negotiate";
    if (deal.status === "Active" || deal.step === "live") return "live";
    if (["Settled", "Completed", "Defaulted", "Cancelled", "SettledTimeout"].includes(deal.status) || deal.step === "settled") return "settled";
    if (bothDeposited || deal.status === "Funded" || deal.step === "key") return "key";
    return deal.step;
  }, [deal?.status, deal?.step, bothDeposited]);

  const effectiveDeal = useMemo(() => {
    if (!deal) return null;
    return {
      ...deal,
      role: isSellerParty ? "seller" : deal.role,
      step: effectiveStep,
      buyerDeposited: deal.buyerDeposited || isForeignBuyerDeposited,
      sellerDeposited: deal.sellerDeposited || isSellerDeposited,
    };
  }, [deal, isSellerParty, effectiveStep, isForeignBuyerDeposited, isSellerDeposited]);

  useEffect(() => {
    if (!deal) return;
    if (prevStepRef.current === null) {
      prevStepRef.current = effectiveStep;
      setView(effectiveStep);
    } else if (prevStepRef.current !== effectiveStep) {
      prevStepRef.current = effectiveStep;
      setView(effectiveStep);
    }
  }, [deal?.id, effectiveStep]);

  useEffect(() => {
    if (bothDeposited && view === "deposit" && !hasAutoAdvanced) {
      setHasAutoAdvanced(true);
      setView("key");
    }
  }, [bothDeposited, view, hasAutoAdvanced]);

  useEffect(() => {
    if (!deal?.pulseStage) return;
    const timer = window.setTimeout(() => app.clearPulse(deal.id), 800);
    return () => window.clearTimeout(timer);
  }, [deal?.pulseStage, deal?.id, app]);

  useEffect(() => {
    if (!deal || deal.status !== "Active" || !deal.proxyKey) return;
    return teeApi.openMeterStream(
      Number(deal.id),
      deal.proxyKey,
      (event) => app.applyMeterEvent(deal.id, event),
      (status) => app.setHeartbeat(deal.id, status === "connected" ? "live" : "stale")
    );
  }, [deal?.id, deal?.status, deal?.proxyKey, app.applyMeterEvent, app.setHeartbeat]);

  useEffect(() => {
    if (!deal || deal.status !== "Active" || !deal.proxyKey) return;
    app.syncMeterState(deal.id, true);
    const interval = setInterval(() => {
      app.syncMeterState(deal.id, true);
    }, 5000);
    return () => clearInterval(interval);
  }, [deal?.id, deal?.status, deal?.proxyKey]);

  if (!deal) {
    return <EmptyState icon={<ArrowLeftRight className="h-6 w-6" />} title="Deal not found." body="Check the id, or switch back to testnet." action={<Button href="/deals">All deals</Button>} />;
  }

  const escrow = escrowOf(deal);
  const depositAmount = !isSellerParty
    ? (deal.buyerDepositRemaining ?? escrow.buyerDeposit)
    : (deal.sellerDepositRemaining ?? escrow.sellerDeposit);
  const myDeposited = !isSellerParty ? (deal.buyerDeposited || isForeignBuyerDeposited) : (deal.sellerDeposited || isSellerDeposited);

  const handleProceedToKey = async () => {
    if (!deal) return;
    setIsConfirmingDeposit(true);
    try {
      const onChain = await fetchContractDeal(Number(deal.id));
      if (!onChain || !["Funded", "Active"].includes(String(onChain.status))) {
        app.pushToast({
          kind: "error",
          title: "Escrow is not funded on-chain",
          body: "Wait for the TEE-signed deposit record and the seller collateral before continuing.",
        });
        return;
      }
      setView("key");
    } finally {
      setIsConfirmingDeposit(false);
    }
  };

  const creditUsd = deal.creditUsd ?? deal.credit;
  const priceUsd = deal.priceUsd ?? deal.price;
  const fmtDeposit = usd(depositAmount);
  const pctUsed = creditUsd > 0 ? ((deal.usedUsd / creditUsd) * 100).toFixed(2) : "0.00";
  const tokensText = deal.tokens >= 1_000_000
    ? `${(deal.tokens / 1_000_000).toFixed(2)}M`
    : deal.tokens >= 1_000
      ? `${(deal.tokens / 1_000).toFixed(1)}k`
      : `${deal.tokens}`;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim().length < 8) return;
    const submittedKey = key.trim();
    setKey("");
    app.submitSellerKey(deal.id, submittedKey);
  };

  const claimBuyerKey = async () => {
    setIsClaimingBuyerKey(true);
    try {
      await app.claimBuyerProxyKey(deal.id);
    } finally {
      setIsClaimingBuyerKey(false);
    }
  };

  const deposit = () => {
    app.ask({
      title: `Deposit ${fmtDeposit}`,
      body: `This locks ${fmtDeposit} in USDC escrow. All deposits are strictly processed in USDC.`,
      confirm: "Deposit",
      run: () => app.deposit(deal.id),
    });
  };

  const cancel = () => {
    app.ask({
      title: "Cancel this deal",
      body: "Cancellation will return any locked deposits and storage fees to your wallet.",
      confirm: "Cancel deal",
      danger: true,
      run: () => app.cancelDeal(deal.id),
    });
  };

  const fileReport = (event: FormEvent) => {
    event.preventDefault();
    if (!report.trim()) return;
    app.sendMessage(deal.id, `Report: ${report.trim()}`);
    setReport("");
  };

  const shownKey = deal.proxyKey ? (keyHidden ? "<YOUR_COPIED_KEY>" : deal.proxyKey) : "cpk_••••••••";
  const snippets = {
    curl: `curl ${deal.baseUrl || BASE_URL}/chat/completions \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${deal.model}","messages":[{"role":"user","content":"Hello"}]}'`,
    python: `from openai import OpenAI\nclient = OpenAI(base_url="${deal.baseUrl || BASE_URL}", api_key="${shownKey}")\nclient.chat.completions.create(model="${deal.model}", messages=[{"role":"user","content":"Hello"}])`,
    node: `import OpenAI from "openai";\nconst client = new OpenAI({ baseURL: "${deal.baseUrl || BASE_URL}", apiKey: "${shownKey}" });\nawait client.chat.completions.create({ model: "${deal.model}", messages: [{ role: "user", content: "Hello" }] });`,
  };

  const primary = view === "deposit" && bothDeposited
    ? <Button className="w-full bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center gap-2" onClick={handleProceedToKey} disabled={isConfirmingDeposit}>
        {isConfirmingDeposit ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        <span>Proceed to Key Activation →</span>
      </Button>
    : view === "deposit" && !myDeposited
    ? <Button className="w-full bg-brand text-white hover:bg-brand/90" onClick={handleMakerVaultPay} disabled={isProcessingDeposit}>
        {isProcessingDeposit ? <Loader2 className="w-4 h-4 animate-spin mr-1.5 inline" /> : null}
        <span>Deposit ${formatUsdcAmount(requiredDepositUsdc)} USDC ({MAKER_VAULT_CONFIG[selectedPayChain].name})</span>
      </Button>
    : view === "key" && deal.keyStatus !== "verified" && (isSellerParty || key.trim().length >= 8)
      ? <Button className="w-full" type="submit" form="seller-key">Activate Deal via TEE</Button>
      : view === "negotiate"
        ? <Button className="w-full" href={`/deals/${deal.id}/ticket`}>Open ticket</Button>
        : null;

  return (
    <div className="space-y-6 pb-24 lg:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Deal {deal.id}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <ProviderLogo provider={deal.provider} className="h-3.5 w-3.5 shrink-0" />
            <span>{deal.provider}</span> · ${deal.creditUsd ? deal.creditUsd.toFixed(2) : deal.credit.toFixed(2)} credit for ${dealPriceUsdc.toFixed(2)} USDC · {ratioOf(deal.price, deal.credit)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            href={`/deals/${deal.id}/ticket`}
            icon={<MessagesSquare className="h-4 w-4 text-mint" />}
          >
            Ticket & Chat
          </Button>
          {isForeignSettling ? (
            <Badge tone="amber" icon={<Loader2 className="h-3 w-3 animate-spin text-amber" />}>
              Settling on Base Sepolia
            </Badge>
          ) : isForeign && (deal.status === "Completed" || deal.status === "Timeout settled" || deal.status === "Auto-released" || deal.step === "settled") && !foreignInfo?.seller_claimed ? (
            <Badge tone="warning" icon={<Clock className="h-3 w-3 text-warning animate-pulse" />}>
              Settling (Base Sepolia Payout Pending)
            </Badge>
          ) : isForeign && foreignInfo?.seller_claimed ? (
            <Badge tone="mint" icon={<Check className="h-3 w-3 text-mint" />}>
              Settled (Base Sepolia)
            </Badge>
          ) : (
            <StatusBadge status={deal.status} />
          )}
        </div>
      </div>
      <Card>
        <Stepper deal={effectiveDeal ?? deal} onPick={setView} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          {deal.matched && deal.buyerTerms?.price && Math.abs(deal.buyerTerms.price - (deal.priceUsd ?? deal.price)) > 0.0001 ? (
            <div className="rounded-xl border border-mint/40 bg-mint/5 p-4 space-y-2.5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-2.5 w-2.5 rounded-full bg-mint animate-pulse" />
                  <span className="text-sm font-semibold text-mint">
                    🎉 New Negotiated Terms Matched in TEE: ${deal.buyerTerms.price} (was ${deal.priceUsd ?? deal.price})
                  </span>
                </div>
                <span className="rounded bg-mint/10 px-2 py-0.5 text-xs font-mono text-mint">
                  Intel TDX Verified
                </span>
              </div>
              <p className="text-xs text-muted leading-relaxed">
                Both parties agreed to <strong>${deal.buyerTerms.price}</strong> in the encrypted chat.
                Deal #{deal.id} was minted earlier with the initial on-chain escrow ($0.0400).
                To fund with the negotiated ${deal.buyerTerms.price} price, click below to create the deal on NEAR.
              </p>
              <div className="pt-1">
                {!isSellerParty ? (
                  <Button
                    onClick={async () => {
                      const newId = await app.createNegotiatedDeal(deal.id);
                      if (newId) router.push(`/deals/${newId}`);
                    }}
                  >
                    Create Deal at ${deal.buyerTerms.price} on NEAR & Deposit →
                  </Button>
                ) : (
                  <p className="text-xs font-semibold text-ink">
                    ✓ Waiting for buyer ({deal.buyer}) to confirm deal creation on NEAR with the negotiated ${deal.buyerTerms.price} price.
                  </p>
                )}
              </div>
            </div>
          ) : null}
          {view === "negotiate" ? (
            <Card>
              <h2 className="text-lg font-semibold">Negotiate</h2>
              <p className="mt-2 text-sm text-muted">Terms are edited on the private ticket. Both sides submit, then the enclave compares them.</p>
              <Button className="mt-4" href={`/deals/${deal.id}/ticket`}>Open ticket</Button>
            </Card>
          ) : null}
          {view === "terms" ? (
            <Card>
              <h2 className="text-lg font-semibold">Terms hash</h2>
              {deal.termsHash ? (
                <div className="mt-4 space-y-3">
                  <HashChip value={deal.termsHash} onCopy={app.copy} />
                  <p className="text-sm">Buyer accepted. Seller accepted.</p>
                  {deal.steps.terms?.tx ? <a className="text-sm font-semibold text-brand" href={txHref(deal.steps.terms.tx)} target="_blank" rel="noreferrer">accept_deal transaction</a> : null}
                </div>
              ) : <p className="mt-3 text-sm text-muted">The hash appears after both sides submit matching terms.</p>}
            </Card>
          ) : null}
          {view === "deposit" ? (
            <Card>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <span>Deposit Escrow</span>
                    <span className="text-[10px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                      100% USDC Maker Vault
                    </span>
                  </h2>
                  <p className="mt-1 text-xs text-muted">
                    Platform operates exclusively in USDC. Cross-chain liquidity is secured by the Conpi Multi-Chain Maker Vault.
                  </p>
                </div>
                <span className="text-xs text-muted shrink-0">
                  Timeout <Countdown until={deal.depositDeadline} />
                </span>
              </div>

              {/* Counterparty Status Cards */}
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-line p-3">
                  <Overline>Buyer · ${formatUsdcAmount(requiredBuyerUsdc)} USDC</Overline>
                  <p className="mt-2 text-sm font-semibold">
                    {deal.buyerDeposited || isForeignBuyerDeposited ? (
                      <span className="text-emerald-500 font-semibold flex items-center gap-1">
                        <Check className="w-4 h-4 inline" /> Deposited
                      </span>
                    ) : buyerAlreadyDepositedUsdc > 0 ? (
                      <span className="text-amber-500">
                        Partially deposited ${buyerAlreadyDepositedUsdc.toFixed(4)} · ${formatUsdcAmount(deal.buyerDepositRemaining ?? 0)} remaining
                      </span>
                    ) : (
                      <span className="text-amber-500">Awaiting Buyer Deposit</span>
                    )}
                  </p>
                </div>
                <div className="rounded-md border border-line p-3">
                  <Overline>Seller · ${formatUsdcAmount(requiredSellerUsdc)} USDC</Overline>
                  <p className="mt-2 text-sm font-semibold">
                    {deal.sellerDeposited || isSellerDeposited ? (
                      <span className="text-emerald-500 font-semibold flex items-center gap-1">
                        <Check className="w-4 h-4 inline" /> Deposited (Collateral Locked)
                      </span>
                    ) : sellerAlreadyDepositedUsdc > 0 ? (
                      <span className="text-amber-500">
                        Partially deposited ${sellerAlreadyDepositedUsdc.toFixed(4)} · ${formatUsdcAmount(deal.sellerDepositRemaining ?? 0)} remaining
                      </span>
                    ) : (
                      <span className="text-amber-500">Awaiting Seller Collateral</span>
                    )}
                  </p>
                </div>
              </div>

              {isSolanaSellerDeal && isSellerParty && !deal.counterpartyAccepted ? (
                <div className="mt-5 rounded-xl border border-purple-500/35 bg-purple-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-purple-400" />
                    <div>
                      <p className="text-sm font-semibold text-ink">Accept this deal with the connected Solana seller wallet</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        Connecting the wallet is not the acceptance transaction. Sign once to lock this seller, the Solana vault, token, collateral amount, and payout route on-chain before sending USDC.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={handleAcceptDeal}
                    disabled={isAcceptingDeal}
                    className="w-full flex items-center justify-center gap-2"
                  >
                    {isAcceptingDeal ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
                    <span>{isAcceptingDeal ? "Recording Solana acceptance…" : "Accept Deal Terms with Solana"}</span>
                  </Button>
                </div>
              ) : null}

              {bothDeposited ? (
                <div className="mt-5 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 space-y-3">
                  <div className="flex items-center gap-2.5 text-emerald-400 font-semibold text-sm">
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                    <span>Both Deposits Confirmed & Escrow Secured</span>
                  </div>
                  <p className="text-xs text-muted leading-relaxed">
                    Escrow is 100% funded with USDC in the Conpi Maker Vault. Proceed to Key Check to activate proxy via TEE hardware enclave.
                  </p>
                  <Button
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center justify-center gap-2"
                    onClick={handleProceedToKey}
                    disabled={isConfirmingDeposit}
                  >
                    {isConfirmingDeposit ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    <span>Proceed to Key Activation →</span>
                  </Button>
                </div>
              ) : null}

              {!myDeposited
                && deal.step !== "settled"
                && !(isSolanaSellerDeal && isSellerParty && !deal.counterpartyAccepted) ? (
                <div className="mt-5 space-y-4">
                  {/* Multi-Chain USDC Payment Rail Selector */}
                  <div>
                    <label className="text-xs font-medium text-muted block mb-1.5">
                      Select Payment Chain (100% USDC):
                    </label>
                    <div className={`grid gap-2 ${isSolanaSellerDeal ? "grid-cols-1" : "grid-cols-3"}`}>
                      {!isSolanaSellerDeal ? <button
                        type="button"
                        onClick={() => setSelectedPayChain("base")}
                        className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                          selectedPayChain === "base"
                            ? "border-brand bg-brand/10 text-brand shadow-sm font-bold"
                            : "border-line bg-surface-2 text-muted hover:text-ink"
                        }`}
                      >
                        <span className="h-2 w-2 rounded-full bg-blue-500" />
                        <span>Base (USDC)</span>
                      </button> : null}

                      {(!isSolanaSellerDeal || isSellerParty) ? <button
                        type="button"
                        onClick={() => setSelectedPayChain("solana")}
                        className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                          selectedPayChain === "solana"
                            ? "border-purple-500 bg-purple-500/10 text-purple-400 shadow-sm font-bold"
                            : "border-line bg-surface-2 text-muted hover:text-ink"
                        }`}
                      >
                        <span className="h-2 w-2 rounded-full bg-purple-500" />
                        <span>Solana (USDC)</span>
                      </button> : null}

                      {(!isSolanaSellerDeal || !isSellerParty) ? <button
                        type="button"
                        onClick={() => setSelectedPayChain("near")}
                        className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                          selectedPayChain === "near"
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-400 shadow-sm font-bold"
                            : "border-line bg-surface-2 text-muted hover:text-ink"
                        }`}
                      >
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        <span>NEAR (USDC)</span>
                      </button> : null}
                    </div>
                  </div>

                  {/* Active Rail Details & Actions */}
                  <div className="p-4 rounded-xl border border-line bg-surface-2 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {selectedPayChain === "solana" && isSolanaSellerDeal
                            ? "Solana Chain Signatures Vault"
                            : `${MAKER_VAULT_CONFIG[selectedPayChain].name} Escrow Vault`}
                        </span>
                        <span className="text-[10px] uppercase font-bold text-brand bg-brand/15 px-2 py-0.5 rounded-full">
                          {MAKER_VAULT_CONFIG[selectedPayChain].symbol}
                        </span>
                      </div>
                      <span className="text-xs font-bold font-mono text-ink">
                        Required now: ${formatUsdcAmount(requiredDepositUsdc)} USDC
                      </span>
                    </div>

                    {/* Vault Address Display */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] text-muted">
                        <span>Target Conpi Maker Vault:</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!activeVaultAddress}
                            onClick={() => {
                              if (!activeVaultAddress) return;
                              app.copy(activeVaultAddress);
                              setCopiedVault(selectedPayChain);
                              setTimeout(() => setCopiedVault(null), 2000);
                            }}
                            className="text-brand hover:underline flex items-center gap-1 text-[11px]"
                          >
                            {copiedVault === selectedPayChain ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                            <span>{copiedVault === selectedPayChain ? "Copied!" : "Copy Vault"}</span>
                          </button>
                          <a
                            href={
                              selectedPayChain === "solana"
                                ? `${MAKER_VAULT_CONFIG.solana.explorer}/address/${activeVaultAddress}?cluster=devnet`
                                : selectedPayChain === "base"
                                ? `${MAKER_VAULT_CONFIG.base.explorer}/address/${activeVaultAddress}`
                                : `${MAKER_VAULT_CONFIG.near.explorer}/address/${MAKER_VAULT_CONFIG.near.vaultAddress}`
                            }
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted hover:text-ink flex items-center gap-0.5 text-[11px]"
                          >
                            <span>Explorer</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                      <div className="font-mono text-[11px] break-all bg-surface p-2 rounded border border-line text-ink">
                        {activeVaultAddress || "Waiting for the seller to lock this deal's Base vault on-chain"}
                      </div>
                    </div>

                    {/* Feedback Messages */}
                    {depositSuccess ? (
                      <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-1.5">
                        <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span>{depositSuccess}</span>
                      </div>
                    ) : null}
                    {depositError ? (
                      <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
                        {depositError}
                      </div>
                    ) : null}

                    {/* Actions */}
                    <div className="pt-1 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        onClick={handleMakerVaultPay}
                        disabled={isProcessingDeposit}
                        className="flex-1 flex items-center justify-center gap-2 bg-brand text-white hover:bg-brand/90 py-2.5 text-xs font-semibold"
                      >
                        {isProcessingDeposit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
                        <span>1-Click Pay ${formatUsdcAmount(requiredDepositUsdc)} USDC ({MAKER_VAULT_CONFIG[selectedPayChain].name})</span>
                      </Button>
                    </div>

                    {/* Or paste hash / signature */}
                    <div className="pt-2 border-t border-line/50">
                      <p className="text-[11px] text-muted mb-1.5">
                        Already transferred USDC from external wallet or exchange? Paste transaction hash or signature:
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={manualTxHash}
                          onChange={(e) => setManualTxHash(e.target.value)}
                          placeholder={selectedPayChain === "solana" ? "Solana signature (5x...)" : "Transaction hash (0x...)"}
                          className="flex-1 bg-surface border border-line rounded px-2.5 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          className="text-xs py-1.5 px-3"
                          disabled={isProcessingDeposit || !manualTxHash.trim()}
                          onClick={handleVerifyManualTx}
                        >
                          Verify & Fund
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* Seller Payout Rail Selection (for Seller) */}
                  {isSellerParty ? (
                    <div className="p-3.5 rounded-xl border border-line bg-surface space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-ink">Your Preferred USDC Payout Destination</span>
                        <span className="text-[10px] text-emerald-400 font-medium">100% USDC Release</span>
                      </div>
                      <p className="text-[11px] text-muted">
                        The seller-authorized Base Sepolia address is locked on the escrow contract before buyer funding.
                      </p>
                      <div className="grid grid-cols-1 gap-2 pt-1">
                        {(["base"] as VaultChain[]).map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => {
                              setSellerPayoutRail(c);
                              if (c === "base" && app.evmAccount) setSellerEvmAddress(app.evmAccount);
                              if (c === "solana" && app.solanaAccount) setSellerPayoutCustomAddress(app.solanaAccount);
                              if (c === "near" && app.account) setSellerPayoutCustomAddress(app.account);
                            }}
                            className={`p-2 rounded border text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
                              sellerPayoutRail === c
                                ? "border-brand bg-brand/10 text-brand font-semibold"
                                : "border-line bg-surface-2 text-muted hover:text-ink"
                            }`}
                          >
                            <span>{c === "base" ? "Base Sepolia" : c === "solana" ? "Solana Devnet" : "NEAR Testnet"}</span>
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <input
                          type="text"
                          value={sellerPayoutRail === "base" ? sellerEvmAddress : sellerPayoutCustomAddress}
                          onChange={(e) => {
                            if (sellerPayoutRail === "base") setSellerEvmAddress(e.target.value);
                            else setSellerPayoutCustomAddress(e.target.value);
                          }}
                          placeholder={
                            sellerPayoutRail === "base"
                              ? "0x... Base Sepolia recipient"
                              : sellerPayoutRail === "solana"
                              ? "Solana recipient address (base58)"
                              : "NEAR account ID (e.g. seller.testnet)"
                          }
                          className="flex-1 bg-surface-2 border border-line rounded px-2.5 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-brand"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="text-xs py-1 px-3"
                          disabled={isUpdatingSellerAddress}
                          onClick={async () => {
                            const addr = (sellerPayoutRail === "base" ? sellerEvmAddress : sellerPayoutCustomAddress).trim();
                            if (!addr) {
                              app.pushToast({ kind: "error", title: "Address required", body: "Please enter a valid payout recipient address." });
                              return;
                            }
                            try {
                              localStorage.setItem(`conpi_seller_payout_rail_${deal.id}`, sellerPayoutRail);
                              localStorage.setItem(`conpi_seller_payout_addr_${deal.id}`, addr);
                            } catch {}

                            if (sellerPayoutRail === "base") handleUpdateSellerEvmAddress();
                          }}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!deal.counterpartyAccepted
                && deal.termsHash
                && isSellerParty
                && !isSolanaSellerDeal ? (
                <div className="mt-4 pt-2 border-t border-line/60">
                  <p className="text-xs text-muted mb-2">Counterparty confirmation needed on-chain:</p>
                  <Button variant="secondary" onClick={handleAcceptDeal} disabled={isAcceptingDeal}>
                    {isAcceptingDeal ? "Recording acceptance…" : "Accept Deal Terms on NEAR"}
                  </Button>
                </div>
              ) : null}
            </Card>
          ) : null}
          {view === "key" ? (
            <Card>
              <h2 className="text-lg font-semibold">Key check</h2>
              <p className="mt-2 text-xs text-muted">
                If the enclave reports a USD terms mismatch, each party must <Link className="font-semibold text-brand" href={`/deals/${deal.id}/ticket`}>refresh their own encrypted terms</Link> before activation.
              </p>
              {deal.keyStatus !== "verified" ? (
                !isSellerParty ? (
                  <div className="mt-4 space-y-4">
                    <div className="p-4 rounded-xl border border-line bg-surface-2 space-y-2">
                      <div className="flex items-center gap-2.5 font-medium text-sm text-ink">
                        <Loader2 className="w-4 h-4 animate-spin text-brand shrink-0" />
                        <span>Awaiting Seller Key Verification</span>
                      </div>
                      <p className="text-xs text-muted leading-relaxed">
                        Seller (<code className="font-mono text-ink font-semibold">{deal.seller}</code>) is submitting their provider API key directly to the TEE hardware enclave.
                        Once verified, your proxy credentials and base URL will become active automatically.
                      </p>
                    </div>
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer hover:text-ink font-medium">Testing in dev environment? Submit key directly</summary>
                      <form id="seller-key" className="mt-3 space-y-3" onSubmit={submitKey}>
                        <label className="block text-[13px] font-medium text-ink">Provider key
                          <input className={`${fieldClass} mt-1.5 font-mono`} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="OpenAI / OpenRouter key" />
                        </label>
                        <p className="text-xs text-muted">This value is sent directly to the hardware enclave to verify quota and activate the proxy key.</p>
                        <Button type="submit">Activate Deal via TEE</Button>
                      </form>
                    </details>
                  </div>
                ) : (
                  <form id="seller-key" className="mt-4 space-y-3" onSubmit={submitKey}>
                    <div className="flex items-center justify-between">
                      <label className="block text-[13px] font-medium text-ink">Provider key</label>
                      <span className="text-[11px] text-emerald-400 font-mono">
                        Connected as Seller ({middle(app.solanaAccount || deal.seller, 6, 4)})
                      </span>
                    </div>
                    <input className={`${fieldClass} mt-1.5 font-mono`} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Sent only to the enclave (e.g. OpenAI / OpenRouter key)" />
                    <p className="text-xs text-muted">This value is sent directly to the hardware enclave to verify quota and activate the proxy key. Not stored in browser or written on-chain.</p>
                    <Button type="submit">Activate Deal via TEE</Button>
                  </form>
                )
              ) : <p className="mt-2 text-sm text-muted">The provider key was verified by the TEE and the deal is activated on NEAR.</p>}
              {deal.keyStatus === "verified" ? (
                <div className="mt-4">
                  <Button onClick={() => setView("live")}>Go to Live Proxy & Usage</Button>
                </div>
              ) : null}
              <ul className="mt-4 space-y-2 text-sm">
                {(deal.keyChecks.length ? deal.keyChecks : [{ label: "Waiting for TEE verification", ok: false }]).map((check) => (
                  <li key={check.label} className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${check.ok ? "bg-mint" : "bg-line"}`} />
                    {check.label}
                    {!check.ok && deal.keyStatus === "checking" ? <span className="text-xs text-muted">Checking</span> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {view === "live" ? (
            <div className="space-y-4">
              <Card>
                <h2 className="text-lg font-semibold">Proxy</h2>
                <div className="mt-4 space-y-3">
                  <div>
                    <Overline>Base URL</Overline>
                    <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[13px]">
                      <span className="truncate">{deal.baseUrl}</span>
                      <button type="button" className="text-xs font-semibold text-brand" onClick={() => app.copy(deal.baseUrl)}>Copy</button>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between">
                      <Overline>API key</Overline>
                      {!isSellerParty && isBuyerParty && deal.proxyKey && keyHidden ? (
                        <button
                          type="button"
                          className="text-xs font-semibold text-brand hover:underline"
                          onClick={handleRevealKey}
                        >
                          Reveal key
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-1">
                      {isSellerParty ? (
                        <div className="rounded-md border border-mint/30 bg-mint/10 px-4 py-3">
                          <div className="flex items-center gap-2 font-semibold text-mint">
                            <ShieldCheck className="h-4 w-4" />
                            Provider key verified
                          </div>
                          <p className="mt-1 text-sm text-muted">
                            The TEE activated the deal and delivered no proxy credential to the seller. Only the authenticated buyer wallet can claim it.
                          </p>
                        </div>
                      ) : deal.proxyKey && isBuyerParty ? (
                        keyHidden ? (
                          <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-mint" />
                              <span className="font-mono text-muted truncate">cpk_live_••••••••••••••••••••••••••••••••</span>
                            </div>
                            <span className="shrink-0 rounded bg-surface px-2 py-0.5 text-[11px] font-medium text-mint">
                              Copied & Hidden from UI
                            </span>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <SecretKey
                                  value={deal.proxyKey}
                                  revoked={deal.proxyRevoked}
                                  onCopy={handleCopyAndHide}
                                />
                              </div>
                              <Button
                                type="button"
                                className="shrink-0 text-xs py-2 px-3 whitespace-nowrap"
                                onClick={() => handleCopyAndHide(deal.proxyKey)}
                              >
                                Copy & Hide Key
                              </Button>
                            </div>
                            <p className="text-[11px] text-muted">
                              Clicking copy will copy the key to your clipboard and remove it from the screen for safety.
                            </p>
                          </div>
                        )
                      ) : isBuyerParty ? (
                        <div className="space-y-2 rounded-md border border-line bg-surface-2 px-4 py-3">
                          <p className="text-sm text-muted">
                            Sign once with the buyer wallet to receive this deal&apos;s TEE-issued proxy key. No transaction or gas is required.
                          </p>
                          <Button type="button" onClick={claimBuyerKey} disabled={isClaimingBuyerKey}>
                            {isClaimingBuyerKey ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
                            Claim buyer proxy key
                          </Button>
                        </div>
                      ) : (
                        <div className="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
                          Connect the buyer wallet <span className="font-mono text-ink">{deal.buyer}</span> to claim the private proxy key.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {!isSellerParty && isBuyerParty && deal.proxyKey ? (
                  <>
                    <div className="mt-4 flex gap-2 text-sm">
                      {(["curl", "python", "node"] as const).map((tab) => (
                        <button key={tab} type="button" className={`rounded px-2 py-1 font-semibold ${snippet === tab ? "bg-surface-2 text-ink" : "text-muted"}`} onClick={() => setSnippet(tab)}>{tab}</button>
                      ))}
                    </div>
                    <pre className="mt-2 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-xs leading-5">{snippets[snippet]}</pre>
                  </>
                ) : null}
              </Card>
              <Card>
                <div className="flex items-end justify-between gap-3">
                  <h2 className="text-lg font-semibold">Usage</h2>
                  <span className="text-xs text-muted">Updated {clockTime(deal.lastUpdate)}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm tabular">
                    <span className="font-semibold text-ink">${deal.usedUsd.toFixed(4)}</span>
                    {" "}of{" "}
                    <span className="font-semibold text-ink">${creditUsd.toFixed(4)} USDC</span>
                    {" "}· {tokensText} tokens
                  </p>
                  <span className="text-xs font-semibold tabular text-brand">
                    {pctUsed}% consumed
                  </span>
                </div>
                <div className="mt-3">
                  <Meter used={deal.usedUsd} credit={creditUsd} stage={deal.stage} pulse={deal.pulseStage} />
                </div>
                <StageTicks price={deal.price} priceUsd={priceUsd} token={deal.token} stage={deal.stage} pulse={deal.pulseStage} />
                <p className="mt-3 text-xs text-muted">
                  Next release at {deal.stage >= 100 ? "settlement" : `${deal.stage < 25 ? 25 : deal.stage < 50 ? 50 : deal.stage < 75 ? 75 : 100}% ($${(priceUsd / 4).toFixed(4)} USDC)`}.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => app.syncMeterState(deal.id)}>Sync meter</Button>
                  {isSolanaSellerDeal ? (
                    <span className="self-center text-xs text-muted">Solana stage payouts are signed, broadcast, and confirmed by the TEE automatically.</span>
                  ) : <Button onClick={() => app.releaseStagePayout(deal.id)}>Release stage payout</Button>}
                  {deal.status === "Active" && !isSolanaSellerDeal ? (
                    <Button variant="ghost" className="text-danger" onClick={() => app.triggerDefaultSettlement(deal.id, "InvalidKey")}>
                      Settle Default & Refund
                    </Button>
                  ) : null}
                </div>
              </Card>
              <Card>
                <h2 className="text-lg font-semibold">Locked prices</h2>
                <table className="mt-3 w-full text-left text-[13px]">
                  <thead className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                    <tr><th className="pb-2">Model</th><th className="pb-2 text-right">Input</th><th className="pb-2 text-right">Output</th></tr>
                  </thead>
                  <tbody>
                    {deal.prices.map((row) => (
                      <tr key={row.model} className="border-t border-line"><td className="py-2">{row.model}</td><td className="py-2 text-right tabular">{row.input}</td><td className="py-2 text-right tabular">{row.output}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ) : null}
          {view === "settled" ? (
            <div className="space-y-4">
              <OutcomeBanner deal={deal} foreignInfo={foreignInfo} />
              <Card>
                <h2 className="text-lg font-semibold">Final split</h2>
                {deal.split ? <EscrowTable deal={deal} foreignInfo={foreignInfo} /> : <p className="mt-2 text-sm text-muted">Settlement figures appear when the deal closes.</p>}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button href={`/history/${deal.id}`}>Receipt</Button>
                  {app.claims.some((claim) => claim.dealId === deal.id && !claim.claimed) ? <Button variant="secondary" href="/claims" icon={undefined}>Claim</Button> : null}
                </div>
              </Card>
            </div>
          ) : null}
          {/* Encrypted Enclave Chat between Buyer & Seller */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <MessagesSquare className="h-5 w-5 text-mint" />
                <h2 className="text-base font-semibold">Encrypted Enclave Chat</h2>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-mono text-muted">
                  {deal.messages.length} {deal.messages.length === 1 ? "message" : "messages"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted">
                  <Lock className="h-3 w-3 text-mint" /> E2E Encrypted to TEE
                </span>
                <Link
                  href={`/deals/${deal.id}/ticket`}
                  className="rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs font-semibold text-brand hover:bg-surface hover:text-ink transition-colors"
                >
                  Full Ticket & Terms →
                </Link>
              </div>
            </div>

            {/* Messages Scroll Box */}
            <div className="my-3 max-h-60 min-h-[120px] space-y-2.5 overflow-y-auto rounded-lg border border-line/50 bg-surface-2/40 p-3">
              {deal.messages.length === 0 ? (
                <div className="flex h-24 flex-col items-center justify-center text-center text-xs text-muted">
                  <p>No messages in this deal yet.</p>
                  <p className="mt-1 text-[11px]">Coordinate terms, deposits, or key checks with the counterparty below.</p>
                </div>
              ) : (
                deal.messages.map((message) => {
                  const mine = message.sender === app.account;
                  let proposal: any = null;
                  if (message.text.startsWith("PROPOSAL:")) {
                    try {
                      proposal = JSON.parse(message.text.slice(9));
                    } catch {}
                  }

                  return (
                    <div key={message.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-muted font-mono">
                        <span className="font-semibold text-foreground">{mine ? "You" : (message.sender.length > 20 ? `${message.sender.slice(0, 10)}…${message.sender.slice(-6)}` : message.sender)}</span>
                        <span>·</span>
                        <span>{message.time}</span>
                      </div>
                      {proposal ? (
                        <div className={`max-w-[90%] rounded-xl border p-3 space-y-2 text-foreground text-xs shadow-sm ${
                          mine ? "border-brand/50 bg-surface-2/70" : "border-mint/50 bg-surface-2"
                        }`}>
                          <div className="flex items-center justify-between border-b border-line/60 pb-1.5">
                            <span className="flex items-center gap-1 font-semibold text-brand text-[11px]">
                              <Fingerprint className="h-3.5 w-3.5 text-mint" /> Term Negotiation Proposal
                            </span>
                            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted">
                              {proposal.token || "USDC"}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                            <div className="rounded bg-surface p-1.5 border border-line/40">
                              <span className="text-[9px] text-muted block">Proposed Price</span>
                              <span className="font-bold text-ink">${proposal.price}</span>
                              <span className="text-[10px] text-brand ml-1 font-medium">({ratioOf(proposal.price, proposal.credit)})</span>
                            </div>
                            <div className="rounded bg-surface p-1.5 border border-line/40">
                              <span className="text-[9px] text-muted block">Credit Size</span>
                              <span className="font-bold text-ink">${proposal.credit}</span>
                            </div>
                          </div>
                          {deal.matched ? (
                            <div className="rounded bg-mint/10 border border-mint/30 py-1 px-2 text-center text-[11px] font-semibold text-mint flex items-center justify-center gap-1">
                              <span>✓ Terms Accepted & Matched (${proposal.price})</span>
                            </div>
                          ) : !mine ? (
                            <Button
                              size="sm"
                              className="w-full text-xs font-semibold"
                              onClick={() => void app.acceptProposal(deal.id, proposal)}
                            >
                              ✓ Accept Proposal (${proposal.price})
                            </Button>
                          ) : (
                            <p className="text-[10px] text-muted italic flex items-center gap-1 pt-0.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-brand animate-ping" />
                              Awaiting counterparty acceptance
                            </p>
                          )}
                        </div>
                      ) : (
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-1.5 text-xs ${
                            mine
                              ? "bg-brand text-brand-ink"
                              : "border border-line bg-surface text-foreground"
                          }`}
                        >
                          {message.text}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Send Message Input */}
            <form onSubmit={handleSendChat} className="flex gap-2">
              <input
                className={`${fieldClass} text-xs`}
                value={chatMsg}
                placeholder={`Send encrypted message to ${!isSellerParty ? "seller" : "buyer"}...`}
                onChange={(event) => setChatMsg(event.target.value)}
              />
              <Button type="submit" size="sm" icon={<Send className="h-3.5 w-3.5" />}>
                Send
              </Button>
            </form>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold">Activity</h2>
            <ul className="mt-3 divide-y divide-line">
              {deal.activity.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                  <div>
                    <div className="font-medium">{event.title}</div>
                    <div className="text-muted">{event.detail}</div>
                  </div>
                  <div className="text-right text-xs text-muted">
                    <div>{event.time}</div>
                    {event.tx ? <a className="font-mono text-brand" href={txHref(event.tx)} target="_blank" rel="noreferrer">{event.tx.slice(0, 6)}…{event.tx.slice(-4)}</a> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <aside className="space-y-4 lg:col-span-4">
          <MakerVaultCard />
          <Card>
            <Overline>Escrow</Overline>
            <div className="mt-3"><EscrowTable deal={deal} foreignInfo={foreignInfo} /></div>
          </Card>

          {Boolean(foreignInfo && Number(foreignInfo.foreign_amount) > 0) ? (
            <Card>
              <div className="flex items-center justify-between">
                <Overline>Base Sepolia Escrow</Overline>
                <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">EVM Vault</span>
              </div>
              <div className="mt-3 space-y-3 text-xs">
                <div>
                  <span className="text-muted block text-[11px] mb-1">Vault Address</span>
                  <div className="font-mono text-[11px] break-all bg-surface-2 p-2 rounded text-ink flex items-center justify-between">
                    <span>{foreignInfo?.vault_address || foreignVault?.address}</span>
                    <a
                      href={`${BASE_SEPOLIA_EXPLORER}/address/${foreignInfo?.vault_address || foreignVault?.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 text-muted hover:text-ink shrink-0"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] pt-1">
                  <span className="text-muted">Gas Sponsorship:</span>
                  <span className="font-mono text-[11px] font-semibold text-emerald-400">
                    ✓ 100% Sponsored by Conpi Vault (Zero ETH Required)
                  </span>
                </div>

                {/* Seller Payout Address Section */}
                <div className="pt-2 border-t border-line/60">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-muted text-[11px]">Seller Base Sepolia Address</span>
                    {effectiveSellerEvmAddress ? (
                      <span className="text-[10px] text-emerald-500 font-medium">Configured</span>
                    ) : (
                      <span className="text-[10px] text-amber-500 font-medium">Pending</span>
                    )}
                  </div>
                  {isSellerParty ? (
                    <div className="space-y-1.5">
                      <input
                        type="text"
                        value={sellerEvmAddress}
                        onChange={(e) => setSellerEvmAddress(e.target.value)}
                        placeholder="0x... Base Sepolia recipient"
                        className="w-full text-xs font-mono p-1.5 rounded bg-surface-2 border border-line text-ink focus:outline-none focus:border-brand"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-full text-xs py-1"
                        disabled={isUpdatingSellerAddress || !sellerEvmAddress.trim() || (foreignInfo?.seller_address && sellerEvmAddress.trim() === foreignInfo.seller_address)}
                        onClick={handleUpdateSellerEvmAddress}
                      >
                        {isUpdatingSellerAddress ? "Updating on NEAR..." : "Save Payout Address"}
                      </Button>
                      {sellerAddressStatus.type === "success" && (
                        <div className="text-[11px] text-emerald-500 font-medium">✓ {sellerAddressStatus.msg}</div>
                      )}
                      {sellerAddressStatus.type === "error" && (
                        <div className="text-[11px] text-rose-500 font-medium">{sellerAddressStatus.msg}</div>
                      )}
                    </div>
                  ) : (
                    <div className="font-mono text-[11px] text-ink break-all bg-surface-2 p-1.5 rounded">
                      {effectiveSellerEvmAddress || "Awaiting seller configuration"}
                    </div>
                  )}
                </div>

                {/* Buyer Refund Address Section */}
                <div className="pt-2 border-t border-line/60">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-muted text-[11px]">Buyer Base Sepolia Address</span>
                    {foreignInfo?.buyer_address && foreignInfo.buyer_address !== "0x0000000000000000000000000000000000000000" ? (
                      <span className="text-[10px] text-emerald-500 font-medium">Configured</span>
                    ) : (
                      <span className="text-[10px] text-amber-500 font-medium">Pending</span>
                    )}
                  </div>
                  {!isSellerParty ? (
                    <div className="space-y-1.5">
                      <input
                        type="text"
                        value={buyerEvmAddressInput}
                        onChange={(e) => setBuyerEvmAddressInput(e.target.value)}
                        placeholder="0x... Base Sepolia refund recipient"
                        className="w-full text-xs font-mono p-1.5 rounded bg-surface-2 border border-line text-ink focus:outline-none focus:border-brand"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-full text-xs py-1"
                        disabled={isUpdatingBuyerAddress || !buyerEvmAddressInput.trim() || buyerEvmAddressInput.trim() === foreignInfo?.buyer_address}
                        onClick={handleUpdateBuyerEvmAddress}
                      >
                        {isUpdatingBuyerAddress ? "Updating on NEAR..." : "Save Refund Address"}
                      </Button>
                    </div>
                  ) : (
                    <div className="font-mono text-[11px] text-ink break-all bg-surface-2 p-1.5 rounded">
                      {foreignInfo?.buyer_address || "Awaiting buyer deposit"}
                    </div>
                  )}
                </div>

                {/* Auto-Release Notice & Finalization Section */}
                {deal.status === "Active" ? (
                  <div className="pt-2 border-t border-line/60 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-muted text-[11px]">Protocol Auto-Release</span>
                      <span className="text-[10px] text-brand font-medium">24h Notice</span>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="flex-1 text-xs py-1.5"
                        disabled={isRequestingAutoRelease}
                        onClick={handleRequestAutoRelease}
                      >
                        {isRequestingAutoRelease ? "Requesting..." : "Notice Auto-Release"}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        className="flex-1 text-xs py-1.5"
                        disabled={isFinalizingAutoRelease}
                        onClick={handleFinalizeAutoRelease}
                      >
                        {isFinalizingAutoRelease ? "Finalizing..." : "Finalize Auto-Release"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Claim Foreign Payout Button for Seller */}
                {isSellerParty && (deal.step === "settled" || deal.status === "Timeout settled" || deal.status === "Buyer breach") ? (
                  <div className="pt-2 border-t border-line/60">
                    {foreignInfo?.seller_claimed ? (
                      <div className="rounded bg-emerald-500/10 border border-emerald-500/20 p-2 text-center text-[11px] text-emerald-500 font-medium">
                        ✓ USDC Payout Claimed on Base Sepolia
                      </div>
                    ) : (
                      <Button
                        type="button"
                        className="w-full text-xs py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
                        disabled={isClaimingForeignPayout}
                        onClick={handleClaimSellerForeignPayout}
                      >
                        {isClaimingForeignPayout ? (
                          <span className="flex items-center justify-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Requesting MPC Signature...
                          </span>
                        ) : (
                          "Claim Earned USDC Payout (Base Sepolia)"
                        )}
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card>
            <Overline>Terms hash</Overline>
            <div className="mt-3">{deal.termsHash ? <HashChip value={deal.termsHash} onCopy={app.copy} /> : <p className="text-sm text-muted">Not matched yet.</p>}</div>
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <Link href="/trust" className="font-semibold text-brand">Contract and enclave</Link>
              <Link href="/governance" className="font-semibold text-brand">DAO</Link>
            </div>
            <form onSubmit={fileReport} className="mt-4 space-y-2">
              <textarea className={`${fieldClass} h-20 py-2`} value={report} placeholder="Report a problem" onChange={(event) => setReport(event.target.value)} />
              <Button type="submit" variant="secondary" className="w-full">Report problem</Button>
            </form>
            {deal.step !== "live" && deal.step !== "settled" ? <Button variant="ghost" className="mt-2 w-full" onClick={cancel}>Cancel</Button> : null}
          </Card>
        </aside>
      </div>
      {primary ? <div className="no-print fixed inset-x-0 bottom-16 z-30 border-t border-line bg-surface/95 p-3 backdrop-blur lg:hidden">{primary}</div> : null}
    </div>
  );
}
