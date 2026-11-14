import { Buffer } from "buffer";
import { createWalletClient, custom, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { CONTRACT_ID, NETWORK } from "./chain";
import { getEvmProvider } from "./evm-wallet";
import { getSolanaProvider } from "./solana-wallet";
import { getWalletSelector } from "./wallet";
import type { WalletChain } from "./types";

export interface BuyerKeyAuthorization {
  chain: "near" | "solana" | "base";
  address: string;
  nonce: string;
  issuedAtMs: number;
  signature: string;
  publicKey?: string;
}

interface BuyerKeyAuthorizationInput {
  dealId: number;
  buyer: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function buildMessage(
  input: BuyerKeyAuthorizationInput,
  unsigned: Omit<BuyerKeyAuthorization, "signature" | "publicKey">
): string {
  return stableStringify({
    action: "conpi.buyer.claim-proxy-key.v1",
    dealId: input.dealId,
    buyer: input.buyer.trim().toLowerCase(),
    chainId: NETWORK,
    contractId: CONTRACT_ID,
    wallet: unsigned,
  });
}

export async function signBuyerKeyAuthorization(
  walletChain: WalletChain,
  input: BuyerKeyAuthorizationInput
): Promise<BuyerKeyAuthorization> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Buffer.from(nonceBytes).toString("base64");
  const issuedAtMs = Date.now();

  if (walletChain === "near") {
    const selector = await getWalletSelector();
    if (!selector) throw new Error("NEAR buyer wallet is not connected");
    const state = selector.selector.store.getState();
    const wallet = await selector.selector.wallet(state.selectedWalletId || "browser-account-wallet");
    if (typeof wallet.signMessage !== "function") {
      throw new Error("This NEAR wallet does not support signed messages");
    }
    const address = state.accounts[0]?.accountId;
    if (!address) throw new Error("NEAR buyer account is unavailable");
    const unsigned = { chain: "near" as const, address, nonce, issuedAtMs };
    const signed = await wallet.signMessage({
      message: buildMessage(input, unsigned),
      recipient: CONTRACT_ID,
      nonce: Buffer.from(nonceBytes),
    });
    if (!signed) throw new Error("NEAR message signing was cancelled");
    if (signed.accountId.toLowerCase() !== address.toLowerCase()) {
      throw new Error("NEAR wallet signed with a different account");
    }
    return { ...unsigned, publicKey: signed.publicKey, signature: signed.signature };
  }

  if (walletChain === "solana") {
    const provider = getSolanaProvider();
    if (!provider?.publicKey || typeof provider.signMessage !== "function") {
      throw new Error("Connected Solana buyer wallet cannot sign messages");
    }
    const address = provider.publicKey.toString();
    const unsigned = { chain: "solana" as const, address, nonce, issuedAtMs };
    const signed = await provider.signMessage(new TextEncoder().encode(buildMessage(input, unsigned)), "utf8");
    const signatureBytes = signed?.signature || signed;
    if (!signatureBytes) throw new Error("Solana message signing was cancelled");
    return { ...unsigned, signature: Buffer.from(signatureBytes).toString("base64") };
  }

  const provider = getEvmProvider();
  if (!provider) throw new Error("Base buyer wallet is not connected");
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  const unsigned = { chain: "base" as const, address, nonce, issuedAtMs };
  const signature = await wallet.signMessage({
    account: address as Address,
    message: buildMessage(input, unsigned),
  }) as Hex;
  return { ...unsigned, signature };
}
