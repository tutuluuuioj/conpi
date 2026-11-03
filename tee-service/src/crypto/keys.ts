import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";

class EnclaveKeyManager {
  private ed25519PrivKey: Uint8Array;
  public ed25519PubKey: Uint8Array;

  private x25519PrivKey: Uint8Array;
  public x25519PubKey: Uint8Array;

  constructor() {
    // Generate ephemeral keys in volatile enclave RAM
    // If a persistent seed is provided via environment (e.g. in tests/dev), we use it;
    // otherwise generate cryptographically secure random bytes in memory.
    if (process.env.ENCLAVE_SEED_HEX) {
      const seed = Buffer.from(process.env.ENCLAVE_SEED_HEX, "hex");
      this.ed25519PrivKey = seed.subarray(0, 32);
      this.x25519PrivKey = sha256(Buffer.concat([seed, Buffer.from("x25519")]));
    } else {
      this.ed25519PrivKey = ed25519.utils.randomPrivateKey();
      this.x25519PrivKey = x25519.utils.randomPrivateKey();
    }

    this.ed25519PubKey = ed25519.getPublicKey(this.ed25519PrivKey);
    this.x25519PubKey = x25519.getPublicKey(this.x25519PrivKey);
  }

  public getSignerPublicKeyNear(): string {
    return `ed25519:${bs58.encode(this.ed25519PubKey)}`;
  }

  public getSignerPublicKeyBytes(): Uint8Array {
    return this.ed25519PubKey;
  }

  public getEncryptionPublicKeyHex(): string {
    return Buffer.from(this.x25519PubKey).toString("hex");
  }

  public getEncryptionPublicKeyBytes(): Uint8Array {
    return this.x25519PubKey;
  }

  public sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.ed25519PrivKey);
  }

  public verify(message: Uint8Array, signature: Uint8Array, pubKey?: Uint8Array): boolean {
    return ed25519.verify(signature, message, pubKey || this.ed25519PubKey);
  }

  public deriveSharedSecret(peerPubKey: Uint8Array): Uint8Array {
    return x25519.getSharedSecret(this.x25519PrivKey, peerPubKey);
  }

  /**
   * Generates the 64-byte or 32-byte report_data for the Intel TDX quote.
   * Cryptographically binds both the Ed25519 signing key and X25519 encryption key.
   */
  public getReportData(): Uint8Array {
    const combined = Buffer.concat([this.ed25519PubKey, this.x25519PubKey]);
    return sha256(combined);
  }
}

export const enclaveKeys = new EnclaveKeyManager();
