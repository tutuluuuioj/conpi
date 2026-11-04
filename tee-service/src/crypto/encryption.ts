import crypto from "crypto";
import { x25519 } from "@noble/curves/ed25519";
import { enclaveKeys } from "./keys.js";

export interface EncryptedEnvelope {
  ephemeralPublicKeyHex: string;
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
}

/**
 * Derives a 32-byte symmetric key from an X25519 shared secret using HKDF-SHA256.
 */
function deriveKey(sharedSecret: Uint8Array): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(sharedSecret),
      Buffer.from("conpi-tee-v1-salt"),
      Buffer.from("conpi-client-to-enclave-encryption"),
      32
    )
  );
}

/**
 * Decrypts an encrypted payload received from a client using the enclave's in-memory X25519 private key.
 */
export function decryptFromClient(envelope: EncryptedEnvelope): string {
  const peerPubKey = Buffer.from(envelope.ephemeralPublicKeyHex, "hex");
  const iv = Buffer.from(envelope.ivHex, "hex");
  const ciphertext = Buffer.from(envelope.ciphertextHex, "hex");
  const tag = Buffer.from(envelope.tagHex, "hex");

  const sharedSecret = enclaveKeys.deriveSharedSecret(peerPubKey);
  const key = deriveKey(sharedSecret);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, undefined, "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Encrypts a plaintext payload to the enclave's X25519 public key.
 * Used by clients / frontend or in integration tests.
 */
export function encryptToEnclave(plaintext: string, enclavePubKeyHex: string): EncryptedEnvelope {
  // Generate ephemeral client keypair
  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);

  const enclavePub = Buffer.from(enclavePubKeyHex, "hex");
  const sharedSecret = x25519.getSharedSecret(ephemeralPriv, enclavePub);
  const key = deriveKey(sharedSecret);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let ciphertext = cipher.update(plaintext, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return {
    ephemeralPublicKeyHex: Buffer.from(ephemeralPub).toString("hex"),
    ivHex: iv.toString("hex"),
    ciphertextHex: ciphertext,
    tagHex: tag,
  };
}
