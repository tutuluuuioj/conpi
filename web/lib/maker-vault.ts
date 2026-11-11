import { type Address, getAddress, createPublicClient, http, erc20Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { CONTRACT_ID } from "./chain";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC, BASE_SEPOLIA_RPC, BASE_SEPOLIA_EXPLORER } from "./chain-signatures";
import { SOLANA_DEVNET_RPC, SOLANA_DEVNET_USDC_MINT, SOLANA_DEVNET_EXPLORER } from "./solana-wallet";

export type VaultChain = "base" | "solana" | "near";

export interface ChainVaultConfig {
  chain: VaultChain;
  name: string;
  symbol: string;
  decimals: number;
  tokenAddress: string;
  vaultAddress: string;
  explorer: string;
  rpcUrl: string;
}

export const MAKER_VAULT_CONFIG: Record<VaultChain, ChainVaultConfig> = {
  base: {
    chain: "base",
    name: "Base Sepolia",
    symbol: "USDC",
    decimals: 6,
    tokenAddress: BASE_SEPOLIA_USDC,
    // Canonical Conpi Maker Vault Address on Base Sepolia
    vaultAddress: "0x1eF50d100e042317FA5DA9edF44424Fb665990d6",
    explorer: BASE_SEPOLIA_EXPLORER,
    rpcUrl: BASE_SEPOLIA_RPC,
  },
  solana: {
    chain: "solana",
    name: "Solana Devnet",
    symbol: "USDC",
    decimals: 6,
    tokenAddress: SOLANA_DEVNET_USDC_MINT,
    // Canonical Conpi Maker Vault Address on Solana Devnet
    vaultAddress: "FXCfMCe2T7u1gDC6534L8jzXCxoMrk4CKfjU3WCd7Doe",
    explorer: SOLANA_DEVNET_EXPLORER,
    rpcUrl: SOLANA_DEVNET_RPC,
  },
  near: {
    chain: "near",
    name: "NEAR Testnet",
    symbol: "USDC",
    decimals: 6,
    tokenAddress: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    // Conpi Escrow Contract on NEAR
    vaultAddress: CONTRACT_ID,
    explorer: "https://testnet.nearblocks.io",
    rpcUrl: "https://test.rpc.fastnear.com",
  },
};

export interface MakerVaultReserves {
  baseUsdc: number;
  solanaUsdc: number;
  nearUsdc: number;
  totalUsdc: number;
  updatedAt: string;
  isHealthy: boolean;
}

/**
 * Converts standard human-readable USDC ($10.50) to 6-decimal atomic units (10500000).
 */
export function usdcToAtomic(amount: number | string): bigint {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num) || num <= 0) return BigInt(0);
  return BigInt(Math.round(num * 1e6));
}

/**
 * Converts 6-decimal atomic units (10500000) to human-readable USDC ($10.50).
 */
export function atomicToUsdc(atomic: bigint | string | number): number {
  const big = typeof atomic === "bigint" ? atomic : BigInt(atomic || 0);
  return Number(big) / 1e6;
}

/**
 * Queries real-time Maker Vault balances across Base Sepolia, Solana Devnet, and NEAR Testnet.
 */
export async function fetchMakerVaultReserves(): Promise<MakerVaultReserves> {
  let baseUsdc = 0.0;
  let solanaUsdc = 0.0;
  let nearUsdc = 0.0;

  try {
    // 1. Fetch Base Sepolia Vault USDC balance
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(MAKER_VAULT_CONFIG.base.rpcUrl),
    });
    const bal = await client.readContract({
      address: MAKER_VAULT_CONFIG.base.tokenAddress as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(MAKER_VAULT_CONFIG.base.vaultAddress)],
    });
    baseUsdc = Number(bal) / 1e6;
  } catch (err) {
    console.warn("[maker-vault] Base reserve fetch notice:", err);
    baseUsdc = 0.0;
  }

  try {
    // 2. Fetch Solana Devnet Vault USDC balance
    const res = await fetch(MAKER_VAULT_CONFIG.solana.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "vault_reserves",
        method: "getTokenAccountsByOwner",
        params: [
          MAKER_VAULT_CONFIG.solana.vaultAddress,
          { mint: MAKER_VAULT_CONFIG.solana.tokenAddress },
          { encoding: "jsonParsed" },
        ],
      }),
    });
    const json = await res.json();
    const accounts = json.result?.value;
    if (accounts && accounts.length > 0) {
      const uiBal = accounts[0].account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (uiBal !== undefined && uiBal !== null) {
        solanaUsdc = Number(uiBal);
      }
    } else {
      solanaUsdc = 0.0;
    }
  } catch (err) {
    console.warn("[maker-vault] Solana reserve fetch notice:", err);
    solanaUsdc = 0.0;
  }

  try {
    // 3. Fetch NEAR Testnet Vault USDC balance
    const argsBase64 = typeof Buffer !== "undefined"
      ? Buffer.from(JSON.stringify({ account_id: MAKER_VAULT_CONFIG.near.vaultAddress })).toString("base64")
      : btoa(JSON.stringify({ account_id: MAKER_VAULT_CONFIG.near.vaultAddress }));

    const res = await fetch(MAKER_VAULT_CONFIG.near.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "vault_reserves_near",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: MAKER_VAULT_CONFIG.near.tokenAddress,
          method_name: "ft_balance_of",
          args_base64: argsBase64,
        },
      }),
    });
    const json = await res.json();
    if (json.result?.result) {
      const bytes = new Uint8Array(json.result.result);
      const decoded = new TextDecoder().decode(bytes);
      const clean = decoded.replace(/"/g, "");
      const atomic = BigInt(clean || "0");
      nearUsdc = Number(atomic) / 1e6;
    } else {
      nearUsdc = 0.0;
    }
  } catch (err) {
    console.warn("[maker-vault] NEAR reserve fetch notice:", err);
    nearUsdc = 0.0;
  }

  const totalUsdc = baseUsdc + solanaUsdc + nearUsdc;

  return {
    baseUsdc,
    solanaUsdc,
    nearUsdc,
    totalUsdc,
    updatedAt: new Date().toISOString(),
    isHealthy: true,
  };
}
