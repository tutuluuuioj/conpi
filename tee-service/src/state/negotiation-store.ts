import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";
import type { TicketState } from "../negotiation/matcher.js";

interface StoredNegotiationState {
  version: 1;
  ticket: TicketState;
}

class NegotiationStateStore {
  private ticketKey(ticketId: string): string {
    return crypto.createHash("sha256").update(ticketId, "utf8").digest("hex");
  }

  private statePath(ticketId: string): string {
    return path.join(CONFIG.meteringStateDir, `ticket-${this.ticketKey(ticketId)}.state`);
  }

  private aad(ticketId: string): Buffer {
    return Buffer.from(`conpi:negotiation-state:v1:${ticketId}`, "utf8");
  }

  private ensureDirectory(): void {
    fs.mkdirSync(CONFIG.meteringStateDir, { recursive: true, mode: 0o700 });
  }

  public save(ticket: TicketState): void {
    this.ensureDirectory();
    const state: StoredNegotiationState = { version: 1, ticket };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", enclaveKeys.getStateStorageKeyBytes(), iv);
    cipher.setAAD(this.aad(ticket.ticketId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const destination = this.statePath(ticket.ticketId);
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, envelope, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
    const dirFd = fs.openSync(CONFIG.meteringStateDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }

  public load(ticketId: string): TicketState | null {
    const filename = this.statePath(ticketId);
    if (!fs.existsSync(filename)) return null;
    try {
      const envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (envelope?.version !== 1) throw new Error("unsupported state version");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        enclaveKeys.getStateStorageKeyBytes(),
        Buffer.from(envelope.iv, "base64")
      );
      decipher.setAAD(this.aad(ticketId));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      const state = JSON.parse(plaintext.toString("utf8")) as StoredNegotiationState;
      const ticket = state?.ticket;
      if (
        state?.version !== 1 ||
        !ticket ||
        ticket.ticketId !== ticketId ||
        !Number.isSafeInteger(ticket.dealId) ||
        ticket.dealId <= 0 ||
        typeof ticket.buyer !== "string" ||
        typeof ticket.seller !== "string" ||
        !Array.isArray(ticket.messages)
      ) {
        throw new Error("stored ticket identity is malformed");
      }
      if (ticket.onChainTermsHashHex && !/^[0-9a-f]{64}$/.test(ticket.onChainTermsHashHex)) {
        throw new Error("stored on-chain terms hash is malformed");
      }
      if (ticket.termsHashHex && !/^[0-9a-f]{64}$/.test(ticket.termsHashHex)) {
        throw new Error("stored matched terms hash is malformed");
      }
      return ticket;
    } catch (error: any) {
      throw new Error(`Encrypted negotiation state for ticket ${ticketId} failed authentication: ${error.message}`);
    }
  }
}

export const negotiationStateStore = new NegotiationStateStore();
