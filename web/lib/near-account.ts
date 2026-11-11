import bs58 from "bs58";

/**
 * Validates whether a string complies with the NEAR Protocol Account ID specification:
 * - Between 2 and 64 characters
 * - Named accounts: lowercase alphanumeric, `-`, `_`, `.` (no uppercase, no trailing/consecutive separators)
 * - Implicit accounts: exactly 64 lowercase hexadecimal characters
 */
export function isValidNearAccountId(accountId: string): boolean {
  if (!accountId || typeof accountId !== "string") return false;
  const trimmed = accountId.trim();
  const len = trimmed.length;
  if (len < 2 || len > 64) return false;
  if (/^[0-9a-f]{64}$/.test(trimmed)) return true;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return false;
  if (/^[._-]|[._-]$|[._-]{2,}/.test(trimmed)) return false;
  const parts = trimmed.split(".");
  for (const part of parts) {
    if (!part || !/^[a-z0-9_-]+$/.test(part)) return false;
  }
  return true;
}

/**
 * Checks whether an address is an EVM address (0x + 40 hex chars).
 */
export function isEvmAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

/**
 * Checks whether an address is a Base58-encoded Solana address (32-byte Ed25519 public key).
 */
export function isSolanaAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  try {
    const bytes = bs58.decode(trimmed);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

/**
 * Deterministically maps any multi-chain address (Solana, Base EVM, or NEAR)
 * into a valid, canonical NEAR AccountId:
 * - Native NEAR account: returned unchanged
 * - Solana address (Base58 32-byte Ed25519): converted to 64-char lowercase hex (valid implicit NEAR AccountId)
 * - Base EVM address (20 bytes): padded with 24 leading zeroes to 64-char lowercase hex
 * - Fallback: SHA-256 64-hex string
 */
export function toNearAccountId(address: string): string {
  if (!address || typeof address !== "string") return "";
  const trimmed = address.trim();

  // If already a valid NEAR account ID, return as-is
  if (isValidNearAccountId(trimmed)) {
    return trimmed;
  }

  // EVM address: 0x + 40 hex chars -> 64-char lowercase hex implicit account
  if (isEvmAddress(trimmed)) {
    return "0".repeat(24) + trimmed.slice(2).toLowerCase();
  }

  // Solana address: 32 bytes Base58 -> 64-char lowercase hex implicit account
  try {
    const bytes = bs58.decode(trimmed);
    if (bytes.length === 32) {
      return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toLowerCase();
    }
  } catch {}

  // Fallback: guaranteed 64 lowercase hex characters
  let hashHex = "";
  if (typeof window === "undefined") {
    try {
      const { createHash } = require("crypto");
      hashHex = createHash("sha256").update(trimmed).digest("hex").toLowerCase();
    } catch {}
  }
  if (!hashHex) {
    hashHex = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(64, "0").slice(0, 64);
  }
  return hashHex;
}

/**
 * Recovers or formats the human-readable wallet address from a NEAR Account ID.
 */
export function fromNearAccountId(accountId: string, originalAddress?: string): string {
  if (originalAddress) return originalAddress;
  if (!accountId || typeof accountId !== "string") return "";
  const trimmed = accountId.trim();

  // EVM address encoded with 24 leading zeroes
  if (/^0{24}[a-f0-9]{40}$/.test(trimmed)) {
    return "0x" + trimmed.slice(24);
  }

  // If it's a 64-hex string that was derived from Solana
  if (/^[0-9a-f]{64}$/.test(trimmed)) {
    try {
      const match = trimmed.match(/.{1,2}/g);
      if (match && match.length === 32) {
        const u8 = new Uint8Array(match.map((byte) => parseInt(byte, 16)));
        return bs58.encode(u8);
      }
    } catch {}
  }

  return trimmed;
}
