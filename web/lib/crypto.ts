import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";

export interface EncryptedKeyEnvelope {
  ephemeralPublicKeyHex: string;
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Encrypts an API key directly to the Intel TDX enclave public key using X25519 ECDH + AES-256-GCM.
 * The plaintext key is never exposed outside the browser or to intermediate proxies.
 */
export function encryptPayloadToEnclave(plaintext: string, enclavePubKeyHex: string): EncryptedKeyEnvelope {
  // 1. Generate client ephemeral X25519 keypair
  const { secretKey, publicKey } = x25519.keygen();

  // 2. Perform ECDH key exchange with enclave's public key
  const peerEnclavePub = hexToBytes(enclavePubKeyHex);
  const sharedSecret = x25519.getSharedSecret(secretKey, peerEnclavePub);

  // 3. Derive 32-byte symmetric AES-256-GCM key via HKDF-SHA256
  const salt = new TextEncoder().encode("conpi-tee-v1-salt");
  const info = new TextEncoder().encode("conpi-client-to-enclave-encryption");
  const derivedKey = hkdf(sha256, sharedSecret, salt, info, 32);

  // 4. Encrypt with AES-256-GCM using a cryptographically random 12-byte IV
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const cipher = gcm(derivedKey, iv);
  const encodedPlaintext = new TextEncoder().encode(plaintext);
  const ciphertextWithTag = cipher.encrypt(encodedPlaintext);

  // Split ciphertext and 16-byte authentication tag
  const ciphertext = ciphertextWithTag.subarray(0, -16);
  const tag = ciphertextWithTag.subarray(-16);

  return {
    ephemeralPublicKeyHex: bytesToHex(publicKey),
    ivHex: bytesToHex(iv),
    ciphertextHex: bytesToHex(ciphertext),
    tagHex: bytesToHex(tag),
  };
}

export function encryptApiKeyToEnclave(apiKey: string, enclavePubKeyHex: string): EncryptedKeyEnvelope {
  return encryptPayloadToEnclave(apiKey.trim(), enclavePubKeyHex);
}
