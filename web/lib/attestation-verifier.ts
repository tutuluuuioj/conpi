import { BASE_URL } from "./chain";

export interface AttestationVerificationResult {
  verified: boolean;
  inEnclave: boolean;
  signerPublicKeyNear: string;
  mrtd: string;
  composeHash: string;
  rtmr3Quote: string;
  rtmr3Replayed: string;
  nonce: string;
  reportDataHex: string;
  expectedReportDataHex: string;
  checks: {
    hardwareEnclave: boolean;
    intelQuoteVerified: boolean;
    reportDataMatchesHash: boolean;
    quoteReportDataMatches: boolean;
    rtmr3ReplayMatchesQuote: boolean;
    composeHashPresent: boolean;
    onChainSignerRegistered: boolean;
    onChainSignerActive: boolean;
    onChainMeasurementMatches: boolean;
  };
  errors: string[];
}

export async function verifyLiveAttestation(cvmBaseUrl = BASE_URL): Promise<AttestationVerificationResult> {
  // Generate random 16-byte nonce
  const nonceBytes = new Uint8Array(16);
  if (typeof window !== "undefined" && window.crypto) {
    window.crypto.getRandomValues(nonceBytes);
  } else {
    for (let i = 0; i < 16; i++) nonceBytes[i] = Math.floor(Math.random() * 256);
  }
  const nonceHex = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Query server-side verification endpoint
  const url = typeof window !== "undefined" ? `/api/verify-attestation?nonce=${nonceHex}` : `${cvmBaseUrl}/attestation?nonce=${nonceHex}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to verify attestation (${res.status}): ${res.statusText}`);
  }

  const result: AttestationVerificationResult = await res.json();
  return result;
}
