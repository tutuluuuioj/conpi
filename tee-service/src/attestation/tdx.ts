import fs from "fs";
import { TappdClient } from "@phala/dstack-sdk";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";

export interface AttestationResult {
  inEnclave: boolean;
  provider: string;
  mrtd: string;
  signerPublicKeyNear: string;
  signerPublicKeyHex: string;
  encryptionPublicKeyHex: string;
  reportDataHex: string;
  rawQuoteHex: string | null;
  timestamp: string;
}

export class AttestationService {
  private client: TappdClient | null = null;
  private cachedQuote: string | null = null;

  constructor() {
    if (fs.existsSync(CONFIG.dstackSocketPath)) {
      try {
        this.client = new TappdClient(CONFIG.dstackSocketPath);
      } catch (err) {
        console.warn(`[Attestation] Could not connect to dstack socket at ${CONFIG.dstackSocketPath}:`, err);
      }
    }
  }

  public async getAttestation(): Promise<AttestationResult> {
    const reportData = enclaveKeys.getReportData();
    const reportDataHex = Buffer.from(reportData).toString("hex");
    let rawQuoteHex: string | null = null;
    let inEnclave = false;

    if (this.client) {
      try {
        const quoteRes = await this.client.tdxQuote(reportData);
        rawQuoteHex = quoteRes.quote;
        inEnclave = true;
        this.cachedQuote = rawQuoteHex;
      } catch (err) {
        console.warn("[Attestation] Real TDX quote request failed, using cached/emulated fallback:", err);
      }
    }

    if (!rawQuoteHex && this.cachedQuote) {
      rawQuoteHex = this.cachedQuote;
    }

    return {
      inEnclave,
      provider: inEnclave ? "Intel TDX (Phala dstack CVM)" : "Conpi Enclave Simulator (Dev/Testnet)",
      mrtd: CONFIG.mrtd,
      signerPublicKeyNear: enclaveKeys.getSignerPublicKeyNear(),
      signerPublicKeyHex: Buffer.from(enclaveKeys.getSignerPublicKeyBytes()).toString("hex"),
      encryptionPublicKeyHex: enclaveKeys.getEncryptionPublicKeyHex(),
      reportDataHex,
      rawQuoteHex,
      timestamp: new Date().toISOString(),
    };
  }

  public async getRawQuote(): Promise<Buffer | null> {
    const att = await this.getAttestation();
    if (att.rawQuoteHex) {
      return Buffer.from(att.rawQuoteHex, "hex");
    }
    return null;
  }
}

export const attestationService = new AttestationService();
