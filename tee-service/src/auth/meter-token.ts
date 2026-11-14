import crypto from "crypto";
import { enclaveKeys } from "../crypto/keys.js";
import type { VaultEntry } from "../vault/preflight.js";

const TOKEN_PREFIX = "cpm_live_";

/**
 * Read-only credential for the seller's private meter. It is derived from the
 * enclave-sealed state key, so it survives a process restart without granting
 * access to the LLM proxy or revealing the buyer's cpk_live credential.
 */
export function sellerMeterToken(dealId: number, termsHashHex: string): string {
  const digest = crypto
    .createHmac("sha256", Buffer.from(enclaveKeys.getStateStorageKeyBytes()))
    .update(`conpi:seller-meter:v1:${dealId}:${termsHashHex.toLowerCase()}`)
    .digest("hex");
  return `${TOKEN_PREFIX}${digest}`;
}

export function isSellerMeterTokenForEntry(token: string, entry: VaultEntry): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  const expected = sellerMeterToken(entry.dealId, entry.termsHashHex);
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
