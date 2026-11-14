import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { JsonRpcProvider } from "near-api-js";
import { verifyMessage as verifyNearMessage } from "near-api-js/nep413";
import { verifyMessage as verifyEvmMessage, type Address, type Hex } from "viem";
import { CONFIG } from "../config.js";
import { canonicalSellerAccount, stableStringify, type SellerWalletChain } from "./seller-key.js";
import { buyerAuthorizationNonceStore } from "./buyer-nonce-store.js";

export type BuyerWalletChain = SellerWalletChain;

export interface BuyerKeyAuthorization {
  chain: BuyerWalletChain;
  address: string;
  nonce: string;
  issuedAtMs: number;
  signature: string;
  publicKey?: string;
}

export interface BuyerKeyAuthorizationRequest {
  dealId: number;
  buyer: string;
  authorization: BuyerKeyAuthorization;
}

/**
 * The claim is deliberately separate from seller key injection. The signed
 * message binds the buyer wallet to one deal and this escrow deployment, so a
 * captured signature cannot claim another deal's proxy credential.
 */
export function buildBuyerKeyAuthorizationMessage(request: BuyerKeyAuthorizationRequest): string {
  return stableStringify({
    action: "conpi.buyer.claim-proxy-key.v1",
    dealId: request.dealId,
    buyer: request.buyer.trim().toLowerCase(),
    chainId: CONFIG.networkId,
    contractId: CONFIG.contractId,
    wallet: {
      chain: request.authorization.chain,
      address: request.authorization.address.trim(),
      nonce: request.authorization.nonce,
      issuedAtMs: request.authorization.issuedAtMs,
    },
  });
}

export interface BuyerAuthorizationDependencies {
  now?: () => number;
  verifyNear?: typeof verifyNearMessage;
  consumeNonce?: boolean;
}

export async function verifyBuyerKeyAuthorization(
  request: BuyerKeyAuthorizationRequest,
  dependencies: BuyerAuthorizationDependencies = {}
): Promise<void> {
  const auth = request.authorization;
  if (!auth || !auth.chain || !auth.address || !auth.signature || !auth.nonce) {
    throw new Error("Buyer wallet signature is required");
  }

  const nonce = Buffer.from(auth.nonce, "base64");
  if (nonce.length !== 32 || nonce.toString("base64") !== auth.nonce) {
    throw new Error("Buyer authorization nonce must be exactly 32 bytes");
  }
  const now = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(auth.issuedAtMs) || Math.abs(now - auth.issuedAtMs) > 5 * 60_000) {
    throw new Error("Buyer authorization has expired");
  }

  const canonicalAddress = canonicalSellerAccount(auth.chain, auth.address);
  if (canonicalAddress !== request.buyer.trim().toLowerCase()) {
    throw new Error("The signing wallet is not the deal buyer");
  }

  const message = buildBuyerKeyAuthorizationMessage(request);
  if (auth.chain === "near") {
    if (!auth.publicKey) throw new Error("NEAR buyer public key is required");
    const verifyNear = dependencies.verifyNear || verifyNearMessage;
    let verified = false;
    let lastError: unknown = null;
    for (const rpcUrl of CONFIG.nearRpcUrls) {
      try {
        await verifyNear({
          signerAccountId: auth.address,
          signerPublicKey: auth.publicKey,
          payload: { message, nonce, recipient: CONFIG.contractId },
          signature: Buffer.from(auth.signature, "base64"),
          provider: new JsonRpcProvider({ url: rpcUrl }),
        });
        verified = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!verified) throw lastError || new Error("All NEAR RPC endpoints failed while verifying the buyer");
  } else if (auth.chain === "solana") {
    const valid = ed25519.verify(
      Buffer.from(auth.signature, "base64"),
      new TextEncoder().encode(message),
      bs58.decode(auth.address)
    );
    if (!valid) throw new Error("Invalid Solana buyer signature");
  } else {
    const valid = await verifyEvmMessage({
      address: auth.address as Address,
      message,
      signature: auth.signature as Hex,
    });
    if (!valid) throw new Error("Invalid Base buyer signature");
  }

  if (dependencies.consumeNonce !== false) buyerAuthorizationNonceStore.consume(auth, now);
}
