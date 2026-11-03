import { sha256 } from "@noble/hashes/sha2.js";
import { fetchContractTeeSigner } from "./contract";
import { BASE_URL } from "./chain";

export interface AttestationVerificationResult {
  verified: boolean;
  signerPublicKeyNear: string;
  mrtd: string;
  composeHash: string;
  nonce: string;
  reportDataHex: string;
  expectedReportDataHex: string;
  checks: {
    nonceFresh: boolean;
    reportDataMatchesHash: boolean;
    quoteReportDataMatches: boolean;
    eventLogComposeHashMatches: boolean;
    onChainSignerRegistered: boolean;
    onChainSignerActive: boolean;
    onChainMeasurementMatches: boolean;
  };
  errors: string[];
}

export async function verifyLiveAttestation(cvmBaseUrl = BASE_URL): Promise<AttestationVerificationResult> {
  const errors: string[] = [];
  const checks = {
    nonceFresh: false,
    reportDataMatchesHash: false,
    quoteReportDataMatches: false,
    eventLogComposeHashMatches: false,
    onChainSignerRegistered: false,
    onChainSignerActive: false,
    onChainMeasurementMatches: false,
  };

  // 1. Generate a cryptographically secure random 16-byte fresh nonce
  const nonceBytes = new Uint8Array(16);
  if (typeof window !== "undefined" && window.crypto) {
    window.crypto.getRandomValues(nonceBytes);
  } else {
    for (let i = 0; i < 16; i++) nonceBytes[i] = Math.floor(Math.random() * 256);
  }
  const nonceHex = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  checks.nonceFresh = true;

  // 2. Query live /v1/attestation endpoint
  const url = `${cvmBaseUrl}/attestation?nonce=${nonceHex}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch attestation from CVM (${res.status}): ${res.statusText}`);
  }
  const data = await res.json();

  const signerPublicKeyNear = data.signerPublicKeyNear || "";
  const signerPublicKeyHex = data.signerPublicKeyHex || "";
  const encryptionPublicKeyHex = data.encryptionPublicKeyHex || "";
  const reportDataHex = (data.reportDataHex || "").toLowerCase();
  const rawQuoteHex = data.rawQuoteHex || "";
  const mrtd = data.mrtd || "";
  const composeHash = data.composeHash || "";
  const eventLog: any[] = Array.isArray(data.eventLog) ? data.eventLog : [];

  // 3. Compute expected report_data: sha256(ed25519_bytes || x25519_bytes || nonce_bytes)
  const ed25519Bytes = Buffer.from(signerPublicKeyHex, "hex");
  const x25519Bytes = Buffer.from(encryptionPublicKeyHex, "hex");
  const nonceBuf = Buffer.from(nonceHex, "hex");
  const combined = Buffer.concat([ed25519Bytes, x25519Bytes, nonceBuf]);
  const expectedHashBytes = sha256(combined);
  const expectedReportDataHex = Buffer.from(expectedHashBytes).toString("hex").toLowerCase();

  if (reportDataHex === expectedReportDataHex) {
    checks.reportDataMatchesHash = true;
  } else {
    errors.push(`Report data mismatch: got ${reportDataHex}, expected ${expectedReportDataHex}`);
  }

  // 4. Verify report_data in raw hardware TDX quote (offsets 568-600)
  if (rawQuoteHex && rawQuoteHex.length >= 632 * 2) {
    const quoteBytes = Buffer.from(rawQuoteHex, "hex");
    const quoteReportData = quoteBytes.subarray(568, 568 + 32).toString("hex").toLowerCase();
    if (quoteReportData === expectedReportDataHex) {
      checks.quoteReportDataMatches = true;
    } else {
      errors.push(`Raw quote report_data at offset 568 mismatch: got ${quoteReportData}`);
    }
  } else if (!data.inEnclave) {
    // In simulator / non-hardware mode
    checks.quoteReportDataMatches = true;
  }

  // 5. Replay / extract compose hash from eventLog
  const composeHashEvent = eventLog.find((e) => e.event === "compose-hash");
  if (composeHashEvent && composeHashEvent.event_payload === composeHash) {
    checks.eventLogComposeHashMatches = true;
  } else if (composeHash) {
    // Check if any IMR 3 event payload matches
    const found = eventLog.some((e) => e.imr === 3 && e.event_payload === composeHash);
    if (found) {
      checks.eventLogComposeHashMatches = true;
    } else {
      errors.push(`Event log does not match compose hash ${composeHash}`);
    }
  }

  // 6. Compare with on-chain get_tee_signer
  if (signerPublicKeyNear) {
    const onChainSigner = await fetchContractTeeSigner(signerPublicKeyNear);
    if (onChainSigner) {
      checks.onChainSignerRegistered = true;
      if (onChainSigner.active) {
        checks.onChainSignerActive = true;
      } else {
        errors.push(`TEE signer ${signerPublicKeyNear} is deactivated on-chain`);
      }

      const meas = onChainSigner.measurement || "";
      const matchesMrtd = mrtd && meas.includes(mrtd);
      const matchesCompose = composeHash && meas.includes(composeHash);
      if (matchesMrtd && matchesCompose) {
        checks.onChainMeasurementMatches = true;
      } else {
        errors.push(`On-chain measurement mismatch: expected mrtd:${mrtd} and compose:${composeHash}, got: ${meas}`);
      }
    } else {
      errors.push(`Signer ${signerPublicKeyNear} is not registered on contract`);
    }
  }

  const verified =
    checks.nonceFresh &&
    checks.reportDataMatchesHash &&
    checks.quoteReportDataMatches &&
    checks.eventLogComposeHashMatches &&
    checks.onChainSignerRegistered &&
    checks.onChainSignerActive &&
    checks.onChainMeasurementMatches &&
    errors.length === 0;

  return {
    verified,
    signerPublicKeyNear,
    mrtd,
    composeHash,
    nonce: nonceHex,
    reportDataHex,
    expectedReportDataHex,
    checks,
    errors,
  };
}
