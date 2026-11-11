import { Buffer } from "buffer";
import { createWalletClient, custom, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { CONTRACT_ID } from "./chain";
import { getEvmProvider } from "./evm-wallet";
import { getSolanaProvider } from "./solana-wallet";
import { getWalletSelector } from "./wallet";
import type { WalletChain } from "./types";

export interface SellerKeyAuthorization {
  chain: "near" | "solana" | "base";
  address: string;
  nonce: string;
  issuedAtMs: number;
  signature: string;
  publicKey?: string;
}

export interface SellerKeyAuthorizationInput {
  dealId: number;
  seller: string;
  provider: string;
  model: string;
  models: string[];
  termsHashHex: string;
  encryptedEnvelope: unknown;
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildMessage(
  input: SellerKeyAuthorizationInput,
  unsigned: Omit<SellerKeyAuthorization, "signature" | "publicKey">
): Promise<string> {
  return stableStringify({
    action: "conpi.seller.inject-key.v1",
    dealId: input.dealId,
    seller: input.seller.trim().toLowerCase(),
    provider: input.provider.trim().toLowerCase(),
    model: input.model.trim(),
    models: Array.from(new Set(input.models.map((item) => item.trim()).filter(Boolean))).sort(),
    termsHashHex: input.termsHashHex.replace(/^0x/, "").toLowerCase(),
    keyCommitment: await sha256Hex(stableStringify(input.encryptedEnvelope)),
    wallet: unsigned,
  });
}

export async function signSellerKeyAuthorization(
  walletChain: WalletChain,
  input: SellerKeyAuthorizationInput
): Promise<SellerKeyAuthorization> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Buffer.from(nonceBytes).toString("base64");
  const issuedAtMs = Date.now();

  if (walletChain === "near") {
    const selector = await getWalletSelector();
    if (!selector) throw new Error("NEAR wallet is not connected");
    const state = selector.selector.store.getState();
    const wallet = await selector.selector.wallet(state.selectedWalletId || "browser-account-wallet");
    if (typeof wallet.signMessage !== "function") {
      throw new Error("This NEAR wallet does not support signed messages");
    }
    const address = state.accounts[0]?.accountId;
    if (!address) throw new Error("NEAR wallet account is unavailable");
    const unsigned = { chain: "near" as const, address, nonce, issuedAtMs };
    const message = await buildMessage(input, unsigned);
    const signed = await wallet.signMessage({
      message,
      recipient: CONTRACT_ID,
      nonce: Buffer.from(nonceBytes),
    });
    if (!signed) throw new Error("NEAR message signing was cancelled");
    if (signed.accountId.toLowerCase() !== address.toLowerCase()) {
      throw new Error("NEAR wallet signed with a different account");
    }
    return {
      ...unsigned,
      publicKey: signed.publicKey,
      signature: signed.signature,
    };
  }

  if (walletChain === "solana") {
    const provider = getSolanaProvider();
    if (!provider?.publicKey || typeof provider.signMessage !== "function") {
      throw new Error("Connected Solana wallet cannot sign messages");
    }
    const address = provider.publicKey.toString();
    const unsigned = { chain: "solana" as const, address, nonce, issuedAtMs };
    const message = await buildMessage(input, unsigned);
    const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
    const signatureBytes = signed?.signature || signed;
    if (!signatureBytes) throw new Error("Solana message signing was cancelled");
    return { ...unsigned, signature: Buffer.from(signatureBytes).toString("base64") };
  }

  const provider = getEvmProvider();
  if (!provider) throw new Error("Base wallet is not connected");
  const wallet = createWalletClient({ chain: baseSepolia, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  const unsigned = { chain: "base" as const, address, nonce, issuedAtMs };
  const message = await buildMessage(input, unsigned);
  const signature = await wallet.signMessage({ account: address as Address, message }) as Hex;
  return { ...unsigned, signature };
}
