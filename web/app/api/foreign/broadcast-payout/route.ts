export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

/** Payout broadcasts must pass through the enclave signature verifier. */
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: "Direct web payout broadcasting is disabled. Use the TEE-verified foreign payout relay.",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
