import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import fs from "fs";
import { DstackClient } from "@phala/dstack-sdk";

export class EnclaveKeyManager {
  private ed25519PrivKey!: Uint8Array;
  public ed25519PubKey!: Uint8Array;

  private x25519PrivKey!: Uint8Array;
  public x25519PubKey!: Uint8Array;

  private stateStorageKey!: Uint8Array;

  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {}

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const socketPaths = [
        "/var/run/dstack.sock",
        "/run/dstack.sock",
        "/var/run/dstack/dstack.sock",
        "/run/dstack/dstack.sock",
      ];
      const reachableSocket = socketPaths.find((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isSocket();
        } catch {
          return false;
        }
      });

      if (reachableSocket || process.env.DSTACK_SIMULATOR_ENDPOINT) {
        try {
          const client = new DstackClient(reachableSocket);
          console.log(`[Keys] Connecting to dstack at ${reachableSocket || "simulator"} to derive keys...`);
          const signerRes = await client.getKey("conpi/signer/v1");
          this.ed25519PrivKey = signerRes.key.subarray(0, 32);

          const encRes = await client.getKey("conpi/encryption/v1");
          this.x25519PrivKey = encRes.key.subarray(0, 32);
          const stateRes = await client.getKey("conpi/metering-state/v1");
          this.stateStorageKey = stateRes.key.subarray(0, 32);
          console.log(`[Keys] In-enclave hardware key derivation successful!`);
        } catch (err: any) {
          if (process.env.NODE_ENV === "test") {
            console.warn(`[Keys] Hardware key derivation failed in test mode, using ephemeral test keys: ${err.message}`);
            this.ed25519PrivKey = ed25519.utils.randomPrivateKey();
            this.x25519PrivKey = x25519.utils.randomPrivateKey();
            this.stateStorageKey = ed25519.utils.randomPrivateKey();
          } else {
            throw new Error(`Failed to derive hardware keys via dstack: ${err.message}`);
          }
        }
      } else if (process.env.NODE_ENV === "test") {
        // Ephemeral random keys strictly for unit tests in non-TEE local test environment
        this.ed25519PrivKey = ed25519.utils.randomPrivateKey();
        this.x25519PrivKey = x25519.utils.randomPrivateKey();
        this.stateStorageKey = ed25519.utils.randomPrivateKey();
      } else {
        throw new Error(
          "Dstack hardware environment required: /var/run/dstack.sock not reachable outside test mode (NODE_ENV !== 'test'). No fallback seeds permitted."
        );
      }

      this.ed25519PubKey = ed25519.getPublicKey(this.ed25519PrivKey);
      this.x25519PubKey = x25519.getPublicKey(this.x25519PrivKey);
      this.initialized = true;
    })();

    await this.initPromise;
  }

  private ensureInit() {
    if (!this.initialized) {
      if (process.env.NODE_ENV === "test") {
        this.ed25519PrivKey = ed25519.utils.randomPrivateKey();
        this.x25519PrivKey = x25519.utils.randomPrivateKey();
        this.ed25519PubKey = ed25519.getPublicKey(this.ed25519PrivKey);
        this.x25519PubKey = x25519.getPublicKey(this.x25519PrivKey);
        this.stateStorageKey = ed25519.utils.randomPrivateKey();
        this.initialized = true;
        return;
      }
      throw new Error("EnclaveKeyManager has not been initialized. Call await enclaveKeys.init() first.");
    }
  }

  public getSignerPublicKeyNear(): string {
    this.ensureInit();
    return `ed25519:${bs58.encode(this.ed25519PubKey)}`;
  }

  public getSignerPublicKeyBytes(): Uint8Array {
    this.ensureInit();
    return this.ed25519PubKey;
  }

  public getEncryptionPublicKeyHex(): string {
    this.ensureInit();
    return Buffer.from(this.x25519PubKey).toString("hex");
  }

  public getEncryptionPublicKeyBytes(): Uint8Array {
    this.ensureInit();
    return this.x25519PubKey;
  }

  public getStateStorageKeyBytes(): Uint8Array {
    this.ensureInit();
    return Uint8Array.from(this.stateStorageKey);
  }

  public sign(message: Uint8Array): Uint8Array {
    this.ensureInit();
    return ed25519.sign(message, this.ed25519PrivKey);
  }

  public verify(message: Uint8Array, signature: Uint8Array, pubKey?: Uint8Array): boolean {
    this.ensureInit();
    return ed25519.verify(signature, message, pubKey || this.ed25519PubKey);
  }

  public deriveSharedSecret(peerPubKey: Uint8Array): Uint8Array {
    this.ensureInit();
    return x25519.getSharedSecret(this.x25519PrivKey, peerPubKey);
  }

  /**
   * Generates the 32-byte report_data for the Intel TDX quote.
   * Cryptographically binds both the Ed25519 signing key, X25519 encryption key,
   * and optional client-provided challenge nonce: sha256(ed25519PubKey || x25519PubKey || nonce).
   */
  public getReportData(nonce?: string | Uint8Array): Uint8Array {
    this.ensureInit();
    let nonceBuf = Buffer.alloc(0);
    if (typeof nonce === "string" && nonce.length > 0) {
      nonceBuf = /^[0-9a-fA-F]+$/.test(nonce) ? Buffer.from(nonce, "hex") : Buffer.from(nonce, "utf-8");
    } else if (nonce instanceof Uint8Array) {
      nonceBuf = Buffer.from(nonce);
    }
    const combined = Buffer.concat([this.ed25519PubKey, this.x25519PubKey, nonceBuf]);
    return sha256(combined);
  }
}

export const enclaveKeys = new EnclaveKeyManager();
