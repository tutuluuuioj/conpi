"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle, RefreshCw, Loader2, Download } from "lucide-react";
import { CODE_HASH, CONTRACT_ID, DAO_ID, MEMBERS, explorerAccount } from "@/lib/chain";
import { useApp } from "@/lib/store";
import { verifyLiveAttestation, AttestationVerificationResult } from "@/lib/attestation-verifier";
import { Badge, Card, HashChip, Overline, Button } from "./ui";

export function TrustView() {
  const app = useApp();
  const [result, setResult] = useState<AttestationVerificationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reverifying, setReverifying] = useState(false);

  const runVerification = async () => {
    try {
      setReverifying(true);
      const res = await verifyLiveAttestation();
      setResult(res);
    } catch (err: any) {
      console.warn("Live attestation verification error:", err);
    } finally {
      setLoading(false);
      setReverifying(false);
    }
  };

  useEffect(() => {
    runVerification();
  }, []);

  const isVerified = result?.verified === true;
  const activeSigner = result?.signerPublicKeyNear || "Querying TEE enclave...";
  const activeMrtd = result?.mrtd || "Querying MRTD measurement...";
  const activeCompose = result?.composeHash || "Querying compose hash...";
  const activeNonce = result?.nonce || "None";
  const activeReportData = result?.reportDataHex || "None";
  const expectedReportData = result?.expectedReportDataHex || "None";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Trust & Remote Attestation</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            The Intel TDX Confidential VM isolates provider API keys, meters usage, and signs on-chain settlements. Remote attestation cryptographically proves the volatile runtime state.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={reverifying}
          icon={reverifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          onClick={runVerification}
        >
          {reverifying ? "Verifying fresh nonce..." : "Re-verify Attestation"}
        </Button>
      </div>

      {/* Main Status Card */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {isVerified ? (
              <ShieldCheck className="h-6 w-6 text-mint" />
            ) : (
              <ShieldAlert className="h-6 w-6 text-danger" />
            )}
            <div>
              <h2 className="text-lg font-semibold">Phala Intel TDX Remote Attestation</h2>
              <p className="text-xs text-muted">Enclave instance bound with fresh nonce & SHA-256 report_data</p>
            </div>
          </div>
          <Badge tone={isVerified ? "mint" : "danger"}>
            {loading ? "Verifying..." : isVerified ? "Cryptographically Verified (100%)" : "Verification Failed"}
          </Badge>
        </div>

        {/* 9 Verification Checks Grid */}
        <div className="mt-6 rounded-lg border border-line bg-surface-2/60 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Cryptographic Proof Checklist</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-2 text-sm">
              {result?.checks.hardwareEnclave ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">1. Intel TDX Hardware Enclave</span>
                <p className="text-xs text-muted">inEnclave: true (genuine Intel TDX CVM on Phala)</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.intelQuoteVerified ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">2. Intel DCAP Quote Verified</span>
                <p className="text-xs text-muted">dcap-qvl signature chain & TCB UpToDate verified</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.reportDataMatchesHash ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">3. sha256(ed25519 ‖ x25519 ‖ nonce)</span>
                <p className="text-xs text-muted">Cryptographic binding to fresh nonce {activeNonce.slice(0, 8)}...</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.quoteReportDataMatches ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">4. Raw TDX Quote Report Data</span>
                <p className="text-xs text-muted">32-byte binary match at hardware offset 568</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.rtmr3ReplayMatchesQuote ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">5. RTMR3 Event Log Replay Match</span>
                <p className="text-xs font-mono text-muted truncate max-w-[280px]">
                  {result?.rtmr3Replayed ? `${result.rtmr3Replayed.slice(0, 16)}...` : "Replaying..."}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.composeHashPresent ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">6. Compose Hash Measured</span>
                <p className="text-xs font-mono text-muted truncate max-w-[280px]">{activeCompose.slice(0, 16)}...</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.onChainSignerRegistered ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">7. Registered on Escrow Contract</span>
                <p className="text-xs text-muted">Verified via get_tee_signer RPC view</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm">
              {result?.checks.onChainSignerActive ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">8. Signer Active & Authorized</span>
                <p className="text-xs text-muted">active: true on NEAR escrow state</p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-sm sm:col-span-2">
              {result?.checks.onChainMeasurementMatches ? (
                <CheckCircle2 className="h-4 w-4 text-mint shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-medium text-ink">9. On-Chain Measurement Match (MRTD + Compose)</span>
                <p className="text-xs text-muted">MRTD from quote and Compose Hash match contract record</p>
              </div>
            </div>
          </div>
        </div>

        {/* Enclave Keys & Hashes */}
        <dl className="mt-6 grid gap-4 text-sm md:grid-cols-2">
          <div>
            <dt className="text-muted">In-Enclave Ed25519 Signer Public Key</dt>
            <dd className="mt-2"><HashChip value={activeSigner} onCopy={app.copy} /></dd>
          </div>
          <div>
            <dt className="text-muted">Measured Compose Hash (IMR 3)</dt>
            <dd className="mt-2"><HashChip value={activeCompose} onCopy={app.copy} /></dd>
          </div>
          <div>
            <dt className="text-muted">Hardware Report Data (SHA-256)</dt>
            <dd className="mt-2 break-all font-mono text-[12px] text-muted">{activeReportData}</dd>
          </div>
          <div>
            <dt className="text-muted">Expected Computed SHA-256</dt>
            <dd className="mt-2 break-all font-mono text-[12px] text-muted">{expectedReportData}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-muted">Measurement (MRTD)</dt>
            <dd className="mt-2 break-all font-mono text-[13px]">{activeMrtd}</dd>
          </div>
        </dl>
      </Card>

      {/* Contract & DAO cards */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Overline>Remote Attestation Quote Download</Overline>
          <p className="mt-3 text-sm text-muted">
            Raw Intel TDX Quote generated by the Intel TDX Quote Generation Service (QGS). The quote is bound directly to the hardware report_data.
          </p>
          <a
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm font-semibold text-brand hover:bg-surface-2/80"
            href={`data:application/json,${encodeURIComponent(JSON.stringify(result || {}, null, 2))}`}
            download="conpi-hardware-attestation.json"
          >
            <Download className="h-4 w-4" /> Download Attestation Verification Report
          </a>
        </Card>

        <Card id="verify">
          <Overline>Escrow Contract (NEAR Testnet)</Overline>
          <div className="mt-3 space-y-3">
            <HashChip value={CONTRACT_ID} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} />
            <div>
              <div className="text-xs text-muted">Code Hash (Reproducible WASM)</div>
              <div className="mt-1"><HashChip value={CODE_HASH} href={explorerAccount(CONTRACT_ID)} onCopy={app.copy} /></div>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <Overline>Multisig DAO Governance Owner</Overline>
        <p className="mt-2 text-sm">Account: {DAO_ID} · 2-of-3 Quorum · 5-minute Timelock</p>
        <ul className="mt-3 divide-y divide-line text-sm">
          {MEMBERS.map((member) => (
            <li key={member.account} className="flex justify-between py-2">
              <span className="font-mono">{member.account}</span>
              <span className="text-muted">{member.role}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
