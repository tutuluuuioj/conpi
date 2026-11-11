"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ExternalLink, RefreshCw, Layers, Database } from "lucide-react";
import { Card, Overline } from "@/components/ui";
import { MAKER_VAULT_CONFIG, fetchMakerVaultReserves, type MakerVaultReserves } from "@/lib/maker-vault";

export function MakerVaultCard({ className = "" }: { className?: string }) {
  const [reserves, setReserves] = useState<MakerVaultReserves | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchMakerVaultReserves();
      setReserves(data);
    } catch {
      // Ignored - fallback handled inside fetchMakerVaultReserves
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className={`space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-brand" />
          <Overline>CONPI Maker Vault</Overline>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider">
            100% USDC
          </span>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-muted hover:text-ink ml-1 p-0.5 rounded transition-all"
            title="Refresh reserves"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted leading-relaxed">
        Protocol-owned multi-chain liquidity pool. Cross-chain buyers pay USDC on Base, Solana, or NEAR; sellers receive USDC on their chosen chain.
      </p>

      {/* Reserves breakdown */}
      <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono">
        {/* Base */}
        <div className="p-2 rounded bg-surface-2 border border-line flex flex-col justify-between">
          <div className="text-[10px] font-semibold text-muted flex items-center justify-center gap-1">
            <span>Base</span>
            <a
              href={`${MAKER_VAULT_CONFIG.base.explorer}/address/${MAKER_VAULT_CONFIG.base.vaultAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand"
            >
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          <div className="text-xs font-bold text-ink mt-1">
            ${(reserves?.baseUsdc ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[9px] text-muted">ERC-20</div>
        </div>

        {/* Solana */}
        <div className="p-2 rounded bg-surface-2 border border-line flex flex-col justify-between">
          <div className="text-[10px] font-semibold text-muted flex items-center justify-center gap-1">
            <span>Solana</span>
            <a
              href={`${MAKER_VAULT_CONFIG.solana.explorer}/address/${MAKER_VAULT_CONFIG.solana.vaultAddress}?cluster=devnet`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand"
            >
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          <div className="text-xs font-bold text-ink mt-1">
            ${(reserves?.solanaUsdc ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[9px] text-muted">SPL-Token</div>
        </div>

        {/* NEAR */}
        <div className="p-2 rounded bg-surface-2 border border-line flex flex-col justify-between">
          <div className="text-[10px] font-semibold text-muted flex items-center justify-center gap-1">
            <span>NEAR</span>
            <a
              href={`${MAKER_VAULT_CONFIG.near.explorer}/address/${MAKER_VAULT_CONFIG.near.vaultAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:text-brand"
            >
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          <div className="text-xs font-bold text-ink mt-1">
            ${(reserves?.nearUsdc ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[9px] text-muted">NEP-141</div>
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] pt-1 text-muted border-t border-line/50">
        <span>Total Protocol Reserves:</span>
        <span className="font-mono font-bold text-emerald-400">
          ${(reserves?.totalUsdc ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
        </span>
      </div>
    </Card>
  );
}
