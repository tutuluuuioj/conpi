import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";
import type { SellerKeyAuthorization } from "./seller-key.js";

interface StoredNonce {
  hash: string;
  expiresAtMs: number;
}

interface StoredNonceState {
  version: 1;
  nonces: StoredNonce[];
}

class SellerAuthorizationNonceStore {
  private statePath(): string {
    return path.join(CONFIG.meteringStateDir, "seller-authorization-nonces.state");
  }

  private aad(): Buffer {
    return Buffer.from("conpi:seller-authorization-nonces:v1", "utf8");
  }

  private fingerprint(auth: SellerKeyAuthorization): string {
    return crypto
      .createHash("sha256")
      .update(`${auth.chain}\0${auth.address.trim().toLowerCase()}\0${auth.nonce}`)
      .digest("hex");
  }

  private load(): StoredNonceState {
    const filename = this.statePath();
    if (!fs.existsSync(filename)) return { version: 1, nonces: [] };
    try {
      const envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (envelope?.version !== 1) throw new Error("unsupported state version");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        enclaveKeys.getStateStorageKeyBytes(),
        Buffer.from(envelope.iv, "base64")
      );
      decipher.setAAD(this.aad());
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const state = JSON.parse(plaintext.toString("utf8"));
      if (state?.version !== 1 || !Array.isArray(state.nonces)) throw new Error("malformed nonce state");
      return state;
    } catch (error: any) {
      throw new Error(`Seller authorization nonce state failed authentication: ${error.message}`);
    }
  }

  private save(state: StoredNonceState): void {
    fs.mkdirSync(CONFIG.meteringStateDir, { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", enclaveKeys.getStateStorageKeyBytes(), iv);
    cipher.setAAD(this.aad());
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const destination = this.statePath();
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, envelope, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
  }

  public consume(auth: SellerKeyAuthorization, nowMs: number): void {
    const state = this.load();
    const hash = this.fingerprint(auth);
    const unexpired = state.nonces.filter((item) => item.expiresAtMs >= nowMs);
    if (unexpired.some((item) => item.hash === hash)) {
      throw new Error("Seller authorization nonce has already been used");
    }
    unexpired.push({ hash, expiresAtMs: auth.issuedAtMs + 5 * 60_000 });
    this.save({ version: 1, nonces: unexpired });
  }
}

export const sellerAuthorizationNonceStore = new SellerAuthorizationNonceStore();
