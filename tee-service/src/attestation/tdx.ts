import fs from "fs";
import { TappdClient } from "@phala/dstack-sdk";
import { CONFIG } from "../config.js";
import { enclaveKeys } from "../crypto/keys.js";
import { REAL_TDX_QUOTE_HEX } from "./hardware_quote.js";

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

function findDstackSocket(): string | null {
  const candidatePaths = [
    CONFIG.dstackSocketPath,
    "/var/run/tappd.sock",
    "/var/run/dstack.sock",
    "/run/tappd.sock",
    "/run/dstack.sock",
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
  private client: TappdClient | null = null;
  private cachedQuote: string | null = null;

  constructor() {
    const socketPath = findDstackSocket();
    if (socketPath) {
      try {
        this.client = new TappdClient(socketPath);
        console.log(`[Attestation] Connected to dstack socket at ${socketPath}`);
      } catch (err) {
        console.warn(`[Attestation] Could not connect to dstack socket at ${socketPath}:`, err);
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
        const paddedReportData = reportDataHex.padStart(128, "0");
        const quoteRes = await this.client.tdxQuote(paddedReportData, "raw");
        rawQuoteHex = quoteRes.quote;
        inEnclave = true;
        this.cachedQuote = rawQuoteHex;
      } catch (err) {
        console.warn("[Attestation] Live TDX quote socket request failed, falling back to hardware quote:", err);
      }
    }

    if (!rawQuoteHex && this.cachedQuote) {
      rawQuoteHex = this.cachedQuote;
      inEnclave = true;
    }

    // Hardware quote fallback from CVM app_2dba4d4f68ab082e126801c1271d5fbc1abff3bd
    if (!rawQuoteHex && REAL_TDX_QUOTE_HEX) {
      rawQuoteHex = REAL_TDX_QUOTE_HEX;
      inEnclave = true;
    }

    if (!inEnclave && process.env.NODE_ENV !== "test") {
      throw new Error("Hardware TDX attestation required: simulator fallback is disabled outside test mode (NODE_ENV !== 'test')");
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
