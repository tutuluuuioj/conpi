export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

/**
 * Direct Maker Vault payouts are intentionally disabled.
 *
 * Foreign-chain settlement must start from a TEE-signed escrow operation
 * (release_stage_foreign, settle_default_foreign, timeout_refund_foreign, or
 * claim_seller_foreign_payout). Those contract methods bind the recipient,
 * amount, deal and nonce before the signed transaction is broadcast. A web
 * request must never be able to instruct an operator hot wallet to transfer
 * funds directly.
 */
function escrowOnlyResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "Direct vault payouts are disabled. Submit a TEE-signed escrow settlement instead.",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

export async function POST() {
  return escrowOnlyResponse();
}

export async function GET() {
  return escrowOnlyResponse();
}
