import { Buffer } from "buffer";
if (typeof window !== "undefined") {
  (window as any).Buffer = (window as any).Buffer || Buffer;
}
import { CONTRACT_ID } from "./chain";

export const NEAR_RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC || "https://test.rpc.fastnear.com";
const FALLBACK_RPC_URL = "https://test.rpc.fastnear.com";

function parseNearResult<T>(value: string): T {
  // Contract view methods currently serialize u128 balances as JSON numbers.
  // Quote integers beyond Number.MAX_SAFE_INTEGER before JSON.parse so wallet
  // deposits retain their exact yoctoNEAR value.
  const lossless = value.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(lossless) as T;
}

export interface OnChainDeal {
  id: number;
  buyer: string;
  seller: string;
  token: string | null;
  price: string | number;
  credit_amount: string | number;
  seller_collateral: string | number;
  buyer_collateral: string | number;
  terms_hash: number[] | null;
  tee_pubkey?: string;
  deposit_deadline?: number;
  key_deadline?: number;
  usage_deadline?: number;
  notice_deadline?: number | null;
  tee_liveness_timeout?: number;
  slash_bps_provider_ban?: number;
  slash_bps_revoke?: number;
  slash_bps_buyer_breach?: number;
  buyer_deposited: string | number | boolean;
  seller_deposited: string | number | boolean;
  released_to_seller?: string | number;
  stage_reached?: number;
  last_signed?: {
    stage: number;
    metered_value: string | number;
    nonce: number;
    issued_at: number;
  } | null;
  last_nonce?: number;
  last_tee_seen?: number;
  status: "Created" | "Funded" | "Active" | "Completed" | "Defaulted" | "Cancelled" | "SettledTimeout" | "Deposited" | "Settled";
  counterparty_accepted?: boolean;
  terms_submitted_by_buyer?: boolean;
  terms_submitted_by_seller?: boolean;
  deposit_duration?: number;
  usage_duration?: number;
  created_at?: number;
  activated_at?: number | null;
  current_stage?: number;
  metered_value?: string;
  released_amount?: string;
  last_checkpoint_time?: number | null;
  auto_release_requested_at?: number | null;
}

export interface OnChainConfig {
  min_deposit_duration: number;
  max_deposit_duration: number;
  min_tee_liveness_timeout: number;
  default_usage_duration: number;
  notice_period_duration: number;
  min_slash_bps: number;
  max_slash_bps: number;
  storage_deposit_fee: string;
}

export interface OnChainTeeSigner {
  measurement: string;
  registered_at: number;
  active: boolean;
}

export async function callNearRpc<T>(methodName: string, args: Record<string, any> = {}): Promise<T> {
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
  // Always retain two independent providers even when NEXT_PUBLIC_NEAR_RPC is
  // set to the official endpoint. A transient failure must not make the UI
  // replace real on-chain deals with an empty list.
  const urls = Array.from(new Set([
    "https://test.rpc.fastnear.com",
    NEAR_RPC_URL,
  ].filter(Boolean)));

  let lastError: any = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `query_${methodName}_${Date.now()}_${attempt}`,
            method: "query",
            params: {
              request_type: "call_function",
              finality: "final",
              account_id: CONTRACT_ID,
              method_name: methodName,
              args_base64: argsBase64,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`NEAR RPC error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();
        if (json.error) {
          throw new Error(json.error.message || JSON.stringify(json.error));
        }

        const rawBytes = json.result?.result;
        if (!rawBytes || !Array.isArray(rawBytes)) {
          throw new Error(`Invalid response bytes for ${methodName}`);
        }

        const decodedStr = new TextDecoder().decode(new Uint8Array(rawBytes));
        return parseNearResult<T>(decodedStr);
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error(`Failed to call ${methodName} on all RPCs`);
}

export async function fetchContractDeals(fromIndex = 0, limit = 100): Promise<OnChainDeal[]> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/deals", { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.deals) && data.deals.length > 0) {
          return data.deals as OnChainDeal[];
        }
      }
    } catch (err) {
      console.warn("Client /api/deals route error, falling back to direct NEAR RPC:", err);
    }
  }
  return callNearRpc<OnChainDeal[]>("list_deals", { from_index: fromIndex, limit });
}

export async function fetchContractDeal(dealId: number): Promise<OnChainDeal | null> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetch("/api/deals", { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.deals)) {
          const match = data.deals.find((d: any) => Number(d.id) === Number(dealId));
          if (match) return match as OnChainDeal;
        }
      }
    } catch {}
  }
  try {
    return await callNearRpc<OnChainDeal | null>("get_deal", { deal_id: dealId });
  } catch (err) {
    console.warn(`fetchContractDeal(${dealId}) error:`, err);
    return null;
  }
}

export async function fetchContractConfig(): Promise<OnChainConfig | null> {
  try {
    return await callNearRpc<OnChainConfig>("get_config", {});
  } catch (err) {
    console.warn("fetchContractConfig error:", err);
    return null;
  }
}

export async function fetchContractTeeSigner(publicKey: string): Promise<OnChainTeeSigner | null> {
  try {
    return await callNearRpc<OnChainTeeSigner | null>("get_tee_signer", { public_key: publicKey });
  } catch (err) {
    console.warn(`fetchContractTeeSigner(${publicKey}) error:`, err);
    return null;
  }
}

export async function fetchContractStagedProposals(): Promise<Array<[number, any]>> {
  try {
    return await callNearRpc<Array<[number, any]>>("list_staged_proposals", {});
  } catch (err) {
    console.warn("fetchContractStagedProposals error:", err);
    return [];
  }
}

export async function fetchContractPendingPayout(accountId: string, token: string | null = null): Promise<string> {
  try {
    return await callNearRpc<string>("get_pending_payout", { account_id: accountId, token });
  } catch (err) {
    return "0";
  }
}

export async function fetchContractDealCreator(dealId: number): Promise<string | null> {
  try {
    const key = new Uint8Array(9);
    key[0] = "c".charCodeAt(0);
    const view = new DataView(key.buffer);
    view.setBigUint64(1, BigInt(dealId), true);
    const keyB64 = Buffer.from(key).toString("base64");

    const urls = [NEAR_RPC_URL, FALLBACK_RPC_URL].filter(Boolean);
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `creator_${dealId}`,
            method: "query",
            params: {
              request_type: "view_state",
              finality: "final",
              account_id: CONTRACT_ID,
              prefix_base64: keyB64,
            },
          }),
        });
        const json = await response.json();
        const values = json.result?.values;
        if (values && values.length > 0) {
          const valBytes = Buffer.from(values[0].value, "base64");
          const len = valBytes.readUInt32LE(0);
          return valBytes.toString("utf8", 4, 4 + len);
        }
      } catch {}
    }
  } catch {}
  return null;
}

export async function fetchContractForeignDeal(dealId: number): Promise<any | null> {
  if (typeof window !== "undefined") {
    try {
      const res = await fetch(`/api/foreign-deal?id=${dealId}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.foreignDeal) {
          return json.foreignDeal;
        }
      }
    } catch (e) {
      console.warn(`[fetchContractForeignDeal] API route fallback to direct RPC for ${dealId}:`, e);
    }
  }

  try {
    return await callNearRpc<any>("get_foreign_deal", { deal_id: dealId });
  } catch {
    return null;
  }
}
