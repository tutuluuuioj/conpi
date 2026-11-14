import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import * as qvl from "@phala/dcap-qvl";
import { BASE_URL, CONTRACT_ID } from "@/lib/chain";
import { callServerNearView } from "@/lib/server-near-rpc";

export const dynamic = "force-dynamic";

let cachedVerification: { data: any; timestamp: number } | null = null;
const CACHE_TTL_MS = 300_000; // 5 minutes

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const requestedNonce = searchParams.get("nonce");
    const force = searchParams.get("force") === "true";

    // Return cached verification if valid and no explicit nonce or force reload requested
    if (!requestedNonce && !force && cachedVerification && Date.now() - cachedVerification.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cachedVerification.data);
    }

    // 1. Generate or use fresh 16-byte nonce
    const nonceHex = requestedNonce || crypto.randomBytes(16).toString("hex");

    // 2. Fetch live attestation from Phala CVM
    const cvmRes = await fetch(`${BASE_URL}/attestation?nonce=${nonceHex}`, {
      cache: "no-store",
    });

    if (!cvmRes.ok) {
      return NextResponse.json(
        { verified: false, error: `Failed to fetch attestation from CVM (${cvmRes.status}): ${cvmRes.statusText}` },
        { status: 502 }
      );
    }

    const data = await cvmRes.json();
    const errors: string[] = [];

    const checks = {
      hardwareEnclave: false,
      intelQuoteVerified: false,
      reportDataMatchesHash: false,
      quoteReportDataMatches: false,
      rtmr3ReplayMatchesQuote: false,
      composeHashPresent: false,
      onChainSignerRegistered: false,
      onChainSignerActive: false,
      onChainMeasurementMatches: false,
    };

    // 3. Fail if inEnclave is false
    if (data.inEnclave === true) {
      checks.hardwareEnclave = true;
    } else {
      errors.push("Hardware TDX check failed: inEnclave is false (running in simulator or mock mode)");
    }

    // 4. Fail if compose hash is missing
    const composeHash = data.composeHash || "";
    if (composeHash && composeHash.length > 0) {
      checks.composeHashPresent = true;
    } else {
      errors.push("Compose hash is missing from attestation");
    }

    const signerPublicKeyNear = data.signerPublicKeyNear || "";
    const signerPublicKeyHex = data.signerPublicKeyHex || "";
    const encryptionPublicKeyHex = data.encryptionPublicKeyHex || "";
    const rawQuoteHex = data.rawQuoteHex || "";
    const eventLog = Array.isArray(data.eventLog) ? data.eventLog : [];

    let quoteMrtd = "";
    let quoteRtmr3 = "";
    let quoteReportData = "";

    // 5. Verify Intel quote signature chain with dcap-qvl & parse quote
    if (rawQuoteHex && rawQuoteHex.length >= 1264) {
      const quoteBytes = Buffer.from(rawQuoteHex, "hex");
      try {
        const verifiedReport = await qvl.getCollateralAndVerify(quoteBytes);
        if (verifiedReport && (verifiedReport.status === "UpToDate" || verifiedReport.status === "ConfigurationAndSWHardeningNeeded")) {
          checks.intelQuoteVerified = true;
        } else {
          errors.push(`Intel quote verification status: ${verifiedReport?.status || "Unknown"}`);
        }
      } catch (qErr: any) {
        errors.push(`Intel DCAP quote verification failed: ${qErr.message}`);
      }

      try {
        const parsed = qvl.Quote.parse(quoteBytes);
        if (parsed.report && parsed.report.data) {
          const repData: any = parsed.report.data;
          quoteMrtd = Buffer.from(repData.mrTd).toString("hex").toLowerCase();
          quoteRtmr3 = Buffer.from(repData.rtMr3).toString("hex").toLowerCase();
          quoteReportData = Buffer.from(repData.reportData).subarray(0, 32).toString("hex").toLowerCase();
        }
      } catch (parseErr: any) {
        errors.push(`Failed to parse TDX quote: ${parseErr.message}`);
      }
    } else {
      errors.push("Raw TDX quote missing or too short");
    }

    // 6. Expected report_data = sha256(ed25519 || x25519 || nonce)
    const ed25519Bytes = Buffer.from(signerPublicKeyHex, "hex");
    const x25519Bytes = Buffer.from(encryptionPublicKeyHex, "hex");
    const nonceBuf = Buffer.from(nonceHex, "hex");
    const expectedHashBytes = crypto
      .createHash("sha256")
      .update(Buffer.concat([ed25519Bytes, x25519Bytes, nonceBuf]))
      .digest();
    const expectedReportDataHex = expectedHashBytes.toString("hex").toLowerCase();
    const cvmReportDataHex = (data.reportDataHex || "").toLowerCase();

    if (cvmReportDataHex === expectedReportDataHex) {
      checks.reportDataMatchesHash = true;
    } else {
      errors.push(`CVM reportData mismatch: got ${cvmReportDataHex}, expected ${expectedReportDataHex}`);
    }

    if (quoteReportData && quoteReportData === expectedReportDataHex) {
      checks.quoteReportDataMatches = true;
    } else {
      errors.push(`Quote reportData at offset 568 mismatch: got ${quoteReportData}, expected ${expectedReportDataHex}`);
    }

    // 7. Replay RTMR3 from eventLog
    let replayedRtmr3 = "";
    if (eventLog.length > 0) {
      const imr3Events = eventLog.filter((e: any) => e.imr === 3);
      let mr = Buffer.alloc(48, 0);
      for (const e of imr3Events) {
        const payloadBuf = e.event_payload ? Buffer.from(e.event_payload, "hex") : Buffer.alloc(0);
        const typeBuf = Buffer.alloc(4);
        typeBuf.writeUInt32LE(e.event_type, 0);
        const digest = crypto
          .createHash("sha384")
          .update(Buffer.concat([typeBuf, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), payloadBuf]))
          .digest();
        mr = crypto.createHash("sha384").update(Buffer.concat([mr, digest])).digest();
      }
      replayedRtmr3 = mr.toString("hex").toLowerCase();

      if (quoteRtmr3 && replayedRtmr3 === quoteRtmr3) {
        checks.rtmr3ReplayMatchesQuote = true;
      } else {
        errors.push(`RTMR3 replay mismatch: replayed ${replayedRtmr3}, quote has ${quoteRtmr3}`);
      }
    } else {
      errors.push("Event log empty; cannot replay RTMR3");
    }

    // 8. Compare with on-chain get_tee_signer. Public testnet RPCs can
    // transiently rate-limit or return gateway errors, so do not turn one
    // failed response into a misleading "signer not registered" result.
    if (signerPublicKeyNear) {
      try {
        const signerData: any = await callServerNearView("get_tee_signer", {
          public_key: signerPublicKeyNear,
        });

        if (signerData) {

          checks.onChainSignerRegistered = true;
          if (signerData.active) {
            checks.onChainSignerActive = true;
          } else {
            errors.push(`TEE signer ${signerPublicKeyNear} is inactive on contract`);
          }

          const meas: string = signerData.measurement || "";
          const matchesMrtd = quoteMrtd && meas.includes(quoteMrtd);
          const matchesCompose = composeHash && meas.includes(composeHash);
          if (matchesMrtd && matchesCompose) {
            checks.onChainMeasurementMatches = true;
          } else {
            errors.push(`On-chain measurement mismatch with quote: expected mrtd:${quoteMrtd} and compose:${composeHash}, got: ${meas}`);
          }
        } else {
          errors.push(`Signer ${signerPublicKeyNear} is not registered on contract ${CONTRACT_ID}`);
        }
      } catch (chainErr: any) {
        errors.push(`On-chain TEE query failed: ${chainErr.message}`);
      }
    }

    const verified =
      checks.hardwareEnclave &&
      checks.intelQuoteVerified &&
      checks.reportDataMatchesHash &&
      checks.quoteReportDataMatches &&
      checks.rtmr3ReplayMatchesQuote &&
      checks.composeHashPresent &&
      checks.onChainSignerRegistered &&
      checks.onChainSignerActive &&
      checks.onChainMeasurementMatches &&
      errors.length === 0;

    const result = {
      verified,
      inEnclave: data.inEnclave,
      signerPublicKeyNear,
      encryptionPublicKeyHex,
      mrtd: quoteMrtd,
      composeHash,
      rtmr3Quote: quoteRtmr3,
      rtmr3Replayed: replayedRtmr3,
      nonce: nonceHex,
      reportDataHex: cvmReportDataHex,
      expectedReportDataHex,
      checks,
      errors,
    };

    if (!requestedNonce && verified) {
      cachedVerification = { data: result, timestamp: Date.now() };
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ verified: false, error: err.message }, { status: 500 });
  }
}
