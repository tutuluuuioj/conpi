export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { CONTRACT_ID } from "@/lib/chain";
import { serverNearRpcEndpoints } from "@/lib/rpc-endpoints";

const RPC_ENDPOINTS = serverNearRpcEndpoints();

function annotateWithVaultDeposits(deals: any[]): any[] {
  const possiblePaths = [
    path.join(process.cwd(), ".vault_used_txs.json"),
    path.join(process.cwd(), "web", ".vault_used_txs.json"),
  ];
  let storePath = possiblePaths[0];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      storePath = p;
      break;
    }
  }
  let usedTxs: any[] = [];
  if (fs.existsSync(storePath)) {
    try {
      usedTxs = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    } catch {}
  }

  const activePaths = [
    path.join(process.cwd(), ".vault_active_deals.json"),
    path.join(process.cwd(), "web", ".vault_active_deals.json"),
  ];
  let activeDeals: Record<string, any> = {};
  for (const p of activePaths) {
    if (fs.existsSync(p)) {
      try {
        activeDeals = JSON.parse(fs.readFileSync(p, "utf-8"));
        break;
      } catch {}
    }
  }

  const payoutPaths = [
    path.join(process.cwd(), ".vault_dispatched_payouts.json"),
    path.join(process.cwd(), "web", ".vault_dispatched_payouts.json"),
  ];
  let dispatchedPayouts: any[] = [];
  for (const p of payoutPaths) {
    if (fs.existsSync(p)) {
      try {
        dispatchedPayouts = JSON.parse(fs.readFileSync(p, "utf-8"));
        break;
      } catch {}
    }
  }

  return deals.map((deal) => {
    // A proxy credential is a bearer secret owned by the on-chain buyer. It
    // must never be serialized by this shared/public deal-list endpoint.
    const { proxyKey: _privateBuyerCredential, ...publicDeal } = deal;
    const activeInfo = activeDeals[String(deal.id)];
    const dealTxs = usedTxs.filter((tx) => Number(tx.dealId) === Number(deal.id));
    const dealPayouts = dispatchedPayouts.filter((p) => Number(p.dealId) === Number(deal.id) && !p.isRefund);
    if (!dealTxs.length && !activeInfo && !dealPayouts.length) return publicDeal;

    const hasNearDeposit = dealTxs.some((tx) => tx.chain === "near");
    const hasSolanaDeposit = dealTxs.some((tx) => tx.chain === "solana");
    const hasBaseDeposit = dealTxs.some((tx) => tx.chain === "base");

    const vaultBuyerDeposited = hasNearDeposit || hasBaseDeposit || (dealTxs.length >= 1 && !hasSolanaDeposit) || Boolean(activeInfo);
    const vaultSellerDeposited = hasSolanaDeposit || (dealTxs.length >= 2) || Boolean(activeInfo);
    const isFunded = (vaultBuyerDeposited && vaultSellerDeposited) || dealTxs.length >= 2 || Boolean(activeInfo);

    let resolvedStatus = deal.status;
    if (activeInfo) {
      resolvedStatus = "Active";
    } else if (isFunded && deal.status === "Created") {
      resolvedStatus = "Funded";
    }

    const totalReleasedUsdc = dealPayouts.reduce((sum, p) => sum + Number(p.amountUsdc || 0), 0);
    const totalReleasedAtomic = dealPayouts.reduce((sum, p) => sum + BigInt(p.amountAtomic || 0), BigInt(0));

    return {
      ...publicDeal,
      vault_buyer_deposited: vaultBuyerDeposited,
      vault_seller_deposited: vaultSellerDeposited,
      vault_deposits: dealTxs,
      vault_payouts: dealPayouts,
      released_to_seller: totalReleasedAtomic > BigInt(0) ? totalReleasedAtomic.toString() : deal.released_to_seller,
      releasedUsd: totalReleasedUsdc > 0 ? totalReleasedUsdc : deal.releasedUsd,
      stage_reached: Math.max(Number(deal.stage_reached || 0), dealPayouts.length * 25),
      status: resolvedStatus,
      baseUrl: activeInfo ? "http://localhost:4000/v1" : undefined,
      active_vault_deal: Boolean(activeInfo),
    };
  });
}

let cachedDeals: any[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 3000;

function parseNearResult<T>(value: string): T {
  const lossless = value.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(lossless) as T;
}

async function fetchFromNear(): Promise<any[]> {
  const argsBase64 = Buffer.from(JSON.stringify({ from_index: 0, limit: 100 })).toString("base64");
  let lastError: any = null;

  for (const url of RPC_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(9000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `api_deals_${Date.now()}`,
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: "list_deals",
            args_base64: argsBase64,
          },
        }),
      });

      if (!response.ok) continue;
      const json = await response.json();
      if (json.error || !json.result?.result) continue;

      const rawBytes = json.result.result;
      const decodedStr = new TextDecoder().decode(new Uint8Array(rawBytes));
      const deals = parseNearResult<any[]>(decodedStr);
      if (Array.isArray(deals) && deals.length > 0) {
        return deals;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (cachedDeals && cachedDeals.length > 0) {
    return cachedDeals;
  }
  throw lastError || new Error("Failed to query list_deals from all NEAR RPC endpoints");
}

export async function GET(req: Request) {
  const now = Date.now();
  console.log(`>>> [/api/deals GET] Invoked. Cached count: ${cachedDeals?.length ?? 0}`);
  if (cachedDeals && now - lastFetchTime < CACHE_TTL_MS) {
    const annotated = annotateWithVaultDeposits(cachedDeals);
    return NextResponse.json({ ok: true, deals: annotated, cached: true });
  }

  try {
    const deals = await fetchFromNear();
    cachedDeals = deals;
    lastFetchTime = now;
    const annotated = annotateWithVaultDeposits(deals);
    console.log(`>>> [/api/deals GET] Success. Returning ${annotated.length} deals.`);
    return NextResponse.json({ ok: true, deals: annotated, cached: false });
  } catch (err: any) {
    console.error(`>>> [/api/deals GET] Error:`, err);
    if (cachedDeals) {
      const annotated = annotateWithVaultDeposits(cachedDeals);
      return NextResponse.json({ ok: true, deals: annotated, fallback: true });
    }
    return NextResponse.json({ ok: false, error: err.message, deals: [] }, { status: 500 });
  }
}
