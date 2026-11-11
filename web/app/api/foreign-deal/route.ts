export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { CONTRACT_ID } from "@/lib/chain";

const RPC_ENDPOINTS = [
  "https://archival-rpc.testnet.near.org",
  "https://rpc.testnet.near.org",
  "https://test.rpc.fastnear.com",
];

const cache = new Map<number, { data: any; time: number }>();
const CACHE_TTL_MS = 2500;

function parseNearResult<T>(value: string): T {
  const lossless = value.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(lossless) as T;
}

async function fetchForeignDealFromNear(dealId: number): Promise<any | null> {
  const argsBase64 = Buffer.from(JSON.stringify({ deal_id: dealId })).toString("base64");
  let lastError: any = null;

  for (const url of RPC_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `foreign_deal_${dealId}_${Date.now()}`,
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: CONTRACT_ID,
            method_name: "get_foreign_deal",
            args_base64: argsBase64,
          },
        }),
      });

      if (!response.ok) continue;
      const json = await response.json();
      if (json.error || !json.result?.result) continue;

      const rawBytes = json.result.result;
      const decodedStr = new TextDecoder().decode(new Uint8Array(rawBytes));
      return parseNearResult<any>(decodedStr);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to query get_foreign_deal(${dealId}) on all NEAR RPCs`);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idParam = searchParams.get("id");
    if (!idParam) {
      return NextResponse.json({ ok: false, error: "Missing deal id parameter" }, { status: 400 });
    }

    const dealId = Number(idParam);
    if (isNaN(dealId)) {
      return NextResponse.json({ ok: false, error: "Invalid deal id" }, { status: 400 });
    }

    const force = searchParams.get("force") === "true";
    const now = Date.now();
    const cached = cache.get(dealId);

    if (!force && cached && now - cached.time < CACHE_TTL_MS) {
      return NextResponse.json({ ok: true, dealId, foreignDeal: cached.data, cached: true });
    }

    const foreignDeal = await fetchForeignDealFromNear(dealId);
    if (foreignDeal) {
      cache.set(dealId, { data: foreignDeal, time: now });
    }

    return NextResponse.json({ ok: true, dealId, foreignDeal, cached: false });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to query foreign deal" },
      { status: 500 }
    );
  }
}
