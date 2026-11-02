"use client";

import React, { useState } from "react";
import {
  ShieldCheck,
  Cpu,
  Layers,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Zap,
  DollarSign,
  Clock,
  ExternalLink,
  ChevronRight,
  Flame,
  Key,
  Database,
  RefreshCw,
  Sliders,
  Send,
  User,
  Activity,
} from "lucide-react";

interface Listing {
  id: string;
  type: "SELL" | "BUY";
  provider: "OpenAI" | "OpenRouter" | "Anthropic";
  seller: string;
  creditAmount: number;
  askingPrice: number;
  models: string[];
  rateLimit: string;
  sellerCollateralPct: number;
}

const SAMPLE_LISTINGS: Listing[] = [
  {
    id: "lst-01",
    type: "SELL",
    provider: "OpenAI",
    seller: "seller.testnet",
    creditAmount: 80,
    askingPrice: 60,
    models: ["gpt-4o-mini", "gpt-4o"],
    rateLimit: "60 req/min",
    sellerCollateralPct: 20,
  },
  {
    id: "lst-02",
    type: "SELL",
    provider: "OpenRouter",
    seller: "dev_credits.testnet",
    creditAmount: 150,
    askingPrice: 110,
    models: ["claude-3-5-sonnet", "gpt-4o", "meta-llama/llama-3-70b"],
    rateLimit: "120 req/min",
    sellerCollateralPct: 25,
  },
  {
    id: "lst-03",
    type: "BUY",
    provider: "OpenAI",
    seller: "ai_startup.testnet",
    creditAmount: 500,
    askingPrice: 380,
    models: ["gpt-4o", "text-embedding-3-large"],
    rateLimit: "200 req/min",
    sellerCollateralPct: 20,
  },
  {
    id: "lst-04",
    type: "SELL",
    provider: "Anthropic",
    seller: "claudefan.testnet",
    creditAmount: 50,
    askingPrice: 38,
    models: ["claude-3-5-haiku", "claude-3-5-sonnet"],
    rateLimit: "50 req/min",
    sellerCollateralPct: 20,
  },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<"marketplace" | "negotiation" | "meter" | "contract">("marketplace");
  const [filterType, setFilterType] = useState<"ALL" | "SELL" | "BUY">("ALL");
  const [walletConnected, setWalletConnected] = useState(true);
  const [userAccount, setUserAccount] = useState("buyer.testnet");

  // Negotiation Ticket State
  const [selectedListing, setSelectedListing] = useState<Listing>(SAMPLE_LISTINGS[0]);
  const [creditAmount, setCreditAmount] = useState<number>(80);
  const [agreedPrice, setAgreedPrice] = useState<number>(60);
  const [buyerCollateral, setBuyerCollateral] = useState<number>(6); // 10%
  const [sellerCollateral, setSellerCollateral] = useState<number>(12); // 20%
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [termsHash, setTermsHash] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Array<{ sender: string; text: string; time: string }>>([
    { sender: "seller.testnet", text: "Hey! I have $80 OpenAI credit ready to transfer safely via TEE.", time: "10:14 AM" },
    { sender: "buyer.testnet", text: "Sounds great. Can we lock the price at $60 with gpt-4o included?", time: "10:15 AM" },
    { sender: "seller.testnet", text: "Agreed. 60 req/min limit is in the term sheet. Click Finalize to match in TEE.", time: "10:16 AM" },
  ]);
  const [newMsg, setNewMsg] = useState("");

  // Live Deal & Meter State
  const [dealStatus, setDealStatus] = useState<"CREATED" | "FUNDED" | "ACTIVE" | "COMPLETED" | "DEFAULTED">("ACTIVE");
  const [meteredTokens, setMeteredTokens] = useState<number>(45000000);
  const [meteredValue, setMeteredValue] = useState<number>(32.0); // $32 of $80
  const [proxyKey, setProxyKey] = useState<string>("cpk_live_9f83a0e1c841bb45");
  const [proxyEndpoint, setProxyEndpoint] = useState<string>("https://tee-phala.conpi.network/v1");
  const [stageReached, setStageReached] = useState<number>(25);
  const [eventsLog, setEventsLog] = useState<Array<{ title: string; desc: string; tx: string; time: string }>>([
    { title: "Deal Created #1", desc: "Buyer: buyer.testnet, Seller: seller.testnet", tx: "0x78ab...34e1", time: "10:17:02" },
    { title: "Terms Registered in TEE", desc: "Terms Hash: 0x9f3c...e21a signed by Phala TDX", tx: "0x44cd...11ea", time: "10:17:15" },
    { title: "Escrow Funded", desc: "Deposited: Buyer $66, Seller $12", tx: "0x89ef...55a2", time: "10:17:45" },
    { title: "TEE Activated", desc: "Key verified, usage clock started (30d)", tx: "0x12fa...90bc", time: "10:18:10" },
    { title: "Stage 25% Released", desc: "$15.00 transferred to seller on NEAR Testnet", tx: "0x66dd...77cc", time: "10:20:00" },
  ]);

  const handleQuickBuy = (listing: Listing) => {
    setSelectedListing(listing);
    setCreditAmount(listing.creditAmount);
    setAgreedPrice(listing.askingPrice);
    setBuyerCollateral(Math.round(listing.askingPrice * 0.1));
    setSellerCollateral(Math.round(listing.askingPrice * (listing.sellerCollateralPct / 100)));
    setActiveTab("negotiation");
  };

  const handleFinalizeTerms = () => {
    setTermsAgreed(true);
    // Canonical SHA-256 simulation matching TEE canonicalizer
    const mockHash = "0x9f3c4d71e8a9310f8821bb490184e21a";
    setTermsHash(mockHash);
  };

  const handleSimulateCall = () => {
    if (dealStatus !== "ACTIVE") return;
    const addedSpend = 2.5;
    const newMetered = Math.min(80, meteredValue + addedSpend);
    setMeteredValue(newMetered);
    setMeteredTokens(prev => prev + 1800000);

    const pct = (newMetered / 80) * 100;
    if (pct >= 100 && stageReached < 100) {
      setStageReached(100);
      setDealStatus("COMPLETED");
      setEventsLog(prev => [
        { title: "Stage 100% Final Release", desc: "$15.00 + $12 collateral released to seller. $6 collateral refunded to buyer.", tx: "0x99aa...22bb", time: "Just now" },
        ...prev
      ]);
    } else if (pct >= 75 && stageReached < 75) {
      setStageReached(75);
      setEventsLog(prev => [
        { title: "Stage 75% Released", desc: "$15.00 released to seller on NEAR Testnet", tx: "0x88bb...33cc", time: "Just now" },
        ...prev
      ]);
    } else if (pct >= 50 && stageReached < 50) {
      setStageReached(50);
      setEventsLog(prev => [
        { title: "Stage 50% Released", desc: "$15.00 released to seller on NEAR Testnet", tx: "0x77aa...44dd", time: "Just now" },
        ...prev
      ]);
    }
  };

  const handleSimulateRevokeDefault = () => {
    if (dealStatus !== "ACTIVE") return;
    setDealStatus("DEFAULTED");
    setEventsLog(prev => [
      {
        title: "⚡ SELLER DEFAULT: Key Revocation",
        desc: "TEE detected HTTP 401 invalid_api_key. Freezing at $32.00 (40%). Automatic pro-rata settlement: Seller gets $9.00 earned + $2.40 collateral. Buyer refunded $36.00 + $6.00 collateral + $9.60 slashed seller collateral (80% slash).",
        tx: "0xdefault...8811",
        time: "Just now"
      },
      ...prev
    ]);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMsg.trim()) return;
    setChatMessages(prev => [...prev, { sender: userAccount, text: newMsg.trim(), time: "Now" }]);
    setNewMsg("");
  };

  const filteredListings = SAMPLE_LISTINGS.filter(l => filterType === "ALL" || l.type === filterType);

  return (
    <div className="min-h-screen flex flex-col font-sans">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center font-bold text-xl text-slate-950 shadow-lg shadow-emerald-500/20">
            C
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold tracking-tight text-white">Conpi</span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                NEAR Testnet
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                Phala Intel TDX
              </span>
            </div>
            <p className="text-xs text-slate-400">Trust-Minimised LLM API Credit Escrow</p>
          </div>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center gap-1 bg-slate-800/80 p-1 rounded-xl border border-slate-700/50">
          <button
            onClick={() => setActiveTab("marketplace")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === "marketplace" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"
            }`}
          >
            Marketplace
          </button>
          <button
            onClick={() => setActiveTab("negotiation")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition relative ${
              activeTab === "negotiation" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"
            }`}
          >
            Negotiation Ticket
            {termsAgreed && <span className="w-2 h-2 rounded-full bg-emerald-400 absolute top-2 right-2"></span>}
          </button>
          <button
            onClick={() => setActiveTab("meter")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition flex items-center gap-1.5 ${
              activeTab === "meter" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"
            }`}
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400" />
            Live Meter & Escrow
          </button>
          <button
            onClick={() => setActiveTab("contract")}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              activeTab === "contract" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"
            }`}
          >
            Smart Contract
          </button>
        </div>

        {/* Wallet Pill */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700 text-sm">
            <User className="w-4 h-4 text-emerald-400" />
            <span className="font-mono text-slate-200">{userAccount}</span>
            <span className="text-xs text-slate-400 border-l border-slate-700 pl-2">240 NEAR</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* ========================================================================= */}
        {/* TAB 1: MARKETPLACE                                                       */}
        {/* ========================================================================= */}
        {activeTab === "marketplace" && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-gradient-to-r from-slate-900 via-slate-900 to-slate-800/80 p-6 rounded-2xl border border-slate-800">
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">API Credit Marketplace</h1>
                <p className="text-sm text-slate-400 mt-1">
                  Liquidate stranded LLM balances or buy discounted tokens. Real keys stay sealed in Phala TDX enclaves.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFilterType("ALL")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    filterType === "ALL" ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  All Offers
                </button>
                <button
                  onClick={() => setFilterType("SELL")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    filterType === "SELL" ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  Sell Listings
                </button>
                <button
                  onClick={() => setFilterType("BUY")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                    filterType === "BUY" ? "bg-emerald-500 text-slate-950" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  Buy Requests
                </button>
              </div>
            </div>

            {/* Listings Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4">
              {filteredListings.map((listing) => {
                const discount = Math.round(((listing.creditAmount - listing.askingPrice) / listing.creditAmount) * 100);
                return (
                  <div
                    key={listing.id}
                    className="p-5 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition flex flex-col justify-between group"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 text-xs font-bold rounded ${
                              listing.type === "SELL" ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                            }`}
                          >
                            {listing.type}
                          </span>
                          <span className="font-semibold text-white">{listing.provider}</span>
                        </div>
                        <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {discount}% Discount
                        </span>
                      </div>

                      <div className="flex items-baseline gap-2 mb-4">
                        <span className="text-3xl font-extrabold text-white">${listing.askingPrice}</span>
                        <span className="text-sm text-slate-400 line-through">${listing.creditAmount} Credit Value</span>
                      </div>

                      <div className="space-y-1.5 text-xs text-slate-400 mb-4 bg-slate-950/40 p-3 rounded-lg border border-slate-800">
                        <div className="flex justify-between">
                          <span>Allowed Models:</span>
                          <span className="text-slate-200 font-mono truncate max-w-[200px]">
                            {listing.models.join(", ")}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>Rate Limit:</span>
                          <span className="text-slate-200">{listing.rateLimit}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Seller Collateral:</span>
                          <span className="text-emerald-400 font-semibold">{listing.sellerCollateralPct}% required</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Seller Account:</span>
                          <span className="text-slate-300 font-mono">{listing.seller}</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleQuickBuy(listing)}
                      className="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
                    >
                      <Zap className="w-4 h-4 fill-slate-950" />
                      Quick Buy / Open Ticket
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 2: NEGOTIATION TICKET                                                 */}
        {/* ========================================================================= */}
        {activeTab === "negotiation" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left: Chat Window (7 Cols) */}
            <div className="lg:col-span-7 bg-slate-900/60 rounded-2xl border border-slate-800 flex flex-col h-[650px]">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/80 rounded-t-2xl">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></div>
                  <span className="font-semibold text-white">Private Ticket #{selectedListing.id}</span>
                  <span className="text-xs text-slate-400">({selectedListing.provider} Credits)</span>
                </div>
                <div className="text-xs text-slate-400 flex items-center gap-1">
                  <Lock className="w-3.5 h-3.5 text-emerald-400" />
                  E2E Encrypted to TEE
                </div>
              </div>

              {/* Chat Stream */}
              <div className="flex-1 p-4 overflow-y-auto space-y-3">
                {chatMessages.map((msg, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-col ${msg.sender === userAccount ? "items-end" : "items-start"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 text-xs text-slate-400">
                      <span className="font-mono">{msg.sender}</span>
                      <span>•</span>
                      <span>{msg.time}</span>
                    </div>
                    <div
                      className={`p-3 rounded-2xl max-w-md text-sm ${
                        msg.sender === userAccount
                          ? "bg-emerald-500 text-slate-950 font-medium rounded-br-none"
                          : "bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700/60"
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))}
              </div>

              {/* Chat Input */}
              <form onSubmit={handleSendMessage} className="p-3 border-t border-slate-800 flex gap-2">
                <input
                  type="text"
                  placeholder="Propose terms or send a message..."
                  value={newMsg}
                  onChange={(e) => setNewMsg(e.target.value)}
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-emerald-500 text-white"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold transition"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>

            {/* Right: Structured Term Sheet (5 Cols) */}
            <div className="lg:col-span-5 space-y-4">
              <div className="bg-slate-900/60 p-5 rounded-2xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-emerald-400" />
                    Structured Term Sheet
                  </h3>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">v1.1 Canonical</span>
                </div>

                <div className="space-y-3 text-sm">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Agreed Credit Amount ($)</label>
                    <input
                      type="number"
                      value={creditAmount}
                      onChange={(e) => setCreditAmount(Number(e.target.value))}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Agreed Purchase Price ($)</label>
                    <input
                      type="number"
                      value={agreedPrice}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setAgreedPrice(val);
                        setBuyerCollateral(Math.round(val * 0.1));
                        setSellerCollateral(Math.round(val * 0.2));
                      }}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Buyer Collateral ($)</label>
                      <input
                        type="number"
                        value={buyerCollateral}
                        onChange={(e) => setBuyerCollateral(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono text-xs"
                      />
                      <span className="text-[10px] text-slate-500">10% standard</span>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Seller Collateral ($)</label>
                      <input
                        type="number"
                        value={sellerCollateral}
                        onChange={(e) => setSellerCollateral(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono text-xs"
                      />
                      <span className="text-[10px] text-slate-500">20% standard</span>
                    </div>
                  </div>

                  {/* Locked Price Table */}
                  <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800 text-xs space-y-1">
                    <span className="text-slate-400 font-semibold block mb-1">Locked Price Table:</span>
                    <div className="flex justify-between text-slate-300">
                      <span>gpt-4o-mini:</span>
                      <span className="font-mono">$0.15 / 1M in • $0.60 / 1M out</span>
                    </div>
                    <div className="flex justify-between text-slate-300">
                      <span>gpt-4o:</span>
                      <span className="font-mono">$2.50 / 1M in • $10.00 / 1M out</span>
                    </div>
                  </div>

                  {/* Terms Hash Status */}
                  {termsHash ? (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs space-y-1">
                      <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
                        <CheckCircle2 className="w-4 h-4" />
                        Terms Matched in Phala TEE!
                      </div>
                      <div className="font-mono text-slate-300 break-all">
                        terms_hash: {termsHash}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400 italic">
                      Both parties must click finalize. Terms are encrypted and matched in Phala TDX memory.
                    </div>
                  )}

                  <button
                    onClick={handleFinalizeTerms}
                    disabled={termsAgreed}
                    className={`w-full py-2.5 rounded-xl font-bold text-sm transition flex items-center justify-center gap-2 ${
                      termsAgreed
                        ? "bg-slate-800 text-slate-400 cursor-not-allowed"
                        : "bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/10"
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4" />
                    {termsAgreed ? "Terms Signed by TEE" : "Finalize & Encrypt to TEE"}
                  </button>

                  {termsAgreed && (
                    <button
                      onClick={() => setActiveTab("meter")}
                      className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition flex items-center justify-center gap-1"
                    >
                      View Live Meter & Deposit Status
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 3: LIVE METER & ESCROW STATUS                                         */}
        {/* ========================================================================= */}
        {activeTab === "meter" && (
          <div className="space-y-6">
            {/* Top Stats Banner */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800">
                <span className="text-xs text-slate-400">Escrow Deal Status</span>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                      dealStatus === "ACTIVE"
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                        : dealStatus === "DEFAULTED"
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    }`}
                  >
                    {dealStatus}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">Deal #1</span>
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800">
                <span className="text-xs text-slate-400">Total Escrow Vault</span>
                <div className="text-2xl font-bold text-white mt-1">$78.00</div>
                <span className="text-[10px] text-slate-500">Buyer ($66) + Seller ($12)</span>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800">
                <span className="text-xs text-slate-400">Delivered Usage</span>
                <div className="text-2xl font-bold text-emerald-400 mt-1">${meteredValue.toFixed(2)}</div>
                <span className="text-[10px] text-slate-500">of $80.00 credit ({(meteredValue / 80 * 100).toFixed(0)}%)</span>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800">
                <span className="text-xs text-slate-400">Current Payout Stage</span>
                <div className="text-2xl font-bold text-white mt-1">{stageReached}%</div>
                <span className="text-[10px] text-slate-500">${((stageReached / 100) * 60).toFixed(2)} Released to Seller</span>
              </div>
            </div>

            {/* Meter Gauge & Staged Releases */}
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-white flex items-center gap-2">
                  <Activity className="w-5 h-5 text-emerald-400" />
                  Live TEE Consumption Meter
                </h3>
                <span className="text-xs font-mono text-slate-400">{(meteredTokens / 1_000_000).toFixed(1)}M Tokens Processed</span>
              </div>

              {/* Progress Bar with Milestone Markers */}
              <div className="relative pt-6 pb-2">
                <div className="w-full bg-slate-950 rounded-full h-4 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full transition-all duration-500 ${
                      dealStatus === "DEFAULTED"
                        ? "bg-gradient-to-r from-red-500 to-amber-500"
                        : "bg-gradient-to-r from-emerald-500 to-cyan-400"
                    }`}
                    style={{ width: `${(meteredValue / 80) * 100}%` }}
                  ></div>
                </div>

                {/* Markers at 25%, 50%, 75%, 100% */}
                <div className="flex justify-between text-xs text-slate-400 mt-2 font-mono">
                  <span className={meteredValue >= 20 ? "text-emerald-400 font-bold" : ""}>25% ($20)</span>
                  <span className={meteredValue >= 40 ? "text-emerald-400 font-bold" : ""}>50% ($40)</span>
                  <span className={meteredValue >= 60 ? "text-emerald-400 font-bold" : ""}>75% ($60)</span>
                  <span className={meteredValue >= 80 ? "text-emerald-400 font-bold" : ""}>100% ($80)</span>
                </div>
              </div>

              {/* Proxy Credentials for Buyer */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-slate-300 block">Buyer Proxy Configuration (Drop-in OpenAI SDK):</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">BASE_URL:</span>
                    <span className="text-cyan-400">{proxyEndpoint}</span>
                  </div>
                  <div className="bg-slate-900 p-2.5 rounded-lg border border-slate-800 flex justify-between items-center">
                    <span className="text-slate-400">API_KEY:</span>
                    <span className="text-emerald-400">{proxyKey}</span>
                  </div>
                </div>
              </div>

              {/* Interactive Simulation Actions */}
              <div className="flex flex-wrap gap-3 pt-2">
                <button
                  onClick={handleSimulateCall}
                  disabled={dealStatus !== "ACTIVE"}
                  className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs transition flex items-center gap-2 border border-slate-700 disabled:opacity-40"
                >
                  <Zap className="w-4 h-4 text-emerald-400" />
                  Simulate API Request (+$2.50)
                </button>

                <button
                  onClick={handleSimulateRevokeDefault}
                  disabled={dealStatus !== "ACTIVE"}
                  className="px-4 py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold text-xs transition flex items-center gap-2 border border-red-500/30 disabled:opacity-40"
                >
                  <AlertTriangle className="w-4 h-4" />
                  Simulate Seller Key Revocation (Pilot Deal 2 Default)
                </button>
              </div>
            </div>

            {/* Event Log & Explorer Txns */}
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-3">
              <h3 className="font-bold text-white text-sm">Contract Lifecycle Events (NEAR Testnet)</h3>
              <div className="space-y-2">
                {eventsLog.map((ev, i) => (
                  <div key={i} className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-semibold text-slate-200">{ev.title}</div>
                      <div className="text-slate-400 text-[11px] mt-0.5">{ev.desc}</div>
                    </div>
                    <div className="text-right">
                      <a
                        href={`https://testnet.nearblocks.io/txns/${ev.tx}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-cyan-400 hover:underline flex items-center gap-1"
                      >
                        {ev.tx}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <div className="text-slate-500 text-[10px] mt-0.5">{ev.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 4: SMART CONTRACT SPECIFICATION & ON-CHAIN STATE                      */}
        {/* ========================================================================= */}
        {activeTab === "contract" && (
          <div className="space-y-6">
            <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">NEAR Escrow Smart Contract</h2>
                  <p className="text-xs text-slate-400 mt-1">Rust SDK v5.30 • Target: wasm32-unknown-unknown • Size: 426 KB</p>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  Ready for Testnet Deploy
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-slate-400 font-bold uppercase tracking-wider">Methods Implemented:</div>
                  <ul className="space-y-1 text-slate-300">
                    <li>• create_deal(params)</li>
                    <li>• register_terms_hash(deal_id, terms_hash, sig)</li>
                    <li>• deposit(deal_id) [attached native NEAR]</li>
                    <li>• ft_on_transfer(sender, amount, msg) [NEP-141]</li>
                    <li>• activate(deal_id, payload, sig)</li>
                    <li>• release_stage(deal_id, stage, payload, sig)</li>
                    <li>• checkpoint(deal_id, payload, sig)</li>
                    <li>• settle_default(deal_id, payload, sig)</li>
                    <li>• timeout_refund(deal_id)</li>
                    <li>• auto_release(deal_id)</li>
                  </ul>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="text-slate-400 font-bold uppercase tracking-wider">Security Invariants Verified:</div>
                  <ul className="space-y-1 text-slate-300">
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Ed25519 signature verified on-chain
                    </li>
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Canonical Borsh payload replay protection
                    </li>
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Strictly increasing per-deal nonces
                    </li>
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Exact balance conservation (zero dust)
                    </li>
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Dual collateral slashing on deliberate revoke
                    </li>
                    <li className="flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 30-day non-use auto-release safeguard
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 px-6 py-4 text-center text-xs text-slate-500">
        Conpi System Architecture • Powered by NEAR Protocol & Intel TDX Confidential Computing
      </footer>
    </div>
  );
}
