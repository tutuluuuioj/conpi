import { createHash } from "crypto";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { JsonRpcProvider } from "near-api-js";
import { verifyMessage as verifyNearMessage } from "near-api-js/nep413";
import { verifyMessage as verifyEvmMessage, type Address, type Hex } from "viem";
import { CONFIG } from "../config.js";

export type SellerWalletChain = "near" | "solana" | "base";

export interface SellerKeyAuthorization {
  chain: SellerWalletChain;
  address: string;
  nonce: string;
  issuedAtMs: number;
  signature: string;
  publicKey?: string;
}

export interface SellerKeyAuthorizationRequest {
  dealId: number;
  seller: string;
  provider: string;
  model: string;
  models: string[];
  termsHashHex: string;
  encryptedEnvelope?: unknown;
  plainApiKey?: string;
  authorization: SellerKeyAuthorization;
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

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * The wallet signs the exact activation request, including the encrypted key
 * envelope. A captured signature therefore cannot authorize another key,
 * model, deal, or terms hash.
 */
export function buildSellerKeyAuthorizationMessage(request: SellerKeyAuthorizationRequest): string {
  const normalizedModels = [...new Set(request.models.map((item) => item.trim()).filter(Boolean))].sort();
  const keyMaterial = request.encryptedEnvelope ?? (
    process.env.NODE_ENV === "test" ? { testPlainApiKey: request.plainApiKey || "" } : null
  );
  const keyCommitment = createHash("sha256").update(stableStringify(keyMaterial)).digest("hex");

  return stableStringify({
    action: "conpi.seller.inject-key.v1",
    dealId: request.dealId,
    seller: request.seller.trim().toLowerCase(),
    provider: request.provider.trim().toLowerCase(),
    model: request.model.trim(),
    models: normalizedModels,
    termsHashHex: request.termsHashHex.replace(/^0x/, "").toLowerCase(),
    keyCommitment,
    wallet: {
      chain: request.authorization.chain,
      address: request.authorization.address.trim(),
      nonce: request.authorization.nonce,
      issuedAtMs: request.authorization.issuedAtMs,
    },
  });
}

export function canonicalSellerAccount(chain: SellerWalletChain, address: string): string {
  const trimmed = address.trim();
  if (chain === "near") return trimmed.toLowerCase();
  if (chain === "base") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) throw new Error("Invalid Base wallet address");
    return `${"0".repeat(24)}${trimmed.slice(2).toLowerCase()}`;
  }
  const bytes = bs58.decode(trimmed);
  if (bytes.length !== 32) throw new Error("Invalid Solana wallet address");
  return Buffer.from(bytes).toString("hex");
}

export interface SellerAuthorizationDependencies {
  now?: () => number;
  verifyNear?: typeof verifyNearMessage;
}

export async function verifySellerKeyAuthorization(
  request: SellerKeyAuthorizationRequest,
  dependencies: SellerAuthorizationDependencies = {}
): Promise<void> {
  const auth = request.authorization;
  if (!auth || !auth.chain || !auth.address || !auth.signature || !auth.nonce) {
    throw new Error("Seller wallet signature is required");
  }

  const nonce = Buffer.from(auth.nonce, "base64");
  if (nonce.length !== 32 || nonce.toString("base64") !== auth.nonce) {
    throw new Error("Seller authorization nonce must be exactly 32 bytes");
  }
  const now = (dependencies.now || Date.now)();
  if (!Number.isSafeInteger(auth.issuedAtMs) || Math.abs(now - auth.issuedAtMs) > 5 * 60_000) {
    throw new Error("Seller authorization has expired");
  }

  const canonicalAddress = canonicalSellerAccount(auth.chain, auth.address);
  if (canonicalAddress !== request.seller.trim().toLowerCase()) {
    throw new Error("The signing wallet is not the deal seller");
  }

  const message = buildSellerKeyAuthorizationMessage(request);
  if (auth.chain === "near") {
    if (!auth.publicKey) throw new Error("NEAR seller public key is required");
    const verifyNear = dependencies.verifyNear || verifyNearMessage;
    await verifyNear({
      signerAccountId: auth.address,
      signerPublicKey: auth.publicKey,
      payload: {
        message,
        nonce,
        recipient: CONFIG.contractId,
      },
      signature: Buffer.from(auth.signature, "base64"),
      provider: new JsonRpcProvider({ url: CONFIG.nodeUrl }),
    });
    return;
  }

  if (auth.chain === "solana") {
    const valid = ed25519.verify(
      Buffer.from(auth.signature, "base64"),
      new TextEncoder().encode(message),
      bs58.decode(auth.address)
    );
    if (!valid) throw new Error("Invalid Solana seller signature");
    return;
  }

  const valid = await verifyEvmMessage({
    address: auth.address as Address,
    message,
    signature: auth.signature as Hex,
  });
  if (!valid) throw new Error("Invalid Base seller signature");
}
