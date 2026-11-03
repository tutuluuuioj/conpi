import fs from "fs";
import { DstackClient } from "@phala/dstack-sdk";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";

export interface AttestationResult {
  inEnclave: boolean;
  provider: string;
  mrtd: string;
  rtmr3?: string;
  composeHash?: string;
  signerPublicKeyNear: string;
  signerPublicKeyHex: string;
  encryptionPublicKeyHex: string;
  reportDataHex: string;
  nonce: string | null;
  rawQuoteHex: string | null;
  timestamp: string;
}

function findDstackSocket(): string | null {
  const candidatePaths = [
    CONFIG.dstackSocketPath,
    "/var/run/dstack.sock",
    "/run/dstack.sock",
    "/var/run/dstack/dstack.sock",
    "/run/dstack/dstack.sock",
  ].filter(Boolean) as string[];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isSocket()) {
          return p;
        }
      }
    } catch {}
  }
  return null;
}

export class AttestationService {
  private client: DstackClient | null = null;
  private mrtd: string = CONFIG.mrtd;
  private rtmr3: string = "";
  private composeHash: string = "";

  constructor() {}

  public async init(): Promise<void> {
    const socketPath = findDstackSocket();
    if (socketPath || process.env.DSTACK_SIMULATOR_ENDPOINT) {
      try {
        this.client = new DstackClient(socketPath || undefined);
        console.log(`[Attestation] Connected to dstack socket at ${socketPath || "simulator"}`);
        try {
          const info = await this.client.info();
          if (info) {
            if ((info as any).mrtd) this.mrtd = (info as any).mrtd;
            if ((info as any).rtmr3) this.rtmr3 = (info as any).rtmr3;
            if ((info as any).compose_hash) this.composeHash = (info as any).compose_hash;
          }
        } catch (e) {
          console.warn("[Attestation] Could not fetch dstack info on startup:", e);
        }
      } catch (err) {
        console.warn(`[Attestation] Could not connect to dstack socket:`, err);
      }
    }
  }

  public async getAttestation(nonce?: string): Promise<AttestationResult> {
    const reportData = enclaveKeys.getReportData(nonce);
    const reportDataHex = Buffer.from(reportData).toString("hex");
    let rawQuoteHex: string | null = null;
    let inEnclave = false;

    if (this.client) {
      try {
        // Dynamic fresh TDX quote query binding reportData (sha256(ed25519PubKey + x25519PubKey + nonce))
        const quoteRes = await this.client.getQuote(reportDataHex);
        rawQuoteHex = quoteRes.quote;
        inEnclave = true;
      } catch (err) {
        console.warn("[Attestation] Live TDX quote socket request failed:", err);
      }
    }

    if (!inEnclave && process.env.NODE_ENV !== "test") {
      throw new Error(
        "Hardware TDX attestation required: simulator/mock fallback is disabled outside test mode (NODE_ENV !== 'test')"
      );
    }

    return {
      inEnclave,
      provider: inEnclave ? "Intel TDX (Phala dstack CVM)" : "Conpi Enclave Simulator (Dev/Testnet)",
      mrtd: this.mrtd,
      rtmr3: this.rtmr3 || undefined,
      composeHash: this.composeHash || undefined,
      signerPublicKeyNear: enclaveKeys.getSignerPublicKeyNear(),
      signerPublicKeyHex: Buffer.from(enclaveKeys.getSignerPublicKeyBytes()).toString("hex"),
      encryptionPublicKeyHex: enclaveKeys.getEncryptionPublicKeyHex(),
      reportDataHex,
      nonce: nonce || null,
      rawQuoteHex,
      timestamp: new Date().toISOString(),
    };
  }

  public async getRawQuote(nonce?: string): Promise<Buffer | null> {
    const att = await this.getAttestation(nonce);
    if (!att.rawQuoteHex) return null;
    return Buffer.from(att.rawQuoteHex, "hex");
  }
}

export const attestationService = new AttestationService();
