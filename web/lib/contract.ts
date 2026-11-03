import { CONTRACT_ID } from "./chain";

export const NEAR_RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC || "https://rpc.testnet.near.org";

export interface OnChainDeal {
  id: number;
  buyer: string;
  seller: string;
  token: string | null;
  price: string;
  credit_amount: string;
  seller_collateral: string;
  buyer_collateral: string;
  terms_hash: number[];
  terms_submitted_by_buyer: boolean;
  terms_submitted_by_seller: boolean;
  buyer_deposited: boolean;
  seller_deposited: boolean;
  deposit_duration: number;
  usage_duration: number;
  tee_liveness_timeout: number;
  slash_bps: number;
  status: "Created" | "Deposited" | "Active" | "Settled" | "Defaulted" | "Cancelled";
  created_at: number;
  activated_at: number | null;
  current_stage: number;
  metered_value: string;
  released_amount: string;
  last_checkpoint_time: number | null;
  auto_release_requested_at: number | null;
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
  const response = await fetch(NEAR_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `query_${methodName}_${Date.now()}`,
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
    throw new Error(`NEAR RPC error: ${response.statusText}`);
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
  return JSON.parse(decodedStr) as T;
}

export async function fetchContractDeals(fromIndex = 0, limit = 100): Promise<OnChainDeal[]> {
  try {
    return await callNearRpc<OnChainDeal[]>("list_deals", { from_index: fromIndex, limit });
  } catch (err) {
    console.warn("fetchContractDeals fallback/error:", err);
    return [];
  }
}

export async function fetchContractDeal(dealId: number): Promise<OnChainDeal | null> {
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
