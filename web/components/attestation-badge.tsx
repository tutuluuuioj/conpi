"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { verifyLiveAttestation, AttestationVerificationResult } from "@/lib/attestation-verifier";

export function AttestationBadge({ showLink = true }: { showLink?: boolean }) {
  // Keep the server render and the browser's first render identical. Reading
  // sessionStorage in a state initializer made a returning browser render the
  // cached badge while the server rendered "Verifying TEE...", which caused a
  // hydration failure across every page containing the header.
  const [result, setResult] = useState<AttestationVerificationResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    try {
      const cached = sessionStorage.getItem("conpi:attestation_badge");
      if (cached) {
        setResult(JSON.parse(cached));
        setLoading(false);
      }
    } catch {}

    verifyLiveAttestation()
      .then((res) => {
        if (mounted) {
          setResult(res);
          setLoading(false);
          try {
            sessionStorage.setItem("conpi:attestation_badge", JSON.stringify(res));
          } catch {}
        }
      })
      .catch((err) => {
        console.warn("Attestation badge verify error:", err);
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        Verifying TEE...
      </span>
    );
  }

  const isVerified = result?.verified === true;

  const badgeContent = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold border transition-colors ${
        isVerified
          ? "border-mint/30 bg-mint/10 text-mint hover:bg-mint/20"
          : "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20"
      }`}
      title={
        isVerified
          ? `Verified Intel TDX Quote bound to fresh nonce: ${result?.nonce?.slice(0, 8)}...`
          : `Attestation verification failed: ${result?.errors?.join("; ") || "Could not verify hardware attestation"}`
      }
    >
      {isVerified ? (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse" />
          <ShieldCheck className="h-3 w-3" />
          TDX Verified
        </>
      ) : (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          <ShieldAlert className="h-3 w-3" />
          Unverified TEE
        </>
      )}
    </span>
  );

  if (showLink) {
    return (
      <Link href="/trust" className="focus-ring rounded-full">
        {badgeContent}
      </Link>
    );
  }

  return badgeContent;
}
